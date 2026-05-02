import chalk from "chalk";
import { hostname } from "os";

export function printBanner(): void {
  console.clear();
  console.log(chalk.green("●") + " " + chalk.bold("Term Bridge agent running"));
  console.log(chalk.gray("Machine:"), chalk.white(hostname()));
}

export function printCode(code: string): void {
  const formatted = `${code.slice(0, 3)}-${code.slice(3)}`;
  console.log(chalk.gray("Code:   "), chalk.bold.cyan(formatted));
  console.log(chalk.gray("Waiting for connections..."));
  console.log();
  console.log(
    chalk.gray("  Peer runs: ") +
      chalk.bold.white(`term-bridge connect ${formatted}`)
  );
  console.log();
}

export function printConnecting(code: string): void {
  console.log(chalk.cyan("→") + " Connecting to " + chalk.bold(code) + "...");
}

export function printConnected(peerAddress: string): void {
  console.log(
    chalk.green("✓") + " Peer connected " + chalk.gray(`(${peerAddress})`)
  );
  console.log(chalk.gray("Session active — terminal shared"));
  console.log(chalk.dim("  Type /help for commands, Ctrl+C to force quit."));
}

export function printDisconnected(): void {
  console.log();
  console.log(chalk.yellow("⚡") + " Peer disconnected. Session ended.");
}
