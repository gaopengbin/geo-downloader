#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageSource = path.join(root, "packages/geod-cli");
const release = require(path.join(packageSource, "lib/release.cjs"));
const { verifyPackage } = require(path.join(packageSource, "lib/verify-package.cjs"));
const portableRoot = path.join(root, `output/geod-cli-public-${release.version}`);
const portableName = `geod-cli-${release.version}-windows-x64`;
const portableDirectory = path.join(portableRoot, portableName);
const portableZip = path.join(portableRoot, `${portableName}.zip`);
const exampleNames = [
  "henan-boundary.json", "henan-overview.json", "henan-overview.openstyle.json",
  "luoyang-tourism.json", "sichuan-overview.json", "sichuan-overview.openstyle.json",
  "imagery-multizoom.json", "imagery-offline-package.json", "imagery-crop.json",
  "imagery-source-id.json",
];

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copy(source, destination) {
  if (!fs.lstatSync(source).isFile()) throw new Error(`Expected a regular file: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  ];
  const candidate = candidates.find((file) => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
  if (!candidate) throw new Error("Cannot locate npm-cli.js next to Node. Set npm_execpath to the full npm-cli.js path.");
  return path.resolve(candidate);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== "--out")) {
    throw new Error("Usage: node scripts/package-geod-cli-npm.mjs [--out output-directory]");
  }
  const output = argv.length ? path.resolve(argv[1]) : path.join(portableRoot, "npm");
  if (fs.existsSync(output)) throw new Error(`Output exists; choose a new --out directory: ${output}`);
  if (sha256(portableZip) !== release.portableZipSha256) throw new Error("Portable ZIP SHA256 does not match the frozen release.");
  const sourceExe = path.join(portableDirectory, "geod.exe");
  if (sha256(sourceExe) !== release.binarySha256) throw new Error("Portable geod.exe SHA256 does not match the frozen release.");
  const originalInfo = JSON.parse(fs.readFileSync(path.join(portableDirectory, "build-info.json"), "utf8"));
  for (const key of ["version", "platform", "sourceRevision", "binarySha256"]) {
    if (originalInfo[key] !== release[key]) throw new Error(`Portable build-info.json ${key} is not the frozen release.`);
  }
  const npm = npmCliPath();
  const stage = path.join(output, "package");
  const sourceFiles = [
    "package.json", "README.md", "LICENSE", "bin/geod.cjs",
    "lib/launcher.cjs", "lib/release.cjs", "lib/verify-package.cjs",
  ];
  for (const file of sourceFiles) copy(path.join(packageSource, file), path.join(stage, file));
  copy(sourceExe, path.join(stage, "native/geod.exe"));
  copy(path.join(portableDirectory, "build-info.json"), path.join(stage, "build-info.json"));
  // Explicit public documents only; do not copy repository directories, env files or caches.
  for (const name of ["geod-cli-0.3.md", "geod-cli-package-managers.md"]) {
    copy(path.join(root, "docs", name), path.join(stage, "docs", name));
  }
  for (const name of exampleNames) {
    copy(path.join(portableDirectory, "examples/geod-cli", name), path.join(stage, "examples/geod-cli", name));
  }
  const verification = verifyPackage(stage);
  const packed = spawnSync(process.execPath, [npm, "pack", "--json", "--offline", "--pack-destination", output], {
    cwd: stage, encoding: "utf8", shell: false, windowsHide: true,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
  });
  fs.writeFileSync(path.join(output, "npm-pack.log"), `${packed.stdout || ""}\n${packed.stderr || ""}`);
  if (packed.error || packed.status !== 0) throw new Error(`npm pack failed: ${packed.error?.message || packed.stderr}`);
  const packInfo = JSON.parse(packed.stdout);
  if (packInfo.length !== 1 || packInfo[0].name !== "geod-cli" || packInfo[0].version !== release.version) throw new Error("Unexpected npm pack metadata.");
  const allowed = new Set([
    ...sourceFiles, "native/geod.exe", "build-info.json",
    "docs/geod-cli-0.3.md", "docs/geod-cli-package-managers.md",
    ...exampleNames.map((name) => `examples/geod-cli/${name}`),
  ]);
  for (const file of packInfo[0].files) {
    if (!allowed.delete(file.path)) throw new Error(`Unexpected or duplicate npm tarball entry: ${file.path}`);
  }
  if (allowed.size) throw new Error(`Missing npm tarball entries: ${[...allowed].join(", ")}`);
  const tarball = path.join(output, packInfo[0].filename);
  const tarballSha256 = sha256(tarball);
  const sourceFileSha256 = Object.fromEntries(sourceFiles.map((file) => [file, sha256(path.join(packageSource, file))]));
  const packedFileSha256 = Object.fromEntries(packInfo[0].files.map((file) => [file.path, sha256(path.join(stage, file.path))]));
  const report = {
    ok: true, name: "geod-cli", version: release.version,
    packagedAt: new Date().toISOString(),
    ...verification,
    portableZip, tarball, tarballSha256, packageFiles: packInfo[0].files,
    sourceFileSha256, packedFileSha256, npmIntegrity: packInfo[0].integrity,
  };
  fs.writeFileSync(path.join(output, "npm-package-report.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(`${tarball}.sha256`, `${tarballSha256}  ${path.basename(tarball)}\n`);
  process.stdout.write(JSON.stringify({ ok: true, tarball, tarballSha256, files: packInfo[0].files.length, bytes: packInfo[0].size }) + "\n");
}

try { main(); } catch (error) {
  process.stderr.write(`GeoD npm packaging failed: ${error.message}\n`);
  process.exitCode = 1;
}
