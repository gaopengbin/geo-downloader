// Actual task/history components. Native task operations and paths are isolated
// samples: no real jobs, clipboard, output files or Explorer windows are touched.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import type { TaskInfo, PersistedTask, DownloadHistoryRecord } from '../src/types/api'
import { initializeI18n, changeAppLanguage } from '../src/i18n'
import { ThemeProvider } from '../src/components/theme/theme-provider'
import { PanelSection } from '../src/components/layout/panel-section'
import { SidebarResizeHandle } from '../src/components/layout/sidebar-resize-handle'
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../src/components/layout/sidebar-width'
import { History, ClipboardList } from 'lucide-react'
import { useTelemetryStore } from '../src/features/telemetry/telemetry-store'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'

const query = new URLSearchParams(location.search)
localStorage.setItem('gd:theme-mode', query.has('dark') ? 'dark' : 'light')
await initializeI18n(); await changeAppLanguage(query.has('en') ? 'en-US' : 'zh-CN')
useTelemetryStore.setState({ consent: 'disabled', noticeAcknowledgedVersion: 999 })
const output = 'Q:\\GeoD测试成果\\artifacts\\geod-3.6.18-release-native-ui\\keyhole-native-task.tif'
const longPath = 'Q:\\GIS成果\\'+('超长目录_区域影像对比_Archive_2026\\').repeat(7)+'Earth_2013-10-16_z14_特别长的成果文件名.tif'
let resumable: PersistedTask[] = [{ task_id: 'interrupted', task_name: 'Google Earth 2026-07-14 z17',
  source_name: 'Google Earth 历史影像 2026-07-14', tile_count: 4, created_at: '2026-10-27 16:50:26',
  request: { source: 'earth_keyhole_fixture', zoom: 17, zoom_levels: [17], bounds: { north:1,south:0,east:1,west:0 }, format:'geotiff' },
} as PersistedTask]
let tasks: TaskInfo[] = query.has('stress') ? [
  { id:'running', name:'超长任务名称_高分辨率影像下载_北京市朝阳区_2026_abcdefghijklmnopqrstuvwxyz', source:'tianditu_satellite', source_name:'我自己的图源名称非常长，包括影像版本、坐标系和时间 2026-11-03', zoom:18, status:'downloading', progress:67.3, total:146022, completed:98273, failed_count:12, message:'服务限流，自动冷却约 8 秒后继续下载', file_size:8092384823 },
  { id:'failed', name:'OSM 道路下载失败，保留任务与原因',source:'osm_vector',source_name:'OpenStreetMap 要素',status:'failed',progress:20,error:'HTTP 429 服务暂时限制请求；已有任务数据保留，请稍后恢复任务。'+('较长的诊断信息_').repeat(32),save_path:longPath.replace('.tif','.geojson'),total:0,completed:0 },
  { id:'decision',name:'历史影像缺块待处理_Google_Earth_2013-10-16',source:'earth_keyhole_fixture',source_name:'Google Earth 历史影像 2013-10-16',zoom:14,status:'pending_decision',progress:98,total:285,completed:280,failed_count:5,message:'已有缺块，请选择补漏重试或按现状导出。'},
  { id:'paused',name:'影像下载已暂停_一个很长但仍应可读的任务标题',source:'tianditu_satellite',source_name:'天地图 卫星',zoom:17,status:'paused',progress:30,total:1000,completed:300,message:'任务已暂停，可继续下载或按现状导出。'},
  { id:'gaps',name:'Google Earth 影像已导出_存在缺块待补漏重导',source:'earth_keyhole_fixture',source_name:'Google Earth 历史影像 2013-10-16',zoom:14,status:'completed_with_gaps',progress:100,total:1000,completed:900,failed_count:100,file_size:123412341,save_path:output},
] : []
if(query.has('osm')) tasks = [
  {id:'osm-request',name:'OSM 道路下载',source:'osm_vector',source_name:'OSM Overpass',status:'downloading',progress:20,message:'OVERPASS_REQUEST:2:3:overpass.private.coffee',total:0,completed:0},
  {id:'osm-wait',name:'OSM 建筑下载',source:'osm_vector',source_name:'OSM Overpass',status:'downloading',progress:20,message:'OVERPASS_WAIT:30',total:0,completed:0},
  {id:'osm-failed',name:'OSM 道路：服务连接失败',source:'osm_vector',source_name:'OSM Overpass',status:'failed',progress:20,error:'OSM_SERVICE_UNAVAILABLE: overpass-api.de: 无法连接服务；备用服务: HTTP 503。本次未生成输出文件。',save_path:output.replace('.tif','.geojson'),total:0,completed:0},
]
let records: DownloadHistoryRecord[] = [
  {id:'complete',name:'Google Earth 2026-07-14 z17',source:'earth_keyhole_fixture',source_name:'Google Earth 历史影像 2026-07-14',zoom:17,format:'geotiff',status:'completed',file_path:output,file_size:170000,tile_count:4,duration_secs:4,created_at:'2026-10-27T21:13:43+08:00',log_file:'fixture.log',has_pyramid:false},
  {id:'long',name:'Google Earth 2013-10-16 z14_超长文件名_一个非常长的测试任务名称',source:'earth_keyhole_fixture',source_name:'Google Earth 历史影像 2013-10-16',zoom:14,format:'geotiff',status:'completed',file_path:longPath,file_size:32010000,tile_count:285,duration_secs:186,created_at:'2026-10-27T17:37:57+08:00',log_file:'fixture-long.log',has_pyramid:true,log_truncated:true},
]
if(query.has('stress')) records.push({id:'history-failed',name:'历史任务失败_不会把计划路径标为已生成文件',source:'osm_vector',format:'geojson',status:'failed',success:false,error:'请求失败，尚未生成输出文件。',file_path:longPath.replace('.tif','.geojson'),file_size:0,created_at:'2026-11-02T08:12:13+08:00'})
const actions: {command:string;args?:unknown}[]=[]
const receipt = { actions, copiedPath:'', openedPath:'', confirmations:0, errors:[] as string[], actualExplorerOpened:false }
function updateReceipt(){ const node=document.getElementById('receipt');if(node)node.textContent=JSON.stringify(receipt) }
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{receipt.copiedPath=text;updateReceipt()}}})
window.addEventListener('error',event=>{receipt.errors.push(event.message);updateReceipt()})
window.addEventListener('unhandledrejection',event=>{receipt.errors.push(String(event.reason));updateReceipt()})
Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},__TAURI_INTERNALS__:{
 transformCallback:()=>0,unregisterCallback:()=>{},invoke:async(command:string,args:Record<string,unknown>)=>{
  if(command==='plugin:event|listen')return 0
  if(command==='plugin:event|unlisten')return
  if(command==='get_active_tasks')return structuredClone(tasks)
  if(command==='get_resumable_tasks')return structuredClone(resumable)
  if(command==='get_download_history')return {records:structuredClone(records),total:records.length,page:1,page_size:50}
  if(command==='get_task_logs'||command==='read_log_file')return [{timestamp:'16:24:13',level:'INFO',message:'download complete; source='+'abcdefghijklmnopqrstuvwxyz'.repeat(30)},{timestamp:'16:24:14',level:'WARN',message:'样例诊断信息，测试不请求任何真实图源。'}]
  if(command==='plugin:dialog|message'){receipt.confirmations++;updateReceipt();return 'No'}
  actions.push({command,args:structuredClone(args)});updateReceipt()
  if(command==='open_file_location'){receipt.openedPath=String(args.filePath);updateReceipt();return}
  if(command==='build_pyramid_for_file'){records=records.map(record=>String(record.id)===String(args.recordId)?{...record,has_pyramid:true}:record);return}
  if(command==='resume_task'){
   let item=resumable.find(task=>task.task_id===args.taskId)
   if(item){resumable=resumable.filter(task=>task.task_id!==args.taskId);tasks.push({id:item.task_id,name:item.task_name,source:'earth_keyhole_fixture',source_name:item.source_name,zoom:17,status:'downloading',progress:25,total:4,completed:1})}
   return {task_id:args.taskId,tile_count:4}
  }
  if(command==='toggle_pause_task'){tasks=tasks.map(task=>task.id===args.taskId?{...task,status:task.status==='paused'?'downloading':'paused'}:task);return true}
  if(command==='export_partial_task')return
  throw Error(`Unsupported task-card fixture command: ${command}`)
 },
}})
const {TasksPanel}=await import('../src/features/tasks/tasks-panel')
const {HistoryPanel}=await import('../src/features/history/history-panel')
const {TasksDialog}=await import('../src/features/tasks/tasks-dialog')
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}})
function ResizeExample(){
 const [requested,setWidth]=useState(SIDEBAR_DEFAULT_WIDTH)
 const width=clampSidebarWidth(requested)
 return <div className="flex min-h-0 flex-1 overflow-hidden">
  <aside id="workspace-sidebar" data-resize-sidebar style={{width,minWidth:SIDEBAR_MIN_WIDTH,maxWidth:SIDEBAR_MAX_WIDTH}} className="h-full shrink-0 space-y-3 overflow-y-auto border-r p-3">
   <PanelSection icon={ClipboardList} title="任务" description="下载进度 / 失败原因 / 保存位置"><TasksPanel/></PanelSection>
   <PanelSection icon={History} title="历史记录" description="已完成 / 失败 / 已删除"><HistoryPanel/></PanelSection>
  </aside>
  <SidebarResizeHandle width={width} onWidthChange={setWidth}/>
  <div className="min-w-0 flex-1 bg-muted/20 p-4 text-sm">独立验证区域 · 当前侧栏 <output data-resize-width>{width}</output>px（最小 {SIDEBAR_MIN_WIDTH}px）<output id="receipt" className="mt-3 block break-all text-xs">尚未操作</output></div>
 </div>
}
const root = createRoot(document.getElementById('root')!)
root.render(<StrictMode><QueryClientProvider client={client}><ThemeProvider>
 <div className="fixed inset-0 flex flex-col">
  <header className="flex shrink-0 flex-wrap items-center gap-4 border-b p-3 text-xs">
   <span>下载卡片布局验证 · 模拟任务与路径，不操作真实文件</span>
   <a href="?">常规样例</a><a href="?stress">压力样例</a><a href="?stress&en&dark">English / Dark</a><a href="?resize&stress">拖拽宽度验证</a><a href="?resize&osm">OSM 恢复提示</a><a href="?resize&stress&dialog">任务弹窗验证</a>
   {query.has('dialog') && <TasksDialog/>}
  </header>
  {query.has('resize')?<ResizeExample/>:<main className="min-h-0 flex-1 overflow-auto"><div className="flex items-start gap-4 p-4">
   {(query.has('single')?[Number(query.get('single'))]:[380,480]).map(width=><section key={width} data-panel-width={width} className="shrink-0 space-y-3" style={{width}}>
    <h2 className="text-xs font-medium text-muted-foreground">侧栏内容宽度 {width}px</h2>
    <PanelSection icon={ClipboardList} title={query.has('en')?'Tasks':'任务'} description={query.has('en')?'Progress / Failures / Output':'下载进度 / 失败原因 / 保存位置'}><TasksPanel/></PanelSection>
    <PanelSection icon={History} title={query.has('en')?'History':'历史记录'} description={query.has('en')?'Completed / Failed':'已完成 / 失败 / 已删除'}><HistoryPanel/></PanelSection>
   </section>)}
  </div><output id="receipt" className="m-4 block max-w-3xl break-all text-[10px]">尚未操作</output></main>}
 </div><Toaster/>
</ThemeProvider></QueryClientProvider></StrictMode>)
import.meta.hot?.dispose(() => root.unmount())
