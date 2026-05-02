import { Writable } from "stream";
import { handleCommand, CommandContext, encodeCtrl, CtrlMsg } from "./commands";

interface ShellLike {
  write(data: string): void;
  onData?(handler: (data: string) => void): { dispose(): void } | void;
}

interface StdinLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  setEncoding?(encoding: BufferEncoding): void;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  off?(event: "data", listener: (chunk: string) => void): unknown;
  removeListener?(event: "data", listener: (chunk: string) => void): unknown;
}

export interface HostTerminalOptions {
  shell: ShellLike;
  stdin?: StdinLike;
  stdout?: Writable;
  sendRemote?: (data: string) => void;
  sendRevInput?: (data: string) => void;
  getViewMode?: () => "local" | "remote";
  onSwitchView?: () => void;
  peerAddress?: string;
  connectedAt?: Date;
  onKick?: () => void;
  onDisconnect?: () => void;
}

export function attachHostTerminal({
  shell,
  stdin = process.stdin,
  stdout = process.stdout,
  sendRemote,
  sendRevInput,
  getViewMode,
  onSwitchView,
  peerAddress,
  connectedAt,
  onKick,
  onDisconnect,
}: HostTerminalOptions): () => void {
  let inputBuffer = "";
  let commandMode = false;

  const cmdCtx: CommandContext = {
    role: "host",
    peerAddress,
    connectedAt,
    sendCtrl: (msg: CtrlMsg) => {
      sendRemote?.(encodeCtrl(msg));
    },
    disconnect: () => {
      onDisconnect?.();
    },
    writeToStdout: (text: string) => {
      stdout.write(text);
    },
    viewMode: "local",
    switchView: () => {
      onSwitchView?.();
      cmdCtx.viewMode = getViewMode?.() ?? "local";
    },
  };

  const onInput = (chunk: string) => {
    for (const ch of chunk) {
      if (ch === "/") {
        commandMode = true;
        inputBuffer = "/";
        stdout.write("/");
        continue;
      }

      if (commandMode) {
        if (ch === "\r" || ch === "\n") {
          stdout.write("\r\n");
          cmdCtx.viewMode = getViewMode?.() ?? "local";
          const handled = handleCommand(inputBuffer, cmdCtx);
          if (handled) {
            inputBuffer = "";
            commandMode = false;
            continue;
          }
          const mode = getViewMode?.() ?? "local";
          if (mode === "remote") {
            sendRevInput?.(inputBuffer + "\r");
          } else {
            shell.write(inputBuffer + "\r");
          }
          inputBuffer = "";
          commandMode = false;
          continue;
        }

        if (ch === "\x7f" || ch === "\b") {
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            stdout.write("\b \b");
          }
          if (inputBuffer.length === 0) {
            commandMode = false;
          }
          continue;
        }

        if (ch === "\x03") {
          stdout.write("^C\r\n");
          inputBuffer = "";
          commandMode = false;
          continue;
        }

        if (ch >= " ") {
          inputBuffer += ch;
          stdout.write(ch);
        }
        continue;
      }

      const mode = getViewMode?.() ?? "local";
      if (mode === "remote") {
        sendRevInput?.(ch);
      } else {
        shell.write(ch);
      }
    }
  };

  const dataSubscription = shell.onData?.((data) => {
    const mode = getViewMode?.() ?? "local";
    if (mode === "local") {
      stdout.write(data);
    }
    sendRemote?.(data);
  });

  if (stdin.isTTY) {
    stdin.setRawMode?.(true);
  }
  stdin.setEncoding?.("utf8");
  stdin.resume();
  stdin.on("data", onInput);

  return () => {
    dataSubscription?.dispose();
    if (stdin.off) {
      stdin.off("data", onInput);
    } else {
      stdin.removeListener?.("data", onInput);
    }
    if (stdin.isTTY) {
      stdin.setRawMode?.(false);
    }
    stdin.pause();
  };
}
