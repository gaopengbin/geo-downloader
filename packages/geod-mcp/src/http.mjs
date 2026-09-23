import { createServer as createHttpServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { GeoDService } from './service.mjs';
import { createServer } from './server.mjs';

const hash = value => createHash('sha256').update(value).digest();

export async function createGeoDHttpServer(env = process.env) {
  const tokenFile = env.GEOD_MCP_TOKEN_FILE;
  if (!tokenFile) throw new Error('GEOD_MCP_TOKEN_FILE is required');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (token.length < 32 || /\s/.test(token)) throw new Error('GEOD_MCP_TOKEN_FILE must contain one random token of at least 32 characters');
  const expected = hash(token);
  const port = Number(env.GEOD_MCP_PORT || 9103);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GEOD_MCP_PORT must be 1024..65535');
  const publicHost = env.GEOD_MCP_PUBLIC_HOST || 'laogao.xyz';
  if (!/^[a-z0-9.-]+$/i.test(publicHost)) throw new Error('GEOD_MCP_PUBLIC_HOST is invalid');
  const allowedHosts = new Set([publicHost.toLowerCase(), `127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`https://${publicHost.toLowerCase()}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const service = new GeoDService({ ...env, GEOD_TRANSPORT: 'streamable-http' });
  await service.ready;
  if (!existsSync(service.bin)) throw new Error('GEOD_BIN is unavailable');
  const handler = createMcpHandler(() => createServer(service));
  const nodeHandler = toNodeHandler(handler);
  const server = createHttpServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'geod-mcp', cliAvailable: true }));
      return;
    }
    if (pathname !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.writeHead(404); res.end(); return;
    }
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase()) ||
        (req.headers.origin && !allowedOrigins.has(String(req.headers.origin).toLowerCase()))) {
      res.writeHead(403); res.end(); return;
    }
    const authorization = req.headers.authorization;
    const provided = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const valid = provided.length >= 32 && timingSafeEqual(hash(provided), expected);
    if (!valid) {
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="GeoD MCP"', 'cache-control': 'no-store' });
      res.end(); return;
    }
    void nodeHandler(req, res);
  });
  server.on('close', () => { void handler.close(); void service.close(); });
  return { server, service, port };
}
