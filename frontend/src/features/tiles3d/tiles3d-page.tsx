import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Box, Download, FolderOpen, Globe, Key, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { isTauriRuntime } from '@/lib/tauri'
import { PanelSection } from '@/components/layout/panel-section'
import { StatCard, StatRow } from '@/components/layout/stat-card'
import { RegionSelector } from '@/features/region/region-selector'
import { useMultiFeatureSubmit } from '@/features/region/use-multi-feature-submit'
import { DispatchModeRadio } from '@/features/region/dispatch-mode-radio'
import { getSettings, saveSettings } from '@/features/settings/settings-api'
import { useSelectionStore } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'

import {
  analyze3dTiles,
  create3dTilesTask,
  estimate3dTiles,
} from './tiles3d-api'
import type {
  Tiles3dEstimate,
  Tiles3dSource,
  TilesetSummary,
} from '@/types/api'

type SourceMode = 'url' | 'ion'

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'feature'
}

function joinPath(dir: string, sub: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${sub}` : `${dir}${sep}${sub}`
}

function timestampNow() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function buildPolygonCoords(): number[][] | null {
  const { bounds, polygon } = useSelectionStore.getState()
  if (polygon && polygon.length > 0) {
    return polygon[0].map((p) => [p.lng, p.lat])
  }
  if (bounds) {
    return [
      [bounds.west, bounds.south],
      [bounds.west, bounds.north],
      [bounds.east, bounds.north],
      [bounds.east, bounds.south],
      [bounds.west, bounds.south],
    ]
  }
  return null
}

export function Tiles3dPage() {
  const { t, i18n } = useTranslation()
  const inTauri = isTauriRuntime()
  const qc = useQueryClient()

  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)

  const [sourceMode, setSourceMode] = useState<SourceMode>('url')
  const [tilesetUrl, setTilesetUrl] = useState('')
  const [referer, setReferer] = useState('')
  const [assetId, setAssetId] = useState<string>('')
  const [ionToken, setIonToken] = useState('')
  const [summary, setSummary] = useState<TilesetSummary | null>(null)
  const [estimate, setEstimate] = useState<Tiles3dEstimate | null>(null)
  const [taskName, setTaskName] = useState('')
  const [saveDir, setSaveDir] = useState('')

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    enabled: inTauri,
  })

  const concurrency = settingsQuery.data?.default_concurrency ?? 50

  // 初始化 Ion token 从 settings
  useEffect(() => {
    const token = settingsQuery.data?.cesium_ion_token
    if (typeof token === 'string' && token && !ionToken) {
      setIonToken(token)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsQuery.data])

  const proxy =
    settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
      ? settingsQuery.data.proxy_url
      : null

  const source: Tiles3dSource | null = useMemo(() => {
    if (sourceMode === 'ion') {
      const id = Number(assetId)
      if (!id || !ionToken.trim()) return null
      return { type: 'cesium_ion', asset_id: id, access_token: ionToken.trim() }
    }
    const url = tilesetUrl.trim()
    if (!url) return null
    const headers: Record<string, string> = {}
    if (referer.trim()) headers['Referer'] = referer.trim()
    return { type: 'url', tileset_url: url, headers }
  }, [sourceMode, tilesetUrl, referer, assetId, ionToken])

  const persistIonToken = async () => {
    if (!settingsQuery.data) return
    const trimmed = ionToken.trim()
    if (settingsQuery.data.cesium_ion_token === trimmed) return
    try {
      await saveSettings({ ...settingsQuery.data, cesium_ion_token: trimmed || null })
      qc.invalidateQueries({ queryKey: ['settings'] })
    } catch (e) {
      console.warn(t('tiles3d.ionTokenSaveFailed'), e)
    }
  }

  // 解析
  const analyzeMutation = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error(t('tiles3d.sourceRequired'))
      setSummary(null)
      setEstimate(null)
      return analyze3dTiles(source, proxy)
    },
    onSuccess: async (s) => {
      setSummary(s)
      // 自动估算
      const coords = buildPolygonCoords()
      if (coords && coords.length >= 3 && source) {
        try {
          const est = await estimate3dTiles(source, coords, proxy)
          setEstimate(est)
        } catch (e) {
          console.warn(t('tiles3d.estimateFailed'), e)
        }
      }
      // 自动在 Cesium viewer 中预览
      if (source) {
        if (source.type === 'cesium_ion') {
          window.dispatchEvent(
            new CustomEvent('gd:preview-tileset', {
              detail: {
                type: 'ion',
                assetId: source.asset_id,
                accessToken: source.access_token,
              },
            }),
          )
        } else if (source.type === 'url') {
          window.dispatchEvent(
            new CustomEvent('gd:preview-tileset', {
              detail: { type: 'url', url: source.tileset_url },
            }),
          )
        }
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('tiles3d.analyzeFailed', { message: msg }))
    },
  })

  // 手动估算（已改为自动，仅保留 “刷新” 能力） - 移除后不再需要

  // 下载
  const downloadMutation = useMutation({
    mutationFn: async (args: { saveDir: string; nameOverride?: string }) => {
      if (!source) throw new Error(t('tiles3d.sourceRequired'))
      const coords = buildPolygonCoords()
      const baseName = taskName.trim() || `3dtiles_${timestampNow()}`
      const finalTaskName = args.nameOverride
        ? `${baseName} - ${args.nameOverride}`
        : baseName
      // 始终在保存目录下追加唯一子目录，避免重名覆盖
      const subDirBase = args.nameOverride
        ? `${sanitizeName(baseName)}_${sanitizeName(args.nameOverride)}`
        : sanitizeName(baseName)
      const subDirName = `${subDirBase}_${timestampNow()}`
      const savePath = joinPath(args.saveDir, subDirName)
      const result = await create3dTilesTask(
        {
          source,
          polygon: coords && coords.length >= 3 ? coords : null,
          save_path: savePath,
          concurrency,
          proxy,
        },
        finalTaskName,
      )
      return result
    },
    onSuccess: () => {
      toast.success(t('tiles3d.taskCreated'))
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(t('tiles3d.createTaskFailed', { message: msg }))
    },
  })

  const hasSelection = bounds != null || (polygon != null && polygon.length > 0)

  const dispatchCtx = useMultiFeatureSubmit()

  const onDownloadClick = async () => {
    if (!source) {
      toast.error(t('tiles3d.sourceRequired'))
      return
    }
    let dir = saveDir.trim()
    if (!dir) {
      const picked = await openDialog({
        directory: true,
        title: t('tiles3d.selectSaveDirectory'),
      })
      if (!picked) return
      dir = picked as string
      setSaveDir(dir)
    }
    if (!dir) return
    try {
      await dispatchCtx.runSubmit(async (perFeatureName) => {
        await downloadMutation.mutateAsync({
          saveDir: dir,
          nameOverride: perFeatureName,
        })
      })
    } catch {
      /* surfaced by mutation onError */
    }
  }

  const pickSaveDir = async () => {
    const dir = await openDialog({
      directory: true,
      title: t('tiles3d.selectSaveDirectory'),
    })
    if (dir) setSaveDir(dir as string)
  }

  // 自动估算：解析完成后，bounds / polygon 变化 400ms 后触发
  useEffect(() => {
    if (!summary || !source || !hasSelection) return
    const handle = window.setTimeout(() => {
      const coords = buildPolygonCoords()
      if (!coords || coords.length < 3) return
      estimate3dTiles(source, coords, proxy)
        .then((e) => setEstimate(e))
        .catch((e) => console.warn(t('tiles3d.estimateFailed'), e))
    }, 400)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, bounds, polygon, hasSelection])

  return (
    <div className="space-y-4">
      <RegionSelector />

      <PanelSection
        icon={Box}
        title={t('tiles3d.sourceTitle')}
        description={t('tiles3d.sourceDescription')}
        dataTour="tiles3d-source-section"
      >
        <Tabs value={sourceMode} onValueChange={(v) => setSourceMode(v as SourceMode)}>
          <TabsList className="grid h-8 w-full grid-cols-2" data-tour="tiles3d-source-tabs">
            <TabsTrigger value="url" className="text-xs">
              <Globe className="mr-1 size-3.5" />
              URL
            </TabsTrigger>
            <TabsTrigger value="ion" className="text-xs">
              <Key className="mr-1 size-3.5" />
              Cesium Ion
            </TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="mt-3 space-y-2">
            <div className="space-y-1.5">
              <Label className="text-xs">tileset.json URL</Label>
              <Input
                value={tilesetUrl}
                onChange={(e) => setTilesetUrl(e.target.value)}
                placeholder="https://example.com/path/tileset.json"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('tiles3d.referer')}</Label>
              <Input
                value={referer}
                onChange={(e) => setReferer(e.target.value)}
                placeholder="https://referer-host"
                className="h-8 text-xs"
              />
            </div>
          </TabsContent>

          <TabsContent value="ion" className="mt-3 space-y-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Asset ID</Label>
              <Input
                type="number"
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
                placeholder={t('tiles3d.assetIdPlaceholder')}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Access Token</Label>
              <Input
                value={ionToken}
                onChange={(e) => setIonToken(e.target.value)}
                onBlur={() => persistIonToken()}
                placeholder="Cesium Ion access token"
                className="h-8 text-xs"
                type="password"
              />
            </div>
          </TabsContent>
        </Tabs>

        <div className="space-y-3 border-t border-border/60 pt-3" data-tour="tiles3d-output-section">
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t('tiles3d.taskName')}{' '}
              <span className="text-muted-foreground">({t('common.optional')})</span>
            </Label>
            <Input
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              placeholder={t('tiles3d.taskNamePlaceholder')}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('tiles3d.saveDirectory')}</Label>
            <div className="flex gap-1.5">
              <Input
                value={saveDir}
                onChange={(e) => setSaveDir(e.target.value)}
                placeholder={t('tiles3d.saveDirectoryPlaceholder')}
                className="h-8 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8 shrink-0"
                title={t('tiles3d.selectSaveDirectory')}
                onClick={pickSaveDir}
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('tiles3d.saveDirectoryHint')}
            </p>
          </div>
        </div>

        {dispatchCtx.showModeSelector && (
          <DispatchModeRadio
            count={dispatchCtx.features?.length ?? 0}
            mode={dispatchCtx.mode}
            onChange={dispatchCtx.setMode}
          />
        )}

        <div className="flex flex-wrap gap-2" data-tour="tiles3d-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => analyzeMutation.mutate()}
            disabled={analyzeMutation.isPending || !source}
          >
            {analyzeMutation.isPending ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Search className="mr-1 size-3.5" />
            )}
            {t('tiles3d.analyze')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onDownloadClick}
            disabled={downloadMutation.isPending || !summary}
          >
            {downloadMutation.isPending ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 size-3.5" />
            )}
            {t('tiles3d.download')}
          </Button>
        </div>

        {summary && (
          <StatCard>
            <StatRow label={t('tiles3d.summary.totalTiles')} value={summary.total_tiles.toLocaleString(i18n.resolvedLanguage)} />
            <StatRow label={t('tiles3d.summary.contentTiles')} value={summary.content_tiles.toLocaleString(i18n.resolvedLanguage)} />
            <StatRow
              label={t('tiles3d.summary.maxDepth')}
              value={`${summary.max_depth} / ${summary.levels}`}
            />
            {summary.has_external_tilesets && (
              <div className="text-amber-600 dark:text-amber-400">
                {t('tiles3d.summary.externalTilesets')}
              </div>
            )}
            {summary.extent && (
              <div className="text-muted-foreground">
                {t('tiles3d.summary.extent', { value: summary.extent.map((n) => n.toFixed(4)).join(', ') })}
              </div>
            )}
          </StatCard>
        )}

        {estimate && (
          <StatCard>
            <StatRow label={t('tiles3d.summary.filteredTiles')} value={estimate.filtered_tiles.toLocaleString(i18n.resolvedLanguage)} />
            <StatRow label={t('tiles3d.summary.downloads')} value={estimate.content_tiles.toLocaleString(i18n.resolvedLanguage)} />
          </StatCard>
        )}

        <p className="text-[11px] text-muted-foreground">
          {t('tiles3d.localPreviewHint')}
        </p>
      </PanelSection>
    </div>
  )
}
