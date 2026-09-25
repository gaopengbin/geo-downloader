#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { runGeod } = require("../lib/launcher.cjs");

runGeod({ packageRoot: path.resolve(__dirname, "..") }).then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`GeoD could not start: ${error.message}\n`);
  process.exitCode = 1;
});
