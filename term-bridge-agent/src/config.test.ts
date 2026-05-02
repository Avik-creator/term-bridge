import assert from "node:assert/strict";
import test from "node:test";

import { getSignalingBase } from "./config";

test("uses the deployed signaling server by default", () => {
  assert.equal(getSignalingBase(), "https://term-bridge-worker.avikm744.workers.dev");
});

test("uses TERM_BRIDGE_SERVER when provided", () => {
  assert.equal(
    getSignalingBase({ TERM_BRIDGE_SERVER: "http://localhost:8787" }),
    "http://localhost:8787"
  );
});
