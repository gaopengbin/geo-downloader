import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initializeI18n } from '../src/i18n'
import { useAppStore } from '../src/store/app-store'
import { useWaybackStore } from '../src/store/wayback-store'
import '../src/index.css'

await initializeI18n()
const versions = { versions: [
  {id:'3',date:'2026-10-01',title:'2026',layer_id:'3'},
  {id:'2',date:'2025-10-01',title:'2025',layer_id:'2'},
  {id:'1',date:'2024-10-01',title:'2024',layer_id:'1'},
] }
const settings = {proxy_enabled:false,tianditu_token:null,default_concurrency:8}
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(command:string)=>{
  if(command==='get_wayback_versions')return versions
  if(command==='get_settings')return settings
  if(command==='get_tile_sources')return {}
  return []
}}})
useAppStore.setState({mode:'wayback'})
useWaybackStore.setState({provider:'esri',previewVersionId:null})
const {WaybackPage}=await import('../src/features/wayback/wayback-page')
const {WaybackTimeline}=await import('../src/features/wayback/wayback-timeline')
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,staleTime:Infinity}}})
client.setQueryData(['settings'],settings)
client.setQueryData(['wayback-versions',''],versions)
class Boundary extends Component<{children:ReactNode},{error:string|null}> {
  state:{error:string|null}={error:null}
  static getDerivedStateFromError(error:Error){return {error:error.message}}
  render(){return this.state.error?<pre role="alert">{this.state.error}</pre>:this.props.children}
}
export function SelectionReceipt(){const id=useWaybackStore(s=>s.previewVersionId);return <output data-testid="selected-version">{id??'none'}</output>}
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><Boundary>
  <p className="p-2">Wayback 实际页面与时间轴回归；图源列表为隔离测试数据，不修改真实配置。</p>
  <SelectionReceipt/>
  <div className="p-3" style={{width:380,maxWidth:'100%'}}><WaybackPage/></div>
  <div className="fixed right-4 top-20 h-64 w-[550px] border bg-muted"><WaybackTimeline/></div>
</Boundary></QueryClientProvider></StrictMode>)
