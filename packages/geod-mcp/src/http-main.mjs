#!/usr/bin/env node
import { createGeoDHttpServer } from './http.mjs';

try {
  const { server, port } = await createGeoDHttpServer();
  server.listen(port, '127.0.0.1', () => process.stderr.write(`GeoD MCP listening on 127.0.0.1:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
} catch (error) {
  process.stderr.write(`GeoD MCP startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
