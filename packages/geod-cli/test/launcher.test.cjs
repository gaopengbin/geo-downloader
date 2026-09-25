"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { runGeod } = require("../lib/launcher.cjs");

function harness(options = {}) {
  const child = new EventEmitter();
  const processLike = new EventEmitter();
  const calls = [];
  const killed = [];
  const errors = [];
  child.kill = (signal) => { killed.push(signal); return true; };
  const pending = runGeod({
    packageRoot: path.resolve("fixture package with spaces"),
    platform: "win32", arch: "x64", nodeVersion: "18.20.8", argv: [],
    processLike,
    stderr: { write: (message) => errors.push(message) },
    spawnImpl: (...args) => { calls.push(args); return child; },
    ...options,
  });
  return { child, processLike, calls, killed, errors, pending };
}

test("spawns only the absolute bundled EXE with literal arguments and inherited streams", async () => {
  const argv = ["plan", "--request", "C:\\a folder\\request $(bad) & echo bad.json", "--name", "河南;whoami"];
  const h = harness({ argv });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], path.resolve("fixture package with spaces", "native/geod.exe"));
  assert.equal(h.calls[0][1], argv);
  assert.deepEqual(h.calls[0][2], { shell: false, stdio: "inherit", windowsHide: true });
  assert.equal("cwd" in h.calls[0][2], false);
  assert.equal("env" in h.calls[0][2], false);
  h.child.emit("close", 0, null);
  assert.equal(await h.pending, 0);
});

for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"], ["win32", "arm64"], ["win32", "ia32"]]) {
  test(`rejects unsupported ${platform}/${arch} before starting any executable`, async () => {
    const h = harness({ platform, arch });
    assert.equal(await h.pending, 1);
    assert.equal(h.calls.length, 0);
    assert.match(h.errors.join(""), /Windows x64 only/);
    assert.match(h.errors.join(""), new RegExp(`${platform}/${arch}`));
  });
}

test("rejects Node below 18 with an actionable message", async () => {
  const h = harness({ nodeVersion: "16.20.2" });
  assert.equal(await h.pending, 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.errors.join(""), /Node.js 18 or newer/);
});

for (const code of [0, 1, 42, 130]) {
  test(`preserves native exit code ${code} and removes signal handlers`, async () => {
    const h = harness();
    h.child.emit("close", code, null);
    assert.equal(await h.pending, code);
    assert.equal(h.processLike.listenerCount("SIGINT"), 0);
    assert.equal(h.processLike.listenerCount("SIGTERM"), 0);
  });
}

test("Windows Ctrl+C lets the native console handler finish with cancellation 130", async () => {
  const h = harness();
  h.processLike.emit("SIGINT");
  assert.deepEqual(h.killed, []);
  assert.equal(h.processLike.listenerCount("SIGINT"), 1);
  h.child.emit("close", 130, null);
  assert.equal(await h.pending, 130);
});

test("a signal-only termination is converted to the corresponding conventional exit code", async () => {
  const h = harness();
  h.child.emit("close", null, "SIGINT");
  assert.equal(await h.pending, 130);
});

test("termination requests are forwarded and listeners are cleaned up", async () => {
  const h = harness();
  h.processLike.emit("SIGTERM");
  assert.deepEqual(h.killed, ["SIGTERM"]);
  h.child.emit("close", null, "SIGTERM");
  assert.equal(await h.pending, 143);
  assert.equal(h.processLike.listenerCount("SIGTERM"), 0);
});

test("missing executable fails closed, with no replacement download or command lookup", async () => {
  const h = harness();
  h.child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
  h.child.emit("close", -4058, null);
  assert.equal(await h.pending, 127);
  assert.equal(h.calls.length, 1);
  assert.match(h.errors.join(""), /Reinstall geod-cli/);
  assert.equal(h.processLike.listenerCount("SIGINT"), 0);
});

test("synchronous spawn errors are visible and do not leave signal handlers", async () => {
  const h = harness({ spawnImpl: () => { throw new Error("denied"); } });
  assert.equal(await h.pending, 1);
  assert.match(h.errors.join(""), /denied/);
  assert.equal(h.processLike.listenerCount("SIGINT"), 0);
});
