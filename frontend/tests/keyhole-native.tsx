// Hidden native window, real production components and IPC/protocol. No UI input.
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import type L from 'leaflet'
import '../src/index.css'
import { initializeI18n } from '../src/i18n'
import { WaybackPage } from '../src/features/wayback/wayback-page'
import { WaybackTimeline } from '../src/features/wayback/wayback-timeline'
import { MapCanvas } from '../src/features/map/map-canvas'
import { useWaybackStore } from '../src/store/wayback-store'
import { useAppStore } from '../src/store/app-store'
import { useSelectionStore } from '../src/store/selection-store'

const report: Record<string, unknown> = { realNativeIPC:true, realNativeTileProtocol:true, desktopInputUsed:false, controlEventsUsed:true, steps:[] }
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms))
let map:L.Map
await initializeI18n()
useAppStore.getState().setMode('wayback')
useWaybackStore.getState().setProvider('earth')
useWaybackStore.getState().setEarthDate('2026-07-14')
useSelectionStore.setState({bounds:null,polygon:null})
const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><div className="grid h-screen grid-cols-[380px_1fr] gap-3 p-3"><div className="overflow-y-auto p-2"><WaybackPage/></div><div className="relative"><MapCanvas onMapReady={(value)=>{map=value;map.setView([37.79068788,-122.401],15,{animate:false})}}/><WaybackTimeline/></div></div></QueryClientProvider>)
async function waitFor(label:string,predicate:()=>boolean,timeout=120000){const start=Date.now();while(Date.now()-start<timeout){if(predicate())return;await sleep(250)}throw new Error(`${label} timed out`)}
async function selectDate(date:string){
  document.querySelector('[data-agent-target="earth-date-select"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await sleep(100)
  const option=Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((element)=>element.textContent?.trim()===date)
  if(!option)throw new Error(`date option missing: ${date}`)
  option.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await sleep(100)
}
function snapshot(label:string){
  const state=useWaybackStore.getState()
  const tiles=Array.from(document.querySelectorAll<HTMLImageElement>('img.leaflet-tile-loaded[data-earth-source]'))
  let visible=0;let opaque=0
  const mapRect=document.querySelector('.leaflet-container')!.getBoundingClientRect()
  const raster=document.createElement('canvas');raster.width=mapRect.width;raster.height=mapRect.height;const ctx=raster.getContext('2d')!
  for(const tile of tiles){const rect=tile.getBoundingClientRect();if(rect.right<=mapRect.left || rect.left>=mapRect.right || rect.bottom<=mapRect.top || rect.top>=mapRect.bottom)continue;visible++;ctx.drawImage(tile,rect.left-mapRect.left,rect.top-mapRect.top,rect.width,rect.height)}
  const pixels=ctx.getImageData(0,0,raster.width,raster.height).data;for(let i=3;i<pixels.length;i+=4)if(pixels[i])opaque++
  return {label,date:state.earthDate,source:state.earthPreview?.source.id,view:state.earthView,dateCount:state.earthPointCatalog?.dates.length,
    sourceKeys:[...new Set(tiles.map((tile)=>tile.dataset.earthSource))],visibleLoadedTiles:visible,opaquePixels:opaque,selection:useSelectionStore.getState().bounds,
    mapRaster:raster.toDataURL('image/png'),alerts:Array.from(document.querySelectorAll('[role="alert"]')).map((e)=>e.textContent)}
}
async function steady(label:string){await waitFor(label,()=>!!useWaybackStore.getState().earthPreview && Array.from(document.querySelectorAll<HTMLImageElement>('img.leaflet-tile-loaded[data-earth-source]')).filter((tile)=>tile.dataset.earthCoords?.startsWith(`${map.getZoom()}/`) && tile.dataset.earthSource===useWaybackStore.getState().earthPreview?.source.id).length>=9);await sleep(2500);const s=snapshot(label);if(s.opaquePixels<10000)throw new Error(`${label}: no real visible imagery`);(report.steps as unknown[]).push(s);return s}
try{
  await steady('initial-no-selection')
  map!.panBy([310,0],{animate:false});await steady('pan-outside-original-view')
  map!.setZoom(16,{animate:false});await steady('zoom-in')
  await selectDate('2024-04-30');await waitFor('2024 context',()=>useWaybackStore.getState().earthPreview?.requestedDate==='2024-04-30');await steady('switch-2024')
  useWaybackStore.getState().setEarthDate('2026-03-06');await sleep(40);useWaybackStore.getState().setEarthDate('2026-07-14');
  await waitFor('latest context',()=>useWaybackStore.getState().earthPreview?.requestedDate==='2026-07-14');const latest=await steady('rapid-switch-latest-wins');
  if(latest.sourceKeys.some((id)=>id!==latest.source))throw new Error('stale date imagery remained')
  const stats=await invoke('keyhole_history_status',{sourceKey:latest.source});report.cacheStats=stats
  const bounds={west:-122.402,south:37.790,east:-122.400,north:37.792}
  useSelectionStore.setState({bounds,externalRevision:1})
  const root=await invoke<string>('qa_root');
  const input=document.querySelector<HTMLInputElement>('#earth-save-path')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,`${root}/keyhole-native-task.tif`)
  input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await sleep(200)
  document.querySelector<HTMLButtonElement>('[data-agent-target="earth-create-download"]')!.click()
  await waitFor('preparation shown before download',()=>document.querySelector('[data-agent-target="earth-download-progress"]')?.getAttribute('data-task-status')==='paused')
  const progressElement=document.querySelector('[data-agent-target="earth-download-progress"]')!
  const preparingText=progressElement.textContent
  if(!preparingText?.includes('1 / 4'))throw new Error(`preparation counts missing: ${preparingText}`)
  const progressBox=progressElement.getBoundingClientRect()
  report.preparationVisible={text:preparingText,html:progressElement.outerHTML,percent:progressElement.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),box:{left:progressBox.left,top:progressBox.top,width:progressBox.width,height:progressBox.height},viewport:[innerWidth,innerHeight]}
  const pausedTasks=await invoke<{id:string}[]>('qa_tasks')
  await invoke('qa_toggle',{taskId:pausedTasks[0].id})
  let finished:unknown
  for(let i=0;i<240;i++){const tasks=await invoke<{id:string;status:string}[]>('qa_tasks');const item=tasks[0];if(item?.status.toLowerCase()==='completed'){finished=item;break}if(item && ['failed','cancelled','incomplete'].includes(item.status.toLowerCase()))throw new Error(JSON.stringify(item));await sleep(500)}
  if(!finished)throw new Error('native export did not complete')
  report.task={finished,createdThroughProductionDownloadButton:true};report.progressTrace=await invoke('qa_progress');report.ok=true
}catch(error){report.ok=false;report.error=String(error)}
await invoke('qa_finish',{report})
