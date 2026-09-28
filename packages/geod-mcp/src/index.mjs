#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { GeoDService } from './service.mjs';
import { createServer } from './server.mjs';

let service, handle, stopping;
async function close() {
  if (stopping) return stopping;
  stopping = (async () => { await service?.close(); await handle?.close(); })();
  return stopping;
}
try {
  service = new GeoDService();
  await service.ready;
  handle = serveStdio(() => createServer(service), { onerror: error => process.stderr.write(`${JSON.stringify({ error: service.error(error) })}\n`) });
  process.stdin.once('end', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: service?.error(error) || { code: 'STARTUP_ERROR', message: error.message } })}\n`);
  process.exitCode = 1;
  await close();
}
