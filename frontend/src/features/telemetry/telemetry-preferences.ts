export const TELEMETRY_NOTICE_VERSION = 5
export type TelemetryPreference = 'pending' | 'enabled' | 'disabled'
export interface SavedTelemetryPreference {
  consent?: TelemetryPreference
  consentedAt?: string | null
  noticeVersion?: number | null
  noticeAcknowledgedVersion?: number | null
  installId?: string | null
}
export function resolveTelemetryPreference(saved:SavedTelemetryPreference|undefined,now:string,id:()=>string){
  if(saved?.consent==='disabled')return {consent:'disabled' as const,consentedAt:saved.consentedAt??now,noticeVersion:TELEMETRY_NOTICE_VERSION,noticeAcknowledgedVersion:TELEMETRY_NOTICE_VERSION,installId:null}
  const samePolicy=saved?.noticeVersion===TELEMETRY_NOTICE_VERSION
  return {consent:'enabled' as const,consentedAt:samePolicy?saved.consentedAt??now:now,noticeVersion:TELEMETRY_NOTICE_VERSION,noticeAcknowledgedVersion:samePolicy?saved.noticeAcknowledgedVersion??null:null,installId:saved?.installId??id()}
}
