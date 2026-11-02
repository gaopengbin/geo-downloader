// Shared with the collector. Only fixed categories and bounded counters cross
// this boundary; never include source IDs, paths, URLs, headers or raw errors.
export const FEATURE_EVENT_NAMES = ['overlay_configuration', 'output_location_action', 'update_transfer_state']
const enumeration = (...values) => (value) => values.includes(value)
const schemas = {
  overlay_configuration: {
    target: enumeration('preview', 'download'),
    action: enumeration('add', 'remove', 'reorder', 'manage_sources'),
    layer_count: enumeration('0', '1', '2-10', '11-100', '100+'),
  },
  output_location_action: {
    action: enumeration('open_folder', 'copy_path'), outcome: enumeration('success', 'failed'),
    strict_file: (value) => typeof value === 'boolean',
  },
  update_transfer_state: {
    state: enumeration('started', 'switching', 'verifying', 'installing', 'failed'),
    source: enumeration('mirror', 'github', 'unknown'),
    reason: enumeration('none', 'slow', 'timeout', 'unavailable', 'invalid', 'other'),
    attempt: (value) => Number.isInteger(value) && value >= 0 && value <= 8,
  },
}
export function validateFeatureTelemetry(name, properties) {
  const schema = Object.hasOwn(schemas, name) ? schemas[name] : null
  if (!schema || !properties || typeof properties !== 'object' || Array.isArray(properties)
    || Object.keys(properties).length !== Object.keys(schema).length
    || !Object.entries(schema).every(([key, check]) => Object.hasOwn(properties, key) && check(properties[key]))) {
    throw new Error('Invalid feature telemetry categories')
  }
  return Object.fromEntries(Object.keys(schema).map((key) => [key, properties[key]]))
}
