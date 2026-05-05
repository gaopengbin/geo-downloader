import { useEffect, useRef, useState, useCallback } from 'react'
import { Boxes, ChevronDown, ChevronUp, Pencil, RotateCcw, Settings2, Square as SquareIcon, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useSelectionStore, type LatLngRing, type MapBounds } from '@/store/selection-store'
import { useAppStore } from '@/store/app-store'
import { loadCesium } from '@/lib/cesium-loader'
import { invokeCommand, isTauriRuntime } from '@/lib/tauri'

// Cesium 全局类型简化（避免引入 @types/cesium 庞大依赖）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cesium = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Viewer = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Entity = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = any

type DrawMode = 'rect' | 'polygon' | null

function lngLatBounds(points: { lng: number; lat: number }[]): MapBounds {
  const lngs = points.map((p) => p.lng)
  const lats = points.map((p) => p.lat)
  return {
    west: Math.min(...lngs),
    east: Math.max(...lngs),
    south: Math.min(...lats),
    north: Math.max(...lats),
  }
}

export function CesiumCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const cesiumRef = useRef<Cesium | null>(null)
  const selectionEntityRef = useRef<Entity | null>(null)
  const tempEntitiesRef = useRef<Entity[]>([])
  const drawHandlerRef = useRef<Handler | null>(null)
  const drawPointsRef = useRef<{ lng: number; lat: number }[]>([])
  const drawModeRef = useRef<DrawMode>(null)
  const tilesetRef = useRef<Cesium | null>(null)
  const lastRevRef = useRef(-1)
  const suppressNextFlyRef = useRef(false)
  const mode = useAppStore((s) => s.mode)
  const visible = mode === 'tiles3d'

  const [status, setStatus] = useState({ coords: '经度: --  纬度: --', height: '高度: --' })
  const [drawMode, setDrawMode] = useState<DrawMode>(null)
  const [previewing, setPreviewing] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // 模型调控面板状态
  const [hasTileset, setHasTileset] = useState(false)
  const [ctrlCollapsed, setCtrlCollapsed] = useState(false)
  const [sse, setSse] = useState(8)
  const [opacity, setOpacity] = useState(100)
  const [offsetLng, setOffsetLng] = useState('0')
  const [offsetLat, setOffsetLat] = useState('0')
  const [offsetHeight, setOffsetHeight] = useState('0')
  const [showBV, setShowBV] = useState(false)

  // 仅在第一次显示时初始化（懒加载 Cesium）
  useEffect(() => {
    if (!visible || viewerRef.current || !containerRef.current) return

    let cancelled = false
    void (async () => {
      try {
        const Cesium = (await loadCesium()) as Cesium
        if (cancelled || !containerRef.current) return
        cesiumRef.current = Cesium

        const viewer = new Cesium.Viewer(containerRef.current, {
          baseLayer: new Cesium.ImageryLayer(
            new Cesium.OpenStreetMapImageryProvider({
              url: 'https://tile.openstreetmap.org/',
            }),
          ),
          terrainProvider: new Cesium.EllipsoidTerrainProvider(),
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          animation: false,
          timeline: false,
          fullscreenButton: false,
          vrButton: false,
          infoBox: false,
          selectionIndicator: false,
        })

        const credit = viewer.cesiumWidget.creditContainer
        if (credit) credit.style.display = 'none'

        // 状态栏：经纬度
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
        handler.setInputAction((movement: { endPosition: unknown }) => {
          const cartesian = viewer.camera.pickEllipsoid(
            movement.endPosition,
            viewer.scene.globe.ellipsoid,
          )
          if (cartesian) {
            const carto = Cesium.Cartographic.fromCartesian(cartesian)
            const lng = Cesium.Math.toDegrees(carto.longitude)
            const lat = Cesium.Math.toDegrees(carto.latitude)
            setStatus((prev) => ({
              ...prev,
              coords: `经度: ${lng.toFixed(6)}  纬度: ${lat.toFixed(6)}`,
            }))
          } else {
            setStatus((prev) => ({ ...prev, coords: '经度: --  纬度: --' }))
          }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

        viewer.camera.percentageChanged = 0.01
        viewer.camera.changed.addEventListener(() => {
          const height = viewer.camera.positionCartographic.height
          if (height !== undefined) {
            const km = height > 1000 ? `${(height / 1000).toFixed(1)} km` : `${height.toFixed(0)} m`
            setStatus((prev) => ({ ...prev, height: `高度: ${km}` }))
          }
        })

        viewerRef.current = viewer
        setReady(true)
      } catch (e) {
        console.error('CesiumJS 加载失败', e)
        setError('CesiumJS 加载失败，请检查网络连接')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [visible])

  // 同步 selectionStore → Cesium 选区显示
  useEffect(() => {
    if (!ready || !viewerRef.current || !cesiumRef.current) return

    const unsub = useSelectionStore.subscribe((state) => {
      if (state.externalRevision === lastRevRef.current) return
      lastRevRef.current = state.externalRevision
      const fly = !suppressNextFlyRef.current
      suppressNextFlyRef.current = false
      drawSelection(state.bounds, state.polygon, fly)
    })
    // 立即同步一次当前状态
    const cur = useSelectionStore.getState()
    lastRevRef.current = cur.externalRevision
    drawSelection(cur.bounds, cur.polygon, false)

    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  function drawSelection(bounds: MapBounds | null, polygon: LatLngRing[] | null, fly: boolean) {
    const Cesium = cesiumRef.current
    const viewer = viewerRef.current
    if (!Cesium || !viewer) return

    if (selectionEntityRef.current) {
      viewer.entities.remove(selectionEntityRef.current)
      selectionEntityRef.current = null
    }

    if (polygon && polygon.length > 0 && polygon[0].length >= 3) {
      const coords: number[] = []
      polygon[0].forEach((p) => coords.push(p.lng, p.lat))
      selectionEntityRef.current = viewer.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(coords),
          material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.25),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
          outlineWidth: 2,
        },
      })
      if (fly) {
        const lngs = polygon[0].map((p) => p.lng)
        const lats = polygon[0].map((p) => p.lat)
        viewer.camera.flyTo({
          destination: Cesium.Rectangle.fromDegrees(
            Math.min(...lngs),
            Math.min(...lats),
            Math.max(...lngs),
            Math.max(...lats),
          ),
          duration: 1.2,
        })
      }
    } else if (bounds) {
      const { west, south, east, north } = bounds
      selectionEntityRef.current = viewer.entities.add({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
          material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.25),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
          outlineWidth: 2,
        },
      })
      if (fly) {
        viewer.camera.flyTo({
          destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
          duration: 1.2,
        })
      }
    }
  }

  function clearTempEntities() {
    const viewer = viewerRef.current
    if (!viewer) return
    tempEntitiesRef.current.forEach((e) => viewer.entities.remove(e))
    tempEntitiesRef.current = []
  }

  function cancelDraw() {
    if (drawHandlerRef.current) {
      drawHandlerRef.current.destroy()
      drawHandlerRef.current = null
    }
    drawModeRef.current = null
    drawPointsRef.current = []
    setDrawMode(null)
    clearTempEntities()
    setHint(null)
    if (viewerRef.current) viewerRef.current.canvas.style.cursor = ''
  }

  function startDraw(mode: 'rect' | 'polygon') {
    const Cesium = cesiumRef.current
    const viewer = viewerRef.current
    if (!Cesium || !viewer) return

    cancelDraw()
    drawModeRef.current = mode
    drawPointsRef.current = []
    setDrawMode(mode)
    setHint(
      mode === 'rect'
        ? '在地球上点击两个角点绘制矩形（右键取消）'
        : '在地球上点击绘制多边形顶点，双击或右键结束（右键取消）',
    )
    viewer.canvas.style.cursor = 'crosshair'

    // 优先拾取 3D Tiles 表面，其次地形/椭球
    const pickPoint = (pos: unknown): unknown => {
      if (tilesetRef.current && viewer.scene.pickPositionSupported) {
        const picked = viewer.scene.pickPosition(pos as never)
        if (
          Cesium.defined(picked) &&
          !Cesium.Cartesian3.equals(picked, Cesium.Cartesian3.ZERO)
        ) {
          return picked
        }
      }
      return viewer.camera.pickEllipsoid(pos as never, viewer.scene.globe.ellipsoid)
    }

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)
    drawHandlerRef.current = handler

    handler.setInputAction((click: { position: unknown }) => {
      const cartesian = pickPoint(click.position)
      if (!cartesian) return
      const carto = Cesium.Cartographic.fromCartesian(cartesian)
      const lng = Cesium.Math.toDegrees(carto.longitude)
      const lat = Cesium.Math.toDegrees(carto.latitude)
      drawPointsRef.current.push({ lng, lat })

      const pointEntity = viewer.entities.add({
        position: cartesian,
        point: {
          pixelSize: 8,
          color: Cesium.Color.fromCssColorString('#3B82F6'),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      tempEntitiesRef.current.push(pointEntity)

      if (drawModeRef.current === 'rect' && drawPointsRef.current.length === 2) {
        finishDraw()
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    if (mode === 'polygon') {
      handler.setInputAction(() => {
        if (drawPointsRef.current.length >= 3) finishDraw()
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    }

    handler.setInputAction((movement: { endPosition: unknown }) => {
      if (drawPointsRef.current.length === 0) return
      const cartesian = pickPoint(movement.endPosition)
      if (!cartesian) return
      const carto = Cesium.Cartographic.fromCartesian(cartesian)
      const lng = Cesium.Math.toDegrees(carto.longitude)
      const lat = Cesium.Math.toDegrees(carto.latitude)
      updatePreview(lng, lat)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction(() => {
      cancelDraw()
      setHint('绘制已取消')
      window.setTimeout(() => setHint(null), 1500)
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
  }

  function updatePreview(curLng: number, curLat: number) {
    const Cesium = cesiumRef.current
    const viewer = viewerRef.current
    if (!Cesium || !viewer) return

    tempEntitiesRef.current = tempEntitiesRef.current.filter((e) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((e as any)._isPreview) {
        viewer.entities.remove(e)
        return false
      }
      return true
    })

    if (drawModeRef.current === 'rect' && drawPointsRef.current.length === 1) {
      const p = drawPointsRef.current[0]
      const positions = Cesium.Cartesian3.fromDegreesArray([
        p.lng, p.lat,
        curLng, p.lat,
        curLng, curLat,
        p.lng, curLat,
      ])
      const e = viewer.entities.add({
        polygon: {
          hierarchy: positions,
          material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.2),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
          outlineWidth: 2,
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(e as any)._isPreview = true
      tempEntitiesRef.current.push(e)
    } else if (drawModeRef.current === 'polygon' && drawPointsRef.current.length >= 1) {
      const coords: number[] = []
      drawPointsRef.current.forEach((p) => coords.push(p.lng, p.lat))
      coords.push(curLng, curLat)
      if (coords.length >= 6) {
        const e = viewer.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(coords),
            material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.15),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
            outlineWidth: 2,
          },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(e as any)._isPreview = true
        tempEntitiesRef.current.push(e)
      }
    }
  }

  function finishDraw() {
    const points = drawPointsRef.current.slice()
    const mode = drawModeRef.current

    let bounds: MapBounds | null = null
    let polygon: LatLngRing[] | null = null

    if (mode === 'rect' && points.length === 2) {
      bounds = lngLatBounds(points)
      polygon = null
    } else if (mode === 'polygon' && points.length >= 3) {
      polygon = [points.map((p) => ({ lat: p.lat, lng: p.lng }))]
      bounds = lngLatBounds(points)
    }

    // 清理绘制状态
    if (drawHandlerRef.current) {
      drawHandlerRef.current.destroy()
      drawHandlerRef.current = null
    }
    drawModeRef.current = null
    drawPointsRef.current = []
    clearTempEntities()
    setDrawMode(null)
    setHint(null)
    if (viewerRef.current) viewerRef.current.canvas.style.cursor = ''

    if (bounds || polygon) {
      // 绘制完成后不重新定位相机：抑制下一次订阅回调中的 flyTo
      suppressNextFlyRef.current = true
      // 写入 selection store，会触发本组件 + Leaflet 重绘（lastRevRef 拦截避免循环）
      useSelectionStore.getState().setExternalSelection({ bounds, polygon })
    }
  }

  // 模型调控：SSE 实时生效
  useEffect(() => {
    if (!hasTileset || !tilesetRef.current) return
    tilesetRef.current.maximumScreenSpaceError = sse
  }, [sse, hasTileset])

  // 模型调控：透明度实时生效
  useEffect(() => {
    if (!hasTileset || !tilesetRef.current || !cesiumRef.current) return
    const Cesium = cesiumRef.current
    if (opacity >= 100) {
      tilesetRef.current.style = undefined
    } else {
      tilesetRef.current.style = new Cesium.Cesium3DTileStyle({
        color: `color("white", ${opacity / 100})`,
      })
    }
  }, [opacity, hasTileset])

  // 模型调控：包围盒实时生效
  useEffect(() => {
    if (!hasTileset || !tilesetRef.current) return
    tilesetRef.current.debugShowBoundingVolume = showBV
  }, [showBV, hasTileset])

  const applyOffset = useCallback(() => {
    const Cesium = cesiumRef.current
    const tileset = tilesetRef.current
    if (!Cesium || !tileset) return
    const lng = Number(offsetLng) || 0
    const lat = Number(offsetLat) || 0
    const h = Number(offsetHeight) || 0
    if (lng === 0 && lat === 0 && h === 0) {
      tileset.modelMatrix = Cesium.Matrix4.IDENTITY.clone()
      return
    }
    const center = tileset.boundingSphere.center
    const cart = Cesium.Cartographic.fromCartesian(center)
    const newCart = new Cesium.Cartographic(
      cart.longitude + Cesium.Math.toRadians(lng),
      cart.latitude + Cesium.Math.toRadians(lat),
      cart.height + h,
    )
    const oldT = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartographic.toCartesian(cart))
    const newT = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartographic.toCartesian(newCart))
    const inverseOld = Cesium.Matrix4.inverse(oldT, new Cesium.Matrix4())
    const offsetMatrix = Cesium.Matrix4.multiply(newT, inverseOld, new Cesium.Matrix4())
    tileset.modelMatrix = offsetMatrix
    toast.success('已应用位置偏移')
  }, [offsetLng, offsetLat, offsetHeight])

  const resetControls = useCallback(() => {
    setSse(8)
    setOpacity(100)
    setOffsetLng('0')
    setOffsetLat('0')
    setOffsetHeight('0')
    setShowBV(false)
    const Cesium = cesiumRef.current
    const tileset = tilesetRef.current
    if (Cesium && tileset) {
      tileset.maximumScreenSpaceError = 8
      tileset.style = undefined
      tileset.modelMatrix = Cesium.Matrix4.IDENTITY.clone()
      tileset.debugShowBoundingVolume = false
    }
  }, [])

  const loadTilesetFromUrl = useCallback(
    async (tilesetUrl: string, opts?: { silent?: boolean }) => {
      if (!cesiumRef.current || !viewerRef.current) {
        if (!opts?.silent) toast.error('Cesium 尚未就绪')
        return
      }
      const Cesium = cesiumRef.current
      const viewer = viewerRef.current
      try {
        if (tilesetRef.current) {
          viewer.scene.primitives.remove(tilesetRef.current)
          tilesetRef.current = null
        }
        const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl)
        tilesetRef.current = viewer.scene.primitives.add(tileset)
        tileset.maximumScreenSpaceError = sse
        tileset.debugShowBoundingVolume = showBV
        if (opacity < 100) {
          tileset.style = new Cesium.Cesium3DTileStyle({
            color: `color("white", ${opacity / 100})`,
          })
        }
        viewer.zoomTo(tileset)
        setHasTileset(true)
        if (!opts?.silent) toast.success('3D Tiles 加载成功')
      } catch (e) {
        console.error('3D Tiles 加载失败', e)
        if (!opts?.silent) toast.error('加载失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [sse, opacity, showBV],
  )

  const loadTilesetFromIon = useCallback(
    async (assetId: number, accessToken: string, opts?: { silent?: boolean }) => {
      if (!cesiumRef.current || !viewerRef.current) {
        if (!opts?.silent) toast.error('Cesium 尚未就绪')
        return
      }
      const Cesium = cesiumRef.current
      const viewer = viewerRef.current
      try {
        if (tilesetRef.current) {
          viewer.scene.primitives.remove(tilesetRef.current)
          tilesetRef.current = null
        }
        const resource = await Cesium.IonResource.fromAssetId(assetId, { accessToken })
        const tileset = await Cesium.Cesium3DTileset.fromUrl(resource)
        tilesetRef.current = viewer.scene.primitives.add(tileset)
        tileset.maximumScreenSpaceError = sse
        tileset.debugShowBoundingVolume = showBV
        if (opacity < 100) {
          tileset.style = new Cesium.Cesium3DTileStyle({
            color: `color("white", ${opacity / 100})`,
          })
        }
        viewer.zoomTo(tileset)
        setHasTileset(true)
        if (!opts?.silent) toast.success('Cesium Ion 模型加载成功')
      } catch (e) {
        console.error('Cesium Ion 加载失败', e)
        if (!opts?.silent)
          toast.error('Ion 加载失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [sse, opacity, showBV],
  )

  // 监听全局预览请求（来自 tiles3d-page 解析成功后）
  useEffect(() => {
    if (!ready) return
    function onPreview(ev: Event) {
      const detail = (ev as CustomEvent).detail as
        | { type: 'url'; url: string }
        | { type: 'ion'; assetId: number; accessToken: string }
        | undefined
      if (!detail) return
      if (detail.type === 'url') {
        void loadTilesetFromUrl(detail.url)
      } else if (detail.type === 'ion') {
        void loadTilesetFromIon(detail.assetId, detail.accessToken)
      }
    }
    window.addEventListener('gd:preview-tileset', onPreview)
    return () => window.removeEventListener('gd:preview-tileset', onPreview)
  }, [ready, loadTilesetFromUrl, loadTilesetFromIon])

  async function handlePreviewLocal() {
    if (!isTauriRuntime()) {
      toast.error('本地预览仅在桌面应用中可用')
      return
    }
    if (!ready || !cesiumRef.current || !viewerRef.current) {
      toast.error('Cesium 尚未就绪')
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const filePath = await open({
        filters: [{ name: 'Tileset JSON', extensions: ['json'] }],
        multiple: false,
        title: '选择 tileset.json',
      })
      if (!filePath || typeof filePath !== 'string') return

      setPreviewing(true)
      const dirIdx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
      const dirPath = filePath.substring(0, dirIdx)
      const fileName = filePath.substring(dirIdx + 1)
      const baseUrl = await invokeCommand<string>('serve_local_tiles', { dirPath })
      const tilesetUrl = baseUrl + '/' + encodeURIComponent(fileName)
      await loadTilesetFromUrl(tilesetUrl)
    } catch (e) {
      console.error('本地 3D Tiles 加载失败', e)
      toast.error('加载失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div
      className="absolute inset-0"
      style={{ display: visible ? 'block' : 'none' }}
      aria-hidden={!visible}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="rounded-md border bg-background p-4 text-sm text-destructive shadow">
            {error}
          </div>
        </div>
      )}

      {/* 绘制工具栏 */}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1 rounded-md border bg-background/95 p-1 shadow-sm backdrop-blur">
        <Button
          variant={drawMode === 'rect' ? 'default' : 'ghost'}
          size="sm"
          className="h-8 justify-start gap-2 px-2 text-xs"
          onClick={() => startDraw('rect')}
          disabled={!ready}
          title="矩形选区"
        >
          <SquareIcon className="size-3.5" />
          矩形
        </Button>
        <Button
          variant={drawMode === 'polygon' ? 'default' : 'ghost'}
          size="sm"
          className="h-8 justify-start gap-2 px-2 text-xs"
          onClick={() => startDraw('polygon')}
          disabled={!ready}
          title="多边形选区"
        >
          <Pencil className="size-3.5" />
          多边形
        </Button>
        <div className="my-0.5 h-px bg-border" />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 justify-start gap-2 px-2 text-xs"
          onClick={handlePreviewLocal}
          disabled={!ready || previewing}
          title="预览本地 3D Tiles 模型"
        >
          <FolderOpen className="size-3.5" />
          {previewing ? '加载中...' : '预览本地'}
        </Button>
      </div>

      {/* 提示条 */}
      {hint && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border bg-background/95 px-3 py-1 text-xs text-foreground shadow backdrop-blur">
          {hint}
        </div>
      )}

      {/* 模型调控面板：仅在 tileset 加载后显示 */}
      {hasTileset && (
        <div className="absolute right-3 top-44 z-10 w-60 rounded-md border bg-background/95 shadow-sm backdrop-blur">
          <button
            type="button"
            onClick={() => setCtrlCollapsed((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-xs font-medium hover:bg-accent/50"
          >
            <span className="flex items-center gap-1.5">
              <Settings2 className="size-3.5" />
              模型调控
            </span>
            {ctrlCollapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          {!ctrlCollapsed && (
            <div className="space-y-3 border-t p-2.5 text-xs">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">显示精度</Label>
                  <span className="font-mono text-xs text-primary">{sse}</span>
                </div>
                <Slider
                  min={1}
                  max={64}
                  step={1}
                  value={[sse]}
                  onValueChange={(v) => setSse(v[0] ?? 8)}
                />
                <p className="text-[10px] text-muted-foreground">值越小越精细，性能开销越大</p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">透明度</Label>
                  <span className="font-mono text-xs text-primary">{opacity}%</span>
                </div>
                <Slider
                  min={0}
                  max={100}
                  step={5}
                  value={[opacity]}
                  onValueChange={(v) => setOpacity(v[0] ?? 100)}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">位置偏移</Label>
                <div className="grid grid-cols-3 gap-1">
                  <Input
                    type="number"
                    value={offsetLng}
                    onChange={(e) => setOffsetLng(e.target.value)}
                    step="0.0001"
                    className="h-7 px-1.5 text-[11px]"
                    placeholder="经度°"
                    title="经度偏移 (°)"
                  />
                  <Input
                    type="number"
                    value={offsetLat}
                    onChange={(e) => setOffsetLat(e.target.value)}
                    step="0.0001"
                    className="h-7 px-1.5 text-[11px]"
                    placeholder="纬度°"
                    title="纬度偏移 (°)"
                  />
                  <Input
                    type="number"
                    value={offsetHeight}
                    onChange={(e) => setOffsetHeight(e.target.value)}
                    step="1"
                    className="h-7 px-1.5 text-[11px]"
                    placeholder="高度m"
                    title="高度偏移 (m)"
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 w-full text-xs"
                  onClick={applyOffset}
                >
                  应用位置偏移
                </Button>
              </div>

              <div className="flex items-center justify-between border-t pt-2">
                <Label htmlFor="cesium-bv" className="text-xs">显示包围盒</Label>
                <Switch id="cesium-bv" checked={showBV} onCheckedChange={setShowBV} />
              </div>

              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full gap-1 text-xs"
                onClick={resetControls}
              >
                <RotateCcw className="size-3" />
                重置
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 状态栏 */}
      <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center gap-2 rounded-md border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur tabular-nums">
        <span>{status.coords}</span>
        <span>·</span>
        <span>{status.height}</span>
      </div>

      {!ready && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
          <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            <Boxes className="size-3.5 animate-pulse" />
            正在加载 CesiumJS...
          </div>
        </div>
      )}
    </div>
  )
}
