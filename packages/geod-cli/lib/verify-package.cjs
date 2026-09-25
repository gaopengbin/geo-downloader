"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const release = require("./release.cjs");

function verifyPackage(packageRoot) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== "geod-cli" || metadata.version !== release.version) {
    throw new Error("npm metadata does not match the frozen GeoD release.");
  }
  if (JSON.stringify(metadata.os) !== '["win32"]' || JSON.stringify(metadata.cpu) !== '["x64"]') {
    throw new Error("GeoD npm packages must be limited to Windows x64.");
  }
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (Object.keys(metadata[key] || {}).length) throw new Error("GeoD npm must have zero runtime dependencies.");
  }
  for (const key of ["preinstall", "install", "postinstall"]) {
    if (metadata.scripts?.[key]) throw new Error("GeoD npm must not run installation hooks.");
  }
  const binary = fs.readFileSync(path.join(packageRoot, "native", "geod.exe"));
  const binarySha256 = createHash("sha256").update(binary).digest("hex");
  if (binarySha256 !== release.binarySha256) throw new Error("Bundled geod.exe SHA256 does not match the frozen release.");
  const info = JSON.parse(fs.readFileSync(path.join(packageRoot, "build-info.json"), "utf8"));
  for (const key of ["version", "platform", "sourceRevision", "binarySha256"]) {
    if (info[key] !== release[key]) throw new Error(`build-info.json ${key} does not match the frozen release.`);
  }
  if (info.name !== "geod-cli") throw new Error("Unexpected build-info.json name.");
  return { ...release, binaryBytes: binary.length };
}

if (require.main === module) {
  try {
    verifyPackage(path.resolve(__dirname, ".."));
  } catch (error) {
    process.stderr.write(`GeoD package verification failed: ${error.message}\nBuild with: node scripts/package-geod-cli-npm.mjs\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyPackage };
