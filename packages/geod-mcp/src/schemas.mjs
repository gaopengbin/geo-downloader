import { z } from 'zod';

const localPath = z.string().min(1).max(4096).describe('Local path visible to the GeoD MCP process.');
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const httpUrl = z.string().min(1).max(16384).regex(/^https?:\/\//).describe('HTTP(S) URL. GeoD validates the endpoint and source policy.');

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
    url: httpUrl.describe('Download-enabled XYZ raster template containing {z}, {x} and {y}.'),
    source: z.string().min(1).max(4096),
    attribution: z.string().min(1).max(4096),
    zoom: z.number().int().min(0).max(22),
    format: z.enum(['png', 'jpeg', 'geotiff']).optional(),
    concurrency: z.number().int().min(1).max(32).optional(),
    allowMissing: z.boolean().optional(),
    clipToLayer: z.string().min(1).max(120).optional().describe('Mask imagery by the polygon union of this vector layer, preserving holes. Requires vector data and PNG/GeoTIFF output.'),
  }).optional(),
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
  plan: z.strictObject({ request: requestSchema }),
  fetch: z.strictObject({ request: requestSchema }),
  jobStatus: z.strictObject({ jobId: identifier }),
  cancelJob: z.strictObject({ jobId: identifier }),
  inspect: z.strictObject({ bundleDir: localPath }),
  getArtifact: z.strictObject({ jobId: identifier, artifactId: identifier }),
};
