import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, realpath, stat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(packageRoot, '../..');
const require = createRequire(import.meta.url);
let installedCliRoot;
try { installedCliRoot = path.dirname(require.resolve('geod-cli/package.json')); } catch { /* Source checkout may use its own release binary. */ }
const MAX_INLINE = 8 * 1024 * 1024;
const MCP_VERSION = '0.1.4';
const PUBLIC_SOURCE = {
  id: 'nasa_gibs_blue_marble', name: 'NASA GIBS Blue Marble', kind: 'builtIn',
  attribution: 'NASA GIBS', maxZoom: 8, available: true, default: false, reason: null,
};
const PUBLIC_SOURCE_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const fail = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, target) => { const relative = path.relative(root, target); return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const sha256 = data => createHash('sha256').update(data).digest('hex');

export class GeoDService {
  constructor(env = process.env) {
    this.workspace = path.resolve(env.GEOD_WORKSPACE || process.cwd());
    this.outputDir = path.resolve(env.GEOD_OUTPUT_DIR || path.join(this.workspace, 'output/geod-mcp'));
    this.bin = path.resolve(env.GEOD_BIN || [path.join(packageRoot, 'bin/geod.exe'), installedCliRoot && path.join(installedCliRoot, 'native/geod.exe'), path.join(repoRoot, 'target/release/geod.exe'), path.join(repoRoot, 'target/release/geod')].find(candidate => candidate && existsSync(candidate)) || path.join(packageRoot, 'bin/geod.exe'));
    this.maxJobs = Number(env.GEOD_MAX_CONCURRENT_JOBS || 2);
    if (!Number.isInteger(this.maxJobs) || this.maxJobs < 1 || this.maxJobs > 4) throw fail('CONFIG_ERROR', 'GEOD_MAX_CONCURRENT_JOBS must be 1..4');
    this.env = { ...process.env, ...env };
    this.jobs = new Map();
    this.closed = false;
    this.activeCalls = new Set();
    this.ready = this.initialize();
  }

  async initialize() {
    this.workspace = await realpath(this.workspace);
    await mkdir(this.outputDir, { recursive: true });
    this.outputDir = await realpath(this.outputDir);
    this.examples = [];
    for (const id of ['sichuan', 'henan']) {
      const filename = `${id}-overview.json`;
      const candidate = [path.join(packageRoot, 'examples', filename), installedCliRoot && path.join(installedCliRoot, 'examples', filename), path.join(repoRoot, 'examples/geod-cli', filename)].find(value => value && existsSync(value));
      if (candidate) {
        const request = JSON.parse(await readFile(candidate, 'utf8'));
        this.examples.push({ id, name: request.name, request });
      }
    }
  }

  async capabilities() {
    await this.ready;
    return { ok: true, name: 'GeoD MCP', version: MCP_VERSION, transport: this.env.GEOD_TRANSPORT || 'stdio', workspace: this.workspace, outputDir: this.outputDir,
      cli: { path: this.bin, available: existsSync(this.bin) },
      limits: { concurrentJobs: this.maxJobs, inlineArtifactBytes: MAX_INLINE, serializedMcpResponseBytes: 9_000_000, maxTiles: this.env.GEOD_PUBLIC_MCP === '1' ? 64 : 4096, maxPixels: this.env.GEOD_PUBLIC_MCP === '1' ? 4194304 : 67108864 },
      workflow: ['geod_sources list before choosing imagery', 'geod_plan', 'geod_fetch', 'geod_job_status until completed', 'geod_get_artifact for small files', ...(typeof this.artifactLink === 'function' ? ['geod_artifact_link for large downloads'] : [])],
      sources: { customRegistration: this.env.GEOD_PUBLIC_MCP !== '1', registry: this.env.GEOD_PUBLIC_MCP === '1' ? 'hosted allowlist' : 'current user GeoD CLI configuration' },
      behavior: { localPaths: 'workspace or configured output directory only', jobsSurviveClientTimeout: true, downloadsResumeAfterRestart: false, clipping: 'imagery.clipToLayer selects a polygon layer; PNG/GeoTIFF outside pixels become transparent; vectors unchanged' },
      examples: this.examples };
  }

  async scopedPath(input, roots = [this.workspace, this.outputDir]) {
    if (typeof input !== 'string' || !input || input.includes('\0')) throw fail('INVALID_PATH', 'A local path is required');
    const resolved = await realpath(path.resolve(this.workspace, input)).catch(() => { throw fail('NOT_FOUND', 'The requested local path does not exist'); });
    if (!roots.some(root => inside(root, resolved))) throw fail('PATH_OUTSIDE_WORKSPACE', 'Local paths must remain inside GEOD_WORKSPACE or GEOD_OUTPUT_DIR');
    return resolved;
  }

  async requestValue(request) {
    if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw fail('REQUEST_TOO_LARGE', 'Request exceeds 2 MiB');
    const value = structuredClone(request);
    if (this.env.GEOD_PUBLIC_MCP === '1') {
      if (value.imagery?.sourceId) {
        if (value.imagery.sourceId !== PUBLIC_SOURCE.id) throw fail('SOURCE_NOT_ALLOWED', 'Hosted accounts support NASA GIBS only; use local MCP or WebMCP for other sources');
        if (value.imagery.url || value.imagery.source || value.imagery.attribution) throw fail('INVALID_SOURCE', 'Use sourceId or url/source/attribution, not both');
        Object.assign(value.imagery, { url: PUBLIC_SOURCE_URL, source: PUBLIC_SOURCE.id, attribution: PUBLIC_SOURCE.attribution });
        delete value.imagery.sourceId;
      }
      if (value.imagery?.overlays?.length || value.imagery?.buildPyramid) throw fail('SOURCE_NOT_ALLOWED', 'Hosted accounts do not run overlay or pyramid jobs; use local MCP or WebMCP');
      value.limits = { maxTiles: 64, maxPixels: 4194304, timeoutSeconds: 180, ...value.limits };
      if (value.imagery) value.imagery.concurrency ??= 4;
      if (value.vector?.input || value.vector?.endpoint || (value.vector && !value.vector.url)) throw fail('SOURCE_NOT_ALLOWED', 'Hosted accounts use prepared GeoJSON URLs only');
      const allowed = (raw, host, pathname) => {
        try { const url = new URL(raw); return url.protocol === 'https:' && url.hostname === host && !url.port && !url.username && !url.password && !url.hash && pathname(url.pathname); }
        catch { return false; }
      };
      if (value.vector?.url && !allowed(value.vector.url, 'geo.datav.aliyun.com', path => /^\/areas_v3\/bound\/[0-9]{6}(?:_full)?\.json$/.test(path))) throw fail('SOURCE_NOT_ALLOWED', 'Hosted accounts support DataV administrative GeoJSON only');
      if (value.imagery?.url && !allowed(value.imagery.url, 'gibs.earthdata.nasa.gov', path => path.startsWith('/wmts/epsg3857/best/'))) throw fail('SOURCE_NOT_ALLOWED', 'Hosted accounts support NASA GIBS imagery only');
      if (value.limits.maxTiles > 64 || value.limits.maxPixels > 4194304 || value.limits.timeoutSeconds > 180 || (value.imagery?.concurrency ?? 1) > 4) throw fail('RESOURCE_LIMIT', 'Hosted accounts are limited to 64 tiles, 4M pixels, 180 seconds and 4 parallel tiles');
    }
    if (value.vector?.input) value.vector.input = await this.scopedPath(value.vector.input);
    return value;
  }

  async sources(input) {
    await this.ready;
    if (this.env.GEOD_PUBLIC_MCP === '1') {
      if (input.action !== 'list') throw fail('LOCAL_ONLY', 'Hosted MCP cannot register or probe arbitrary tile sources; use local MCP for custom sources');
      return { ok: true, defaultSourceId: null, sources: [PUBLIC_SOURCE] };
    }
    const args = [input.action];
    for (const [key, flag] of Object.entries({ id: '--id', name: '--name', url: '--url', attribution: '--attribution', maxZoom: '--max-zoom', scheme: '--scheme', zoom: '--zoom', x: '--x', y: '--y' })) {
      if (input[key] !== undefined) args.push(flag, String(input[key]));
    }
    if (input.subdomains?.length) args.push('--subdomains', input.subdomains.join(','));
    return this.run(this.bin, ['sources', ...args], { timeout: input.action === 'probe' ? 30_000 : 10_000 });
  }

  error(error) {
    let message = String(error?.message || error).slice(0, 3000);
    message = message.replace(/https?:\/\/[^\s"<>]+/g, raw => { try { const url = new URL(raw); url.username = ''; url.password = ''; if (url.search) url.search = '?[redacted]'; return url.href; } catch { return '[url]'; } });
    return { code: error?.code || 'GEOD_MCP_ERROR', message };
  }

  run(command, args, { signal, timeout = 210_000, progress, ipc = false } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(fail('CANCELLED', 'Operation cancelled'));
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    this.activeCalls.add(controller);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.workspace, env: this.env, windowsHide: true, shell: false, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stdoutBytes = 0, stderr = '', forced, hardKill, settled = false;
      const stop = error => {
        if (forced) return;
        forced = error;
        if (ipc && child.connected) {
          child.send({ type: 'geod:cancel' }, () => {});
          hardKill = setTimeout(() => child.kill(), 12_000);
        } else child.kill();
      };
      const abort = () => stop(fail('CANCELLED', 'Operation cancelled'));
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop(fail('TIMEOUT', `Operation exceeded ${Math.round(timeout / 1000)} seconds`)), timeout);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(hardKill);
        controller.signal.removeEventListener('abort', abort);
        signal?.removeEventListener('abort', relay);
        this.activeCalls.delete(controller);
        error ? reject(error) : resolve(value);
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > 8 * 1024 * 1024) stop(fail('OUTPUT_TOO_LARGE', 'Subprocess JSON exceeded 8 MiB'));
        else stdout += chunk;
      });
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-65536);
        const lines = stderr.split('\n'); stderr = lines.pop();
        for (const line of lines) {
          try {
            const raw = JSON.parse(line), item = {};
            for (const [key, value] of Object.entries(raw)) if (typeof value === 'number' || (typeof value === 'string' && ['phase', 'stage', 'event', 'status'].includes(key))) item[key] = typeof value === 'string' ? value.slice(0, 100) : value;
            if (Object.keys(item).length) progress?.(item);
          } catch { /* Human logs remain off the protocol and job result. */ }
        }
      });
      if (ipc) child.on('message', message => { if (message?.type === 'geod:render-progress') progress?.({ phase: String(message.phase || message.stage || 'rendering').slice(0, 100) }); });
      child.on('error', error => finish(fail('PROCESS_START_FAILED', `Cannot start ${path.basename(command)}: ${error.code || error.message}`)));
      child.on('close', code => {
        if (forced) return finish(forced);
        let value;
        try { value = JSON.parse(stdout); } catch { return finish(fail('INVALID_PROCESS_OUTPUT', `${path.basename(command)} did not return valid JSON (exit ${code})`)); }
        if (code !== 0 || value.ok === false) return finish(fail(value.error?.code || 'PROCESS_FAILED', value.error?.message || `Process exited ${code}`));
        finish(null, value);
      });
    });
  }

  async plan(request, { signal } = {}) {
    await this.ready;
    const value = await this.requestValue(request);
    const temp = await mkdtemp(path.join(this.outputDir, '.plan-'));
    try {
      const file = path.join(temp, 'request.json');
      await writeFile(file, JSON.stringify(value));
      return await this.run(this.bin, ['plan', '--request', file], { signal, timeout: 30_000 });
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  async inspect(bundleDir, { signal } = {}) {
    await this.ready;
    const bundle = await this.scopedPath(bundleDir);
    return this.run(this.bin, ['inspect', '--bundle', bundle], { signal, timeout: 30_000 });
  }

  snapshot(job) {
    return structuredClone({ ok: true, ...job.record, elapsedMs: Date.parse(job.record.finishedAt || new Date().toISOString()) - Date.parse(job.record.createdAt) });
  }

  async persist(job) {
    const data = JSON.stringify(job.record, null, 2);
    const temporary = path.join(job.dir, `.${randomUUID()}.tmp`);
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, path.join(job.dir, 'job.json'));
  }

  async startJob(kind, worker) {
    await this.ready;
    if (this.closed) throw fail('CANCELLED', 'Server is closing');
    if ([...this.jobs.values()].filter(job => !terminal(job.record.status)).length >= this.maxJobs) throw fail('BUSY', 'Concurrent job limit reached; wait for or cancel an active job');
    const jobId = randomUUID(), dir = path.join(this.outputDir, jobId);
    let finishJob;
    const job = { dir, controller: new AbortController(), done: new Promise(resolve => { finishJob = resolve; }), record: { jobId, kind, status: 'running', createdAt: new Date().toISOString(), progress: { phase: 'starting' }, artifacts: [] } };
    // Reserve the slot before the first await, including simultaneous tool calls.
    this.jobs.set(jobId, job);
    try { await mkdir(dir); await this.persist(job); }
    catch (error) { this.jobs.delete(jobId); finishJob(); throw error; }
    void (async () => {
      try {
        if (this.closed || job.controller.signal.aborted) throw fail('CANCELLED', 'Operation cancelled');
        const result = await worker(job);
        if (job.controller.signal.aborted) throw fail('CANCELLED', 'Operation cancelled');
        job.record.result = result; job.record.status = 'completed'; job.record.progress = { phase: 'completed' };
      } catch (error) {
        job.record.error = this.error(error);
        job.record.status = error.code === 'CANCELLED' ? 'cancelled' : 'failed';
        job.record.artifacts = [];
      } finally {
        job.record.finishedAt = new Date().toISOString();
        await this.persist(job).catch(error => { job.record.persistenceError = this.error(error); });
        finishJob();
      }
    })();
    return this.snapshot(job);
  }

  async addArtifact(job, id, file, mimeType) {
    const resolved = await this.scopedPath(file, [job.dir]);
    const bytes = (await stat(resolved)).size;
    // Hash streaming avoids loading analysis rasters into the MCP process.
    const { createReadStream } = await import('node:fs');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(resolved)) hash.update(chunk);
    job.record.artifacts.push({ id, name: path.basename(resolved), path: resolved, uri: `geod://artifacts/${job.record.jobId}/${id}`, mimeType, bytes, sha256: hash.digest('hex') });
  }

  async startFetch(request) {
    await this.ready;
    const value = await this.requestValue(request);
    // Business validation stays in geod-core and runs before accepting a job.
    await this.plan(value);
    return this.startJob('fetch', async job => {
      const requestPath = path.join(job.dir, 'request.json'), bundleDir = path.join(job.dir, 'bundle');
      await writeFile(requestPath, JSON.stringify(value, null, 2), { flag: 'wx' });
      const result = await this.run(this.bin, ['fetch', '--request', requestPath, '--out', bundleDir], { signal: job.controller.signal, timeout: ((value.limits?.timeoutSeconds || 180) + 60) * 1000, progress: update => { job.record.progress = update; } });
      await this.addArtifact(job, 'manifest', result.manifestPath, 'application/json');
      for (const asset of result.manifest.assets) await this.addArtifact(job, asset.id, path.join(bundleDir, asset.path), asset.mimeType);
      return result;
    });
  }

  async getJob(jobId) {
    await this.ready;
    if (!ID.test(jobId)) throw fail('INVALID_JOB_ID', 'Invalid job ID');
    if (this.jobs.has(jobId)) return this.jobs.get(jobId);
    const dir = await this.scopedPath(path.join(this.outputDir, jobId), [this.outputDir]);
    const file = await this.scopedPath(path.join(dir, 'job.json'), [dir]);
    if ((await stat(file)).size > 8 * 1024 * 1024) throw fail('INVALID_JOB', 'Stored job record too large');
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (record.jobId !== jobId || !Array.isArray(record.artifacts)) throw fail('INVALID_JOB', 'Stored job record is invalid');
    if (!terminal(record.status)) {
      record.status = 'failed'; record.finishedAt = new Date().toISOString(); record.artifacts = [];
      record.error = { code: 'INTERRUPTED', message: 'Server stopped before completion. Start a new job; partial downloads are not resumed.' };
    }
    const job = { dir, record };
    this.jobs.set(jobId, job);
    await this.persist(job);
    return job;
  }

  async jobStatus(jobId) { return this.snapshot(await this.getJob(jobId)); }

  async cancelJob(jobId) {
    const job = await this.getJob(jobId);
    if (!terminal(job.record.status)) {
      job.record.status = 'cancelling';
      job.controller.abort();
      job.record.progress = { phase: 'cancelling' };
    }
    return this.snapshot(job);
  }

  async readArtifact(jobId, artifactId) {
    const { artifact, file } = await this.artifactFile(jobId, artifactId);
    if (artifact.bytes > MAX_INLINE) throw fail('ARTIFACT_TOO_LARGE', this.env.GEOD_TRANSPORT === 'streamable-http'
      ? 'Artifact exceeds 8 MiB inline limit. Use geod_artifact_link to download it.'
      : `Artifact exceeds 8 MiB inline limit. Use its local path: ${file}`);
    const data = await readFile(file);
    if (data.length !== artifact.bytes || sha256(data) !== artifact.sha256) throw fail('ARTIFACT_CHANGED', 'Artifact bytes no longer match the completed job');
    return { artifact: structuredClone(artifact), data };
  }

  async artifactFile(jobId, artifactId) {
    if (!ID.test(artifactId)) throw fail('INVALID_ARTIFACT_ID', 'Invalid artifact ID');
    const job = await this.getJob(jobId);
    if (job.record.status !== 'completed') throw fail('JOB_NOT_COMPLETE', 'Artifacts are available after the job completes');
    const artifact = job.record.artifacts.find(item => item.id === artifactId);
    if (!artifact) throw fail('ARTIFACT_NOT_FOUND', 'Artifact ID is not registered for this job');
    const file = await this.scopedPath(artifact.path, [job.dir]);
    const size = (await stat(file)).size;
    if (size !== artifact.bytes) throw fail('ARTIFACT_CHANGED', 'Artifact size no longer matches the completed job');
    return { artifact: structuredClone(artifact), file };
  }

  async close() {
    this.closed = true;
    for (const controller of this.activeCalls) controller.abort();
    for (const job of this.jobs.values()) if (!terminal(job.record.status)) job.controller?.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
  }
}
