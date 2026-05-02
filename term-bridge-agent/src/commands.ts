export type CtrlMsg =
  | { type: "cmd"; cmd: string; args: string }
  | { type: "cmd_response"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kick" }
  | { type: "transfer_start"; filename: string; size: number }
  | { type: "transfer_chunk"; index: number; data: string }
  | { type: "transfer_end"; filename: string };

export function isCtrlMsg(raw: string): boolean {
  return raw.startsWith("\x00TB:");
}

export function encodeCtrl(msg: CtrlMsg): string {
  return "\x00TB:" + JSON.stringify(msg);
}

export function decodeCtrl(raw: string): CtrlMsg | null {
  if (!raw.startsWith("\x00TB:")) return null;
  try {
    return JSON.parse(raw.slice(4)) as CtrlMsg;
  } catch {
    return null;
  }
}

export interface CommandContext {
  role: "host" | "client";
  peerAddress?: string;
  connectedAt?: Date;
  sendCtrl: (msg: CtrlMsg) => void;
  disconnect: () => void;
  writeToStdout: (text: string) => void;
}

export function handleCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");

  switch (cmd) {
    case "/exit":
    case "/quit":
    case "/q":
      ctx.writeToStdout("\r\n\x1b[33m⚡ Disconnecting...\x1b[0m\r\n");
      ctx.disconnect();
      return true;

    case "/help":
      ctx.writeToStdout("\r\n\x1b[1mTerm Bridge Commands:\x1b[0m\r\n");
      ctx.writeToStdout("  \x1b[36m/exit\x1b[0m, \x1b[36m/quit\x1b[0m   Disconnect session\r\n");
      ctx.writeToStdout("  \x1b[36m/status\x1b[0m          Show connection info\r\n");
      ctx.writeToStdout("  \x1b[36m/help\x1b[0m            Show this help\r\n");
      if (ctx.role === "host") {
        ctx.writeToStdout("  \x1b[36m/kick\x1b[0m            Kick the connected client\r\n");
      }
      ctx.writeToStdout("  \x1b[36m/transfer\x1b[0m <file>  Send a file to peer\r\n");
      ctx.writeToStdout("\r\n");
      return true;

    case "/status": {
      const uptime = ctx.connectedAt
        ? Math.floor((Date.now() - ctx.connectedAt.getTime()) / 1000)
        : 0;
      const mins = Math.floor(uptime / 60);
      const secs = uptime % 60;
      ctx.writeToStdout("\r\n\x1b[1mSession Status:\x1b[0m\r\n");
      ctx.writeToStdout(`  Role:      ${ctx.role}\r\n`);
      ctx.writeToStdout(`  Peer:      ${ctx.peerAddress ?? "unknown"}\r\n`);
      ctx.writeToStdout(`  Uptime:    ${mins}m ${secs}s\r\n`);
      ctx.writeToStdout("\r\n");
      return true;
    }

    case "/kick":
      if (ctx.role !== "host") {
        ctx.writeToStdout("\r\n\x1b[31mOnly the host can kick.\x1b[0m\r\n");
        return true;
      }
      ctx.sendCtrl({ type: "kick" });
      ctx.writeToStdout("\r\n\x1b[33m⚡ Client kicked.\x1b[0m\r\n");
      ctx.disconnect();
      return true;

    case "/transfer":
      if (!args) {
        ctx.writeToStdout("\r\n\x1b[31mUsage: /transfer <filepath>\x1b[0m\r\n");
        return true;
      }
      ctx.sendCtrl({ type: "cmd", cmd: "transfer", args });
      return true;

    default:
      ctx.writeToStdout(`\r\n\x1b[31mUnknown command: ${cmd}. Type /help for available commands.\x1b[0m\r\n`);
      return true;
  }
}
