import { createServer as createHttpServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { GeoDService } from './service.mjs';
import { createServer } from './server.mjs';
import { createOAuth } from './oauth.mjs';

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
  const signature = (userId, jobId, artifactId, expires) => createHmac('sha256', token).update(`${userId ? `${userId}\n` : ''}${jobId}\n${artifactId}\n${expires}`).digest('hex');
  service.artifactLink = async (jobId, artifactId) => {
    const { artifact } = await service.artifactFile(jobId, artifactId);
    const expires = Math.floor(Date.now() / 1000) + 600;
    const url = new URL(`https://${publicHost}/geod-mcp/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(artifactId)}`);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('sig', signature('', jobId, artifactId, expires));
    return { ok: true, url: url.href, expiresAt: new Date(expires * 1000).toISOString(), artifact: { id: artifact.id, name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256, mimeType: artifact.mimeType } };
  };
  const handler = createMcpHandler(() => createServer(service));
  const nodeHandler = toNodeHandler(handler);
  const oauth = env.GEOD_MCP_OAUTH_STATE_FILE ? await createOAuth({ file: env.GEOD_MCP_OAUTH_STATE_FILE, publicHost, accountApi: env.GEOD_ACCOUNT_API_URL }) : null;
  const userServices = new Map();
  const pendingUsers = new Map();
  let globalJobs = 0;
  const userEntry = userId => {
    if (!/^user-[a-f0-9-]{36}$/i.test(userId)) throw new Error('Invalid user ID');
    if (userServices.has(userId)) return Promise.resolve(userServices.get(userId));
    if (pendingUsers.has(userId)) return pendingUsers.get(userId);
    const pending = (async () => {
    const workspace = path.join(service.workspace, 'users', userId);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const userService = new GeoDService({ ...env, GEOD_WORKSPACE: workspace, GEOD_OUTPUT_DIR: path.join(workspace, 'jobs'), GEOD_MAX_CONCURRENT_JOBS: '1', GEOD_TRANSPORT: 'streamable-http', GEOD_PUBLIC_MCP: '1' });
    await userService.ready;
    const startJob = userService.startJob.bind(userService);
    userService.startJob = async (kind, worker) => {
      if (globalJobs >= 1) throw Object.assign(new Error('Hosted GeoD is busy; retry shortly'), { code: 'BUSY' });
      globalJobs++;
      try {
        await oauth.countJob(userId);
        const result = await startJob(kind, worker);
        userService.jobs.get(result.jobId).done.finally(() => { globalJobs--; });
        return result;
      } catch (cause) { globalJobs--; throw cause; }
    };
    userService.artifactLink = async (jobId, artifactId) => {
      const { artifact } = await userService.artifactFile(jobId, artifactId);
      const expires = Math.floor(Date.now() / 1000) + 600;
      const url = new URL(`https://${publicHost}/geod-mcp/artifacts/${userId}/${encodeURIComponent(jobId)}/${encodeURIComponent(artifactId)}`);
      url.searchParams.set('expires', String(expires));
      url.searchParams.set('sig', signature(userId, jobId, artifactId, expires));
      return { ok: true, url: url.href, expiresAt: new Date(expires * 1000).toISOString(), artifact: { id: artifact.id, name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256, mimeType: artifact.mimeType } };
    };
    const clientHandler = createMcpHandler(() => createServer(userService));
    const entry = { service: userService, handler: clientHandler, nodeHandler: toNodeHandler(clientHandler) };
    userServices.set(userId, entry);
    return entry;
    })();
    pendingUsers.set(userId, pending);
    void pending.finally(() => pendingUsers.delete(userId)).catch(() => {});
    return pending;
  };
  const server = createHttpServer((req, res) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = parsed.pathname;
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'geod-mcp', cliAvailable: true }));
      return;
    }
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase()) ||
        (req.headers.origin && !allowedOrigins.has(String(req.headers.origin).toLowerCase()))) {
      res.writeHead(403); res.end(); return;
    }
    if (oauth && (pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/'))) {
      void oauth.handle(req, res, parsed).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
      return;
    }
    const artifactMatch = /^\/artifacts\/(?:(?<user>user-[a-f0-9-]{36})\/)?(?<job>[a-zA-Z0-9_-]{1,160})\/(?<artifact>[a-zA-Z0-9_-]{1,160})$/.exec(pathname);
    if (!artifactMatch && (pathname !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method))) { res.writeHead(404); res.end(); return; }
    if (artifactMatch) {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const { user: userId = '', job: jobId, artifact: artifactId } = artifactMatch.groups;
      const expiresText = parsed.searchParams.get('expires') || '';
      const sig = parsed.searchParams.get('sig') || '';
      const expires = Number(expiresText);
      const now = Math.floor(Date.now() / 1000);
      const expectedSig = signature(userId, jobId, artifactId, expiresText);
      if (!/^\d{10}$/.test(expiresText) || expires <= now || expires > now + 600 || !/^[a-f0-9]{64}$/.test(sig) ||
          !timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return;
      }
      void (async () => {
        try {
          const targetService = userId ? (await userEntry(userId)).service : service;
          const { artifact, file } = await targetService.artifactFile(jobId, artifactId);
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(file)) digest.update(chunk);
          if (digest.digest('hex') !== artifact.sha256) { res.writeHead(409); res.end(); return; }
          const filename = String(artifact.name || artifact.id).replace(/[^a-zA-Z0-9._-]/g, '_');
          const mimeType = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(artifact.mimeType) ? artifact.mimeType : 'application/octet-stream';
          res.writeHead(200, { 'content-type': mimeType, 'content-length': artifact.bytes, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
          await pipeline(createReadStream(file), res);
        } catch { if (!res.headersSent) { res.writeHead(404); res.end(); } else res.destroy(); }
      })();
      return;
    }
    const authorization = req.headers.authorization;
    const provided = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const valid = provided.length >= 32 && timingSafeEqual(hash(provided), expected);
    const userId = valid ? null : oauth?.validate(provided);
    if (!valid && !userId) {
      const challenge = oauth ? `Bearer resource_metadata="${oauth.metadataUrl}", scope="geod:tools"` : 'Bearer realm="GeoD MCP"';
      res.writeHead(401, { 'www-authenticate': challenge, 'cache-control': 'no-store' });
      res.end(); return;
    }
    if (userId) void userEntry(userId).then(entry => entry.nodeHandler(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(503); res.end(); } });
    else void nodeHandler(req, res);
  });
  server.on('close', () => { void handler.close(); void service.close(); for (const entry of userServices.values()) { void entry.handler.close(); void entry.service.close(); } });
  return { server, service, port };
}
