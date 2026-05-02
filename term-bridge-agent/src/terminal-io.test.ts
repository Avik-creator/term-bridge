import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";

import { attachHostTerminal } from "./terminal-io";

class FakeStdin extends EventEmitter {
  isTTY = true;
  rawMode = false;
  resumed = false;
  paused = false;

  setRawMode(value: boolean): void {
    this.rawMode = value;
  }

  setEncoding(_encoding: BufferEncoding): void {}

  resume(): this {
    this.resumed = true;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

test("host stdin writes into the PTY", () => {
  const stdin = new FakeStdin();
  const written: string[] = [];
  const cleanup = attachHostTerminal({
    shell: { write: (chunk) => written.push(chunk) },
    stdin,
  });

  stdin.emit("data", "pwd\r");

  assert.deepEqual(written, ["pwd\r"]);
  assert.equal(stdin.rawMode, true);
  assert.equal(stdin.resumed, true);

  cleanup();
  assert.equal(stdin.rawMode, false);
  assert.equal(stdin.paused, true);
});

test("host PTY output is mirrored locally and remotely", () => {
  let onShellData: ((data: string) => void) | undefined;
  const remoteOutput: string[] = [];
  const localOutput: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      localOutput.push(chunk.toString());
      callback();
    },
  });

  attachHostTerminal({
    shell: {
      write: () => {},
      onData: (handler) => {
        onShellData = handler;
      },
    },
    stdin: new FakeStdin(),
    stdout,
    sendRemote: (data) => remoteOutput.push(data),
  });

  onShellData?.("hello\r\n");

  assert.deepEqual(localOutput, ["hello\r\n"]);
  assert.deepEqual(remoteOutput, ["hello\r\n"]);
});

test("in remote viewMode stdin goes to sendRevInput instead of shell", () => {
  const stdin = new FakeStdin();
  const written: string[] = [];
  const revInput: string[] = [];

  attachHostTerminal({
    shell: { write: (chunk) => written.push(chunk) },
    stdin,
    getViewMode: () => "remote",
    sendRevInput: (data) => revInput.push(data),
  });

  stdin.emit("data", "ls\r");

  assert.deepEqual(written, []);
  assert.deepEqual(revInput, ["ls\r"]);
});

test("in remote viewMode shell output is sent remotely but not displayed locally", () => {
  let onShellData: ((data: string) => void) | undefined;
  const remoteOutput: string[] = [];
  const localOutput: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      localOutput.push(chunk.toString());
      callback();
    },
  });

  attachHostTerminal({
    shell: {
      write: () => {},
      onData: (handler) => {
        onShellData = handler;
      },
    },
    stdin: new FakeStdin(),
    stdout,
    sendRemote: (data) => remoteOutput.push(data),
    getViewMode: () => "remote",
  });

  onShellData?.("hello\r\n");

  assert.deepEqual(localOutput, []);
  assert.deepEqual(remoteOutput, ["hello\r\n"]);
});
