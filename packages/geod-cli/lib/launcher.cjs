"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { constants } = require("node:os");

function signalExitCode(signal) {
  return 128 + (constants.signals[signal] || 1);
}

/** Run the bundled binary without a shell or changing the caller's working directory. */
function runGeod({
  packageRoot,
  argv = process.argv.slice(2),
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  spawnImpl = spawn,
  processLike = process,
  stderr = process.stderr,
} = {}) {
  if (platform !== "win32" || arch !== "x64") {
    stderr.write(`GeoD CLI 0.1.1 supports Windows x64 only; received ${platform}/${arch}. No binary was downloaded.\n`);
    return Promise.resolve(1);
  }
  if (Number.parseInt(nodeVersion, 10) < 18) {
    stderr.write(`GeoD CLI requires Node.js 18 or newer; received ${nodeVersion}.\n`);
    return Promise.resolve(1);
  }
  const executable = path.resolve(packageRoot, "native", "geod.exe");

  return new Promise((resolve) => {
    let child;
    let finished = false;
    let requestedSignal;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      processLike.removeListener("SIGINT", onInterrupt);
      processLike.removeListener("SIGTERM", onTerminate);
      resolve(code);
    };
    const forwardSignal = (signal) => {
      requestedSignal = signal;
      // Windows broadcasts Ctrl+C to this console's native child as well.
      // child.kill('SIGINT') would force TerminateProcess and bypass GeoD's 130 response.
      if (platform === "win32" && signal === "SIGINT") return;
      try {
        child.kill(signal);
      } catch (error) {
        stderr.write(`GeoD could not forward ${signal}: ${error.message}\n`);
      }
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");
    const onError = (error) => {
      stderr.write(error.code === "ENOENT"
        ? "GeoD's bundled executable is missing. Reinstall geod-cli; this package never downloads a replacement at runtime.\n"
        : `GeoD could not start: ${error.message}\n`);
      finish(error.code === "ENOENT" ? 127 : 1);
    };

    try {
      child = spawnImpl(executable, argv, {
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      });
    } catch (error) {
      onError(error);
      return;
    }
    processLike.on("SIGINT", onInterrupt);
    processLike.on("SIGTERM", onTerminate);
    child.once("error", onError);
    child.once("close", (code, signal) => {
      finish(Number.isInteger(code) ? code : signalExitCode(signal || requestedSignal));
    });
  });
}

module.exports = { runGeod };
