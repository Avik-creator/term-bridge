#!/usr/bin/env node
import "dotenv/config";
import { createSession } from "./session";
import { startPtyBridge } from "./pty";
import { connectClient } from "./client";
import { printBanner, printCode, printConnecting, printConnected, printDisconnected } from "./ui";

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === "connect" && args[1]) {
    const code = args[1];
    printConnecting(code);
    await connectClient(code);
    return;
  }

  printBanner();
  const { code, sessionId, signalingUrl } = await createSession();
  printCode(code);
  await startPtyBridge({
    sessionId,
    signalingUrl,
    onConnected: (peerAddress) => printConnected(peerAddress),
    onDisconnected: () => {
      printDisconnected();
      process.exit(0);
    },
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
