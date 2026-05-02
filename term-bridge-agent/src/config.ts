const DEFAULT_SIGNALING_BASE = "https://term-bridge-worker.avikm744.workers.dev";

export function getSignalingBase(
  env: Pick<NodeJS.ProcessEnv, "TERM_BRIDGE_SERVER"> = process.env
): string {
  return env.TERM_BRIDGE_SERVER ?? DEFAULT_SIGNALING_BASE;
}
