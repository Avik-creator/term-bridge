import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type CtrlMsg =
  | { type: "cmd_response"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kick" }
  | { type: "transfer_start"; filename: string; size: number }
  | { type: "transfer_chunk"; index: number; data: string }
  | { type: "transfer_end"; filename: string }
  | { type: "rev_data"; data: string }
  | { type: "rev_input"; data: string }
  | { type: "rev_resize"; cols: number; rows: number };

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
  viewMode: "local" | "remote";
  switchView: () => void;
  transferFile?: (filepath: string) => void;
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
      ctx.writeToStdout("  \x1b[36m/switch\x1b[0m          Switch local ↔ remote terminal\r\n");
      ctx.writeToStdout("  \x1b[36m/help\x1b[0m            Show this help\r\n");
      if (ctx.role === "host") {
        ctx.writeToStdout("  \x1b[36m/kick\x1b[0m            Kick the connected client\r\n");
      }
      ctx.writeToStdout("  \x1b[36m/transfer\x1b[0m <file>  Send a file to peer (tab to complete)\r\n");
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
      ctx.writeToStdout(`  View:      ${ctx.viewMode}\r\n`);
      ctx.writeToStdout("\r\n");
      return true;
    }

    case "/switch":
      ctx.switchView();
      ctx.writeToStdout(
        `\r\n\x1b[36m→ Switched to ${ctx.viewMode} terminal\x1b[0m\r\n`
      );
      return true;

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
      ctx.transferFile?.(expandPath(args));
      return true;

    default:
      ctx.writeToStdout(`\r\n\x1b[31mUnknown command: ${cmd}. Type /help for available commands.\x1b[0m\r\n`);
      return true;
  }
}

export function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

export function tabComplete(input: string): { completed: string; matches?: string[] } | null {
  const prefix = "/transfer ";
  if (!input.startsWith(prefix)) return null;

  const partial = input.slice(prefix.length);
  if (!partial) return null;

  const expanded = expandPath(partial);
  const dir = path.dirname(expanded);
  const base = path.basename(expanded);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.startsWith(base));
  } catch {
    return null;
  }

  if (entries.length === 0) return null;

  if (entries.length === 1) {
    const full = path.join(dir, entries[0]);
    try {
      const isDir = fs.statSync(full).isDirectory();
      return { completed: prefix + full + (isDir ? "/" : "") };
    } catch {
      return { completed: prefix + full };
    }
  }

  return { completed: input, matches: entries };
}
