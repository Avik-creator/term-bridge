# Term Bridge

Share your real terminal with anyone via a 6-digit code. No port forwarding. No VPNs. Fully peer-to-peer after the WebRTC handshake.

Both sides can view and control each other's terminals using `/switch`.

## Architecture

```
Host machine                  Cloudflare Edge                  Peer machine
────────────                  ───────────────                  ────────────
term-bridge-agent
  │
  ├─ node-pty ($SHELL)  ────────────────────────────────────  node-pty ($SHELL)
  │   real shell            (P2P WebRTC DataChannel)            real shell
  │
  └─ WebSocket ──► Hono Worker ──► SessionRoom DO ◄── WebSocket ◄─ agent
                    (router)        (signaling relay)
```

### Flow

1. Host runs `term-bridge` → agent calls `POST /session` → Worker creates a Durable Object, stores pairing code in KV
2. Peer runs `term-bridge connect 483-291` → resolves code → connects to the same DO
3. DO relays SDP offer/answer + ICE candidates between the two
4. WebRTC DataChannel opens → DO goes idle. Terminal data flows P2P, DTLS-encrypted end-to-end

### Bidirectional Mode

Both host and peer spawn their own PTY. Data flows both ways:

| Direction | Channel | Description |
|-----------|---------|-------------|
| Host → Peer | DataChannel (raw) | Host PTY output |
| Peer → Host | DataChannel (raw) | Keystrokes to host PTY |
| Peer → Host | Ctrl `rev_data` | Peer PTY output |
| Host → Peer | Ctrl `rev_input` | Keystrokes to peer PTY |

Use `/switch` to toggle which terminal you're viewing and controlling.

## Project Structure

```
term-bridge/
├── term-bridge-worker/     Cloudflare Worker (Hono + Durable Objects)
│   ├── src/index.ts        Routes + SessionRoom DO
│   ├── static/install.sh   curl|bash installer
│   └── wrangler.jsonc      DO bindings, KV, migrations
│
├── term-bridge-agent/      CLI agent (Node.js + node-pty + WebRTC)
│   ├── src/
│   │   ├── index.ts        Entry point (host / connect modes)
│   │   ├── session.ts      Create session via signaling server
│   │   ├── pty.ts          Host PTY + WebRTC DataChannel bridge
│   │   ├── client.ts       Peer connect mode + reverse PTY
│   │   ├── terminal-io.ts  Host stdin/stdout routing
│   │   ├── commands.ts     Slash-command system + ctrl protocol
│   │   ├── rtc-cleanup.ts  Safe WebRTC resource teardown
│   │   ├── config.ts       Signaling server URL config
│   │   └── ui.ts           CLI banner / code display
│   └── scripts/
│       ├── build.ts        esbuild bundle
│       └── fix-pty.js      macOS node-pty binary fixup
│
└── .gitignore
```

## Quick Start

### 1. Deploy the Worker

```bash
cd term-bridge-worker
npm install

# Create KV namespace for pairing codes
npx wrangler kv namespace create CODES
# Copy the `id` into wrangler.jsonc → kv_namespaces[0].id

npx wrangler kv namespace create CODES --preview
# Copy the `preview_id` into wrangler.jsonc → kv_namespaces[0].preview_id

# Local dev
npm run dev

# Deploy to Cloudflare
npm run deploy
```

Your Worker URL: `https://term-bridge-worker.<subdomain>.workers.dev`

### 2. Run the Agent (Host)

```bash
cd term-bridge-agent
npm install

echo 'TERM_BRIDGE_SERVER=https://term-bridge-worker.<subdomain>.workers.dev' > .env

npm run dev
```

Output:
```
● Term Bridge agent running
Machine: MacBook-Pro
Code:    483-291
Waiting for connections...

  Peer runs: term-bridge connect 483-291
```

### 3. Connect (Peer)

On another machine:

```bash
npm run dev -- connect 483-291
```

Or after `npm install -g term-bridge-agent`:

```bash
term-bridge connect 483-291
```

### 4. Switch Terminals

Once connected, either side can switch to the other's terminal:

```
/switch       → Switch to the other machine's terminal
/switch       → Switch back to your own
/status       → See current view mode (local/remote)
```

## Commands

| Command | Description |
|---------|-------------|
| `/switch` | Toggle between local and remote terminal |
| `/status` | Show connection info and current view |
| `/help` | List available commands |
| `/exit`, `/quit`, `/q` | Disconnect session |
| `/kick` | Kick the peer (host only) |
| `/transfer <file>` | Send a file to the peer |

## API Routes

The Cloudflare Worker exposes:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/session` | Create session → returns `{ code, sessionId }` |
| `GET` | `/join/:code` | Resolve pairing code → `{ sessionId }` |
| `GET` | `/session/:id/ws?role=host\|client` | WebSocket upgrade (signaling) |
| `GET` | `/install` | `curl \| bash` installer script |
| `GET` | `/app` | Status page |

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `TERM_BRIDGE_SERVER` | agent `.env` | Base URL of your Cloudflare Worker |
| `SHELL` | system | Auto-detected — which shell to spawn |

## Security

- Terminal data is DTLS-encrypted end-to-end — Cloudflare never sees it
- The Durable Object only relays signaling (SDP + ICE), not terminal content
- Pairing codes expire after 10 minutes (KV TTL)
- Add Bearer token auth to `POST /session` to prevent unauthorized sessions

## Tech Stack

- **Worker**: Cloudflare Workers, Hono, Durable Objects, KV
- **Agent**: Node.js, node-pty, node-datachannel (libdatachannel), WebSocket
- **Protocol**: WebRTC DataChannel with SDP/ICE signaling over WebSocket
