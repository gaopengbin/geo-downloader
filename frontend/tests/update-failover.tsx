import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { initializeI18n, changeAppLanguage } from '../src/i18n'
import { ThemeProvider } from '../src/components/theme/theme-provider'
import { useUpdateStore } from '../src/features/update/update-store'
import type { UpdateTransfer } from '../src/features/update/update-transfer'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'

const query = new URLSearchParams(location.search)
localStorage.setItem('gd:theme-mode', query.has('dark') ? 'dark' : 'light')
await initializeI18n()
await changeAppLanguage(query.has('en') ? 'en-US' : 'zh-CN')
const callbacks = new Map<number, (event: unknown) => void>()
const subscriptions = new Map<number, { event: string; handler: number }>()
let next = 0
const receipt = { calls: 0, listeners: 0, stopped: 0, verifiedArguments: false, installerLaunched: false, stages: [] as string[] }
function updateReceipt() { document.getElementById('receipt')!.textContent = JSON.stringify(receipt) }
function emit(value: UpdateTransfer) {
  receipt.stages.push(value.phase); updateReceipt()
  for (const [id, sub] of subscriptions) {
    const payload = sub.event === 'update-download-progress' ? value.progress : value
    callbacks.get(sub.handler)?.({ event: sub.event, id, payload })
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => {
    const sub = subscriptions.get(id)
    if (sub) callbacks.delete(sub.handler)
    subscriptions.delete(id); receipt.listeners = subscriptions.size; receipt.stopped++; updateReceipt()
  } },
  __TAURI_INTERNALS__: {
    transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++next, callback); return next },
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === 'plugin:event|listen') {
        subscriptions.set(++next, { event: String(args.event), handler: Number(args.handler) })
        receipt.listeners = subscriptions.size; updateReceipt(); return next
      }
      if (command === 'plugin:event|unlisten') return
      if (command !== 'download_and_install_update') throw Error('Unexpected fixture command')
      receipt.calls++
      receipt.verifiedArguments = args.expectedSha256 === 'a'.repeat(64) && args.expectedSize === 10505425
      if (!receipt.verifiedArguments) throw Error('Missing integrity arguments')
      const event: UpdateTransfer = { source: 'mirror', phase: 'downloading', attempt: 1, progress: 2,
        downloaded: 200000, total: 10505425, bytesPerSecond: 18 * 1024, reason: null }
      emit(event); await pause(2000)
      emit({ ...event, source: 'github', phase: 'switching', attempt: 2, progress: 0, downloaded: 0, bytesPerSecond: 0, reason: 'slow' })
      await pause(1500)
      if (query.has('fail') && receipt.calls === 1) throw Error('UPDATE_SOURCES_FAILED: controlled fixture failure')
      emit({ ...event, source: 'github', attempt: 2, progress: 55, downloaded: 5700000, bytesPerSecond: 1.5 * 1024 * 1024 })
      if (query.get('hold') === 'backup') await new Promise(() => {})
      await pause(4500)
      emit({ ...event, source: 'github', phase: 'verifying', attempt: 2, progress: 99, downloaded: 10505425, bytesPerSecond: 0 })
      await pause(1500)
      emit({ ...event, source: 'github', phase: 'installing', attempt: 2, progress: 100, downloaded: 10505425, bytesPerSecond: 0 })
      // The fixture never executes an installer or exits the desktop application.
    },
  },
})
const { UpdateDialog } = await import('../src/features/update/update-dialog')
useUpdateStore.getState().showDialog({ currentVersion: '3.6.13', latestVersion: '3.6.24', noteGroups: [],
  downloadUrl: 'https://laogao.xyz/packages/latest/GeoDownloader_3.6.24_windows_x64-setup.exe',
  releaseUrl: 'https://github.com/gaopengbin/geo-downloader/releases/tag/v3.6.24',
  expectedSha256: 'a'.repeat(64), expectedSize: 10505425 })
createRoot(document.getElementById('root')!).render(<StrictMode><ThemeProvider>
  <header className="h-12 border-b bg-background px-5 py-3 text-sm font-semibold">GeoD · 更新界面隔离验证</header>
  <main className="p-5 text-sm text-muted-foreground">使用真实更新弹窗和事件监听；状态为测试数据，不会安装、退出应用或更改系统代理。
    <output id="receipt" className="block break-all" data-testid="receipt">尚未开始</output>
  </main><UpdateDialog/><Toaster/>
</ThemeProvider></StrictMode>)
