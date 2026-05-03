import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import nodeDataChannel from "node-datachannel";
import * as pty from "node-pty";
import WebSocket from "ws";
import { closeRtcResources } from "./rtc-cleanup";
import { attachHostTerminal } from "./terminal-io";
import { isCtrlMsg, decodeCtrl, encodeCtrl, CtrlMsg } from "./commands";

export interface PtyBridgeOptions {
  sessionId: string;
  signalingUrl: string;
  onConnected: (peerAddress: string) => void;
  onDisconnected: () => void;
}

type SignalMsg =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: string; mid: string }
  | { type: "peer_info"; address: string }
  | { type: "peer_disconnected" }
  | { type: "resize"; cols: number; rows: number };

let ptyFixed = false;

function fixPtyNativeBinaries(): void {
  if (ptyFixed) return;
  ptyFixed = true;
  if (process.platform !== "darwin") return;

  const ptyDir = path.dirname(require.resolve("node-pty/package.json"));
  const prebuildsDir = path.join(ptyDir, "prebuilds");
  if (!fs.existsSync(prebuildsDir)) return;

  try {
    execSync(`chmod +x "${prebuildsDir}"/*/spawn-helper`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(`xattr -dr com.apple.quarantine "${ptyDir}"`, { stdio: "ignore" });
  } catch {}
  try {
    execSync(
      `find "${ptyDir}" -name "*.node" -exec codesign --force --sign - {} \\;`,
      { stdio: "ignore" }
    );
  } catch {}
  try {
    execSync(
      `codesign --force --sign - "${prebuildsDir}"/*/spawn-helper`,
      { stdio: "ignore" }
    );
  } catch {}
}

export function spawnShell(cols = 220, rows = 50): pty.IPty {
  const platform = process.platform;
  let shellBin: string;

  if (platform === "win32") {
    shellBin = process.env.COMSPEC ?? "cmd.exe";
  } else {
    shellBin = process.env.SHELL ?? "/bin/bash";
    if (platform === "darwin" && !fs.existsSync("/bin/zsh")) {
      shellBin = "/bin/bash";
    }
  }

  if (!fs.existsSync(shellBin)) {
    throw new Error(`Shell not found: ${shellBin}`);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM_BRIDGE = "1";
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";

  fixPtyNativeBinaries();

  const term = pty.spawn(shellBin, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME ?? process.cwd(),
    env,
  });

  return term;
}

export async function startPtyBridge(opts: PtyBridgeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.signalingUrl);
    let shell: pty.IPty | null = null;
    let settled = false;
    let pc: nodeDataChannel.PeerConnection | null = null;
    let dc: nodeDataChannel.DataChannel | null = null;
    let cleanupHostTerminal: (() => void) | null = null;
    let peerAddress: string | undefined;
    let connectedAt: Date | undefined;
    let viewMode: "local" | "remote" = "local";
    let transferState: {
      filename: string;
      size: number;
      chunks: Map<number, string>;
    } | null = null;

    const getViewMode = () => viewMode;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanupHostTerminal?.();
      closeRtcResources({
        dataChannel: dc,
        peerConnection: pc,
        cleanup: () => nodeDataChannel.cleanup(),
      });
      shell?.kill();
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve();
    };

    ws.on("message", (raw) => {
      let msg: SignalMsg;
      try { msg = JSON.parse(raw.toString()) as SignalMsg; }
      catch { return; }

      switch (msg.type) {
        case "peer_info": {
          peerAddress = msg.address;
          connectedAt = new Date();
          opts.onConnected(msg.address);

          pc = new nodeDataChannel.PeerConnection("host", {
            iceServers: ["stun:stun.cloudflare.com:3478"],
          });

          pc.onLocalDescription((sdp, type) => {
            wsSend(ws, { type, sdp });
          });

          pc.onLocalCandidate((candidate, mid) => {
            wsSend(ws, { type: "ice", candidate, mid });
          });

          dc = pc.createDataChannel("terminal");

          dc.onOpen(() => {
            try {
              shell = spawnShell();
              cleanupHostTerminal = attachHostTerminal({
                shell,
                sendRemote: (data) => {
                  if (dc!.isOpen()) dc!.sendMessage(data);
                },
                sendRevInput: (data) => {
                  if (dc!.isOpen()) {
                    dc!.sendMessage(encodeCtrl({ type: "rev_input", data }));
                  }
                },
                getViewMode,
                onSwitchView: () => {
                  viewMode = viewMode === "local" ? "remote" : "local";
                  if (viewMode === "remote" && dc?.isOpen()) {
                    const cols = process.stdout.columns ?? 80;
                    const rows = process.stdout.rows ?? 24;
                    dc.sendMessage(encodeCtrl({ type: "rev_resize", cols, rows }));
                  }
                },
                transferFile: (filepath) => {
                  sendFile(dc!, filepath);
                },
                peerAddress,
                connectedAt,
                onDisconnect: () => {
                  opts.onDisconnected();
                  done();
                },
              });
              shell.onExit(({ exitCode }) => {
                if (dc!.isOpen()) {
                  dc!.sendMessage(`\r\n[Process exited with code ${exitCode}]\r\n`);
                  dc!.close();
                }
                opts.onDisconnected();
                done();
              });
            } catch (err) {
              dc!.sendMessage("\r\n[Failed to spawn shell]\r\n");
            }
          });

          dc.onMessage((msg) => {
            if (!shell) return;
            const raw = typeof msg === "string" ? msg : Buffer.from(msg).toString();

            if (isCtrlMsg(raw)) {
              const ctrl = decodeCtrl(raw);
              if (!ctrl) return;
              handleIncomingCtrl(ctrl);
              return;
            }

            try {
              const parsed = JSON.parse(raw) as SignalMsg;
              if (parsed.type === "resize") {
                shell.resize(parsed.cols, parsed.rows);
                return;
              }
            } catch {}
            shell.write(raw);
          });

          dc.onClosed(() => {
            opts.onDisconnected();
            done();
          });

          dc.onError(() => {});
          break;
        }
        case "answer":
          if (pc) {
            pc.setRemoteDescription(msg.sdp, "answer");
          }
          break;
        case "ice":
          if (pc) {
            pc.addRemoteCandidate(msg.candidate, msg.mid);
          }
          break;
        case "peer_disconnected":
          opts.onDisconnected();
          done();
          break;
      }
    });

    ws.on("close", () => {});

    ws.on("error", (err) => {
      done(err);
    });

    function handleIncomingCtrl(ctrl: CtrlMsg): void {
      switch (ctrl.type) {
        case "rev_data":
          if (viewMode === "remote") {
            process.stdout.write(ctrl.data);
          }
          break;
        case "kick":
          break;
        case "cmd_response":
          process.stdout.write(ctrl.text + "\r\n");
          break;
        case "transfer_start":
          transferState = {
            filename: ctrl.filename,
            size: ctrl.size,
            chunks: new Map(),
          };
          process.stdout.write(`\r\n\x1b[36mReceiving file: ${ctrl.filename} (${ctrl.size} bytes)...\x1b[0m\r\n`);
          break;
        case "transfer_chunk":
          if (transferState) {
            transferState.chunks.set(ctrl.index, ctrl.data);
          }
          break;
        case "transfer_end":
          if (transferState) {
            finishTransfer(transferState);
            transferState = null;
          }
          break;
      }
    }

    function sendFile(dataChannel: nodeDataChannel.DataChannel, filepath: string): void {
      if (!dataChannel.isOpen()) return;
      const filename = path.basename(filepath);
      try {
        const stat = fs.statSync(filepath);
        if (!stat.isFile()) {
          process.stdout.write(`\r\n\x1b[31mNot a file: ${filepath}\x1b[0m\r\n`);
          return;
        }
        process.stdout.write(`\r\n\x1b[36mSending ${filename} (${stat.size} bytes)...\x1b[0m\r\n`);
        dataChannel.sendMessage(encodeCtrl({ type: "transfer_start", filename, size: stat.size }));
        const CHUNK = 16384;
        const fd = fs.openSync(filepath, "r");
        const buf = Buffer.alloc(CHUNK);
        let idx = 0;
        while (true) {
          const read = fs.readSync(fd, buf, 0, CHUNK, idx * CHUNK);
          if (read === 0) break;
          dataChannel.sendMessage(encodeCtrl({ type: "transfer_chunk", index: idx, data: buf.toString("base64", 0, read) }));
          idx++;
        }
        fs.closeSync(fd);
        dataChannel.sendMessage(encodeCtrl({ type: "transfer_end", filename }));
        process.stdout.write(`\x1b[32mSent: ${filename}\x1b[0m\r\n`);
      } catch (err) {
        process.stdout.write(`\r\n\x1b[31mTransfer failed: ${err}\x1b[0m\r\n`);
      }
    }

    function finishTransfer(state: { filename: string; size: number; chunks: Map<number, string> }): void {
      const outPath = path.join(process.cwd(), state.filename);
      try {
        const fd = fs.openSync(outPath, "w");
        const indices = [...state.chunks.keys()].sort((a, b) => a - b);
        for (const idx of indices) {
          const buf = Buffer.from(state.chunks.get(idx)!, "base64");
          fs.writeSync(fd, buf, 0, buf.length, idx * 16384);
        }
        fs.closeSync(fd);
        process.stdout.write(`\x1b[32mSaved: ${outPath} (${state.size} bytes)\x1b[0m\r\n`);
      } catch (err) {
        process.stdout.write(`\x1b[31mTransfer save failed: ${err}\x1b[0m\r\n`);
      }
    }
  });
}

function wsSend(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
