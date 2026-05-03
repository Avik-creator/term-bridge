/**
 * term-bridge-worker/src/index.ts
 *
 * Cloudflare Worker using Hono as the HTTP/WS router.
 * The SessionRoom Durable Object exposes RPC methods for the Worker to call.
 *
 * Routes (all handled by Hono):
 *   GET  /install              → curl|bash installer for the CLI agent
 *   POST /session              → create session, return 6-digit code + sessionId
 *   GET  /join/:code           → resolve code → return sessionId
 *   GET  /session/:id/ws       → WebSocket upgrade, forwarded into SessionRoom DO
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  SESSION_ROOMS: DurableObjectNamespace<SessionRoom>;
  CODES: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

const INSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

BOLD='\\033[1m'
GREEN='\\033[0;32m'
RED='\\033[0;31m'
YELLOW='\\033[0;33m'
CYAN='\\033[0;36m'
GRAY='\\033[0;90m'
RESET='\\033[0m'

info()  { echo -e "\${GREEN}●\${RESET} \$*"; }
warn()  { echo -e "\${YELLOW}⚡\${RESET} \$*"; }
error() { echo -e "\${RED}✗\${RESET} \$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "Node.js is required. Install it from https://nodejs.org"

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "\$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ is required (you have v\${NODE_VERSION}). Upgrade at https://nodejs.org"
fi

info "Installing \${BOLD}term-bridge-agent\${RESET}..."

if npm install -g term-bridge-agent 2>/dev/null; then
  info "Installed. Run \${BOLD}term-bridge\${RESET} to share your terminal."
else
  warn "npm global install failed. Falling back to npx..."
  info "No install needed. Just run: \${BOLD}npx term-bridge-agent\${RESET}"
fi

echo ""
echo -e "  \${GRAY}Usage:\${RESET} \${CYAN}term-bridge\${RESET}"
echo -e "  \${GRAY}Then share the URL with your peer.\${RESET}"
echo ""
`;

const APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Term Bridge</title>
  </head>
  <body>
    <pre>Term Bridge signaling worker is running.</pre>
  </body>
</html>`;

app.get("/install", (c) => {
  return c.text(INSTALL_SCRIPT, 200, {
    "Content-Type": "text/x-shellscript; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
});

app.get("/app", (c) => {
  return c.html(APP_HTML);
});

app.post("/session", async (c) => {
  const body = await c.req.json<{ machine?: string }>();
  const machine = body.machine ?? "unknown";

  const sessionId = crypto.randomUUID();
  const code = generateCode();

  await c.env.CODES.put(code, sessionId, { expirationTtl: 600 });

  const roomId = c.env.SESSION_ROOMS.idFromName(sessionId);
  const room = c.env.SESSION_ROOMS.get(roomId);
  await room.init(machine);

  return c.json({ code, sessionId });
});

app.get("/join/:code", async (c) => {
  const code = c.req.param("code").replace("-", "");
  const sessionId = await c.env.CODES.get(code);

  if (!sessionId) {
    return c.json({ error: "Code not found or expired" }, 404);
  }

  await c.env.CODES.delete(code);

  return c.json({ sessionId });
});

app.get("/session/:id/ws", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const sessionId = c.req.param("id");
  const role = (c.req.query("role") ?? "client") as "host" | "client";

  const roomId = c.env.SESSION_ROOMS.idFromName(sessionId);
  const room = c.env.SESSION_ROOMS.get(roomId);

  const url = new URL(c.req.url);
  url.searchParams.set("role", role);
  return room.fetch(new Request(url.toString(), c.req.raw));
});

export default app;

export class SessionRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
  }

  private async getMachine(): Promise<string> {
    return (await this.ctx.storage.get<string>("machine")) ?? "unknown";
  }

  private async isSessionEnded(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>("sessionEnded")) ?? false;
  }

  private getSocketByRole(role: "host" | "client"): WebSocket | undefined {
    for (const sock of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(sock);
      if (tags[0] === role && sock.readyState === WebSocket.OPEN) {
        return sock;
      }
    }
    return undefined;
  }

  private getActiveCount(): number {
    return this.ctx.getWebSockets().filter(
      (s) => s.readyState === WebSocket.OPEN
    ).length;
  }

  async init(machine: string): Promise<void> {
    await this.ctx.storage.put("machine", machine);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = (url.searchParams.get("role") ?? "client") as "host" | "client";
    return this.handleWebSocketUpgrade(request, role);
  }

  async handleWebSocketUpgrade(request: Request, role: "host" | "client"): Promise<Response> {
    if (await this.isSessionEnded()) {
      return new Response("This session has ended", { status: 410 });
    }

    if (this.getSocketByRole(role)) {
      return new Response(`A ${role} is already connected to this session`, { status: 409 });
    }

    const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();

    this.ctx.acceptWebSocket(serverSocket, [role]);
    console.log(`[DO] ${role} connected, total sockets:`, this.getActiveCount());

    if (this.getSocketByRole("host") && this.getSocketByRole("client")) {
      console.log("[DO] both connected, sending peer_info to host");
      const hostSocket = this.getSocketByRole("host")!;
      const cf = (request as any).cf as { ip?: string } | undefined;
      this.send(hostSocket, {
        type: "peer_info",
        address: cf?.ip ?? "unknown",
        machine: await this.getMachine(),
      });
    }

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const role = tags[0] as "host" | "client";
    const peer: "host" | "client" = role === "host" ? "client" : "host";

    const msgStr = message instanceof ArrayBuffer
      ? new TextDecoder().decode(message)
      : message;
    console.log(`[DO] ${role} msg:`, msgStr.substring(0, 80));

    const peerSocket = this.getSocketByRole(peer);
    if (peerSocket) {
      peerSocket.send(message);
      console.log(`[DO] relayed to ${peer}`);
    } else {
      console.log(`[DO] ${peer} not available`);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const role = tags[0] as "host" | "client";
    await this.disconnect(role);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const role = tags[0] as "host" | "client";
    await this.disconnect(role);
  }

  private async disconnect(role: "host" | "client"): Promise<void> {
    await this.ctx.storage.put("sessionEnded", true);

    const peer: "host" | "client" = role === "host" ? "client" : "host";
    const peerSocket = this.getSocketByRole(peer);
    if (peerSocket) {
      this.send(peerSocket, { type: "peer_disconnected", role });
      peerSocket.close(1000, "Peer disconnected");
    }
  }

  private send(ws: WebSocket, data: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}

function generateCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, "0");
}
