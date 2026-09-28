#!/usr/bin/env node
import { install } from '../src/install.mjs';

const args = process.argv.slice(2);
if (args[0] !== 'install' || args.length > 2 || (args[1] && !['codex', 'workbuddy'].includes(args[1]))) {
  process.stderr.write('Usage: geod-agent install [codex|workbuddy]\n');
  process.exitCode = 2;
} else {
  try {
    const result = install({ client: args[1] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`GeoD Agent setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
