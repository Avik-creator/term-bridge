# term-bridge-worker

Cloudflare Worker that provides **HTTP + WebSocket signaling** for Term Bridge: short-lived pairing codes, session lookup, and relaying WebRTC signaling messages between host and client inside a **Durable Object** (`SessionRoom`).

This document describes **NPM + Wrangler usage**—installing dependencies in this package and running or deploying the worker. This package is **`"private": true`** in `package.json`, so it is **not** published to the npm registry; you run it from a clone of this repo (or copy the package into your monorepo).

## Stack

- **Cloudflare Workers** with `nodejs_compat` (`wrangler.jsonc`)
- **Hono** for routing and CORS
- **Durable Object** (`SessionRoom`) — one instance per `sessionId`, holds up to two WebSockets (`host` / `client`) and relays messages
- **KV** (`CODES`) — maps 6-digit code → `sessionId` with **600s TTL** (see `POST /session` in `src/index.ts`)

## Requirements

- **Node.js** (LTS recommended; Wrangler 3 expects a current Node)
- **Cloudflare account** and **Wrangler CLI** (installed as a devDependency: `npx wrangler` or `npm exec wrangler`)
- **Wrangler logged in**: `npx wrangler login`

## Install (npm, in this directory)

```bash
cd term-bridge-worker
npm install
```

## First-time Cloudflare resources

The checked-in `wrangler.jsonc` binds a **KV namespace** by **id** and **preview_id**. Those IDs belong to a specific Cloudflare account. **For your own account**, create a namespace and paste the ids into `wrangler.jsonc`:

```bash
npx wrangler kv namespace create CODES
```

Use the returned `id` for production and `preview_id` (if shown) for `wrangler dev`. Update the `kv_namespaces` block accordingly.

**Durable Object migrations** are defined under `migrations` in `wrangler.jsonc`. The first `wrangler deploy` in a new account applies them; do not reuse migration tags incorrectly across renamed workers—see [Cloudflare Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) if you change class names or bindings.

## Scripts (npm)

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `npm run dev` | `wrangler dev` — local worker + DO + KV preview |
| `deploy` | `npm run deploy` | `wrangler deploy` — production worker |
| `cf-typegen` | `npm run cf-typegen` | `wrangler types` — regenerate bindings types if you change `wrangler.jsonc` |

## Deployed URL and the CLI agent

After deploy, Wrangler prints your worker URL (for example `https://term-bridge-worker.<subdomain>.workers.dev`).

Point **term-bridge-agent** at that origin (scheme + host, no path):

```bash
export TERM_BRIDGE_SERVER=https://your-worker.example.workers.dev
term-bridge
# peer machine:
term-bridge connect XXX-XXX
```

Host and client **must** use the same `TERM_BRIDGE_SERVER` value so codes and WebSockets hit the same KV and Durable Object namespace.

## HTTP API

CORS is applied to all routes (`app.use("*", cors())` in `src/index.ts`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/app` | Small HTML page confirming the worker is up |
| `GET` | `/install` | Returns a **bash** script (`text/x-shellscript`) that installs `term-bridge-agent` globally or suggests `npx term-bridge-agent` |
| `POST` | `/session` | JSON body optional `{ "machine": "<hostname>" }`. Creates session, stores code in KV (10 min), initializes DO. Response: `{ "code", "sessionId" }` |
| `GET` | `/join/:code` | `code` may include or omit hyphen. Returns `{ "sessionId" }` or **404** if missing/expired. **Deletes** the code from KV after success (one-time join) |
| `GET` | `/session/:id/ws?role=host\|client` | **WebSocket** upgrade; `id` is `sessionId`. **426** if not a WebSocket upgrade. **409** if that role is already connected. **410** if session already ended |

WebSocket messages are **opaque JSON strings** relayed between host and client (WebRTC signaling as produced by term-bridge-agent).

## Remote install script (`/install`)

Example (only run scripts from origins you trust):

```bash
curl -fsSL https://YOUR_WORKER_ORIGIN/install | bash
```

The script checks Node 18+, tries `npm install -g term-bridge-agent`, and falls back to `npx term-bridge-agent` if global install fails. The same logic lives inline in the worker (`INSTALL_SCRIPT` in `src/index.ts`); `static/install.sh` is a sibling copy for editing/reference.

## How it fits with term-bridge-agent

1. Host: `POST /session` → `{ code, sessionId }` → WebSocket `GET /session/:sessionId/ws?role=host`
2. Client: `GET /join/:code` → `{ sessionId }` → WebSocket `GET /session/:sessionId/ws?role=client`
3. When both sockets are open, the DO sends the host a `peer_info` message (includes connecting IP when available via `request.cf`).

## Troubleshooting

- **404 on join**: Code expired (KV TTL), already consumed (join deletes the key), or wrong `TERM_BRIDGE_SERVER` on the client.
- **409 on WebSocket**: That role slot is already taken; only one host and one client per session.
- **410 on WebSocket**: Session marked ended after a peer disconnected.
- **KV / DO errors after fork**: Replace KV ids in `wrangler.jsonc` and redeploy; confirm `durable_objects` binding name matches `SESSION_ROOMS` in code.

## Related

- **term-bridge-agent** — npm package and CLI (`term-bridge`); see that package’s `README.md` for host/client usage and `TERM_BRIDGE_SERVER`.

## License

See the repository root for license information if applicable.
