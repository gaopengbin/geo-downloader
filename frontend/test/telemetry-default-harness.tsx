import{createRoot}from'react-dom/client'
import{useState}from'react'
import{initializeI18n,changeAppLanguage}from'../src/i18n'
import{useTelemetryStore,TELEMETRY_NOTICE_VERSION}from'../src/features/telemetry/telemetry-store'
import{TelemetryConsentDialog}from'../src/features/telemetry/telemetry-consent-dialog'
import{Button}from'../src/components/ui/button'
import'../src/index.css'
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('Local isolated preview only')
await initializeI18n();await changeAppLanguage(new URL(location.href).searchParams.get('language')==='en'?'en-US':'zh-CN')
function Preview(){
 const state=useTelemetryStore();const[open,setOpen]=useState(false)
 return <main style={{padding:20}}><p data-consent={state.consent}>{state.consent}</p><Button onClick={()=>{state.setConsent('disabled')}}>Disable in settings</Button><Button onClick={()=>setOpen(true)}>Show notice</Button><TelemetryConsentDialog mode="default-notice" open={open||(state.consent==='enabled'&&state.noticeAcknowledgedVersion!==TELEMETRY_NOTICE_VERSION)} onOpenChange={value=>{setOpen(value);if(!value)state.acknowledgeNotice()}} onAccept={()=>{state.acknowledgeNotice();setOpen(false)}} onDecline={()=>{state.setConsent('disabled');setOpen(false)}}/></main>
}
createRoot(document.getElementById('root')!).render(<Preview/>)
