// Optional task execution diagnostic v1. Closed fields; no free-form errors/URLs.
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const integer=(v,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const nullable=(v,p)=>v===null||p(v);
const fail=()=>{throw Error('INVALID_EXECUTION_DIAGNOSTIC')};
export function validateExecutionDiagnostic(d){
 if(!exact(d,['version','scheduler','overpass'])||d.version!==1||(d.scheduler===null&&d.overpass===null))fail();
 if(d.scheduler!==null){
  const s=d.scheduler;
  const counters=['requests','responses','http_404','http_429','http_503','timeouts','network_errors','gate_wait_ms','retry_wait_ms','last_backoff_ms','max_backoff_ms','observed_ms','peak_qps','max_in_flight','waiting_requests'];
  if(!exact(s,[...counters,'provider','target_qps','target_concurrency','user_rate','user_batch_size','user_batch_pause_ms'])||s.provider!=='tianditu'||!counters.every(k=>integer(s[k])))fail();
  if(!nullable(s.target_qps,v=>integer(v,10000)&&v>0)||!nullable(s.target_concurrency,v=>integer(v,65535)&&v>0)||!integer(s.user_rate,10000)||!integer(s.user_batch_size,100000)||!integer(s.user_batch_pause_ms,600000))fail();
  if(s.responses>s.requests||s.http_404+s.http_429+s.http_503>s.responses||s.timeouts+s.network_errors>s.requests||s.peak_qps>s.requests||s.max_in_flight>s.requests||s.last_backoff_ms>s.max_backoff_ms||s.max_backoff_ms>86400000)fail();
 }
 if(d.overpass!==null){
  const o=d.overpass;
  if(!exact(o,['queue_wait_ms','fallback_count','wait_ms','attempts'])||!nullable(o.queue_wait_ms,integer)||!integer(o.fallback_count,2)||!integer(o.wait_ms)||!Array.isArray(o.attempts)||o.attempts.length>3||o.fallback_count!==Math.max(0,o.attempts.length-1))fail();
  for(const a of o.attempts){
   if(!exact(a,['endpoint','outcome','http_status','elapsed_ms','backoff_ms'])||!['de','mailru','privatecoffee','other'].includes(a.endpoint)||!['requesting','success','http_error','timeout','connect_error','body_error','invalid_json','incomplete','invalid_response','request_error','deadline'].includes(a.outcome)||!nullable(a.http_status,v=>integer(v,599)&&v>=100)||!integer(a.elapsed_ms)||!integer(a.backoff_ms))fail();
   if(a.outcome==='success'&&(a.http_status===null||a.http_status<200||a.http_status>=300))fail();
   if(a.outcome==='http_error'&&(a.http_status===null||a.http_status<300))fail();
  }
 }
 return JSON.parse(JSON.stringify(d));
}
