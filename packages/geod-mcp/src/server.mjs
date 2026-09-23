import { McpServer, ProtocolError, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { toolSchemas } from './schemas.mjs';

const ARTIFACT_URI_TEMPLATE = 'geod://artifacts/{jobId}/{artifactId}';
const NATIVE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Leave framing/envelope headroom below the SDK's default 10 MB stdio buffer.
const MAX_SERIALIZED_RESPONSE_BYTES = 9_000_000;

function withinWireLimit(result, localPath) {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SERIALIZED_RESPONSE_BYTES) {
    throw Object.assign(new Error(localPath
      ? `Artifact exceeds the 9 MB serialized response limit after encoding. Use its local path: ${localPath}`
      : 'GeoD result exceeds the 9 MB serialized response limit. Inspect a smaller result or read individual artifacts using their local paths.'),
    { code: localPath ? 'ARTIFACT_TOO_LARGE' : 'RESPONSE_TOO_LARGE' });
  }
  return result;
}

function publicError(error) {
  const candidate = error && typeof error === 'object' ? error : {};
  const code = candidate.name === 'AbortError' ? 'CANCELLED'
    : typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate.code) ? candidate.code : 'GEOD_ERROR';
  const raw = typeof candidate.message === 'string' ? candidate.message : typeof error === 'string' ? error : 'GeoD could not complete this operation.';
  const message = raw.split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 600) || 'GeoD could not complete this operation.';
  return { code, message };
}

function jsonResult(value) {
  const text = JSON.stringify(value);
  const structuredContent = JSON.parse(text);
  if (!structuredContent || typeof structuredContent !== 'object' || Array.isArray(structuredContent)) throw new Error('GeoD service returned an invalid result object.');
  return withinWireLimit({ content: [{ type: 'text', text }], structuredContent });
}

async function safely(operation, errorDetails = publicError) {
  try { return await operation(); }
  catch (error) { return { ...jsonResult({ error: errorDetails(error) }), isError: true }; }
}

function resourceError(error, uri, errorDetails = publicError) {
  const safe = errorDetails(error);
  if (safe.code.includes('NOT_FOUND') || safe.code === 'ENOENT') return new ResourceNotFoundError(uri, `${safe.code}: ${safe.message}`);
  return new ProtocolError(-32603, `${safe.code}: ${safe.message}`, { code: safe.code });
}

function isText(mimeType) {
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase();
  return mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json') || mime === 'application/xml' || mime.endsWith('+xml');
}

function artifactPayload(value, jobId, artifactId) {
  // readArtifact enforces the configured payload limit (8 MiB by default) and
  // confinement to registered artifacts. This adapter never reads arbitrary paths.
  if (!value || !Buffer.isBuffer(value.data) || !value.artifact) throw new Error('GeoD service returned an invalid artifact.');
  const { artifact, data } = value;
  const uri = `geod://artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(artifactId)}`;
  if (artifact.id !== artifactId || artifact.uri !== uri || artifact.bytes !== data.byteLength || typeof artifact.mimeType !== 'string') throw new Error('GeoD artifact metadata does not match its data.');
  return { artifact, data, uri, mimeType: artifact.mimeType };
}

/**
 * Build the transport-independent GeoD MCP server.
 *
 * The injected service owns subprocesses, job persistence, cancellation, local
 * output paths, and read-size limits. Fetch and render only enqueue work here.
 */
export function createServer(service) {
  for (const name of ['capabilities', 'plan', 'startFetch', 'jobStatus', 'cancelJob', 'inspect', 'readArtifact']) {
    if (typeof service?.[name] !== 'function') throw new TypeError(`GeoD service is missing ${name}().`);
  }
  const safeError = error => {
    // The service knows configured credentials and URL-redaction rules. Apply
    // them to foreground tools/resources as well as background job failures.
    try { return publicError(typeof service.error === 'function' ? service.error(error) : error); }
    catch { return { code: 'GEOD_ERROR', message: 'GeoD could not complete this operation.' }; }
  };
  const server = new McpServer({ name: 'geod-mcp', version: '0.1.1' }, {
    instructions: 'GeoD downloads real geographic imagery through the GeoD CLI. Start with geod_capabilities and geod_plan. geod_fetch returns a background job ID; poll geod_job_status, then read the verified imagery preview or other artifact with geod_get_artifact. Always inspect source, coverage, quality and warnings. Province overviews should use a permitted imagery source and bounded requests.',
  });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const createJob = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const register = (name, title, description, inputSchema, annotations, operation) => {
    server.registerTool(name, { title, description, inputSchema, annotations }, (args, ctx) => safely(async () => jsonResult(await operation(args, ctx)), safeError));
  };

  register('geod_capabilities', 'GeoD capabilities',
    'Inspect available GeoD CLI download commands, size limits and example requests before starting work.',
    toolSchemas.capabilities, readOnly, () => service.capabilities());

  register('geod_plan', 'Plan a GeoD acquisition',
    'Validate a parameterized GeoD request and estimate tile count, pixels and actual footprint without downloading data. Keep imagery zoom appropriate for the requested output scale.',
    toolSchemas.plan, readOnly, ({ request }, ctx) => service.plan(request, { signal: ctx.mcpReq.signal }));

  register('geod_fetch', 'Fetch geographic data',
    'Start a bounded download/import job for imagery and/or vectors. Returns jobId and status immediately. Poll geod_job_status for the bundle and artifact list; quality may be partial when allowMissing is enabled.',
    toolSchemas.fetch, createJob, ({ request }) => service.startFetch(request));

  register('geod_job_status', 'Read GeoD job status',
    'Get a job status, result and registered artifact metadata. Completed artifacts have geod:// URIs for geod_get_artifact or resources/read.',
    toolSchemas.jobStatus, readOnly, ({ jobId }) => service.jobStatus(jobId));

  register('geod_cancel_job', 'Cancel a GeoD job',
    'Cancel a queued or running acquisition/render job. Repeated cancellation is safe; already completed artifacts remain available according to the service retention policy.',
    toolSchemas.cancelJob, { ...readOnly, readOnlyHint: false }, ({ jobId }) => service.cancelJob(jobId));

  register('geod_inspect', 'Inspect a GeoD bundle',
    'Inspect and validate an existing local GeoD bundle, including manifest, file integrity, layer profiles, provenance and quality.',
    toolSchemas.inspect, readOnly, ({ bundleDir }, ctx) => service.inspect(bundleDir, { signal: ctx.mcpReq.signal }));

  server.registerTool('geod_get_artifact', {
    title: 'Read a GeoD artifact',
    description: 'Read a registered job artifact within the configured inline size limit (default 8 MiB). PNG/JPEG/WebP/GIF return a native image; GeoJSON/JSON/text return their UTF-8 contents. Every result includes original metadata and a resource link. Large artifacts and GeoTIFF are intended for local processing using the job artifact path.',
    inputSchema: toolSchemas.getArtifact,
    annotations: readOnly,
  }, ({ jobId, artifactId }) => safely(async () => {
    const { artifact, data, uri, mimeType } = artifactPayload(await service.readArtifact(jobId, artifactId), jobId, artifactId);
    const result = jsonResult({ artifact });
    result.content.push({ type: 'resource_link', uri, name: artifact.name ?? artifact.id, mimeType, size: data.byteLength });
    if (NATIVE_IMAGE_MIMES.has(mimeType.toLowerCase())) result.content.push({ type: 'image', data: data.toString('base64'), mimeType });
    else if (isText(mimeType)) result.content.push({ type: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(data) });
    return withinWireLimit(result, artifact.path);
  }, safeError));

  if (typeof service.artifactLink === 'function') register('geod_artifact_link', 'Download a GeoD artifact',
    'Create a signed HTTPS download URL for a completed registered artifact, including files too large for inline MCP reads. The link expires in ten minutes; share it only with the intended recipient.',
    toolSchemas.getArtifact, readOnly, ({ jobId, artifactId }) => service.artifactLink(jobId, artifactId));

  // SDK v2 registers dynamic resources via registerResource + ResourceTemplate.
  // Artifacts are discovered through completed job results rather than an
  // unbounded global resources/list enumeration.
  server.registerResource('geod-artifact', new ResourceTemplate(ARTIFACT_URI_TEMPLATE, { list: undefined }), {
    title: 'GeoD job artifact',
    description: 'Original verified job artifact bytes, subject to the configured inline read limit. Discover artifact URIs in geod_job_status.',
  }, async (uri, variables) => {
    try {
      const parsed = toolSchemas.getArtifact.parse({ jobId: variables.jobId, artifactId: variables.artifactId });
      const payload = artifactPayload(await service.readArtifact(parsed.jobId, parsed.artifactId), parsed.jobId, parsed.artifactId);
      return withinWireLimit({ contents: [{ uri: payload.uri, mimeType: payload.mimeType, ...(isText(payload.mimeType)
        ? { text: new TextDecoder('utf-8', { fatal: true }).decode(payload.data) }
        : { blob: payload.data.toString('base64') }) }] }, payload.artifact.path);
    } catch (error) { throw resourceError(error, uri.href, safeError); }
  });

  for (const [id, title] of [['sichuan', 'Sichuan map request'], ['henan', 'Henan map request']]) {
    server.registerResource(`geod-example-${id}`, `geod://examples/${id}`, {
      title,
      description: 'Reusable GeoD request example. Review data sources, bounds and resource limits before calling geod_plan and geod_fetch.',
      mimeType: 'application/json',
    }, async (uri) => {
      try {
        const capabilities = await service.capabilities();
        const example = capabilities.examples?.find((candidate) => candidate.id === id);
        if (!example?.request) throw Object.assign(new Error(`Example ${id} is unavailable.`), { code: 'EXAMPLE_NOT_FOUND' });
        return withinWireLimit({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(example.request, null, 2) }] });
      } catch (error) { throw resourceError(error, uri.href, safeError); }
    });
  }
  return server;
}
