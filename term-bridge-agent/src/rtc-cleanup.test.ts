import assert from "node:assert/strict";
import test from "node:test";

import { closeRtcResources } from "./rtc-cleanup";

test("closes data channel and peer connection", () => {
  const calls: string[] = [];

  closeRtcResources({
    dataChannel: {
      isOpen: () => true,
      close: () => calls.push("dc"),
    },
    peerConnection: {
      close: () => calls.push("pc"),
    },
  });

  assert.deepEqual(calls, ["dc", "pc"]);
});

test("still closes peer connection when data channel is already closed", () => {
  const calls: string[] = [];

  closeRtcResources({
    dataChannel: {
      isOpen: () => false,
      close: () => calls.push("dc"),
    },
    peerConnection: {
      close: () => calls.push("pc"),
    },
  });

  assert.deepEqual(calls, ["pc"]);
});

test("runs native WebRTC cleanup after closing resources", () => {
  const calls: string[] = [];

  closeRtcResources({
    peerConnection: {
      close: () => calls.push("pc"),
    },
    cleanup: () => calls.push("cleanup"),
  });

  assert.deepEqual(calls, ["pc", "cleanup"]);
});
