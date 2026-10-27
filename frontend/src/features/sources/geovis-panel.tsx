import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { invokeCommand } from '@/lib/tauri'

interface GeovisCapability {
  id: string
  name: string
  available: boolean
  code: number | null
  message: string
}

interface GeovisStatus {
  configured: boolean
  checked_at: string | null
  capabilities: GeovisCapability[]
}

export function GeovisPanel() {
  const { i18n } = useTranslation()
  const en = i18n.resolvedLanguage?.startsWith('en') === true
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const status = useQuery({ queryKey: ['geovis-status'], queryFn: () => invokeCommand<GeovisStatus>('geovis_status') })
  const refreshSources = () => {
    for (const queryKey of [['geovis-status'], ['tile-sources-merged'], ['builtin-sources']]) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
  const verify = useMutation({
    mutationFn: async (save: boolean) => {
      if (save) {
        await invokeCommand('geovis_set_token', { token: key.trim() })
        setKey('')
      }
      return invokeCommand<GeovisStatus>('geovis_probe_access')
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['geovis-status'], data)
      refreshSources()
      toast.success(en ? 'Geovis permissions checked' : '星图接口权限已验证')
    },
    onError: (error) => { refreshSources(); toast.error(String(error)) },
  })
  const remove = useMutation({
    mutationFn: () => invokeCommand('geovis_delete_token'),
    onSuccess: () => { setConfirmDelete(false); refreshSources(); toast.success(en ? 'Key removed' : '星图 Key 已移除') },
    onError: (error) => toast.error(String(error)),
  })
  const pending = verify.isPending || remove.isPending
  return (
    <section className="space-y-4" aria-label={en ? 'Geovis authorization' : '星图授权'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium"><KeyRound className="size-4" />{en ? 'Geovis Earth' : '星图地球'}</div>
        <Badge variant="outline">{status.data?.configured ? (en ? 'Key saved' : 'Key 已安全保存') : (en ? 'Not connected' : '未连接')}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {en ? 'Connect your own Key. Only imagery that passes the permission and image checks appears in the source list.' : '使用自己的 Key 连接星图。只有接口权限和真实瓦片验证通过的影像，才会加入图源列表。'}
      </p>
      <div className="space-y-2">
        <Label htmlFor="geovis-key">{en ? 'Geovis Key' : '星图 Key'}</Label>
        <Input id="geovis-key" type="password" autoComplete="off" spellCheck={false} value={key}
          onChange={(e) => setKey(e.target.value)} disabled={pending}
          placeholder={status.data?.configured ? (en ? 'Enter a replacement Key' : '输入新 Key 可替换当前授权') : (en ? 'Enter your Key' : '请输入星图 Key')} />
        <p className="text-xs text-muted-foreground">{en ? 'Stored in the system credential manager. It is never included in source URLs or settings files.' : '密钥保存在系统凭据库，不写入图源地址或设置文件。'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!key.trim() || pending} onClick={() => verify.mutate(true)}>
          {verify.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <KeyRound className="mr-2 size-4" />}
          {en ? 'Save and verify' : '保存并验证'}
        </Button>
        <Button size="sm" variant="outline" disabled={!status.data?.configured || pending} onClick={() => verify.mutate(false)}>
          <RefreshCw className="mr-2 size-4" />{en ? 'Check permissions' : '重新检测权限'}
        </Button>
        {status.data?.configured && <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
          if (confirmDelete) remove.mutate()
          else setConfirmDelete(true)
        }}><Trash2 className="mr-2 size-4" />{confirmDelete ? (en ? 'Confirm removal' : '确认移除') : (en ? 'Remove Key' : '移除 Key')}</Button>}
      </div>
      {status.isLoading && <p className="flex items-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />{en ? 'Reading connection…' : '正在读取授权状态…'}</p>}
      {status.error && <p role="alert" className="text-sm text-destructive">{String(status.error)}</p>}
      {status.data?.configured && status.data.capabilities.length === 0 && <p className="text-sm text-muted-foreground">{en ? 'Check permissions to discover available imagery.' : '点击“重新检测权限”，发现当前 Key 可使用的影像。'}</p>}
      {status.data?.capabilities.map((item) => (
        <div key={item.id} className="flex items-start gap-3 rounded-md border p-3">
          {item.available ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
              <span>{en ? ({ geovis_2025: '2025 imagery', geovis_2021: '2021 historical imagery', geovis_2022: '2022 historical imagery', geovis_city_history: 'City history catalog' }[item.id] ?? item.name) : item.name}</span>
              <Badge variant="outline">{item.available ? (en ? 'Verified' : '验证通过') : (item.code === 128 ? (en ? 'Permission required' : '未开通权限') : (en ? 'Unavailable' : '暂不可用'))}</Badge>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{en ? (item.available ? 'Provider response verified.' : item.code === 128 ? 'Enable this API for your Key in the Geovis console.' : `Verification failed${item.code == null ? '' : ` (${item.code})`}. Check your Key and API access.`) : item.message}</p>
          </div>
        </div>
      ))}
      {status.data?.checked_at && <p className="text-xs text-muted-foreground">{en ? 'Last checked: ' : '最近检测：'}{new Date(status.data.checked_at).toLocaleString(en ? 'en-US' : 'zh-CN')}</p>}
      <p className="text-xs leading-5 text-muted-foreground">{en ? 'The year identifies a provider basemap version, not the capture date of every pixel. Global coverage is available up to level 16 for 2025 and level 13 for 2021/2022; higher levels cover mainland China. API quotas and permitted uses follow your Geovis account.' : '年份表示供应商底图版本，不代表每个位置的拍摄日期。2025 影像全球至 16 级，2021/2022 历史影像全球至 13 级，更高级别覆盖中国大陆。调用额度及使用范围以你的星图账户权益为准。'}</p>
      <div className="flex flex-wrap gap-4">
        <a href="https://open.geovisearth.com/console/key" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">{en ? 'Manage Key permissions' : '管理 Key 权限'}<ExternalLink className="size-3.5" /></a>
        <a href="https://open.geovisearth.com/map/select?productId=1706" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">{en ? 'View historical API plans' : '查看历史影像接口权益'}<ExternalLink className="size-3.5" /></a>
      </div>
    </section>
  )
}
