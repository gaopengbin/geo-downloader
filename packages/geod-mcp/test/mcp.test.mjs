import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(packageRoot, '..', '..');
const geodBin = path.resolve(process.env.GEOD_TEST_BIN ?? path.join(repoRoot, 'target', 'release', process.platform === 'win32' ? 'geod.exe' : 'geod'));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const color = [46, 112, 69];

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

// A valid deterministic 256x256 RGB PNG; no remote imagery or image library.
function fixturePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc(256 * (1 + 256 * 3));
  for (let y = 0; y < 256; y++) {
    const offset = y * (1 + 256 * 3) + 1;
    for (let x = 0; x < 256; x++) {
      for (let channel = 0; channel < 3; channel++) scanlines[offset + x * 3 + channel] = color[channel];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Independently decode 8-bit noninterlaced RGBA PNG and all five row filters.
// Reading the actual alpha avoids treating a four-channel declaration as proof.
function decodeRgbaPng(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let width, height;
  const data = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(bytes.subarray(offset + 4, offset + 8 + length)), `invalid PNG ${type} CRC`);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      assert.equal(body[8], 8); assert.equal(body[9], 6, 'clipped preview must carry RGBA');
      assert.equal(body[12], 0, 'test decoder expects noninterlaced PNG');
    }
    if (type === 'IDAT') data.push(body);
    offset += length + 12;
  }
  assert.equal(width, 256); assert.equal(height, 256);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  assert.equal(raw.length, height * (stride + 1));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, `unsupported PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

function pixelAt(image, lon, lat) {
  const latitude = lat * Math.PI / 180;
  const x = Math.floor((lon + 180) / 360 * 1024 - 512);
  const y = Math.floor((1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) * 512 - 256);
  return [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
}

async function fixtureService() {
  const png = fixturePng();
  const geojson = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{
    type: 'Feature', properties: { layer: 'boundary', name: 'Synthetic mainland with lake' },
    geometry: { type: 'Polygon', coordinates: [
      [[10, 10], [70, 10], [70, 50], [10, 50], [10, 10]],
      [[30, 20], [30, 35], [50, 35], [50, 20], [30, 20]],
    ] },
  }] }));
  const sockets = new Set();
  const state = { imageRequests: 0, vectorRequests: 0, hangingRequests: 0 };
  const server = createServer((request, response) => {
    if (request.url === '/hang/2/2/1.png') {
      state.hangingRequests += 1;
      return; // Deliberately hold the HTTP response open until cancellation.
    }
    if (request.url === '/2/2/1.png') {
      state.imageRequests += 1;
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      response.end(png);
    } else if (request.url === '/boundary.geojson') {
      state.vectorRequests += 1;
      response.writeHead(200, { 'content-type': 'application/geo+json', 'content-length': geojson.length });
      response.end(geojson);
    } else {
      response.writeHead(404); response.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`, state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function requestFor(baseUrl) {
  return {
    schemaVersion: '1.0', name: 'MCP protocol synthetic clipping fixture', bounds: [1, 1, 89, 65],
    imagery: {
      url: `${baseUrl}/{z}/{x}/{y}.png`, source: 'local-mcp-test-fixture', attribution: 'Synthetic pixels for automated tests only',
      zoom: 2, format: 'geotiff', concurrency: 1, clipToLayer: 'boundary',
    },
    vector: { url: `${baseUrl}/boundary.geojson`, source: 'local-mcp-test-fixture', attribution: 'Synthetic boundaries for automated tests only', layers: ['boundary'] },
    limits: { maxTiles: 1, maxPixels: 65536, timeoutSeconds: 30 },
  };
}

function structured(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', 'tools must provide structuredContent');
  const text = result.content.find((block) => block.type === 'text');
  assert.ok(text, 'tools must provide JSON text for clients without structured output');
  assert.deepEqual(JSON.parse(text.text), result.structuredContent, 'text and structuredContent must agree');
  return result.structuredContent;
}

async function expectRejected(invoke) {
  let result;
  try { result = await invoke(); } catch (error) {
    assert.ok(error instanceof Error);
    return;
  }
  assert.ok(result?.isError === true || result?.structuredContent?.ok === false, `expected a tool or protocol error, received ${JSON.stringify(result)}`);
}

async function waitForJob(client, jobId, expected = 'completed') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = structured(await client.callTool({ name: 'geod_job_status', arguments: { jobId } }));
    if (['completed', 'failed', 'cancelled'].includes(status.status)) {
      assert.equal(status.status, expected, JSON.stringify(status));
      return status;
    }
    assert.ok(['queued', 'running', 'cancelling'].includes(status.status), `unexpected job state ${status.status}`);
    await delay(100);
  }
  assert.fail(`job ${jobId} did not reach ${expected} within 30 seconds`);
}

function artifactNamed(job, filename) {
  assert.ok(Array.isArray(job.artifacts));
  const artifact = job.artifacts.find((item) => item.name === filename || path.basename(item.path ?? '') === filename);
  assert.ok(artifact, `missing ${filename}: ${JSON.stringify(job.artifacts)}`);
  assert.ok(path.isAbsolute(artifact.path), 'local artifact paths must be directly usable');
  assert.match(artifact.uri, /^geod:\/\/artifacts\/[^/]+\/[^/]+$/);
  assert.ok(Number.isInteger(artifact.bytes) && artifact.bytes > 0);
  return artifact;
}

test('official MCP v2 stdio client completes GeoD jobs and reads native artifacts', { timeout: 120_000 }, async (t) => {
  await access(geodBin);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'geod-mcp-protocol-'));
  const privateFile = path.join(workspace, 'not-an-artifact.txt');
  await writeFile(privateFile, 'A real file outside registered artifacts must never be exposed by resources/read.');
  const outsideWorkspace = await mkdtemp(path.join(os.tmpdir(), 'geod-mcp-outside-'));
  const outsideInput = path.join(outsideWorkspace, 'boundary.geojson');
  await writeFile(outsideInput, JSON.stringify({ type: 'FeatureCollection', features: [{
    type: 'Feature', properties: { layer: 'boundary' },
    geometry: { type: 'Polygon', coordinates: [[[10, 10], [70, 10], [70, 50], [10, 50], [10, 10]]] },
  }] }));
  const fixture = await fixtureService();
  const protocolErrors = [];
  const serverLogs = [];
  async function connectClient() {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(packageRoot, 'src', 'index.mjs')], cwd: packageRoot, stderr: 'pipe',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
        GEOD_WORKSPACE: workspace, GEOD_OUTPUT_DIR: path.join(workspace, 'output'), GEOD_BIN: geodBin,
      },
    });
    transport.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()));
    const connected = new Client({ name: 'geod-mcp-protocol-test', version: '1.0.0' });
    connected.onerror = (error) => protocolErrors.push(String(error));
    try { await connected.connect(transport); } catch (error) {
      await connected.close().catch(() => {});
      throw new Error(`MCP stdio connection failed: ${error.message}\n${serverLogs.join('')}`, { cause: error });
    }
    return connected;
  }
  let client;
  t.after(async () => {
    await client?.close().catch(() => {});
    await fixture.close();
    for (const [directory, prefix] of [[workspace, 'geod-mcp-protocol-'], [outsideWorkspace, 'geod-mcp-outside-']]) {
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith(prefix));
      await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  client = await connectClient();

  await t.test('tools/list and capabilities expose the promised callable interface', async () => {
    const list = await client.listTools();
    const names = list.tools.map((tool) => tool.name);
    for (const name of ['geod_capabilities', 'geod_plan', 'geod_fetch', 'geod_job_status', 'geod_cancel_job', 'geod_inspect', 'geod_get_artifact']) assert.ok(names.includes(name), `missing ${name}`);
    assert.ok(!names.includes('geod_render'));
    structured(await client.callTool({ name: 'geod_capabilities', arguments: {} }));
  });

  let completed;
  await t.test('plan performs no fetch and fetch returns an asynchronous job', async () => {
    const request = requestFor(fixture.url);
    const plan = structured(await client.callTool({ name: 'geod_plan', arguments: { request } }));
    assert.equal(plan.ok, true);
    assert.equal(fixture.state.imageRequests, 0);
    assert.equal(fixture.state.vectorRequests, 0);
    const start = Date.now();
    const job = structured(await client.callTool({ name: 'geod_fetch', arguments: { request } }));
    assert.ok(typeof job.jobId === 'string' && job.jobId);
    assert.ok(['queued', 'running'].includes(job.status), `fetch must return a pending job, received ${job.status}`);
    assert.ok(Date.now() - start < 5000, 'submission must return without waiting for data acquisition');
    completed = await waitForJob(client, job.jobId);
    assert.equal(fixture.state.imageRequests, 1);
    assert.equal(fixture.state.vectorRequests, 1);
    assert.ok(completed.result, 'completed job must retain its result');
  });

  await t.test('artifacts and resources preserve the verified manifest and transparent PNG', async () => {
    assert.ok(completed, 'successful acquisition is required');
    const manifestArtifact = artifactNamed(completed, 'manifest.json');
    const previewArtifact = artifactNamed(completed, 'imagery-preview.png');
    const jobId = completed.jobId;
    assert.equal(manifestArtifact.uri, `geod://artifacts/${jobId}/${manifestArtifact.id}`);
    const manifestTool = await client.callTool({ name: 'geod_get_artifact', arguments: { jobId, artifactId: manifestArtifact.id } });
    structured(manifestTool);
    assert.ok(manifestTool.content.some((item) => item.type === 'resource_link' && item.uri === manifestArtifact.uri), 'artifact tool must expose a native resource link');
    const manifestRead = await client.readResource({ uri: manifestArtifact.uri });
    const manifestContent = manifestRead.contents.find((item) => item.uri === manifestArtifact.uri);
    assert.ok(manifestContent);
    const manifestBytes = manifestContent.text !== undefined ? Buffer.from(manifestContent.text) : Buffer.from(manifestContent.blob, 'base64');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.kind, 'geod-bundle');
    assert.equal(manifest.quality.status, 'complete');
    assert.equal(manifest.quality.missingTiles, 0);
    assert.equal(manifest.layers.find((layer) => layer.id === 'boundary').featureCount, 1);
    assert.deepEqual(manifestBytes, await readFile(manifestArtifact.path));
    const inspection = structured(await client.callTool({ name: 'geod_inspect', arguments: { bundleDir: path.dirname(manifestArtifact.path) } }));
    assert.equal(inspection.ok, true);

    const previewTool = await client.callTool({ name: 'geod_get_artifact', arguments: { jobId, artifactId: previewArtifact.id } });
    structured(previewTool);
    const image = previewTool.content.find((item) => item.type === 'image');
    assert.ok(image, 'preview must be a native MCP image content block');
    assert.equal(image.mimeType, 'image/png');
    const png = Buffer.from(image.data, 'base64');
    const previewRead = await client.readResource({ uri: previewArtifact.uri });
    const blob = previewRead.contents.find((item) => item.uri === previewArtifact.uri);
    assert.equal(blob.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(blob.blob, 'base64'), png);
    assert.deepEqual(png, await readFile(previewArtifact.path));
    const declared = manifest.assets.find((asset) => asset.id === 'imagery-preview');
    assert.equal(createHash('sha256').update(png).digest('hex'), declared.sha256);
    assert.equal(png.length, declared.bytes);
    assert.equal(png.length, previewArtifact.bytes);
    const decoded = decodeRgbaPng(png);
    assert.deepEqual(pixelAt(decoded, 15, 15), [...color, 255], 'inside pixels must retain source imagery');
    assert.equal(pixelAt(decoded, 40, 28)[3], 0, 'polygon hole must remain transparent');
    assert.equal(pixelAt(decoded, 80, 15)[3], 0, 'outside province polygon must be transparent');
  });

  await t.test('unknown identifiers and resource traversal never expose filesystem files', async () => {
    assert.ok(completed);
    await expectRejected(() => client.callTool({ name: 'geod_job_status', arguments: { jobId: 'missing-job' } }));
    await expectRejected(() => client.callTool({ name: 'geod_job_status', arguments: { jobId: '../escape' } }));
    await expectRejected(() => client.callTool({ name: 'geod_get_artifact', arguments: { jobId: completed.jobId, artifactId: 'missing-asset' } }));
    await expectRejected(() => client.callTool({ name: 'geod_get_artifact', arguments: { jobId: completed.jobId, artifactId: '../../outside.txt' } }));
    for (const uri of [
      `geod://artifacts/${completed.jobId}/../../outside.txt`,
      `geod://artifacts/${completed.jobId}/%2e%2e%2foutside.txt`,
      'geod://artifacts/missing-job/manifest',
      pathToFileURL(privateFile).href,
    ]) await assert.rejects(client.readResource({ uri }), `must reject unsafe or unregistered resource ${uri}`);

    const request = requestFor(fixture.url);
    delete request.vector.url;
    request.vector.input = outsideInput;
    for (const name of ['geod_plan', 'geod_fetch']) {
      const rejection = await client.callTool({ name, arguments: { request } });
      assert.equal(rejection.isError, true);
      assert.equal(rejection.structuredContent.error.code, 'PATH_OUTSIDE_WORKSPACE', 'existing GeoJSON outside the configured roots must be rejected before CLI execution');
    }
  });

  let staleRunning;
  await t.test('a running HTTP job can be cancelled without publishing completed artifacts', async () => {
    const request = requestFor(fixture.url);
    delete request.vector;
    delete request.imagery.clipToLayer;
    request.imagery.url = `${fixture.url}/hang/{z}/{x}/{y}.png`;
    const job = structured(await client.callTool({ name: 'geod_fetch', arguments: { request } }));
    const deadline = Date.now() + 10_000;
    while (!fixture.state.hangingRequests && Date.now() < deadline) await delay(50);
    assert.equal(fixture.state.hangingRequests, 1, 'cancellation must interrupt a real in-flight HTTP request');
    const recordPath = path.join(workspace, 'output', job.jobId, 'job.json');
    staleRunning = { jobId: job.jobId, path: recordPath, bytes: await readFile(recordPath) };
    assert.equal(JSON.parse(staleRunning.bytes).status, 'running');
    const cancelled = structured(await client.callTool({ name: 'geod_cancel_job', arguments: { jobId: job.jobId } }));
    assert.ok(['cancelled', 'cancelling', 'running'].includes(cancelled.status));
    const final = await waitForJob(client, job.jobId, 'cancelled');
    assert.equal(final.artifacts?.length ?? 0, 0, 'cancelled downloads must not expose completed artifacts');
  });

  await t.test('a new stdio process restores completed artifacts and marks interrupted work failed', async () => {
    assert.ok(completed);
    assert.ok(staleRunning);
    await client.close();
    // Restore the real in-flight record after stopping its child cleanly: this
    // models crash residue without leaving an orphan downloader in the test.
    await writeFile(staleRunning.path, staleRunning.bytes);
    client = await connectClient();
    const restored = structured(await client.callTool({ name: 'geod_job_status', arguments: { jobId: completed.jobId } }));
    assert.equal(restored.status, 'completed');
    assert.deepEqual(restored.result, completed.result);
    assert.deepEqual(restored.artifacts, completed.artifacts);
    const previewArtifact = artifactNamed(restored, 'imagery-preview.png');
    const toolResult = await client.callTool({ name: 'geod_get_artifact', arguments: { jobId: restored.jobId, artifactId: previewArtifact.id } });
    structured(toolResult);
    const image = toolResult.content.find((block) => block.type === 'image');
    assert.ok(image, 'a restarted server must still return native images');
    assert.deepEqual(Buffer.from(image.data, 'base64'), await readFile(previewArtifact.path));
    const manifestArtifact = artifactNamed(restored, 'manifest.json');
    const resource = await client.readResource({ uri: manifestArtifact.uri });
    assert.equal(resource.contents[0].text, await readFile(manifestArtifact.path, 'utf8'));

    const interrupted = structured(await client.callTool({ name: 'geod_job_status', arguments: { jobId: staleRunning.jobId } }));
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error.code, 'INTERRUPTED');
    assert.deepEqual(interrupted.artifacts, []);
    const persisted = JSON.parse(await readFile(staleRunning.path, 'utf8'));
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.error.code, 'INTERRUPTED');
    assert.equal(fixture.state.hangingRequests, 1, 'interrupted downloads must not silently resume');
  });

  await t.test('download and error logs do not corrupt MCP stdout', async () => {
    await client.listTools();
    assert.deepEqual(protocolErrors, [], `stdio transport received nonprotocol output: ${protocolErrors.join('\n')}`);
  });
});

test('legacy 2025-11-25 clients negotiate and call tools over raw JSON-RPC stdio', { timeout: 20_000 }, async (t) => {
  await access(geodBin);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'geod-mcp-legacy-'));
  const child = spawn(process.execPath, [path.join(packageRoot, 'src', 'index.mjs')], {
    cwd: packageRoot, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env, GEOD_WORKSPACE: workspace, GEOD_OUTPUT_DIR: path.join(workspace, 'output'),
      GEOD_BIN: geodBin,
    },
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const protocolErrors = [];
  let stderr = '', sequence = 0, transportError;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  function failPending(error) {
    transportError = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  child.on('error', failPending);
  child.stdin.on('error', failPending);
  const closed = new Promise((resolve) => child.once('close', (code) => {
    if (pending.size) failPending(new Error(`Legacy MCP process exited ${code}: ${stderr}`));
    resolve(code);
  }));
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0', 'stdout must contain only JSON-RPC messages');
      if (Object.hasOwn(message, 'id')) {
        const waiter = pending.get(message.id);
        assert.ok(waiter, `unexpected response ID ${message.id}`);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`));
        else waiter.resolve(message.result);
      } else assert.equal(typeof message.method, 'string', 'unidentified JSON-RPC messages must be notifications');
    } catch (error) {
      protocolErrors.push(String(error));
      failPending(error);
    }
  });
  function request(method, params = {}) {
    if (transportError) return Promise.reject(transportError);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Legacy ${method} timed out: ${stderr}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  t.after(async () => {
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill(), 3000);
    await closed;
    clearTimeout(killTimer);
    lines.close();
    const resolved = path.resolve(workspace);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('geod-mcp-legacy-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'geod-legacy-test', version: '1.0.0' },
  });
  assert.equal(initialized.protocolVersion, '2025-11-25', 'server must negotiate the explicitly requested stable protocol');
  assert.ok(initialized.capabilities.tools);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await request('tools/list');
  assert.ok(listed.tools.some((tool) => tool.name === 'geod_capabilities'));
  assert.ok(listed.tools.some((tool) => tool.name === 'geod_fetch'));
  const capabilities = structured(await request('tools/call', { name: 'geod_capabilities', arguments: {} }));
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.transport, 'stdio');
  assert.deepEqual(protocolErrors, []);
});
