export interface FeatureTelemetryEventMap {
  overlay_configuration: { target: 'preview' | 'download'; action: 'add' | 'remove' | 'reorder' | 'manage_sources'; layer_count: '0' | '1' | '2-10' | '11-100' | '100+' }
  output_location_action: { action: 'open_folder' | 'copy_path'; outcome: 'success' | 'failed'; strict_file: boolean }
  update_transfer_state: { state: 'started' | 'switching' | 'verifying' | 'installing' | 'failed'; source: 'mirror' | 'github' | 'unknown'; reason: 'none' | 'slow' | 'timeout' | 'unavailable' | 'invalid' | 'other'; attempt: number }
}
export const FEATURE_EVENT_NAMES: string[]
export function validateFeatureTelemetry(name: string, properties: unknown): Record<string, boolean | string | number>
