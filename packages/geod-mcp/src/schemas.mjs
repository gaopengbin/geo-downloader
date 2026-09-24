import { z } from 'zod';

const localPath = z.string().min(1).max(4096).describe('Local path visible to the GeoD MCP process.');
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const httpUrl = z.string().min(1).max(16384).regex(/^https?:\/\//).describe('HTTP(S) URL. GeoD validates the endpoint and source policy.');
const sourceId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).describe('ID from geod_sources list or a locally registered source.');
const sourceFields = value => [value.url, value.source, value.attribution].filter(item => item !== undefined).length;
const overlaySchema = z.strictObject({
  sourceId: sourceId.optional(), url: httpUrl.optional(),
  source: z.string().min(1).max(4096).optional(), attribution: z.string().min(1).max(4096).optional(),
  subdomains: z.array(z.string().min(1).max(128)).max(8).optional(),
  maxZoom: z.number().int().min(0).max(22).optional(),
}).refine(value => value.sourceId ? sourceFields(value) === 0 : sourceFields(value) === 3,
  'Overlay needs either sourceId or url/source/attribution.');

export const boundsSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-85.05112878).max(85.05112878),
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-85.05112878).max(85.05112878),
]).refine(([west, south, east, north]) => west < east && south < north, 'Bounds must be ordered west,south,east,north with positive width and height.')
  .describe('Requested WGS84 [west, south, east, north]. Split antimeridian regions.');

export const requestSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  name: z.string().min(1).max(240),
  bounds: boundsSchema,
  imagery: z.strictObject({
    sourceId: sourceId.optional(),
    url: httpUrl.optional().describe('Download-enabled XYZ raster template containing {z}, {x} and {y}.'),
    source: z.string().min(1).max(4096).optional(),
    attribution: z.string().min(1).max(4096).optional(),
    zoom: z.number().int().min(0).max(22),
    zoomMax: z.number().int().min(0).max(22).optional(),
    zoomLevels: z.array(z.number().int().min(0).max(22)).min(1).max(23).optional(),
    format: z.enum(['png', 'jpeg', 'geotiff']).optional(),
    concurrency: z.number().int().min(1).max(32).optional(),
    allowMissing: z.boolean().optional(),
    compression: z.enum(['lzw', 'deflate', 'none']).optional(),
    generateSidecars: z.boolean().optional(),
    subdomains: z.array(z.string().min(1).max(128)).max(8).optional(),
    overlays: z.array(overlaySchema).max(8).optional(),
    cropToShape: z.boolean().optional(),
    polygon: z.array(z.array(z.strictObject({ lat: z.number().finite(), lng: z.number().finite() })).min(3)).min(1).optional(),
    buildPyramid: z.boolean().optional(),
    clipToLayer: z.string().min(1).max(120).optional().describe('Mask imagery by the polygon union of this vector layer, preserving holes. Requires vector data and PNG/GeoTIFF output.'),
  }).refine(value => value.sourceId ? sourceFields(value) === 0 : [0, 3].includes(sourceFields(value)),
    'Use sourceId, complete url/source/attribution, or a configured local default source.').optional(),
  vector: z.strictObject({
    input: localPath.optional().describe('Prepared local WGS84 GeoJSON. Use an absolute path for a stable MCP invocation.'),
    url: httpUrl.optional().describe('Prepared WGS84 GeoJSON URL, suitable for province boundaries.'),
    endpoint: httpUrl.optional().describe('Optional Overpass endpoint for bounded online extraction.'),
    layers: z.array(z.enum(['boundary', 'roads', 'railways', 'water', 'landuse', 'places', 'pois', 'tourism'])).max(8).optional(),
    source: z.string().min(1).max(4096).optional(),
    attribution: z.string().min(1).max(4096).optional(),
  }).optional(),
  limits: z.strictObject({
    maxTiles: z.number().int().min(1).max(4096).optional(),
    maxPixels: z.number().int().min(1).max(67_108_864).optional(),
    timeoutSeconds: z.number().int().min(1).max(1800).optional(),
  }).optional(),
}).refine((request) => request.imagery !== undefined || request.vector !== undefined, 'Supply imagery and/or vector data.')
  .describe('GeoD request 1.0. geod_plan performs authoritative source, clipping, and resource validation before fetching.');

// Additional source combinations and tile estimates remain authoritative in Rust.
export const toolSchemas = {
  capabilities: z.strictObject({}),
  sources: z.strictObject({
    action: z.enum(['list', 'register', 'update', 'remove', 'default', 'probe']),
    id: sourceId.optional(), name: z.string().min(1).max(128).optional(), url: httpUrl.optional(),
    attribution: z.string().min(1).max(4096).optional(), maxZoom: z.number().int().min(0).max(22).optional(),
    subdomains: z.array(z.string().min(1).max(128)).max(8).optional(), scheme: z.enum(['xyz', 'tms']).optional(),
    zoom: z.number().int().min(0).max(22).optional(), x: z.number().int().min(0).max(4_194_303).optional(), y: z.number().int().min(0).max(4_194_303).optional(),
  }).superRefine((value, ctx) => {
    if (value.action !== 'list' && !value.id) ctx.addIssue({ code: 'custom', message: 'This action requires id.' });
    if (['register', 'update'].includes(value.action) && (!value.name || !value.url || !value.attribution)) ctx.addIssue({ code: 'custom', message: 'Registration needs name, url and attribution.' });
  }),
  plan: z.strictObject({ request: requestSchema }),
  fetch: z.strictObject({ request: requestSchema }),
  jobStatus: z.strictObject({ jobId: identifier }),
  cancelJob: z.strictObject({ jobId: identifier }),
  inspect: z.strictObject({ bundleDir: localPath }),
  getArtifact: z.strictObject({ jobId: identifier, artifactId: identifier }),
};
