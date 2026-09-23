import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Script } from 'node:vm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGeoDHttpServer } from '../src/http.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const bin = path.join(root, 'target', 'release', process.platform === 'win32' ? 'geod.exe' : 'geod');
const post = (url, value, form = false, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(value) : JSON.stringify(value) });

test('separate account OAuth uses PKCE, resource binding and isolated MCP workspace', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'geod-oauth-'));
  const owner = randomBytes(32).toString('hex');
  await writeFile(path.join(folder, 'owner'), owner);
  const legacyToken = randomBytes(32).toString('base64url');
  await writeFile(path.join(folder, 'oauth.json'), JSON.stringify({ access: { [createHash('sha256').update(legacyToken).digest('hex')]: { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resource: 'https://laogao.xyz/geod-mcp/mcp', expires: Math.floor(Date.now() / 1000) + 3600 } } }));
  const account = createServer(async (req, res) => {
    const validSession = req.headers.cookie === 'geostyle_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    if (req.url === '/api/account' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: validSession ? { id: 'user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : null }));
      return;
    }
    if (req.url === '/api/account/login' && req.method === 'POST' && req.headers.origin === 'http://127.0.0.1:19474') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'geostyle_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; Path=/; HttpOnly; SameSite=Lax' });
      res.end(JSON.stringify({ user: { id: 'user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }));
      return;
    }
    if (req.url === '/api/account/verification' && req.method === 'POST') {
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ challengeId: 'challenge-1' })); return;
    }
    if (req.url === '/api/account/verification' && req.method === 'PUT') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'geostyle_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; Path=/; HttpOnly; SameSite=Lax' });
      res.end(JSON.stringify({ user: { id: 'user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })); return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise(resolve => account.listen(19474, '127.0.0.1', resolve));
  const { server, service } = await createGeoDHttpServer({ GEOD_MCP_TOKEN_FILE: path.join(folder, 'owner'), GEOD_MCP_OAUTH_STATE_FILE: path.join(folder, 'oauth.json'), GEOD_ACCOUNT_API_URL: 'http://127.0.0.1:19474/api/account', GEOD_MCP_PORT: '19475', GEOD_WORKSPACE: folder, GEOD_BIN: bin, GEOD_RENDER_ENABLED: '0' });
  await new Promise(resolve => server.listen(19475, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:19475';
  let client;
  try {
    const unauth = await fetch(`${base}/mcp`, { method: 'POST' });
    assert.equal(unauth.status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${legacyToken}` } })).status, 401);
    assert.match(unauth.headers.get('www-authenticate'), /oauth-protected-resource/);
    const resourceDoc = await fetch(`${base}/.well-known/oauth-protected-resource/geod-mcp/mcp`).then(r => r.json());
    assert.equal(resourceDoc.resource, 'https://laogao.xyz/geod-mcp/mcp');
    const issuerDoc = await fetch(`${base}/.well-known/oauth-authorization-server/geod-mcp`).then(r => r.json());
    assert.equal(issuerDoc.issuer, 'https://laogao.xyz/geod-mcp');
    const nativeRegistration = await post(`${base}/oauth/register`, { client_name: 'Native Agent', redirect_uris: ['marvis://oauth/callback'], application_type: 'native', token_endpoint_auth_method: 'none' });
    assert.equal(nativeRegistration.status, 201);
    assert.deepEqual((await nativeRegistration.json()).redirect_uris, ['marvis://oauth/callback']);
    const unsafeRegistration = await post(`${base}/oauth/register`, { redirect_uris: ['javascript:alert(1)'] });
    assert.equal(unsafeRegistration.status, 400);
    assert.equal((await unsafeRegistration.json()).error, 'invalid_redirect_uri');
    const registration = await post(`${base}/oauth/register`, { client_name: 'OAuth test', redirect_uris: ['http://127.0.0.1:49152/callback'] });
    assert.equal(registration.status, 201);
    const { client_id: clientId } = await registration.json();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorization = new URL(`${base}/oauth/authorize`);
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: 'http://127.0.0.1:49152/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, resource: resourceDoc.resource, state: 'test-state', scope: 'geod:tools' })) authorization.searchParams.set(key, value);
    const page = await fetch(authorization);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html, /platform-api|platform_token/);
    assert.match(html, /注册密码为 8–128 个字符/);
    assert.match(html, /该邮箱已注册，请返回登录/);
    assert.doesNotMatch(html, /Unable to verify this identity/);
    new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    const transaction = html.match(/const tx="([^"]+)"/)[1];
    const rejected = await post(`${base}/oauth/approve`, { transaction }, false, { origin: 'http://127.0.0.1:19475' });
    assert.equal(rejected.status, 401);
    const login = await post(`${base}/oauth/account/login`, { email: 'owner@example.com', password: 'sample-password-123' }, false, { origin: 'http://127.0.0.1:19475' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /Path=\/geod-mcp\/oauth\//);
    const verificationRequest = await post(`${base}/oauth/account/verification`, { channel: 'email', target: 'new@example.com', purpose: 'register' }, false, { origin: 'http://127.0.0.1:19475' });
    assert.equal(verificationRequest.status, 202);
    assert.equal((await verificationRequest.json()).challengeId, 'challenge-1');
    const verified = await fetch(`${base}/oauth/account/verification`, { method: 'PUT', headers: { origin: 'http://127.0.0.1:19475', 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'email', target: 'new@example.com', purpose: 'register', challengeId: 'challenge-1', code: '123456', password: 'sample-password-123' }) });
    assert.equal(verified.status, 200);
    assert.match(verified.headers.get('set-cookie'), /Path=\/geod-mcp\/oauth\//);
    const approved = await post(`${base}/oauth/approve`, { transaction }, false, { origin: 'http://127.0.0.1:19475', cookie: login.headers.get('set-cookie').split(';')[0] });
    assert.equal(approved.status, 200);
    const code = new URL((await approved.json()).redirect).searchParams.get('code');
    const bad = await post(`${base}/oauth/token`, { grant_type: 'authorization_code', client_id: clientId, redirect_uri: 'http://127.0.0.1:49152/callback', code, code_verifier: 'wrong', resource: resourceDoc.resource }, true);
    assert.equal(bad.status, 400);
    const grant = await post(`${base}/oauth/token`, { grant_type: 'authorization_code', client_id: clientId, redirect_uri: 'http://127.0.0.1:49152/callback', code, code_verifier: verifier, resource: resourceDoc.resource }, true);
    assert.equal(grant.status, 200);
    const token = (await grant.json()).access_token;
    assert.equal((await post(`${base}/oauth/token`, { grant_type: 'authorization_code', client_id: clientId, redirect_uri: 'http://127.0.0.1:49152/callback', code, code_verifier: verifier, resource: resourceDoc.resource }, true)).status, 400);
    client = new Client({ name: 'oauth-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const result = (await client.callTool({ name: 'geod_capabilities', arguments: {} })).structuredContent;
    assert.equal(result.cli.available, true);
    assert.match(result.workspace, /users[\\/]user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
    const blocked = (await client.callTool({ name: 'geod_plan', arguments: { request: { schemaVersion: '1.0', name: 'blocked', bounds: [110, 30, 111, 31], vector: { url: 'http://127.0.0.1:19474/secret' } } } })).structuredContent;
    assert.equal(blocked.error.code, 'SOURCE_NOT_ALLOWED');
  } finally {
    await client?.close();
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await new Promise(resolve => account.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
