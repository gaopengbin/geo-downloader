// Deliberately excludes arguments, paths, coordinates, URLs, emails and diagnostics.
import { randomUUID } from 'node:crypto';
export const USAGE_VERSION = 1;
export const OPERATIONS = new Set(['plan', 'fetch', 'inspect', 'sources', 'geostyle-import', 'auth',
  'geod_capabilities', 'geod_sources', 'geod_plan', 'geod_fetch', 'geod_job_status',
  'geod_cancel_job', 'geod_inspect', 'geod_get_artifact', 'geod_artifact_link', 'login', 'refresh']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const REASONS = new Set(['none', 'cancelled', 'network', 'timeout', 'auth', 'permission', 'disk',
  'invalid_request', 'source_policy', 'incomplete', 'interrupted', 'unknown']);
const FIELDS = ['schemaVersion', 'eventId', 'attemptId', 'occurredAt', 'product', 'transport', 'kind',
  'operation', 'state', 'reason', 'isTest', 'installationId', 'version'].sort();

export function validateUsage(event, { local = false, now = Date.now() } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(FIELDS)) throw new Error('Invalid usage fields');
  const date = Date.parse(event.occurredAt);
  if (event.schemaVersion !== 1 || !UUID.test(event.eventId) || !UUID.test(event.attemptId) ||
      (event.installationId !== null && !UUID.test(event.installationId)) ||
      !Number.isFinite(date) || date > now + 300_000 || date < now - 90 * 86400_000 ||
      !['cli', 'mcp', 'unknown'].includes(event.product) || !['cli', 'stdio', 'http', 'oauth'].includes(event.transport) ||
      !['authorization', 'tool', 'download'].includes(event.kind) || !OPERATIONS.has(event.operation) ||
      !REASONS.has(event.reason) || typeof event.isTest !== 'boolean' ||
      typeof event.version !== 'string' || !/^[0-9][0-9A-Za-z.+_-]{0,31}$/.test(event.version)) throw new Error('Invalid usage value');
  if ((event.product === 'cli' && event.transport !== 'cli') || (event.product === 'mcp' && event.transport === 'cli')) throw new Error('Invalid transport');
  if ((event.product === 'unknown' || event.transport === 'oauth') && !(event.product === 'unknown' && event.transport === 'oauth' && event.kind === 'authorization')) throw new Error('Unknown authorization product only');
  const states = event.kind === 'authorization' ? ['succeeded'] : event.kind === 'tool'
    ? ['started', 'succeeded', 'failed', 'cancelled'] : ['started', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'];
  if (!states.includes(event.state) || (event.kind === 'authorization' && !['login', 'refresh'].includes(event.operation)) ||
      (event.kind === 'download' && !['fetch', 'geod_fetch'].includes(event.operation))) throw new Error('Invalid usage transition');
  if (local && (event.kind === 'authorization' || event.transport === 'http' || !event.installationId)) throw new Error('Server-owned event');
  return { ...event };
}

export function usageEvent(context, details) {
  return validateUsage({ schemaVersion: 1, eventId: randomUUID(), attemptId: randomUUID(),
    occurredAt: new Date().toISOString(), product: 'mcp', transport: 'stdio', version: '0.1.6',
    installationId: null, isTest: false, reason: 'none', ...context, ...details });
}

export function usageReason(error) {
  const text = `${error?.code || ''} ${error?.message || error || ''}`.toUpperCase();
  if (/CANCEL|ABORT/.test(text)) return 'cancelled';
  if (/INTERRUPTED/.test(text)) return 'interrupted';
  if (/TIMEOUT|TIMED OUT|DEADLINE/.test(text)) return 'timeout';
  if (/LOGIN_REQUIRED|UNAUTH|TOKEN_REQUIRED|HTTP\s*(401|403)/.test(text)) return 'auth';
  if (/SOURCE_NOT_ALLOWED|OFFLINE_FORBIDDEN/.test(text)) return 'source_policy';
  if (/EACCES|PERMISSION|ACCESS DENIED/.test(text)) return 'permission';
  if (/ENOSPC|DISK|STORAGE/.test(text)) return 'disk';
  if (/NETWORK|CONNECT|DNS|HTTP|DOWNLOAD|FETCH|TLS/.test(text)) return 'network';
  if (/INVALID|ARGUMENT|SCHEMA/.test(text)) return 'invalid_request';
  return 'unknown';
}

export function downloadOutcome(result) {
  const quality = result?.manifest?.quality;
  if (quality?.status === 'partial' || quality?.missingTiles > 0 || quality?.missing_tiles > 0) return 'partial';
  return quality?.status === 'complete' ? 'completed' : null;
}
