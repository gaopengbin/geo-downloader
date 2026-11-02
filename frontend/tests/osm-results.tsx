import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { initializeI18n, changeAppLanguage } from '../src/i18n'
import { ThemeProvider } from '../src/components/theme/theme-provider'
import type { TaskInfo, DownloadHistoryRecord } from '../src/types/api'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'

const query = new URLSearchParams(location.search)
localStorage.setItem('gd:theme-mode', query.has('dark') ? 'dark' : 'light')
await initializeI18n(); await changeAppLanguage(query.has('en') ? 'en-US' : 'zh-CN')
const path = 'D:\\GIS 成果\\长沙道路导出\\2026-11-02\\测试区域\\osm_roads_20261102.geojson'
let tasks: TaskInfo[] = query.has('restart') ? [] : [
  { id: 'failed', name: 'OSM 道路：请求失败', source: 'osm_vector', status: 'failed', progress: 20,
    error: 'Overpass 请求超时；没有生成本次输出文件。', message: '正在请求 Overpass API...', save_path: path, total: 0, completed: 0 },
  { id: 'success', name: 'OSM 建筑：已保存', source: 'osm_vector', status: 'completed', progress: 100,
    message: '完成', save_path: path.replace('roads', 'buildings'), total: 0, completed: 0, file_size: 12345 },
]
const records: DownloadHistoryRecord[] = [
  { id: 'failed', name: 'OSM 道路：请求失败', source: 'osm_vector', format: 'geojson', status: 'failed', error: 'Overpass 请求超时；没有生成本次输出文件。', file_path: path, file_size: 0 },
  { id: 'success', name: 'OSM 建筑：已保存', source: 'osm_vector', format: 'geojson', status: 'completed', file_path: path.replace('roads', 'buildings'), file_size: 12345 },
  { id: 'archived', name: '历史 OSM：已保存', source: 'osm_vector', format: 'geojson', status: 'completed', file_path: path, file_size: 9876 },
]
const callbacks = new Map<number, (event: unknown) => void>()
const subscriptions = new Map<number, { event: string; handler: number }>()
let next = 0
const receipt = { opens: 0, strictFile: false, openedPath: '', copies: 0, copiedPath: '', removed: [] as string[], actualExplorerOpened: false }
function receiptText() { document.getElementById('receipt')!.textContent = JSON.stringify(receipt) }
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text: string) => { receipt.copies++; receipt.copiedPath = text; receiptText() },
} })
Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => {
    const sub = subscriptions.get(id); if (sub) callbacks.delete(sub.handler); subscriptions.delete(id)
  } },
  __TAURI_INTERNALS__: {
    transformCallback: (cb: (event: unknown) => void) => { callbacks.set(++next, cb); return next },
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === 'plugin:event|listen') { subscriptions.set(++next, { event: String(args.event), handler: Number(args.handler) }); return next }
      if (command === 'plugin:event|unlisten') return
      if (command === 'get_active_tasks') return tasks
      if (command === 'get_resumable_tasks') return []
      if (command === 'get_download_history') {
        if (query.has('history-fail')) throw Error('Controlled history read failure')
        return { records, total: records.length, page: 1, page_size: 50 }
      }
      if (command === 'get_task_logs' || command === 'read_log_file') return []
      if (command === 'plugin:dialog|message') return 'Yes'
      if (command === 'remove_task') {
        tasks = tasks.filter((task) => task.id !== args.taskId); receipt.removed.push(String(args.taskId)); receiptText(); return
      }
      if (command === 'open_file_location') {
        receipt.opens++; receipt.strictFile = args.requireFileExists === true; receipt.openedPath = String(args.filePath); receiptText()
        if (!receipt.strictFile) throw Error('OSM output must use strict file checking')
        if (query.has('missing')) throw Error('输出文件不存在或已移动，请核对保存路径。')
        return
      }
      throw Error(`Unexpected OSM result fixture command: ${command}`)
    },
  },
})
const { TasksPanel } = await import('../src/features/tasks/tasks-panel')
const { HistoryPanel } = await import('../src/features/history/history-panel')
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><ThemeProvider>
  <header className="border-b p-3 text-sm">GeoD · OSM 结果界面隔离验证；路径为样例，不打开真实资源管理器。</header>
  <main className="grid max-w-[900px] gap-4 p-4 md:grid-cols-2">
    <section className="min-w-0"><h2 className="mb-3 font-semibold">任务与结果</h2><TasksPanel/></section>
    <section className="min-w-0"><h2 className="mb-3 font-semibold">历史记录</h2><HistoryPanel/></section>
    <output id="receipt" data-testid="receipt" className="break-all text-xs">尚未操作</output>
  </main><Toaster/>
</ThemeProvider></QueryClientProvider></StrictMode>)
