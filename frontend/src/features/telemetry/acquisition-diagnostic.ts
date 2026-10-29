import {validateDownloadDiagnostic}from './download-diagnostic.mjs'
export interface AcquisitionDiagnostic {
 version:1;phase:string;additional_sources:number;error_code:string|null;error_http_status:number|null;failed_source:number|null;storage_checked_at:string|null;
 sources:{role:'base'|'overlay';provider:string;endpoint:string;fingerprint:string;host:string|null;options:Record<string,string>;authentication_configured:boolean;http_status:number|null;last_rejection_status:number|null;observed_responses:number}[];
 storage:{roles:string[];volume:string;budget_kind:string;required_bytes:number|null;available_bytes:number|null;met_budget:boolean|null}[];
}
export function sanitizeAcquisitionDiagnostic(raw:unknown):AcquisitionDiagnostic|null{
 try{return validateDownloadDiagnostic(raw)}catch{return null}
}
export function taskAcquisitionDiagnostic(raw:unknown):AcquisitionDiagnostic|null{
 return sanitizeAcquisitionDiagnostic(raw&&typeof raw==='object'?(raw as Record<string,unknown>).acquisition:null)
}
export function taskAcquisitionFields(raw:unknown):{diagnostic?:AcquisitionDiagnostic}{const diagnostic=taskAcquisitionDiagnostic(raw);return diagnostic?{diagnostic}:{}}
