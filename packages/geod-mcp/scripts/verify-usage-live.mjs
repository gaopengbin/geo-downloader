// Real CLI + stdio/HTTP MCP executions against a public DataV boundary.
// OAuth/account fixtures and all observations are isolated, explicitly test data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createGeoDHttpServer } from '../src/http.mjs';
import { configureUsage } from '../src/usage-client.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const output = path.join(root, 'artifacts', `tools-usage-live-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const bin = process.env.GEOD_TEST_BIN || path.join(root, 'target', 'debug', process.platform === 'win32' ? 'geod.exe' : 'geod');
const accountId = `user-${randomUUID()}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
const probe = createServer(); const port = await listen(probe); await new Promise(resolve => probe.close(resolve));
const home = path.join(output, 'cli-home'); await mkdir(home);
const usageDir = path.join(output, 'usage');
let slowStarted = false;
const fixtures = createServer((req, res) => {
  if (req.url === '/api/account') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ user: { id: accountId } })); }
  else if (req.url === '/slow') { slowStarted = true; req.on('close', () => res.destroy()); }
  else { res.writeHead(404); res.end('Synthetic missing source'); }
});
const fixturePort = await listen(fixtures);
const tokenFile = path.join(output, 'owner-token'); await writeFile(tokenFile, randomBytes(32).toString('hex'));
const hosted = await createGeoDHttpServer({ GEOD_MCP_TOKEN_FILE: tokenFile, GEOD_MCP_OAUTH_STATE_FILE: path.join(output, 'oauth-state.json'),
  GEOD_MCP_PORT: String(port), GEOD_ACCOUNT_API_URL: `http://127.0.0.1:${fixturePort}/api/account`,
  GEOD_WORKSPACE: output, GEOD_BIN: bin, GEOD_USAGE_DIR: usageDir, GEOD_USAGE_TEST: '1', GEOD_CLI_HOME: path.join(output, 'hosted-cli-home') });
await new Promise(resolve => hosted.server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, GEOD_CLI_HOME: home, GEOD_USAGE_ENDPOINT: `${base}/usage`, GEOD_USAGE_TEST: '1', GEOD_TELEMETRY: '1' };
const receipt = { output, startedAt: new Date().toISOString(), mode: 'local production-code services; test account fixture; real public DataV downloads', checks: {} };
let stdio, http, killed;

function launch(args, overrides = {}) {
  const child = spawn(bin, args, { cwd: output, env: { ...env, ...overrides }, windowsHide: true, shell: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr = (stderr + b).slice(-12000); });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => {
    let value; try { value = JSON.parse(stdout); } catch { value = null; }
    resolve({ code, value, stderr });
  }); });
  return { child, done };
}
async function cli(args, overrides) { return launch(args, overrides).done; }
async function post(url, data, headers = {}, form = false) {
  return fetch(url, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(data) : JSON.stringify(data) });
}
async function events() {
  await hosted.usage.flush();
  return (await Promise.all((await readdir(usageDir)).filter(n => n.endsWith('.jsonl')).map(n => readFile(path.join(usageDir, n), 'utf8'))))
    .flatMap(s => s.trim().split('\n').filter(Boolean).map(JSON.parse));
}
async function fetchMcp(client, request) {
  assert.equal((await client.callTool({ name: 'geod_plan', arguments: { request } })).structuredContent.ok, true);
  const started = (await client.callTool({ name: 'geod_fetch', arguments: { request } })).structuredContent;
  assert.ok(started.jobId, JSON.stringify(started));
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const job = (await client.callTool({ name: 'geod_job_status', arguments: { jobId: started.jobId } })).structuredContent;
    if (job.status === 'completed') {
      assert.equal(job.result.manifest.quality.status, 'complete');
      assert.ok(job.artifacts.some(a => a.mimeType === 'application/geo+json' || a.id !== 'manifest'));
      return { jobId: job.jobId, artifacts: job.artifacts.length, manifest: job.manifestPath };
    }
    assert.ok(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job.error));
    await delay(400);
  }
  throw new Error('Real MCP job timed out');
}

try {
  // Exercise the real PKCE exchange and distinguish its refresh from a new grant.
  const registration = await (await post(`${base}/oauth/register`, { client_name: 'GeoD telemetry test', geod_product: 'mcp', redirect_uris: ['http://127.0.0.1:49152/callback'] })).json();
  const verifier = randomBytes(32).toString('base64url'), resource = 'https://laogao.xyz/geod-mcp/mcp';
  const authorization = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries({ client_id: registration.client_id, redirect_uri: 'http://127.0.0.1:49152/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource, state: 'isolated-test', scope: 'geod:tools' })) authorization.searchParams.set(k, v);
  const page = await fetch(authorization).then(r => r.text());
  const transaction = page.match(/const tx="([^"]+)"/)[1];
  const approved = await (await post(`${base}/oauth/approve`, { transaction }, { cookie: `geostyle_session=${'a'.repeat(43)}`, origin: base })).json();
  const code = new URL(approved.redirect).searchParams.get('code');
  const grant = await (await post(`${base}/oauth/token`, { grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: 'http://127.0.0.1:49152/callback', code, code_verifier: verifier, resource }, {}, true)).json();
  assert.ok(grant.access_token);
  const refreshed = await (await post(`${base}/oauth/token`, { grant_type: 'refresh_token', client_id: registration.client_id, refresh_token: grant.refresh_token, resource }, {}, true)).json();
  assert.ok(refreshed.access_token);
  await writeFile(path.join(home, 'account.json'), JSON.stringify({ clientId: registration.client_id, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token, expiresAt: Date.now() / 1000 + 3600 }));
  await writeFile(path.join(output, 'accounts.json'), JSON.stringify({ users: [{ id: accountId, email: 'isolated-tools-test@example.invalid', isTestAccount: true }] }));
  const request = JSON.parse(await readFile(path.join(root, 'examples/geod-cli/henan-boundary.json'), 'utf8'));
  const requestFile = path.join(output, 'request.json'); await writeFile(requestFile, JSON.stringify(request));
  const downloaded = await cli(['fetch', '--request', requestFile, '--out', path.join(output, 'cli-boundary')]);
  assert.equal(downloaded.code, 0, JSON.stringify(downloaded.value));
  assert.equal(downloaded.value.manifest.quality.status, 'complete');
  const inspected = await cli(['inspect', '--bundle', path.join(output, 'cli-boundary')]); assert.equal(inspected.code, 0);
  receipt.checks.cli = { quality: downloaded.value.manifest.quality.status, artifacts: downloaded.value.manifest.assets.length, inspected: true };
  console.log('CLI public boundary downloaded and verified.');

  stdio = new Client({ name: 'geod-usage-live-test', version: '1.0.0' });
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'packages/geod-mcp/src/index.mjs')], cwd: output,
    env: { ...env, GEOD_BIN: bin, GEOD_WORKSPACE: output, GEOD_OUTPUT_DIR: path.join(output, 'stdio-jobs') }, stderr: 'pipe' }));
  await stdio.listTools();
  receipt.checks.stdio = await fetchMcp(stdio, request);
  await stdio.close(); stdio = null;
  console.log('Local stdio MCP boundary downloaded and verified.');

  http = new Client({ name: 'geod-usage-http-test', version: '1.0.0' });
  await http.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token}` } } }));
  await http.listTools();
  receipt.checks.http = await fetchMcp(http, request);
  console.log('OAuth HTTP MCP boundary downloaded and verified.');

  const failureFile = path.join(output, 'failure.json');
  await writeFile(failureFile, JSON.stringify({ ...request, vector: { ...request.vector, url: `http://127.0.0.1:${fixturePort}/missing` } }));
  const failed = await cli(['fetch', '--request', failureFile, '--out', path.join(output, 'failed-boundary')]);
  assert.notEqual(failed.code, 0); receipt.checks.realCliFailure = { code: failed.code, errorCode: failed.value?.error?.code };
  const slowFile = path.join(output, 'slow.json');
  await writeFile(slowFile, JSON.stringify({ ...request, vector: { ...request.vector, url: `http://127.0.0.1:${fixturePort}/slow` } }));
  killed = launch(['fetch', '--request', slowFile, '--out', path.join(output, 'interrupted-boundary')]);
  for (let n = 0; n < 100 && !slowStarted; n++) await delay(50);
  assert.equal(slowStarted, true);
  await delay(250); killed.child.kill('SIGKILL'); await killed.done; killed = null;
  // An unrelated successful command drains any durable started event after the crash.
  await cli(['inspect', '--bundle', path.join(output, 'cli-boundary')]);
  receipt.checks.killedCli = 'started only; expected unknown outcome';

  // Collector unavailable: the same real inspect succeeds and keeps observations pending.
  const offline = await cli(['inspect', '--bundle', path.join(output, 'cli-boundary')], { GEOD_USAGE_ENDPOINT: `http://127.0.0.1:${fixturePort}/unavailable` });
  assert.equal(offline.code, 0);
  assert.ok((await readdir(path.join(home, 'usage-outbox'))).length > 0);
  await cli(['inspect', '--bundle', path.join(output, 'cli-boundary')]);
  await delay(300);
  const rows = await events();
  const starts = rows.filter(e => e.kind === 'download' && e.state === 'started');
  assert.equal(starts.length, 5, '3 CLI attempts + 1 stdio + 1 HTTP; no child CLI duplicates');
  assert.equal(rows.filter(e => e.kind === 'download' && e.state === 'completed').length, 3);
  assert.equal(rows.filter(e => e.kind === 'download' && e.state === 'failed').length, 1);
  assert.equal(rows.filter(e => e.kind === 'authorization' && e.operation === 'login').length, 1);
  assert.equal(rows.filter(e => e.kind === 'authorization' && e.operation === 'refresh').length, 1);
  assert.ok(rows.every(e => e.isTest));
  assert.ok(rows.every(e => e.operation !== 'tools/list'));
  assert.ok(!JSON.stringify(rows).includes('areas_v3'));
  receipt.checks.observations = { records: rows.length, authorizations: 1, refreshes: 1, downloadStarts: 5, completed: 3, failed: 1, withoutTerminal: 1, allMarkedTest: true, childCliDuplicates: 0, noParametersRecorded: true };
  receipt.checks.collectorUnavailable = 'operation succeeded; outbox replayed';
  const rejectedBeforeFetch = await cli(['fetch', '--request', path.join(output, 'not-present.json'), '--out', path.join(output, 'not-started')]);
  assert.notEqual(rejectedBeforeFetch.code, 0);
  assert.equal((await events()).filter(e => e.kind === 'download' && e.state === 'started').length, 5, 'validation rejection must not invent a download');
  const beforeConsentTest = (await events()).length;
  const disabled = await cli(['inspect', '--bundle', path.join(output, 'cli-boundary')], { GEOD_TELEMETRY: undefined });
  assert.equal(disabled.code, 0); assert.equal((await events()).length, beforeConsentTest);
  assert.equal((await cli(['telemetry', 'enable'], { GEOD_TELEMETRY: undefined })).value.enabled, true);
  assert.equal((await configureUsage('status', { GEOD_CLI_HOME: home })).enabled, true);
  assert.equal((await cli(['telemetry', 'disable'], { GEOD_TELEMETRY: undefined })).value.enabled, false);
  assert.equal((await configureUsage('status', { GEOD_CLI_HOME: home })).enabled, false);
  receipt.checks.consent = 'native CLI and MCP share status; disabled reporting sends no events';
  receipt.checks.preflight = 'invalid request recorded as tool failure, no invented download';
  receipt.checks.observations.records = (await events()).length;
  receipt.finishedAt = new Date().toISOString(); receipt.passed = true;
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.passed = false; receipt.error = error.message;
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.error(JSON.stringify({ output, error: error.message })); process.exitCode = 1;
} finally {
  killed?.child.kill(); await stdio?.close(); await http?.close();
  await new Promise(resolve => hosted.server.close(resolve)); await hosted.service.close(); await hosted.usage.flush();
  fixtures.closeAllConnections(); await new Promise(resolve => fixtures.close(resolve));
}
