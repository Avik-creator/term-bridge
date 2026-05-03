import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  encodeCtrl, decodeCtrl, isCtrlMsg,
  tabComplete, expandPath, handleCommand,
  type CommandContext, type CtrlMsg
} from "./commands.ts";

test("ctrl round-trip: all types", () => {
  const msgs: CtrlMsg[] = [
    { type: "transfer_start", filename: "f.txt", size: 100 },
    { type: "transfer_chunk", index: 0, data: "AQID" },
    { type: "transfer_end", filename: "f.txt" },
    { type: "rev_data", data: "output" },
    { type: "rev_input", data: "input" },
    { type: "rev_resize", cols: 80, rows: 24 },
    { type: "resize", cols: 120, rows: 40 },
    { type: "kick" },
    { type: "cmd_response", text: "ok" },
  ];
  for (const msg of msgs) {
    const enc = encodeCtrl(msg);
    assert.ok(isCtrlMsg(enc));
    assert.deepEqual(decodeCtrl(enc), msg);
  }
  assert.ok(!isCtrlMsg("normal text"));
  assert.ok(!isCtrlMsg("\x1b[31mansi\x1b[0m"));
  assert.equal(decodeCtrl("garbage"), null);
});

test("expandPath", () => {
  assert.equal(expandPath("~/x"), path.join(os.homedir(), "x"));
  assert.equal(expandPath("/tmp/f"), "/tmp/f");
  assert.ok(expandPath("./f").endsWith("/f"));
});

test("tab complete: single match", () => {
  const r = tabComplete("/transfer /tmp/tb-test-dir/al");
  assert.ok(r);
  assert.equal(r!.completed, "/transfer /tmp/tb-test-dir/alpha.txt");
  assert.equal(r!.matches, undefined);
});

test("tab complete: partial dir name completes with /", () => {
  const r = tabComplete("/transfer /tmp/tb-test-dir");
  assert.ok(r);
  assert.equal(r!.completed, "/transfer /tmp/tb-test-dir/");
});

test("tab complete: inside dir with single match", () => {
  const r = tabComplete("/transfer /tmp/tb-test-dir/b");
  assert.ok(r);
  assert.equal(r!.completed, "/transfer /tmp/tb-test-dir/beta.txt");
});

test("tab complete: no match → null", () => {
  assert.equal(tabComplete("/transfer /tmp/nonexistent-xyz"), null);
  assert.equal(tabComplete("/help"), null);
  assert.equal(tabComplete("/transfer "), null);
});

test("tab complete: unique file in /tmp", () => {
  const r = tabComplete("/transfer /tmp/tb-test-host");
  assert.ok(r);
  assert.equal(r!.completed, "/transfer /tmp/tb-test-host.txt");
});

test("/transfer invokes callback with expanded path", () => {
  const paths: string[] = [];
  const ctx: CommandContext = {
    role: "host",
    sendCtrl() {},
    disconnect() {},
    writeToStdout() {},
    viewMode: "local",
    switchView() {},
    transferFile: (p) => paths.push(p),
  };
  handleCommand("/transfer /tmp/tb-test-host.txt", ctx);
  assert.equal(paths[0], "/tmp/tb-test-host.txt");
});

test("/transfer with ~ expands home", () => {
  const paths: string[] = [];
  const ctx: CommandContext = {
    role: "host",
    sendCtrl() {},
    disconnect() {},
    writeToStdout() {},
    viewMode: "local",
    switchView() {},
    transferFile: (p) => paths.push(p),
  };
  handleCommand("/transfer ~/Documents", ctx);
  assert.equal(paths[0], path.join(os.homedir(), "Documents"));
});

test("/transfer no args → usage", () => {
  const out: string[] = [];
  const ctx: CommandContext = {
    role: "host",
    sendCtrl() {},
    disconnect() {},
    writeToStdout(t) { out.push(t); },
    viewMode: "local",
    switchView() {},
  };
  const handled = handleCommand("/transfer", ctx);
  assert.ok(handled);
  assert.ok(out.some(l => l.includes("Usage")));
});

test("/switch toggles view", () => {
  let mode = "local" as "local" | "remote";
  const out: string[] = [];
  const ctx: CommandContext = {
    role: "client",
    sendCtrl() {},
    disconnect() {},
    writeToStdout(t) { out.push(t); },
    viewMode: mode,
    switchView() {
      mode = mode === "local" ? "remote" : "local";
      ctx.viewMode = mode;
    },
  };
  handleCommand("/switch", ctx);
  assert.equal(mode, "remote");
  handleCommand("/switch", ctx);
  assert.equal(mode, "local");
});

test("full file transfer protocol: chunk + reassemble", () => {
  const content = "Line1\nLine2\nLine3 with special chars: \x1b[31mred\x1b[0m\n";
  const tmp = path.join(os.tmpdir(), "tb-proto-test.txt");
  fs.writeFileSync(tmp, content);

  const CHUNK = 8;
  const stat = fs.statSync(tmp);
  const fname = path.basename(tmp);

  const wire: string[] = [];
  wire.push(encodeCtrl({ type: "transfer_start", filename: fname, size: stat.size }));
  const buf = Buffer.alloc(CHUNK);
  const fd = fs.openSync(tmp, "r");
  let i = 0;
  while (true) {
    const n = fs.readSync(fd, buf, 0, CHUNK, i * CHUNK);
    if (n === 0) break;
    wire.push(encodeCtrl({ type: "transfer_chunk", index: i, data: buf.toString("base64", 0, n) }));
    i++;
  }
  fs.closeSync(fd);
  wire.push(encodeCtrl({ type: "transfer_end", filename: fname }));

  const chunks = new Map<number, string>();
  let rName = "", rSize = 0;
  for (const raw of wire) {
    const c = decodeCtrl(raw)!;
    if (c.type === "transfer_start") { rName = c.filename; rSize = c.size; }
    if (c.type === "transfer_chunk") chunks.set(c.index, c.data);
  }

  const out = path.join(os.tmpdir(), "tb-proto-recv.txt");
  const ofd = fs.openSync(out, "w");
  for (const idx of [...chunks.keys()].sort((a, b) => a - b)) {
    const b = Buffer.from(chunks.get(idx)!, "base64");
    fs.writeSync(ofd, b, 0, b.length, idx * CHUNK);
  }
  fs.closeSync(ofd);

  assert.equal(rName, fname);
  assert.equal(rSize, content.length);
  assert.equal(fs.readFileSync(out, "utf8"), content);
  fs.unlinkSync(tmp);
  fs.unlinkSync(out);
});

test("binary file transfer", () => {
  const buf = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) buf[i] = i;
  const tmp = path.join(os.tmpdir(), "tb-bin-test.bin");
  fs.writeFileSync(tmp, buf);

  const CHUNK = 32;
  const wire: string[] = [];
  wire.push(encodeCtrl({ type: "transfer_start", filename: "tb-bin-test.bin", size: 256 }));
  const rbuf = Buffer.alloc(CHUNK);
  const fd = fs.openSync(tmp, "r");
  let i = 0;
  while (true) {
    const n = fs.readSync(fd, rbuf, 0, CHUNK, i * CHUNK);
    if (n === 0) break;
    wire.push(encodeCtrl({ type: "transfer_chunk", index: i, data: rbuf.toString("base64", 0, n) }));
    i++;
  }
  fs.closeSync(fd);
  wire.push(encodeCtrl({ type: "transfer_end", filename: "tb-bin-test.bin" }));

  const chunks = new Map<number, string>();
  for (const raw of wire) {
    const c = decodeCtrl(raw)!;
    if (c.type === "transfer_chunk") chunks.set(c.index, c.data);
  }

  const out = path.join(os.tmpdir(), "tb-bin-recv.bin");
  const ofd = fs.openSync(out, "w");
  for (const idx of [...chunks.keys()].sort((a, b) => a - b)) {
    const b = Buffer.from(chunks.get(idx)!, "base64");
    fs.writeSync(ofd, b, 0, b.length, idx * CHUNK);
  }
  fs.closeSync(ofd);

  assert.deepEqual(fs.readFileSync(out), buf);
  fs.unlinkSync(tmp);
  fs.unlinkSync(out);
});
