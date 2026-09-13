"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const metadata = require("../package.json");
const release = require("../lib/release.cjs");
const { verifyPackage } = require("../lib/verify-package.cjs");

test("package restricts platforms, includes its binary and has no install hooks or runtime dependencies", () => {
  assert.deepEqual(metadata.os, ["win32"]);
  assert.deepEqual(metadata.cpu, ["x64"]);
  assert.deepEqual(metadata.bin, { geod: "bin/geod.cjs" });
  assert.equal(metadata.engines.node, ">=18");
  assert.ok(metadata.files.includes("native/geod.exe"));
  assert.equal(metadata.scripts.prepack, "node lib/verify-package.cjs");
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) assert.equal(metadata[key], undefined);
  for (const key of ["preinstall", "install", "postinstall"]) assert.equal(metadata.scripts[key], undefined);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geod-cli-integrity-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("geod-cli-integrity-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, "native"));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(directory, "build-info.json"), JSON.stringify({ name: "geod-cli", ...release }));
  return directory;
}

test("packing source without the verified binary fails closed", (t) => {
  assert.throws(() => verifyPackage(fixture(t)), /ENOENT/);
});

test("packing a substituted executable fails the frozen SHA256 check", (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "native/geod.exe"), "not the released executable");
  assert.throws(() => verifyPackage(directory), /SHA256 does not match/);
});

test("changing npm version or adding an install hook cannot silently bypass release checks", (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ ...metadata, version: "0.1.2" }));
  assert.throws(() => verifyPackage(directory), /metadata does not match/);
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ ...metadata, scripts: { ...metadata.scripts, postinstall: "curl bad" } }));
  assert.throws(() => verifyPackage(directory), /installation hooks/);
});
