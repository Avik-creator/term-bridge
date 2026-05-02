# Term Bridge - Real Terminal Sharing over Cloudflare + WebRTC

Share your actual shell (zsh/bash/fish) with anyone via a 6-digit code.
No port forwarding. No VPNs. Fully peer-to-peer after the WebRTC handshake.

---

## Architecture

```
Host machine                  Cloudflare Edge                  Browser
────────────                  ───────────────                  ───────
term-bridge-agent (bun)
  │
  ├─ node-pty ($SHELL) ──────────────────────────────────── xterm.js
  │   real shell process         (P2P WebRTC DataChannel)
  │
  └─ WebSocket ──► Hono Worker ──► SessionRoom DO ◄── WebSocket ◄─ browser
                   (router)        (RPC + relay)       (signaling)
```

Flow:
1. Agent calls POST /session → Hono Worker creates a DO via RPC, stores code in KV.
2. Browser calls GET /join/:code → resolves to sessionId.
3. Both connect via GET /session/:id/ws?role=host|client → DO holds both WebSockets.
4. DO relays SDP offer/answer + ICE candidates (WebRTC handshake) between the two.
5. DataChannel opens → DO is no longer in the path. Agent pipes pty ↔ DataChannel.
6. Browser xterm.js renders the live real terminal.

---

## Part 1 — Cloudflare Worker (Hono + Durable Objects)

### Prerequisites
- Cloudflare account (free tier — DOs are free as of April 2025)
- bun installed: curl -fsSL https://bun.sh/install | bash

### Setup

```bash
cd term-bridge-worker
bun install

# Create the KV namespace for pairing codes
bunx wrangler kv namespace create CODES
# Copy the `id` into wrangler.jsonc kv_namespaces[0].id

bunx wrangler kv namespace create CODES --preview
# Copy the `preview_id` into wrangler.jsonc kv_namespaces[0].preview_id

# Local dev
bun run dev

# Deploy
bun run deploy
```

Your Worker URL: https://term-bridge-worker.<your-subdomain>.workers.dev

---

## Part 2 — Host Agent (bun + node-pty)

### Prerequisites
- bun >= 1.0
- macOS or Linux (node-pty requires native bindings)

### Setup

```bash
cd term-bridge-agent
bun install

echo 'TERM_BRIDGE_SERVER=https://term-bridge-worker.<your-subdomain>.workers.dev' > .env

bun run dev
```

Output:
  ● Term Bridge agent running
  Machine: MacBook-Pro
  Code:    483-291
  Waiting for connections...

The agent reads process.env.SHELL automatically — zsh, bash, fish, nushell all work.
Override with: SHELL=/bin/bash bun run dev

---

## Part 3 — Browser Client (xterm.js)

See the full xterm.js + WebRTC binding example in the README section on the
browser client. Key points:
- GET /join/:code → resolve sessionId
- WebSocket to /session/:id/ws?role=client for signaling
- RTCPeerConnection answers the SDP offer from the host
- pc.ondatachannel binds the "terminal" channel to xterm.js
- Resize events sent as JSON: { type: "resize", cols, rows }

---

## Environment Variables

| Variable          | Where        | Description                                    |
|-------------------|--------------|------------------------------------------------|
| TERM_BRIDGE_SERVER | agent .env  | Base URL of your Cloudflare Worker             |
| SHELL             | system       | Auto-detected — which shell to spawn           |
| TURN_USERNAME     | agent .env   | (Optional) Cloudflare TURN credential          |
| TURN_CREDENTIAL   | agent .env   | (Optional) Cloudflare TURN credential          |

---

## Security Notes

- Terminal data is DTLS-encrypted end-to-end — Cloudflare never sees it.
- The DO only relays signaling (SDP + ICE), not terminal content.
- Pairing codes expire after 10 minutes if unclaimed (KV TTL).
- Add Bearer token auth to POST /session to prevent unauthorized sessions.
