import { Component, useCallback, useReducer, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

// Browser regression fixture. These are local synthetic catalogues, not provider data.
// A stable ref may legitimately update its owner when a DOM node first attaches.
// Reattaching that same node on every render used to crash Radix under React 19.
class CaseBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('REF_REGRESSION', error.stack, info.componentStack) }
  render() {
    return this.state.error
      ? <pre role="alert" data-testid="case-error" className="whitespace-pre-wrap rounded border border-destructive p-3 text-destructive">{this.state.error}</pre>
      : this.props.children
  }
}

function RefConsumer({ kind }: { kind: 'select' | 'button' }) {
  const [attachmentUpdates, bump] = useReducer((n: number) => n + 1, 0)
  const capture = useCallback((node: HTMLButtonElement | null) => {
    if (node) bump()
  }, [])
  const [value, setValue] = useState('2024-10-01')
  return <div className="space-y-2" data-testid={`${kind}-ref-consumer`}>
    {kind === 'select'
      ? <Select value={value} onValueChange={setValue}>
        <SelectTrigger ref={capture} aria-label="引用更新日期"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="2024-10-01">2024-10-01</SelectItem><SelectItem value="2025-10-01">2025-10-01</SelectItem></SelectContent>
      </Select>
      : <Button asChild ref={capture}><button type="button">带稳定引用的子按钮</button></Button>}
    <output data-testid={`${kind}-ref-result`}>{JSON.stringify({ attachmentUpdates, value })}</output>
  </div>
}

const CATALOGUES = [
  ['source-a', 'source-b', 'custom-source'],
  Array.from({ length: 120 }, (_, i) => `${1906 + i}-10-01`),
  Array.from({ length: 10 }, (_, i) => String(2016 + i)),
]

function DynamicCatalogue() {
  const [provider, setProvider] = useState('0')
  const [entries, setEntries] = useState(CATALOGUES[0])
  const [value, setValue] = useState(CATALOGUES[0][0])
  const [completed, setCompleted] = useState(0)
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState(false)
  function changeProvider(next: string) {
    setProvider(next)
    setEntries([...CATALOGUES[Number(next)]])
    setValue(CATALOGUES[Number(next)][0])
  }
  function stress() {
    setRunning(true)
    setCompleted(0)
    let count = 0
    const step = () => {
      const p = count % CATALOGUES.length
      const options = [...CATALOGUES[p]]
      setProvider(String(p)); setEntries(options); setValue(options[count % options.length])
      count += 1; setCompleted(count)
      if (count < 120) requestAnimationFrame(step)
      else setRunning(false)
    }
    requestAnimationFrame(step)
  }
  return <div className="space-y-3">
    <Select value={provider} onValueChange={changeProvider}>
      <SelectTrigger aria-label="测试图源"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="0">普通图源</SelectItem><SelectItem value="1">历史日期</SelectItem><SelectItem value="2">年度底图</SelectItem></SelectContent>
    </Select>
    <Select value={value} onValueChange={setValue} open={open} onOpenChange={setOpen}>
      <SelectTrigger aria-label="测试日期"><SelectValue /></SelectTrigger>
      <SelectContent>{entries.map(entry => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
    </Select>
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setEntries([...entries])}>重载相同目录</Button>
      <Button onClick={stress} disabled={running}>连续切换 120 次</Button>
      <Button onClick={() => { setOpen(true); stress() }} disabled={running}>展开时连续刷新 120 次</Button>
    </div>
    <output data-testid="catalogue-result">{JSON.stringify({ provider, value, count: entries.length, completed, running, open })}</output>
  </div>
}

export default function Fixture() {
  const [selectedCase, setCase] = useState<'select' | 'button' | null>(null)
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <header><h1 className="text-xl font-semibold">GeoD React 19 控件回归</h1><p className="text-sm text-muted-foreground">本地合成图源与日期；使用产品实际共享组件，不联网下载或访问用户配置。</p></header>
    <section className="space-y-3 rounded border p-4"><h2>引用更新回归</h2>
      <div className="flex gap-2"><Button onClick={() => setCase('select')}>检查日期控件引用</Button><Button onClick={() => setCase('button')}>检查嵌套子控件引用</Button></div>
      {selectedCase && <CaseBoundary key={selectedCase}><RefConsumer kind={selectedCase} /></CaseBoundary>}
    </section>
    <section className="space-y-3 rounded border p-4"><h2>图源与日期切换</h2><CaseBoundary><DynamicCatalogue /></CaseBoundary></section>
    <section className="flex gap-2 rounded border p-4">
      <Dialog><DialogTrigger asChild><Button>检查弹窗</Button></DialogTrigger><DialogContent><DialogTitle>共享弹窗回归</DialogTitle><p>弹窗保持可关闭。</p></DialogContent></Dialog>
      <Popover><PopoverTrigger asChild><Button>检查浮层</Button></PopoverTrigger><PopoverContent>共享浮层回归</PopoverContent></Popover>
      <DropdownMenu><DropdownMenuTrigger asChild><Button>检查菜单</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>本地测试选项</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </section>
  </main>
}

