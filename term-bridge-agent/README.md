# term-bridge-agent

Term Bridge host agent: share your real terminal with a peer over a WebRTC DataChannel, with signaling through a small HTTP/WebSocket service.

This document describes **NPM usage**—installing the published package and running the `term-bridge` CLI. For hacking on the TypeScript source, use `npm run dev` in a clone of this repo.

## Requirements

- **Node.js 20+** (the build targets Node 20; see `scripts/build.ts`.)
- **Native addons**: `node-pty` and `node-datachannel` compile on install. You need a supported platform and typical build tooling (e.g. Xcode CLI tools on macOS, build-essential on Linux, or [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) on Windows).

## Install (npm)

**Global CLI** (recommended if you use Term Bridge often):

```bash
npm install -g term-bridge-agent
```

After install, the binary is **`term-bridge`** (not the package name).

**One-off / pinned version** without a global install:

```bash
npx term-bridge-agent
# or, to be explicit about the binary name:
npx -p term-bridge-agent term-bridge
```

`prepublishOnly` runs `npm run build`, so the published tarball includes `dist/` and the CLI is ready to run.

### Trusted dependencies

This package lists `node-pty` and `node-datachannel` under `trustedDependencies` so their install scripts can run under npm’s security model. If install is blocked, follow your npm version’s prompts to allow those packages, or install in an environment where lifecycle scripts are permitted.

## Usage

### Host (machine that shares its terminal)

```bash
term-bridge
```

The agent prints a **six-digit pairing code** (shown as `XXX-XXX`) and waits on signaling until a peer connects.

### Client (machine that attaches to the host)

On the other machine:

```bash
term-bridge connect XXX-XXX
```

You can omit the hyphen in the code if you prefer.

### In-session commands

After the data channel is up, commands start with **`/`** (see `src/commands.ts`). Examples:

| Command | Purpose |
|--------|---------|
| `/help` | List commands |
| `/exit`, `/quit`, `/q` | Leave the session |
| `/status` | Connection info |
| `/switch` | Toggle local vs remote terminal view |
| `/transfer <path>` | Send a file to the peer (tab completion where supported) |

On the **host**, `/kick` disconnects the client.

## Configuration

**Signaling base URL** (HTTP for REST, same origin used for WebSocket):

| Variable | Description |
|----------|-------------|
| `TERM_BRIDGE_SERVER` | Base URL of the Term Bridge worker (no trailing slash required). If unset, the default in `src/config.ts` is used. |

Example:

```bash
export TERM_BRIDGE_SERVER=https://your-worker.example.com
term-bridge
```

Both host and client must use the **same** signaling server so the pairing code resolves to the same session.

## How it fits together

1. **Host** `POST /session` → receives `code` and `sessionId`, then opens a WebSocket as `role=host`.
2. **Client** `GET /join/:code` → receives `sessionId`, then opens a WebSocket as `role=client`.
3. **WebRTC** (offer/answer/ICE) is exchanged via the worker; terminal I/O flows over the DataChannel.

## Troubleshooting

- **Install fails on native modules**: Install compiler toolchain for your OS, delete `node_modules`, and run `npm install` again.
- **Invalid or expired code**: Codes are short-lived server-side; start a new host session and use the new code.
- **Cannot connect**: Confirm `TERM_BRIDGE_SERVER` matches on both sides and that the worker is reachable from both networks.

## Package vs CLI name

| | Name |
|---|------|
| npm package | `term-bridge-agent` |
| Executable | `term-bridge` |

## License

See the repository root for license information if applicable.
