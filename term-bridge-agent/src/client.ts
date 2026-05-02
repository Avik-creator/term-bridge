import * as fs from "fs";
import * as path from "path";
import nodeDataChannel from "node-datachannel";
import * as pty from "node-pty";
import WebSocket from "ws";
import { getSignalingBase } from "./config";
import { closeRtcResources } from "./rtc-cleanup";
import { spawnShell } from "./pty";
import {
  handleCommand,
  CommandContext,
  encodeCtrl,
  decodeCtrl,
  isCtrlMsg,
  CtrlMsg,
} from "./commands";

type SignalMsg =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: string; mid: string }
  | { type: "peer_info"; address: string }
  | { type: "peer_disconnected" };

export async function connectClient(code: string): Promise<void> {
  const rawCode = code.replace("-", "");
  const signalingBase = getSignalingBase();

  console.error("[CLIENT] Resolving code:", rawCode);
  const joinRes = await fetch(`${signalingBase}/join/${rawCode}`);
  if (!joinRes.ok) {
    throw new Error(`Invalid or expired code: ${code}`);
  }
  const { sessionId } = (await joinRes.json()) as { sessionId: string };
  console.error("[CLIENT] Got sessionId:", sessionId);

  const wsUrl = new URL(`/session/${sessionId}/ws`, signalingBase);
  wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
  wsUrl.searchParams.set("role", "client");
  console.error("[CLIENT] Connecting to WS:", wsUrl.toString());

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl.toString());
    let dc: nodeDataChannel.DataChannel | null = null;
    let cleanupClientTerminal: (() => void) | null = null;
    let peerAddress: string | undefined;
    let connectedAt: Date | undefined;
    let clientPty: pty.IPty | null = null;
    let viewMode: "local" | "remote" = "remote";
    let transferState: {
      filename: string;
      size: number;
      chunks: Map<number, string>;
    } | null = null;

    ws.on("open", () => {
      console.error("[CLIENT WS] opened");
    });
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanupClientTerminal?.();
      clientPty?.kill();
      closeRtcResources({
        dataChannel: dc,
        peerConnection: pc,
        cleanup: () => nodeDataChannel.cleanup(),
      });
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve();
    };

    const pc = new nodeDataChannel.PeerConnection("client", {
      iceServers: ["stun:stun.cloudflare.com:3478"],
    });

    pc.onLocalDescription((sdp, type) => {
      console.error("[PC] local description:", type);
      wsSend(ws, { type, sdp });
    });

    pc.onLocalCandidate((candidate, mid) => {
      console.error("[PC] local candidate:", mid);
      wsSend(ws, { type: "ice", candidate, mid });
    });

    pc.onDataChannel((channel) => {
      dc = channel;
      console.error("[PC] data channel received");
      channel.onOpen(() => {
        console.error("[DC] opened");
        connectedAt = new Date();

        const cols = process.stdout.isTTY
          ? process.stdout.columns ?? 80
          : 80;
        const rows = process.stdout.isTTY
          ? process.stdout.rows ?? 24
          : 24;

        clientPty = spawnShell(cols, rows);

        clientPty.onExit(({ exitCode }) => {
          if (viewMode === "local") {
            process.stdout.write(`\r\n\x1b[33m[Local shell exited with code ${exitCode}]\x1b[0m\r\n`);
          }
          clientPty = spawnShell(cols, rows);
          wireClientPty(clientPty);
        });

        wireClientPty(clientPty);

        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
        process.stdin.resume();

        channel.sendMessage(
          JSON.stringify({ type: "resize", cols, rows })
        );

        let inputBuffer = "";
        let commandMode = false;

        const cmdCtx: CommandContext = {
          role: "client",
          peerAddress,
          connectedAt,
          sendCtrl: (msg: CtrlMsg) => {
            if (channel.isOpen()) channel.sendMessage(encodeCtrl(msg));
          },
          disconnect: () => {
            if (channel.isOpen()) channel.close();
            done();
          },
          writeToStdout: (text: string) => {
            process.stdout.write(text);
          },
          viewMode: "remote",
          switchView: () => {
            viewMode = viewMode === "remote" ? "local" : "remote";
            cmdCtx.viewMode = viewMode;
          },
        };

        const onInput = (chunk: string) => {
          for (const ch of chunk) {
            if (ch === "/") {
              commandMode = true;
              inputBuffer = "/";
              process.stdout.write("/");
              continue;
            }

            if (commandMode) {
              if (ch === "\r" || ch === "\n") {
                process.stdout.write("\r\n");
                cmdCtx.viewMode = viewMode;
                const handled = handleCommand(inputBuffer, cmdCtx);
                if (handled) {
                  inputBuffer = "";
                  commandMode = false;
                  continue;
                }
                if (viewMode === "local" && clientPty) {
                  clientPty.write(inputBuffer + "\r");
                } else if (channel.isOpen()) {
                  channel.sendMessage(inputBuffer + "\r");
                }
                inputBuffer = "";
                commandMode = false;
                continue;
              }

              if (ch === "\x7f" || ch === "\b") {
                if (inputBuffer.length > 0) {
                  inputBuffer = inputBuffer.slice(0, -1);
                  process.stdout.write("\b \b");
                }
                if (inputBuffer.length === 0) {
                  commandMode = false;
                }
                continue;
              }

              if (ch === "\x03") {
                process.stdout.write("^C\r\n");
                inputBuffer = "";
                commandMode = false;
                continue;
              }

              if (ch >= " ") {
                inputBuffer += ch;
                process.stdout.write(ch);
              }
              continue;
            }

            if (viewMode === "local") {
              clientPty?.write(ch);
            } else if (channel.isOpen()) {
              channel.sendMessage(ch);
            }
          }
        };
        process.stdin.on("data", onInput);

        let onResize: (() => void) | null = null;
        if (process.stdout.isTTY) {
          onResize = () => {
            const c = process.stdout.columns ?? 80;
            const r = process.stdout.rows ?? 24;
            if (viewMode === "local" && clientPty) {
              clientPty.resize(c, r);
            } else if (channel.isOpen()) {
              channel.sendMessage(
                JSON.stringify({ type: "resize", cols: c, rows: r })
              );
            }
          };
          process.stdout.on("resize", onResize);
        }

        cleanupClientTerminal = () => {
          process.stdin.off("data", onInput);
          if (onResize) process.stdout.off("resize", onResize);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();
        };
      });

      channel.onMessage((msg) => {
        const raw = typeof msg === "string" ? msg : Buffer.from(msg).toString();

        if (isCtrlMsg(raw)) {
          const ctrl = decodeCtrl(raw);
          if (!ctrl) return;
          handleIncomingCtrl(ctrl);
          return;
        }

        if (viewMode === "remote") {
          process.stdout.write(raw);
        }
      });

      channel.onClosed(() => {
        process.stdout.write("\r\n\x1b[33m⚡ Disconnected.\x1b[0m\r\n");
        done();
      });

      channel.onError((err) => {
        process.stdout.write(`\r\n\x1b[31mDataChannel error: ${err}\x1b[0m\r\n`);
        done();
      });
    });

    function wireClientPty(cPty: pty.IPty): void {
      cPty.onData((data: string) => {
        if (viewMode === "local") {
          process.stdout.write(data);
        }
        if (dc?.isOpen()) {
          dc.sendMessage(encodeCtrl({ type: "rev_data", data }));
        }
      });
    }

    function handleIncomingCtrl(ctrl: CtrlMsg): void {
      switch (ctrl.type) {
        case "kick":
          process.stdout.write("\r\n\x1b[33m⚡ Host kicked you from the session.\x1b[0m\r\n");
          done();
          break;
        case "cmd_response":
          process.stdout.write(ctrl.text + "\r\n");
          break;
        case "rev_input":
          clientPty?.write(ctrl.data);
          break;
        case "rev_resize":
          clientPty?.resize(ctrl.cols, ctrl.rows);
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

    ws.on("message", (raw) => {
      let msg: SignalMsg;
      try { msg = JSON.parse(raw.toString()) as SignalMsg; }
      catch { return; }

      console.error("[WS] received:", msg.type);

      switch (msg.type) {
        case "offer":
          console.error("[PC] setting remote description (offer)...");
          pc.setRemoteDescription(msg.sdp, "offer");
          break;
        case "ice":
          console.error("[PC] adding remote candidate...");
          pc.addRemoteCandidate(msg.candidate, msg.mid);
          break;
        case "peer_info":
          peerAddress = msg.address;
          console.error("[WS] peer_info received, closing WS");
          ws.close();
          break;
        case "peer_disconnected":
          process.stdout.write("\r\n\x1b[33m⚡ Host disconnected.\x1b[0m\r\n");
          done();
          break;
      }
    });

    ws.on("close", () => {
      console.error("[WS] closed");
    });

    ws.on("error", (err) => {
      console.error("[WS] error:", err.message);
      done(err);
    });
  });
}

function wsSend(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
