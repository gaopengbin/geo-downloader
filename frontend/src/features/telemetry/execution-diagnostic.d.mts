export interface SchedulerDiagnostic {
 provider:'tianditu';
 requests:number;responses:number;http_404:number;http_429:number;http_503:number;timeouts:number;network_errors:number;
 gate_wait_ms:number;retry_wait_ms:number;last_backoff_ms:number;max_backoff_ms:number;observed_ms:number;peak_qps:number;max_in_flight:number;waiting_requests:number;
 target_qps:number|null;target_concurrency:number|null;user_rate:number;user_batch_size:number;user_batch_pause_ms:number;
}
export interface ExecutionDiagnostic {
 version:1;scheduler:SchedulerDiagnostic|null;
 overpass:{queue_wait_ms:number|null;fallback_count:number;wait_ms:number;attempts:{endpoint:string;outcome:string;http_status:number|null;elapsed_ms:number;backoff_ms:number}[]}|null;
}
export function validateExecutionDiagnostic(value:unknown):ExecutionDiagnostic
