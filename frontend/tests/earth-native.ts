// Real Tauri IPC, real catalog/decoder, real task manager, no fake success responses.
import { invoke } from '@tauri-apps/api/core'
const report: Record<string, unknown> = { earthEngineLoaded: false, uiInputUsed: false, tasks: [] }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const root = await invoke<string>('qa_root')
  const bounds = { west: -122.402, south: 37.790, east: -122.400, north: 37.792 }
  const catalog = await invoke<{id:string; dates:{date:string;supportedNodes:number}[]}>('earth_history_catalog', { bounds, zoom: 17, proxy: null, requestId: crypto.randomUUID() })
  report.catalog = catalog
  for (const date of ['2026-03-06','2026-07-14','2025-11-30','2024-04-30']) {
    const listed = catalog.dates.some((entry) => entry.date === date && entry.supportedNodes > 0)
    const plan = await invoke<{id:string;source:{id:string};tileCount:number;fallbackOccurred:boolean}>('earth_history_prepare', { catalogId: catalog.id, date, proxy: null, requestId: crypto.randomUUID() })
    if (!listed && !plan.fallbackOccurred) throw new Error('an unlisted date must have explicit packet-date fallback evidence')
    const savePath = `${root}/${date}.tif`
    const polygon = [[{lng:bounds.west,lat:bounds.south},{lng:bounds.west,lat:bounds.north},{lng:bounds.east,lat:bounds.north},{lng:bounds.east,lat:bounds.south}]]
    const created = await invoke<{taskId:string;pauseRequested:boolean}>('qa_create_task', { pauseImmediately: date === '2026-03-06',
      request: { source: plan.source.id, bounds, zoom: 17, zoom_levels: [17], format: 'geotiff', save_path: savePath,
        concurrency: 2, crop_to_shape: true, polygon, compression: 'lzw', generate_sidecars: true } })
    let pauseObserved = false
    if (created.pauseRequested) {
      await sleep(200)
      const tasks = await invoke<{id:string;status:string}[]>('qa_tasks')
      pauseObserved = tasks.some((task) => task.id === created.taskId && task.status.toLowerCase() === 'paused')
      if (!await invoke('qa_toggle', { taskId: created.taskId })) throw new Error('resume failed')
    }
    let finished: unknown = null
    for (let i=0;i<180;i++) {
      const tasks = await invoke<{id:string;status:string;message?:string}[]>('qa_tasks')
      const task = tasks.find((entry) => entry.id === created.taskId)
      if (task && ['failed','cancelled'].includes(task.status.toLowerCase())) throw new Error(JSON.stringify(task))
      if (task?.status.toLowerCase() === 'completed') { finished = task; break }
      await sleep(400)
    }
    if (!finished) throw new Error('native task did not complete')
    ;(report.tasks as unknown[]).push({ date, listedInScopedCatalog: listed, fallbackOccurred: plan.fallbackOccurred, planId:plan.id, created, pauseObserved, finished, savePath })
  }
  report.ok = true
} catch (error) { report.ok = false; report.error = String(error) }
await invoke('qa_finish', { report })
