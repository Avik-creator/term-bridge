/**
 * session.ts
 * Registers a new session with the Cloudflare Workers signaling server.
 * Returns the 6-digit pairing code + a WebSocket URL to wait for the peer.
 */

import { hostname } from "os";
import { getSignalingBase } from "./config";

export interface SessionInfo {
  code: string;
  sessionId: string;
  signalingUrl: string;
}

export async function createSession(): Promise<SessionInfo> {
  const signalingBase = getSignalingBase();
  const res = await fetch(`${signalingBase}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine: hostname() }),
  });

  if (!res.ok) {
    throw new Error(`Signaling server error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { code: string; sessionId: string };

  const wsUrl = new URL(`/session/${data.sessionId}/ws`, signalingBase);
  wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
  wsUrl.searchParams.set("role", "host");

  return {
    code: data.code,
    sessionId: data.sessionId,
    signalingUrl: wsUrl.toString(),
  };
}
