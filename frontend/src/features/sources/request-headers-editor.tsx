import { useEffect, useState } from 'react'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseHeaderRows, type HeaderRow } from './request-headers'

export function RequestHeadersEditor({ value, onChange, onError, disabled = false }: {
  value?: Record<string, string>
  onChange: (headers: Record<string, string>) => void
  onError: (error: string | null) => void
  disabled?: boolean
}) {
  const [rows, setRows] = useState<HeaderRow[]>(() => Object.entries(value ?? {})
    .map(([name, value]) => ({ id: crypto.randomUUID(), name, value })))
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { onError(null) }, [onError])

  function update(next: HeaderRow[]) {
    setRows(next)
    try {
      const headers = parseHeaderRows(next)
      setError(null)
      onError(null)
      onChange(headers)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      onError(message)
    }
  }

  return <div className="space-y-2 rounded-md border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Label>自定义请求头（可选）</Label>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant="ghost" aria-label={visible ? '隐藏请求头值' : '显示请求头值'}
          onClick={() => setVisible(!visible)}>
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || rows.length >= 64}
          onClick={() => update([...rows, { id: crypto.randomUUID(), name: '', value: '' }])}>
          <Plus className="mr-1 size-4" />添加请求头
        </Button>
      </div>
    </div>
    {rows.map((row, index) => <div key={row.id} className="flex items-start gap-1.5">
      <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Input aria-label={`请求头 ${index + 1} 名称`} placeholder="Authorization / Referer" value={row.name}
          disabled={disabled} autoComplete="off" spellCheck={false} className="font-mono text-xs"
          onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} />
        <Input aria-label={`请求头 ${index + 1} 值`} placeholder="Bearer … / https://…" value={row.value}
          type={visible ? 'text' : 'password'} disabled={disabled} autoComplete="off" spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => update(rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} />
      </div>
      <Button type="button" size="icon" variant="ghost" aria-label={`删除请求头 ${index + 1}`} disabled={disabled}
        onClick={() => update(rows.filter((item) => item.id !== row.id))}><Trash2 className="size-4" /></Button>
    </div>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <p className="text-xs leading-5 text-muted-foreground">
      用于 Token、Cookie 或来源校验，测试、地图预览和下载共用。值随本机图源配置保存，请勿分享含凭证的配置。
    </p>
  </div>
}
