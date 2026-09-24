"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, MapPinned, Plus, Square, Trash2, Zap } from "lucide-react";
import { downloadBrowserImagery, planBrowserImagery, type Bounds, type ImageryPlan } from "../../lib/browser-imagery";
import { BROWSER_SOURCE, probeBrowserSource, readBrowserSources, saveBrowserSources, validateBrowserSource, type BrowserSource, type BrowserSourceStore } from "../../lib/browser-sources";
import { clipBounds, validateClipGeometry } from "../../lib/browser-clip";
import styles from "./browser.module.css";

type Tool = { name: string; description: string; inputSchema: object; annotations?: object; execute: (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<object> };
type ModelContext = { registerTool: (tool: Tool, options?: { signal?: AbortSignal }) => Promise<unknown> };
type SourceForm = { id: string; name: string; url: string; attribution: string; maxZoom: string; scheme: "xyz" | "tms"; subdomains: string };
const EMPTY_FORM: SourceForm = { id: "", name: "", url: "", attribution: "", maxZoom: "18", scheme: "xyz", subdomains: "" };
const EXAMPLES: { name: string; bounds: Bounds }[] = [{ name: "河南", bounds: [110.3, 31.3, 116.7, 36.5] }, { name: "四川", bounds: [97.3, 26.0, 108.5, 34.3] }];
const LABELS = ["西经度", "南纬度", "东经度", "北纬度"];
const KEYS = ["west", "south", "east", "north"];
const textError = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。";
const result = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const sourceView = (source: BrowserSource, defaultId: string) => ({ id: source.id, name: source.name, attribution: source.attribution, maxZoom: source.maxZoom, scheme: source.scheme, default: source.id === defaultId, kind: source.id === BROWSER_SOURCE.id ? "builtIn" : "custom" });
const requestSchema = { type: "object", properties: {
  west: { type: "number" }, south: { type: "number" }, east: { type: "number" }, north: { type: "number" },
  zoom: { type: "integer", minimum: 0, maximum: 22 }, sourceId: { type: "string", description: "geod_browser_sources list 返回的图源 ID；省略时使用页面当前图源" },
  clipGeometry: { type: "object", description: "可选的 WGS84 GeoJSON Polygon 或 MultiPolygon；边界外像素透明，ZIP 附带 clip.geojson", properties: {
    type: { type: "string", enum: ["Polygon", "MultiPolygon"] }, coordinates: { type: "array" },
  }, required: ["type", "coordinates"], additionalProperties: false },
}, required: ["west", "south", "east", "north", "zoom"], additionalProperties: false };
const sourcesSchema = { type: "object", properties: {
  action: { type: "string", enum: ["list", "register", "update", "remove", "default", "probe"] }, id: { type: "string" },
  name: { type: "string" }, url: { type: "string", description: "用户获授权的 HTTPS 瓦片模板，只保存在当前浏览器" },
  attribution: { type: "string" }, maxZoom: { type: "integer", minimum: 0, maximum: 22 }, scheme: { type: "string", enum: ["xyz", "tms"] },
  subdomains: { type: "array", items: { type: "string" }, maxItems: 8 }, zoom: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" },
}, required: ["action"], additionalProperties: false };

function planSummary(plan: ImageryPlan) {
  return { sourceId: plan.sourceId, source: plan.source, attribution: plan.attribution, bounds: plan.bounds, zoom: plan.zoom,
    tileCount: plan.tiles, width: plan.width, height: plan.height,
    clip: plan.clipGeometry ? `${plan.clipGeometry.type}；边界外透明，附带 clip.geojson` : "无多边形裁剪",
    execution: "当前浏览器直接从所选图源下载、拼接并裁剪；GeoD 服务器不处理影像。" };
}

export default function BrowserImagery() {
  const [values, setValues] = useState(["110.3", "31.3", "116.7", "36.5"]);
  const [zoom, setZoom] = useState(7);
  const [clipText, setClipText] = useState("");
  const [store, setStore] = useState<BrowserSourceStore>({ defaultSourceId: BROWSER_SOURCE.id, customSources: [] });
  const storeRef = useRef(store);
  const [activeId, setActiveId] = useState(BROWSER_SOURCE.id);
  const activeRef = useRef(BROWSER_SOURCE.id);
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [sourceMessage, setSourceMessage] = useState("");
  const [message, setMessage] = useState("");
  const [plan, setPlan] = useState<ImageryPlan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<{ preview: string; archive: string; source: string; clipped: boolean } | null>(null);
  const [webMcpStatus, setWebMcpStatus] = useState("检测中");
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const urlsRef = useRef<string[]>([]);

  const clearReady = useCallback(() => { for (const url of urlsRef.current) URL.revokeObjectURL(url); urlsRef.current = []; setReady(null); }, []);
  const sourceById = useCallback((id: string) => {
    const found = [BROWSER_SOURCE, ...storeRef.current.customSources].find(source => source.id === id);
    if (!found) throw new Error(`未找到图源 ${id}；先调用 geod_browser_sources list。`);
    return found;
  }, []);
  const chooseSource = useCallback((id: string) => {
    sourceById(id); activeRef.current = id; setActiveId(id); setPlan(null); clearReady();
  }, [clearReady, sourceById]);
  const persist = useCallback((next: BrowserSourceStore) => {
    const saved = saveBrowserSources(next); storeRef.current = saved; setStore(saved); setPlan(null); clearReady(); return saved;
  }, [clearReady]);

  useEffect(() => {
    const saved = readBrowserSources(); storeRef.current = saved; setStore(saved);
    activeRef.current = saved.defaultSourceId; setActiveId(saved.defaultSourceId);
  }, []);

  const makePlan = useCallback((bounds: Bounds, level: number, sourceId: string, clipGeometry?: unknown) =>
    planBrowserImagery(bounds, level, sourceById(sourceId), clipGeometry), [sourceById]);
  const toolPlan = useCallback((input: Record<string, unknown>) => {
    const bounds = [input.west, input.south, input.east, input.north];
    if (bounds.some(value => typeof value !== "number")) throw new Error("请提供数字格式的 west、south、east、north。");
    return makePlan(bounds as Bounds, input.zoom as number, typeof input.sourceId === "string" ? input.sourceId : activeRef.current, input.clipGeometry);
  }, [makePlan]);

  const runFetch = useCallback(async (next: ImageryPlan, externalSignal?: AbortSignal) => {
    if (busyRef.current) throw new Error("已有下载任务正在运行，请先等待或取消。");
    busyRef.current = true; setBusy(true); chooseSource(next.sourceId);
    setValues(next.bounds.map(String)); setZoom(next.zoom); setClipText(next.clipGeometry ? JSON.stringify(next.clipGeometry, null, 2) : "");
    setPlan(next); setProgress(null); setMessage("正在当前浏览器中下载、拼接和裁剪影像…");
    const controller = new AbortController(); abortRef.current = controller;
    const abort = () => controller.abort(); externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    try {
      const files = await downloadBrowserImagery(next, (done, total) => setProgress({ done, total }), controller.signal);
      const preview = URL.createObjectURL(files.png); const archive = URL.createObjectURL(files.zip);
      urlsRef.current = [preview, archive]; setReady({ preview, archive, source: next.source, clipped: !!next.clipGeometry });
      setMessage(next.clipGeometry ? "裁剪完成。边界外已透明；保存数据包可获得影像和裁剪边界。" : "拼接完成。点击“保存数据包”把影像、定位文件和来源说明存到你的设备。");
      return { ...planSummary(next), archiveReady: true, archiveBytes: files.zip.size, nextStep: "请让用户在本页面点击保存数据包。" };
    } catch (error) { setMessage(error instanceof Error && error.name === "AbortError" ? "任务已取消。" : textError(error)); throw error; }
    finally { externalSignal?.removeEventListener("abort", abort); abortRef.current = null; busyRef.current = false; setBusy(false); }
  }, [chooseSource]);

  const sourceAction = useCallback(async (input: Record<string, unknown>, signal?: AbortSignal) => {
    const action = input.action;
    if (action === "list") return { ok: true, defaultSourceId: storeRef.current.defaultSourceId,
      sources: [BROWSER_SOURCE, ...storeRef.current.customSources].map(source => sourceView(source, storeRef.current.defaultSourceId)) };
    const id = String(input.id ?? ""); if (!id) throw new Error("此操作需要图源 ID。");
    if (action === "register" || action === "update") {
      const source = validateBrowserSource(input); const custom = storeRef.current.customSources;
      const exists = custom.some(item => item.id === id);
      if (action === "register" && exists) throw new Error("图源 ID 已存在，请用 update 修改。");
      if (action === "update" && !exists) throw new Error("图源不存在，请用 register 添加。");
      persist({ defaultSourceId: storeRef.current.defaultSourceId, customSources: exists ? custom.map(item => item.id === id ? source : item) : [...custom, source] });
      chooseSource(id); setSourceMessage(`${source.name} 已保存在当前浏览器。请检测一块瓦片确认跨域访问可用。`);
      return { ok: true, source: sourceView(source, storeRef.current.defaultSourceId), savedIn: "current browser only" };
    }
    if (action === "remove") {
      if (id === BROWSER_SOURCE.id) throw new Error("内置图源不能删除。");
      if (!storeRef.current.customSources.some(item => item.id === id)) throw new Error("图源不存在。");
      const saved = persist({ defaultSourceId: storeRef.current.defaultSourceId === id ? BROWSER_SOURCE.id : storeRef.current.defaultSourceId,
        customSources: storeRef.current.customSources.filter(item => item.id !== id) });
      if (activeRef.current === id) chooseSource(saved.defaultSourceId);
      setSourceMessage("图源已从当前浏览器删除。"); return { ok: true, removed: id };
    }
    if (action === "default") {
      sourceById(id); persist({ ...storeRef.current, defaultSourceId: id }); chooseSource(id);
      setSourceMessage("默认图源已更新，保存在当前浏览器。"); return { ok: true, defaultSourceId: id };
    }
    if (action === "probe") {
      const source = sourceById(id);
      const checked = await probeBrowserSource(source, Number(input.zoom ?? 0), Number(input.x ?? 0), Number(input.y ?? 0), signal);
      setSourceMessage(`${source.name} 的检测瓦片可在此浏览器读取。`); return checked;
    }
    throw new Error("未知图源操作。");
  }, [chooseSource, persist, sourceById]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) { setWebMcpStatus("当前浏览器未开放 WebMCP；手动操作仍可用"); return; }
    const controller = new AbortController();
    const tools: Tool[] = [
      { name: "geod_browser_capabilities", description: "查看当前页面的本机影像下载能力；GeoD 服务器不处理影像。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
        execute: async () => result({ maxTiles: 256, maxPixels: 16_777_216, output: "PNG + EPSG:3857 PGW/PRJ + manifest.json，裁剪时附带 clip.geojson，打包为 ZIP", clip: "可选 WGS84 Polygon/MultiPolygon；边界外透明，瓦片数量仍按经纬度框计算", requiresOpenPage: true, sources: "geod_browser_sources；用户图源保存在当前浏览器，需支持 CORS" }) },
      { name: "geod_browser_sources", description: "列出、注册、更新、删除或设置用户自己的浏览器图源，也可检测一块瓦片。图源地址只保存在当前浏览器，列表不返回地址。只有用户要求时才检测网络瓦片。",
        inputSchema: sourcesSchema, annotations: { readOnlyHint: false },
        execute: async (input, options) => result(await sourceAction(input, options?.signal)) },
      { name: "geod_browser_plan", description: "按 WGS84 范围、级别、可选 sourceId 和 clipGeometry 估算当前浏览器影像下载。Polygon/MultiPolygon 边界外透明；不发起网络下载。先列出图源。",
        inputSchema: requestSchema, annotations: { readOnlyHint: true }, execute: async input => result(planSummary(toolPlan(input))) },
      { name: "geod_browser_fetch", description: "仅在用户要求下载时调用。当前浏览器直接从所选图源下载、拼接并按可选 clipGeometry 裁剪，完成后让用户保存 ZIP。不要用来测试连接。",
        inputSchema: requestSchema, annotations: { readOnlyHint: false }, execute: async (input, options) => result(await runFetch(toolPlan(input), options?.signal)) },
    ];
    Promise.all(tools.map(tool => context.registerTool(tool, { signal: controller.signal })))
      .then(() => setWebMcpStatus("WebMCP 工具已就绪（4 个）"))
      .catch(() => setWebMcpStatus("WebMCP 注册失败；手动操作仍可用"));
    return () => controller.abort();
  }, [runFetch, sourceAction, toolPlan]);
  useEffect(() => () => { abortRef.current?.abort(); for (const url of urlsRef.current) URL.revokeObjectURL(url); }, []);

  const parseClip = () => {
    if (!clipText.trim()) return undefined;
    try { return validateClipGeometry(JSON.parse(clipText)); }
    catch (error) { if (error instanceof SyntaxError) throw new Error("裁剪边界不是有效的 GeoJSON JSON；请检查括号和逗号。"); throw error; }
  };
  const currentPlan = () => makePlan(values.map(Number) as Bounds, zoom, activeId, parseClip());
  const handleClipBounds = () => { try { const geometry = parseClip(); if (!geometry) throw new Error("请先粘贴 GeoJSON 裁剪边界。");
      const bounds = clipBounds(geometry); setValues(bounds.map(String)); setPlan(null); clearReady(); setMessage("已按裁剪边界填入经纬度范围；请先估算下载量。"); }
    catch (error) { setMessage(textError(error)); } };
  const handlePlan = () => { try { const next = currentPlan(); setPlan(next); setMessage(`范围有效：${next.tiles} 块瓦片，输出约 ${next.width} × ${next.height} 像素${next.clipGeometry ? "；边界外将透明" : ""}。`); }
    catch (error) { setPlan(null); setMessage(textError(error)); } };
  const handleFetch = async () => { try { await runFetch(currentPlan()); } catch (error) { setMessage(textError(error)); } };
  const handleProbe = async () => { try { const next = currentPlan(); await sourceAction({ action: "probe", id: next.sourceId, zoom: next.zoom, x: next.firstX, y: next.firstY }); }
    catch (error) { setSourceMessage(textError(error)); } };
  const handleRegister = async () => {
    try { const source = validateBrowserSource({ ...form, maxZoom: Number(form.maxZoom), subdomains: form.subdomains.split(",").map(part => part.trim()).filter(Boolean) });
      const action = storeRef.current.customSources.some(item => item.id === source.id) ? "update" : "register";
      await sourceAction({ action, ...source }); setForm(EMPTY_FORM); setShowForm(false);
    } catch (error) { setSourceMessage(textError(error)); }
  };
  const sources = [BROWSER_SOURCE, ...store.customSources];
  const active = sources.find(source => source.id === activeId) ?? BROWSER_SOURCE;

  return <div className={styles.workspace}>
    <section className={styles.formCard} aria-labelledby="browser-request-title">
      <div className={styles.sectionTop}><span className={styles.sectionIcon}><MapPinned size={20} aria-hidden="true" /></span>
        <div><span className={styles.kicker}>01 / REQUEST</span><h2 id="browser-request-title">选择下载范围</h2></div></div>
      <p className={styles.description}>当前使用 <strong>{active.name}</strong>。下载前请确认图源许可、署名和拍摄时间。</p>
      <div className={styles.exampleRow} aria-label="示例区域">{EXAMPLES.map(example => <button type="button" key={example.name} disabled={busy}
        onClick={() => { setValues(example.bounds.map(String)); setPlan(null); clearReady(); }}>{example.name}示例</button>)}</div>
      <div className={styles.boundsGrid}>{LABELS.map((label, index) => <label key={label}><span>{label}</span>
        <input aria-label={label} type="number" inputMode="decimal" step="any" value={values[index]} disabled={busy}
          onChange={event => { setValues(current => current.map((value, i) => i === index ? event.target.value : value)); setPlan(null); clearReady(); }} />
        <small>{KEYS[index]}</small></label>)}</div>
      <div className={styles.clipField}>
        <div className={styles.clipHeading}><label htmlFor="browser-clip">按多边形裁剪 <span>可选</span></label>
          {clipText && <button type="button" disabled={busy} onClick={() => { setClipText(""); setPlan(null); clearReady(); setMessage("已清除多边形裁剪。"); }}>清除</button>}</div>
        <textarea id="browser-clip" value={clipText} disabled={busy} maxLength={1_000_000}
          onChange={event => { setClipText(event.target.value); setPlan(null); clearReady(); }}
          placeholder={'粘贴 GeoJSON Polygon、MultiPolygon 或 Feature，例如：\n{"type":"Polygon","coordinates":[[[113,34],[114,34],[114,35],[113,35],[113,34]]]}'}/>
        <div className={styles.clipFoot}><span>边界外透明，支持内洞；瓦片下载量按经纬度框估算。</span>
          <button type="button" disabled={busy || !clipText.trim()} onClick={handleClipBounds}>按边界填入范围</button></div>
      </div>
      <div className={styles.zoomHeading}><span>影像级别 · 图源最高 {active.maxZoom}</span><strong>{zoom}</strong></div>
      <div className={styles.zoomRow} role="group" aria-label="影像级别">
        {[0, 2, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22].filter(level => level <= active.maxZoom).map(level => <button type="button" key={level}
          aria-pressed={zoom === level} disabled={busy} onClick={() => { setZoom(level); setPlan(null); clearReady(); }}>{level}</button>)}
        {![0, 2, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22].includes(active.maxZoom) && <button type="button" aria-pressed={zoom === active.maxZoom}
          disabled={busy} onClick={() => { setZoom(active.maxZoom); setPlan(null); clearReady(); }}>{active.maxZoom}</button>}
      </div>
      <div className={styles.actionRow}><button type="button" className={styles.secondary} disabled={busy} onClick={handlePlan}>估算大小</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={handleFetch}><Zap size={17} aria-hidden="true" />在本机下载并拼接</button>
        {busy && <button type="button" className={styles.cancel} onClick={() => abortRef.current?.abort()}><Square size={14} aria-hidden="true" />取消</button>}</div>
      <p className={styles.status} role="status">{message || "先估算，再决定是否下载。"}</p>
      {busy && progress && <progress className={styles.progress} aria-label="瓦片下载进度" value={progress.done} max={progress.total} />}
    </section>

    <section className={styles.resultCard} aria-labelledby="browser-result-title">
      <div className={styles.sectionTop}><span className={styles.sectionIcon}><Download size={20} aria-hidden="true" /></span>
        <div><span className={styles.kicker}>02 / RESULT</span><h2 id="browser-result-title">保存到你的设备</h2></div></div>
      {ready ? <><div className={styles.preview}><img src={ready.preview} alt={`当前浏览器拼接的 ${ready.source} 影像预览`} /></div>
        <a className={styles.download} href={ready.archive} download={`geod-browser-${Date.now()}.zip`}><Download size={17} aria-hidden="true" />保存数据包</a>
        <p className={styles.finePrint}>ZIP 包含 imagery.png、imagery.pgw、imagery.prj、manifest.json{ready.clipped ? " 和 clip.geojson" : ""}。文件不会经过 GeoD 服务器。</p></>
        : <div className={styles.empty}>{plan ? <><strong>{plan.tiles} 块瓦片</strong><span>{plan.width} × {plan.height} 像素 · RGBA 内存约 {Math.ceil(plan.width * plan.height * 4 / 1024 / 1024)} MiB{plan.clipGeometry ? " · 边界外透明" : ""}</span></>
          : <><strong>等待范围规划</strong><span>结果会在当前页面生成，不占用 GeoD 服务器的下载和拼接资源。</span></>}</div>}
      <div className={styles.runtime}><span className={styles.dot} />{webMcpStatus}</div>
      <p className={styles.finePrint}>WebMCP 需要 Agent 打开此页面并支持网页工具。普通浏览器可手动操作；关闭页面会中止未完成任务。</p>
    </section>

    <section className={styles.sourceCard} aria-labelledby="browser-sources-title">
      <div className={styles.sectionTop}><span className={styles.sectionIcon}><MapPinned size={20} aria-hidden="true" /></span>
        <div><span className={styles.kicker}>03 / SOURCES</span><h2 id="browser-sources-title">选择或注册图源</h2></div></div>
      <p className={styles.description}>自定义图源只保存在当前浏览器，不同步到账号、CLI 或服务器。图源必须允许网页跨域读取瓦片（CORS），且你有权下载使用。</p>
      <div className={styles.sourceList}>{sources.map(source => <div className={styles.sourceRow} key={source.id}>
        <button type="button" className={styles.sourceChoice} aria-pressed={activeId === source.id} disabled={busy}
          onClick={() => { chooseSource(source.id); setSourceMessage(`已选择 ${source.name}。`); }}><strong>{source.name}</strong>
          <span>{source.id} · 0–{source.maxZoom} 级 · {source.scheme.toUpperCase()}{store.defaultSourceId === source.id ? " · 默认" : ""}</span></button>
        {source.id !== BROWSER_SOURCE.id && <button type="button" className={styles.sourceRemove} aria-label={`删除图源 ${source.name}`} disabled={busy}
          onClick={() => { void sourceAction({ action: "remove", id: source.id }).catch(error => setSourceMessage(textError(error))); }}><Trash2 size={16} aria-hidden="true" /></button>}
      </div>)}</div>
      <div className={styles.sourceActions}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => { void sourceAction({ action: "default", id: activeId }).catch(error => setSourceMessage(textError(error))); }}>设为默认</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => { void handleProbe(); }}>检测当前范围的一块瓦片</button>
        <button type="button" className={styles.secondary} disabled={busy} aria-expanded={showForm} onClick={() => setShowForm(value => !value)}><Plus size={15} aria-hidden="true" />注册图源</button>
      </div>
      {showForm && <div className={styles.sourceForm}>
        <p>填写自己的 HTTPS XYZ/TMS 瓦片模板。同一 ID 再次保存会更新图源；地址可能含授权参数，页面不会把它返回给 Agent。</p>
        <div className={styles.sourceFormGrid}>
          <label>图源 ID<input value={form.id} maxLength={64} onChange={event => setForm(current => ({ ...current, id: event.target.value }))} placeholder="my_imagery" /></label>
          <label>图源名称<input value={form.name} maxLength={128} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="我的影像图源" /></label>
          <label className={styles.fullField}>HTTPS 瓦片模板<input type="password" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} placeholder="https://example.com/{z}/{x}/{y}.png" autoComplete="off" /></label>
          <label className={styles.fullField}>来源和署名<input value={form.attribution} onChange={event => setForm(current => ({ ...current, attribution: event.target.value }))} placeholder="数据提供方 / 授权说明" /></label>
          <label>最高级别<input type="number" min={0} max={22} value={form.maxZoom} onChange={event => setForm(current => ({ ...current, maxZoom: event.target.value }))} /></label>
          <label>子域名（可选，逗号分隔）<input value={form.subdomains} onChange={event => setForm(current => ({ ...current, subdomains: event.target.value }))} placeholder="a,b,c" /></label>
        </div>
        <div className={styles.schemeRow} role="group" aria-label="瓦片行号方式">{(["xyz", "tms"] as const).map(scheme => <button type="button" key={scheme}
          aria-pressed={form.scheme === scheme} onClick={() => setForm(current => ({ ...current, scheme }))}>{scheme.toUpperCase()}</button>)}</div>
        <button type="button" className={styles.primary} onClick={() => { void handleRegister(); }}>保存到当前浏览器</button>
      </div>}
      <p className={styles.status} role="status">{sourceMessage || "注册后先检测一块瓦片；未开放 CORS 的图源无法在浏览器拼接。"}</p>
    </section>
  </div>;
}
