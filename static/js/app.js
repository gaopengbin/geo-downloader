/**
 * TIF下载工具 - 前端交互逻辑
 */

// ============ 全局变量 ============
let map;
let drawnItems;
let drawControl;
let currentBounds = null;
let currentPolygon = null;
let boundaryLayer = null;
let mapLayers = {}; // Store layer objects by ID
let tileSourceConfigs = {}; // 图源配置（含 max_zoom）
let overlayLayers = {}; // 叠加图层（标注等）
let layerControl = null; // 图层控制器引用
let activeTaskListeners = {}; // 活动任务的事件监听器 { taskId: unlisten函数 }
let activeTaskLogListeners = {}; // 任务日志事件监听器
let taskLogs = {}; // 任务日志数据 { taskId: [log1, log2, ...] }
let taskTimers = {}; // 任务计时器 { taskId: intervalId }
let batchGeojson = null; // 批量下载时暂存的 FeatureCollection + 文件名

// ============ 工具函数 ============

/**
 * HTML 转义：防御 XSS，应用于所有通过 innerHTML 模板插入的外部/用户数据。
 * 必须在所有动态字符串插值（远程 API、用户输入、文件解析结果等）处使用。
 */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 转义字符串使其可安全嵌入 HTML 属性（单/双引号 + 引号上下文）。
 * 用于 data-* 属性或 title 等内联属性场景。
 */
function escapeAttr(str) {
    return escapeHtml(str);
}
/**
 * 从 GeoJSON 中提取所有多边形坐标
 * 支持 Polygon、MultiPolygon、FeatureCollection（多个 Feature）
 * 返回 [[{lat,lng},...], [{lat,lng},...]] 格式（多个多边形外环）
 */
function extractPolygonFromGeoJSON(geojson) {
    if (!geojson) return null;
    
    const allRings = [];
    
    function extractFromGeometry(geometry) {
        if (!geometry) return;
        if (geometry.type === 'Polygon') {
            allRings.push(geometry.coordinates[0]); // 外环
        } else if (geometry.type === 'MultiPolygon') {
            for (const poly of geometry.coordinates) {
                allRings.push(poly[0]); // 每个子多边形的外环
            }
        }
    }
    
    if (geojson.type === 'FeatureCollection' && geojson.features) {
        for (const feature of geojson.features) {
            extractFromGeometry(feature.geometry);
        }
    } else if (geojson.type === 'Feature') {
        extractFromGeometry(geojson.geometry);
    } else {
        // 裸 Geometry
        extractFromGeometry(geojson);
    }
    
    if (allRings.length === 0) return null;
    
    // GeoJSON 坐标是 [lng, lat]，转换为 [{lat, lng},...] 格式
    return allRings.map(ring =>
        ring.map(coord => ({ lat: coord[1], lng: coord[0] }))
    );
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', async function() {
    initTitlebar(); // 初始化标题栏控制
    initModeToggle(); // 模式切换 (TIF / 3D Tiles)
    initCesiumControls(); // Cesium 调控面板
    await initSettings(); // 加载设置
    initMap();
    initDrawControls();
    initEventListeners();
    initTabNavigation();
    initZoomSlider();
    initConcurrencySlider();
    initCompressOption();
    initTiles3dPanel(); // 3D Tiles 面板事件
    initCesiumDrawTools(); // CesiumJS 绘图工具
    initWaybackPanel(); // 历史影像面板事件
    // GitHub Star 引导气泡
    const starHint = document.getElementById('star-hint');
    if (starHint) {
        if (localStorage.getItem('star-hint-dismissed')) {
            starHint.remove();
        } else {
            const dismiss = () => { starHint.remove(); localStorage.setItem('star-hint-dismissed', '1'); };
            document.getElementById('github-star-btn')?.addEventListener('click', dismiss);
            setTimeout(() => { if (starHint.parentElement) { starHint.style.animation = 'starHintFadeIn 0.3s ease reverse forwards'; setTimeout(() => starHint.remove(), 300); } }, 15000);
        }
    }

    // 赞助按钮
    document.getElementById('sponsor-btn')?.addEventListener('click', () => {
        document.getElementById('sponsor-dialog').style.display = '';
    });
    // 点击遮罩关闭
    document.getElementById('sponsor-dialog')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('sponsor-overlay')) e.target.style.display = 'none';
    });
    // 加群/关注公众号
    document.getElementById('community-open-btn')?.addEventListener('click', () => {
        const dlg = document.getElementById('community-dialog');
        if (dlg) dlg.style.display = '';
    });
    document.getElementById('community-close-btn')?.addEventListener('click', () => {
        document.getElementById('community-dialog').style.display = 'none';
    });
    document.getElementById('community-dialog')?.addEventListener('click', (e) => {
        if (e.target.classList.contains('sponsor-overlay')) e.target.style.display = 'none';
    });
    initSettingsPanel();
    initBatchEvents(); // 批量下载面板事件
    initHistoryListEvents();
    initTaskListEvents();
    initResumableTaskEvents();
    loadProvinces();
    loadResumableTasks();
    loadDownloadHistory();
    checkForUpdates(true);
});

// ============ 标题栏控制 ============
function initTitlebar() {
    // 只在 Tauri 环境下启用
    if (!window.__TAURI__) return;
    
    const { getCurrentWindow } = window.__TAURI__.window;
    const appWindow = getCurrentWindow();
    
    // 最小化
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
        appWindow.minimize();
    });
    
    // 最大化/还原
    document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
        const isMaximized = await appWindow.isMaximized();
        if (isMaximized) {
            appWindow.unmaximize();
        } else {
            appWindow.maximize();
        }
    });
    
    // 关闭
    document.getElementById('titlebar-close')?.addEventListener('click', () => {
        appWindow.close();
    });
    
    // 拖动窗口 - 绑定到标题栏区域
    const titlebar = document.querySelector('.titlebar');
    if (titlebar) {
        titlebar.addEventListener('mousedown', (e) => {
            // 排除按钮、模式切换器、Star按钮的点击
            if (e.target.closest('.titlebar-btn') || e.target.closest('.mode-toggle') || e.target.closest('.github-star-btn') || e.target.closest('.sponsor-btn')) return;
            appWindow.startDragging();
        });
        
        // 双击标题栏最大化/还原
        titlebar.addEventListener('dblclick', async (e) => {
            if (e.target.closest('.titlebar-btn') || e.target.closest('.mode-toggle') || e.target.closest('.github-star-btn') || e.target.closest('.sponsor-btn')) return;
            const isMaximized = await appWindow.isMaximized();
            if (isMaximized) {
                appWindow.unmaximize();
            } else {
                appWindow.maximize();
            }
        });
    }
}

// ============ 模式切换 (TIF / 3D Tiles) ============
let currentMode = 'tif'; // 'tif' | 'dem' | '3dtiles' | 'wayback'
let cesiumViewer = null;
let cesiumTileset = null;

function initModeToggle() {
    const toggleContainer = document.getElementById('mode-toggle');
    if (!toggleContainer) return;

    toggleContainer.querySelectorAll('.mode-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === currentMode) return;
            switchMode(mode);
        });
    });
}

function switchMode(mode) {
    currentMode = mode;

    // 更新标题栏按钮状态
    document.querySelectorAll('#mode-toggle .mode-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });

    // 标题固定为 GeoDownloader，不随模式切换

    // 切换面板内容
    const tifContent = document.getElementById('tif-mode-content');
    const tiles3dContent = document.getElementById('tiles3d-mode-content');
    const waybackContent = document.getElementById('wayback-mode-content');
    // 'tif' 与 'dem' 共用同一个下载面板，仅数据源/格式不同
    const showTif = mode === 'tif' || mode === 'dem';
    if (tifContent) tifContent.style.display = showTif ? '' : 'none';
    if (tiles3dContent) tiles3dContent.style.display = mode === '3dtiles' ? '' : 'none';
    if (waybackContent) waybackContent.style.display = mode === 'wayback' ? '' : 'none';

    // 重建 source-select 选项以匹配当前模式（DEM 仅显示 DEM 源）
    rebuildSourceSelectForMode(mode);

    // 切换地图引擎（wayback 使用 Leaflet，同 tif）
    const mapEl = document.getElementById('map');
    const cesiumEl = document.getElementById('cesium-container');
    const cesiumDrawTools = document.getElementById('cesium-draw-tools');
    if (mode === '3dtiles') {
        mapEl.style.display = 'none';
        cesiumEl.style.display = '';
        if (cesiumDrawTools) cesiumDrawTools.style.display = '';
        // 延迟一帧等 DOM reflow，确保容器有实际尺寸
        requestAnimationFrame(() => {
            initCesiumViewer();
            // 如果已有选区，在 Cesium 上显示
            syncSelectionToCesium();
        });
    } else {
        cesiumEl.style.display = 'none';
        mapEl.style.display = '';
        if (cesiumDrawTools) cesiumDrawTools.style.display = 'none';
        map.invalidateSize(); // Leaflet 可能需要重新计算尺寸
        // 清理 Cesium 绘图状态
        cleanCesiumDrawing();
    }

    // wayback 模式切入时，自动加载版本列表（仅首次）并显示预览
    const timelineEl = document.getElementById('wayback-timeline');
    if (mode === 'wayback') {
        // 隐藏基础底图，避免覆盖 Wayback 影像
        Object.values(mapLayers).forEach(layer => {
            if (map.hasLayer(layer)) map.removeLayer(layer);
        });
        if (!waybackVersionsLoaded) {
            loadWaybackVersions();
        } else if (waybackPreviewLayer && map) {
            waybackPreviewLayer.addTo(map);
        }
        if (timelineEl && waybackVersionsLoaded) timelineEl.style.display = '';
    } else {
        // 切出 wayback 时移除预览图层，恢复基础底图
        if (waybackPreviewLayer && map && map.hasLayer(waybackPreviewLayer)) {
            map.removeLayer(waybackPreviewLayer);
        }
        if (timelineEl) timelineEl.style.display = 'none';
        // 恢复当前选中的基础底图
        const sourceSelect = document.getElementById('source-select');
        if (sourceSelect && mapLayers[sourceSelect.value] && !map.hasLayer(mapLayers[sourceSelect.value])) {
            mapLayers[sourceSelect.value].addTo(map);
        }
    }
}

function initCesiumViewer() {
    if (cesiumViewer) return;
    if (typeof Cesium === 'undefined') {
        console.warn('CesiumJS 尚未加载');
        return;
    }

    cesiumViewer = new Cesium.Viewer('cesium-container', {
        baseLayer: new Cesium.ImageryLayer(
            new Cesium.OpenStreetMapImageryProvider({
                url: 'https://tile.openstreetmap.org/'
            })
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
    });

    // 隐藏 Cesium 水印
    const credit = cesiumViewer.cesiumWidget.creditContainer;
    if (credit) credit.style.display = 'none';

    // Cesium 状态栏：经纬度 + 相机高度
    const statusCoords = document.getElementById('status-coords');
    const statusZoom = document.getElementById('status-zoom');
    const handler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.scene.canvas);
    handler.setInputAction((movement) => {
        const cartesian = cesiumViewer.camera.pickEllipsoid(movement.endPosition, cesiumViewer.scene.globe.ellipsoid);
        if (cartesian) {
            const carto = Cesium.Cartographic.fromCartesian(cartesian);
            const lng = Cesium.Math.toDegrees(carto.longitude);
            const lat = Cesium.Math.toDegrees(carto.latitude);
            statusCoords.textContent = `经度: ${lng.toFixed(6)}  纬度: ${lat.toFixed(6)}`;
        } else {
            statusCoords.textContent = '经度: --  纬度: --';
        }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    cesiumViewer.camera.changed.addEventListener(() => {
        const height = cesiumViewer.camera.positionCartographic.height;
        if (height !== undefined) {
            const km = height > 1000 ? `${(height / 1000).toFixed(1)} km` : `${height.toFixed(0)} m`;
            statusZoom.textContent = `高度: ${km}`;
        }
    });
    cesiumViewer.camera.percentageChanged = 0.01;
}

// ============ 设置管理 ============
let appSettings = null;

async function initSettings() {
    try {
        appSettings = await TifApi.getSettings();
        applySettings(appSettings);
    } catch (error) {
        console.error('Failed to load settings:', error);
        appSettings = {
            tianditu_token: null,
            proxy_enabled: false,
            proxy_url: 'http://127.0.0.1:10808',
            default_concurrency: 30,
            default_zoom: 15
        };
    }
}

function applySettings(settings) {
    if (!settings) return;
    
    // 天地图 Token
    const tokenInput = document.getElementById('tianditu-token-input');
    if (tokenInput && settings.tianditu_token) {
        tokenInput.value = settings.tianditu_token;
    }
    
    // 代理设置
    const proxyCheckbox = document.getElementById('proxy-checkbox');
    const proxyInput = document.getElementById('proxy-input');
    if (proxyCheckbox) proxyCheckbox.checked = settings.proxy_enabled !== false;
    if (proxyInput && settings.proxy_url) proxyInput.value = settings.proxy_url;
    
    // 并发数
    const concurrencySlider = document.getElementById('concurrency-slider');
    const concurrencyValue = document.getElementById('concurrency-value');
    if (concurrencySlider && settings.default_concurrency) {
        concurrencySlider.value = settings.default_concurrency;
        if (concurrencyValue) concurrencyValue.textContent = settings.default_concurrency;
    }
    
    // 缩放级别
    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider && settings.default_zoom) {
        zoomSlider.value = settings.default_zoom;
    }

    // Cesium Ion Token
    const ionTokenInput = document.getElementById('ion-token');
    if (ionTokenInput && settings.cesium_ion_token) {
        ionTokenInput.value = settings.cesium_ion_token;
    }

    // 调试模式
    const debugCheckbox = document.getElementById('debug-mode-checkbox');
    if (debugCheckbox) debugCheckbox.checked = !!settings.debug_mode;

    // 内存预算
    const budgetSlider = document.getElementById('memory-budget-slider');
    const budgetValue = document.getElementById('memory-budget-value');
    if (budgetSlider && settings.memory_budget_mb) {
        budgetSlider.value = settings.memory_budget_mb;
        if (budgetValue) budgetValue.textContent = settings.memory_budget_mb + ' MB';
    }
}

function getTianDiTuToken() {
    return appSettings?.tianditu_token || '';
}

function readZoomRange(sliderId, maxInputId) {
    const slider = document.getElementById(sliderId);
    const maxInput = document.getElementById(maxInputId);
    const zoom = parseInt(slider?.value || '15', 10);
    const limit = parseInt(slider?.max || '22', 10);
    let zoomMax = zoom;

    if (maxInput && maxInput.value.trim() !== '') {
        const raw = parseInt(maxInput.value, 10);
        if (!Number.isNaN(raw)) {
            zoomMax = Math.min(Math.max(raw, zoom), limit);
        }
    }

    return { zoom, zoomMax, hasRange: zoomMax > zoom };
}

function formatZoomRangeLabel(zoom, zoomMax) {
    return zoomMax > zoom ? `z${zoom}-${zoomMax}` : `z${zoom}`;
}

async function refreshMapLayers() {
    // 记录当前激活的基础图层
    let activeLayerKey = null;
    for (const [key, layer] of Object.entries(mapLayers)) {
        if (map.hasLayer(layer)) {
            activeLayerKey = key;
            map.removeLayer(layer);
        }
    }
    
    // 记录当前激活的叠加图层
    const activeOverlays = [];
    for (const [key, layer] of Object.entries(overlayLayers)) {
        if (map.hasLayer(layer)) {
            activeOverlays.push(key);
            map.removeLayer(layer);
        }
    }
    
    // 移除旧的图层控制器
    if (layerControl) {
        layerControl.remove();
        layerControl = null;
    }
    
    // 清空旧图层引用
    mapLayers = {};
    overlayLayers = {};
    
    // 重新加载图源
    await loadMapSources();
    
    // 恢复之前激活的基础图层
    if (activeLayerKey && mapLayers[activeLayerKey]) {
        for (const [key, layer] of Object.entries(mapLayers)) {
            if (map.hasLayer(layer) && key !== activeLayerKey) {
                map.removeLayer(layer);
            }
        }
        if (!map.hasLayer(mapLayers[activeLayerKey])) {
            mapLayers[activeLayerKey].addTo(map);
        }
    }
    
    // 恢复之前激活的叠加图层
    for (const key of activeOverlays) {
        if (overlayLayers[key]) {
            overlayLayers[key].addTo(map);
        }
    }
}

// ============ 地图初始化 ============
async function initMap() {
    // 创建地图，默认中心在中国
    map = L.map('map', { zoomControl: false }).setView([35.8617, 104.1954], 5);
    
    // 添加缩放控件到右上角
    L.control.zoom({
        position: 'topright'
    }).addTo(map);
    
    // 绘制图层
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    
    // 加载图源
    await loadMapSources();
    
    // 多次延迟刷新地图尺寸，确保布局完成后渲染正确
    [100, 500, 1000].forEach(delay => {
        setTimeout(() => map.invalidateSize(), delay);
    });
    
    // 状态栏：显示鼠标经纬度和缩放级别
    const statusCoords = document.getElementById('status-coords');
    const statusZoom = document.getElementById('status-zoom');
    statusZoom.textContent = `缩放: ${map.getZoom()}`;
    map.on('mousemove', function(e) {
        statusCoords.textContent = `经度: ${e.latlng.lng.toFixed(6)}  纬度: ${e.latlng.lat.toFixed(6)}`;
    });
    map.on('mouseout', function() {
        statusCoords.textContent = '经度: --  纬度: --';
    });
    map.on('zoomend', function() {
        statusZoom.textContent = `缩放: ${map.getZoom()}`;
    });

    // 窗口大小改变时刷新
    window.addEventListener('resize', () => map.invalidateSize());
    
    // 窗口重新获得焦点时刷新（修复文件对话框导致的渲染问题）
    window.addEventListener('focus', () => {
        setTimeout(() => {
            map.invalidateSize();
            map.eachLayer(layer => {
                if (layer.redraw) layer.redraw();
            });
        }, 100);
    });

    // 侧边栏拖拽调整宽度
    initSidebarResizer();
}

function initSidebarResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const sidebar = document.getElementById('sidebar');
    if (!resizer || !sidebar) return;

    let startX, startWidth;

    resizer.addEventListener('mousedown', (e) => {
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (e) => {
            const newWidth = startWidth + (e.clientX - startX);
            const min = parseInt(getComputedStyle(sidebar).minWidth) || 280;
            const max = parseInt(getComputedStyle(sidebar).maxWidth) || 600;
            sidebar.style.width = Math.max(min, Math.min(max, newWidth)) + 'px';
        };

        const onMouseUp = () => {
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (map) map.invalidateSize();
            if (cesiumViewer) cesiumViewer.resize();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

async function loadMapSources() {
    try {
        const customToken = getTianDiTuToken();
        const sources = await TifApi.getTileSources(customToken);
        tileSourceConfigs = sources; // 保存图源配置
        const baseMaps = {};
        let firstLayer = null;
        
        // 构建图层
        for (const [key, config] of Object.entries(sources)) {
            const layer = L.tileLayer(config.url, {
                attribution: config.attribution,
                maxZoom: config.max_zoom,
                subdomains: config.subdomains || []
            });
            mapLayers[key] = layer;
            baseMaps[config.name] = layer;
            if (!firstLayer) firstLayer = layer;
        }
        
        // 按名称排序后填充下拉框
        const sourceSelect = document.getElementById('source-select');
        sourceSelect.innerHTML = '';
        const sortedEntries = Object.entries(sources).sort((a, b) => a[1].name.localeCompare(b[1].name));
        for (const [key, config] of sortedEntries) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = config.name;
            sourceSelect.appendChild(opt);
        }
        
        // 按名称排序重建 baseMaps（Leaflet 按插入顺序显示）
        const sortedBaseMaps = {};
        Object.keys(baseMaps).sort((a, b) => a.localeCompare(b)).forEach(name => {
            sortedBaseMaps[name] = baseMaps[name];
        });
        
        if (mapLayers['osm']) {
            mapLayers['osm'].addTo(map);
            sourceSelect.value = 'osm';
            updateZoomSliderMax('osm');
        } else if (firstLayer) {
            firstLayer.addTo(map);
            const firstKey = Object.keys(sources)[0];
            if (firstKey) updateZoomSliderMax(firstKey);
        }
        // 按当前 mode 过滤 source-select 选项（DEM 模式仅显示 DEM 源）
        rebuildSourceSelectForMode(currentMode);
        
        // 创建天地图标注叠加图层
        const token = customToken || '436ce7e50d27eede2f2929307e6b33c0';
        const tdtSubdomains = ['0','1','2','3','4','5','6','7'];
        const overlayMaps = {};
        
        const ciaLayer = L.tileLayer(
            `https://t{s}.tianditu.gov.cn/cia_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cia&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${token}`,
            { subdomains: tdtSubdomains, maxZoom: 18, transparent: true }
        );
        const cvaLayer = L.tileLayer(
            `https://t{s}.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${token}`,
            { subdomains: tdtSubdomains, maxZoom: 18, transparent: true }
        );
        overlayLayers = { tianditu_cia: ciaLayer, tianditu_cva: cvaLayer };
        overlayMaps['天地图 影像标注'] = ciaLayer;
        overlayMaps['天地图 矢量标注'] = cvaLayer;
        
        if (layerControl) layerControl.remove();
        layerControl = L.control.layers(sortedBaseMaps, overlayMaps).addTo(map);
        syncDropdownWithMap();
        
    } catch (error) {
        console.error('Failed to load tile sources:', error);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);
    }
}

// GCJ-02 图源列表（中国区域有偏移）
const GCJ02_SOURCES = ['google_map', 'gaode_map', 'gaode_satellite'];

function syncDropdownWithMap() {
    const sourceSelect = document.getElementById('source-select');
    
    // 检查并显示 GCJ-02 警告
    function checkGcj02Warning(sourceKey) {
        if (GCJ02_SOURCES.includes(sourceKey)) {
            showGcj02Warning();
        } else {
            hideGcj02Warning();
        }
    }
    
    // 当下拉框改变时，切换地图图层
    sourceSelect.addEventListener('change', function(e) {
        const selectedKey = e.target.value;
        if (mapLayers[selectedKey]) {
            // 移除所有基础图层
            for (const key in mapLayers) {
                if (map.hasLayer(mapLayers[key])) {
                    map.removeLayer(mapLayers[key]);
                }
            }
            // 添加选中的图层
            mapLayers[selectedKey].addTo(map);
            checkGcj02Warning(selectedKey);
        }
        // 更新 zoom slider 的最大值
        updateZoomSliderMax(selectedKey);
        // DEM 源锁定输出格式为 GeoTIFF (Float32)
        applyDemFormatLock(selectedKey);
    });
    
    // 当地图图层通过控件改变时，更新下拉框
    map.on('baselayerchange', function(e) {
        for (const [key, layer] of Object.entries(mapLayers)) {
            if (layer === e.layer) {
                sourceSelect.value = key;
                checkGcj02Warning(key);
                updateZoomSliderMax(key);
                break;
            }
        }
    });
}

// 显示 GCJ-02 偏移警告
function showGcj02Warning() {
    let warning = document.getElementById('gcj02-warning');
    if (!warning) {
        warning = document.createElement('div');
        warning.id = 'gcj02-warning';
        warning.className = 'gcj02-warning';
        warning.innerHTML = '⚠️ 该图源中国区域使用 GCJ-02 坐标系，与行政边界存在偏移';
        document.querySelector('.map-panel').appendChild(warning);
    }
    warning.style.display = 'block';
}

// 隐藏 GCJ-02 偏移警告
function hideGcj02Warning() {
    const warning = document.getElementById('gcj02-warning');
    if (warning) {
        warning.style.display = 'none';
    }
}

// DEM 源识别（与后端 dem::is_dem_source 保持一致）
function isDemSource(key) {
    return key === 'dem_terrarium';
}

// 当选择 DEM 源时锁定输出格式为 GeoTIFF（Float32 单波段）
function applyDemFormatLock(sourceKey) {
    const fmtSelect = document.getElementById('format-select');
    if (!fmtSelect) return;
    if (isDemSource(sourceKey)) {
        fmtSelect.value = 'geotiff';
        fmtSelect.disabled = true;
        fmtSelect.title = 'DEM 数据仅支持 GeoTIFF Float32 输出';
    } else {
        fmtSelect.disabled = false;
        fmtSelect.title = '';
    }
}

// 根据当前 mode 重建数据源下拉框
// - 'dem'  : 仅显示 DEM 源（dem_*），自动锁格式
// - 其他   : 显示非 DEM 源
function rebuildSourceSelectForMode(mode) {
    const sourceSelect = document.getElementById('source-select');
    if (!sourceSelect || !tileSourceConfigs) return;

    const wantDem = mode === 'dem';
    const prevValue = sourceSelect.value;

    // 过滤 + 排序
    const entries = Object.entries(tileSourceConfigs)
        .filter(([key]) => isDemSource(key) === wantDem)
        .sort((a, b) => a[1].name.localeCompare(b[1].name));

    sourceSelect.innerHTML = '';
    for (const [key, config] of entries) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = config.name;
        sourceSelect.appendChild(opt);
    }

    // 选择默认值：保留之前的（如果仍存在），否则用首个
    let nextValue = entries.find(([k]) => k === prevValue)?.[0];
    if (!nextValue) {
        nextValue = wantDem ? 'dem_terrarium' : (entries.find(([k]) => k === 'osm')?.[0] || entries[0]?.[0]);
    }
    if (nextValue) {
        sourceSelect.value = nextValue;
        updateZoomSliderMax(nextValue);
        // 模式切换导致选中源变化时，同步切换地图底图
        if (nextValue !== prevValue) {
            sourceSelect.dispatchEvent(new Event('change'));
        }
    }
    applyDemFormatLock(nextValue || '');
}

// ============ 绘制控件初始化 ============
function initDrawControls() {
    drawControl = new L.Control.Draw({
        position: 'topright',
        draw: {
            polyline: false,
            circle: false,
            circlemarker: false,
            marker: false,
            polygon: {
                allowIntersection: false,
                shapeOptions: {
                    color: '#0052cc',
                    fillColor: '#0052cc',
                    fillOpacity: 0.2,
                    weight: 2
                }
            },
            rectangle: {
                shapeOptions: {
                    color: '#0052cc',
                    fillColor: '#0052cc',
                    fillOpacity: 0.2,
                    weight: 2
                }
            }
        },
        edit: {
            featureGroup: drawnItems,
            remove: true
        }
    });
    
    map.addControl(drawControl);
    
    // 绘制完成事件
    map.on(L.Draw.Event.CREATED, function(e) {
        // 清除之前的绘制
        drawnItems.clearLayers();
        if (boundaryLayer) {
            map.removeLayer(boundaryLayer);
            boundaryLayer = null;
        }
        
        // 添加新绘制
        drawnItems.addLayer(e.layer);
        
        // 获取边界
        if (e.layerType === 'rectangle') {
            const bounds = e.layer.getBounds();
            currentBounds = {
                north: bounds.getNorth(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                west: bounds.getWest()
            };
            currentPolygon = null;
        } else if (e.layerType === 'polygon') {
            const latlngs = e.layer.getLatLngs()[0];
            currentPolygon = [latlngs.map(ll => ({ lat: ll.lat, lng: ll.lng }))];
            // 计算边界框
            const bounds = e.layer.getBounds();
            currentBounds = {
                north: bounds.getNorth(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                west: bounds.getWest()
            };
        }
        
        updateSelectionInfo();
        estimateDownload();
        updateVectorButtons();
        syncSelectionToCesium();
    });
    
    // 删除事件
    map.on(L.Draw.Event.DELETED, function(e) {
        currentBounds = null;
        currentPolygon = null;
        updateSelectionInfo();
        document.getElementById('download-btn').disabled = true;
        updateVectorButtons();
        syncSelectionToCesium();
    });
}

// ============ Tab 导航 ============
function initTabNavigation() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            
            // 更新按钮状态
            tabBtns.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            
            // 更新面板状态
            tabPanels.forEach(panel => {
                panel.classList.remove('active');
            });
            document.getElementById(`tab-${tabId}`).classList.add('active');
            
            // 切换到下载中心时刷新任务和历史
            if (tabId === 'history') {
                refreshActiveTasks();
                loadResumableTasks();
                loadDownloadHistory();
            }
        });
    });
}

// ============ 设置面板 ============
function initSettingsPanel() {
    // 默认并发数滑块
    const defaultConcurrency = document.getElementById('default-concurrency');
    const defaultConcurrencyValue = document.getElementById('default-concurrency-value');
    if (defaultConcurrency && defaultConcurrencyValue) {
        if (appSettings?.default_concurrency) {
            defaultConcurrency.value = appSettings.default_concurrency;
            defaultConcurrencyValue.textContent = appSettings.default_concurrency;
        }
        defaultConcurrency.addEventListener('input', (e) => {
            defaultConcurrencyValue.textContent = e.target.value;
        });
    }
    
    // 默认缩放级别滑块
    const defaultZoom = document.getElementById('default-zoom');
    const defaultZoomValue = document.getElementById('default-zoom-value');
    if (defaultZoom && defaultZoomValue) {
        if (appSettings?.default_zoom) {
            defaultZoom.value = appSettings.default_zoom;
            defaultZoomValue.textContent = appSettings.default_zoom;
        }
        defaultZoom.addEventListener('input', (e) => {
            defaultZoomValue.textContent = e.target.value;
        });
    }
    
    // 保存设置按钮
    const saveBtn = document.getElementById('save-settings-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveAllSettings);
    }

    // 调试模式 — 即时生效
    const debugCheckbox = document.getElementById('debug-mode-checkbox');
    if (debugCheckbox) {
        debugCheckbox.addEventListener('change', async () => {
            if (appSettings) {
                appSettings.debug_mode = debugCheckbox.checked;
                try { await TifApi.saveSettings(appSettings); } catch (e) { /* silent */ }
            }
        });
    }

    // 内存预算滑块 — 实时显示数值
    const budgetSlider = document.getElementById('memory-budget-slider');
    const budgetValue = document.getElementById('memory-budget-value');
    if (budgetSlider && budgetValue) {
        budgetSlider.addEventListener('input', () => {
            budgetValue.textContent = budgetSlider.value + ' MB';
        });
    }

    // 获取系统内存信息（异步加载，不阻塞初始化）
    TifApi.getSystemMemory().then(memInfo => {
        const memInfoEl = document.getElementById('system-memory-info');
        if (memInfo && memInfoEl) {
            const totalGB = (memInfo.total_mb / 1024).toFixed(1);
            const availGB = (memInfo.available_mb / 1024).toFixed(1);
            memInfoEl.textContent = `本机内存：总计 ${totalGB} GB，当前可用 ${availGB} GB`;
        }
    }).catch(() => { /* silent */ });
    
    // 清空历史按钮
    const clearHistoryBtn = document.getElementById('clear-history-btn');
    if (clearHistoryBtn) {
        clearHistoryBtn.addEventListener('click', clearAllHistory);
    }
    
    // 图源管理
    initSourceDialog();
    initBuiltinSourcesList();
    initCustomSourcesList();
    loadBuiltinDefaults().then(() => renderBuiltinSourcesList());
    const addSourceBtn = document.getElementById('add-source-btn');
    if (addSourceBtn) {
        addSourceBtn.addEventListener('click', () => {
            editingSourceId = null;
            editingBuiltin = false;
            openSourceDialog('添加自定义图源', null);
        });
    }
    
    // 版本号显示
    const versionEl = document.getElementById('app-version');
    if (versionEl) versionEl.textContent = APP_VERSION;
    
    // 检查更新按钮
    const checkUpdateBtn = document.getElementById('check-update-btn');
    if (checkUpdateBtn) {
        checkUpdateBtn.addEventListener('click', () => checkForUpdates(false));
    }
    
    // 更新对话框按钮
    const updateLaterBtn = document.getElementById('update-later-btn');
    if (updateLaterBtn) updateLaterBtn.addEventListener('click', closeUpdateDialog);
    const updateNowBtn = document.getElementById('update-now-btn');
    if (updateNowBtn) updateNowBtn.addEventListener('click', doUpdateNow);
}

// ============ 自动更新 ============

let APP_VERSION = '3.3.0';
const GITHUB_REPO = 'gaopengbin/geo-downloader';

// 从 Tauri 配置动态读取版本号，保持单一数据源 (tauri.conf.json)
async function initAppVersion() {
    try {
        if (window.__TAURI__?.app?.getVersion) {
            APP_VERSION = await window.__TAURI__.app.getVersion();
            const el = document.getElementById('app-version');
            if (el) el.textContent = APP_VERSION;
        }
    } catch (_) {}
}
initAppVersion();

function compareVersions(a, b) {
    // SemVer 比较：先比 major.minor.patch，再比 prerelease 标签
    // 规则：无 prerelease > 有 prerelease；prerelease 内部按 . 分段，数字数字比较，字符串字典序
    const parse = (v) => {
        const [core, pre] = v.split('-');
        const main = core.split('.').map(n => parseInt(n, 10) || 0);
        const preParts = pre ? pre.split('.').map(p => /^\d+$/.test(p) ? parseInt(p, 10) : p) : null;
        return { main, pre: preParts };
    };
    const va = parse(a), vb = parse(b);
    for (let i = 0; i < 3; i++) {
        const na = va.main[i] || 0, nb = vb.main[i] || 0;
        if (na !== nb) return na > nb ? 1 : -1;
    }
    // main 段相等，比较 prerelease
    if (!va.pre && !vb.pre) return 0;
    if (!va.pre) return 1;   // 稳定版 > prerelease
    if (!vb.pre) return -1;
    for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
        const pa = va.pre[i], pb = vb.pre[i];
        if (pa === undefined) return -1;
        if (pb === undefined) return 1;
        if (typeof pa === 'number' && typeof pb === 'number') {
            if (pa !== pb) return pa > pb ? 1 : -1;
        } else if (typeof pa === typeof pb) {
            if (pa !== pb) return pa > pb ? 1 : -1;
        } else {
            // 数字 < 字符串
            return typeof pa === 'number' ? -1 : 1;
        }
    }
    return 0;
}

function extractKeyUpdates(body) {
    if (!body) return [];
    const updates = [];
    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
            let content = trimmed.slice(1).trim();
            const boldMatch = content.match(/\*\*(.+?)\*\*/);
            if (boldMatch) content = boldMatch[1];
            if (content.length > 0 && content.length < 60) updates.push(content);
        }
    }
    return updates.slice(0, 8);
}

let _updateDownloadUrl = null;
let _updateVersion = null;
let _updateUnlisten = null;

function showUpdateDialog(latestVersion, downloadUrl, releaseUrl, body) {
    document.getElementById('update-current-ver').textContent = 'v' + APP_VERSION;
    document.getElementById('update-new-ver').textContent = 'v' + latestVersion;
    
    // 更新内容
    const notes = extractKeyUpdates(body);
    const notesEl = document.getElementById('update-notes');
    const listEl = document.getElementById('update-notes-list');
    if (notes.length > 0) {
        listEl.innerHTML = notes.map(n => `<li>${escapeHtml(n)}</li>`).join('');
        notesEl.style.display = '';
    } else {
        notesEl.style.display = 'none';
    }
    
    // 重置进度
    document.getElementById('update-progress').style.display = 'none';
    document.getElementById('update-dialog-footer').style.display = '';
    
    _updateDownloadUrl = downloadUrl;
    _updateVersion = latestVersion;
    
    const nowBtn = document.getElementById('update-now-btn');
    if (downloadUrl) {
        nowBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>立即更新';
    } else {
        nowBtn.innerHTML = '前往下载';
        _updateDownloadUrl = releaseUrl;
    }
    
    document.getElementById('update-dialog').style.display = '';
}

function closeUpdateDialog() {
    document.getElementById('update-dialog').style.display = 'none';
    if (_updateUnlisten) { _updateUnlisten(); _updateUnlisten = null; }
}

function switchSponsorTab(tab) {
    document.querySelectorAll('.sponsor-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const remoteBase = 'https://laogao.xyz/packages/qr-assets';
    const remote = tab === 'wx' ? `${remoteBase}/wx.jpg` : `${remoteBase}/zfb.jpg`;
    const local = tab === 'wx' ? './images/wx.jpg' : './images/zfb.jpg';
    const imgEl = document.getElementById('sponsor-qr-img');
    imgEl.onerror = function () { this.onerror = null; this.src = local; };
    imgEl.src = remote;
}

async function doUpdateNow() {
    if (!_updateDownloadUrl) return;
    
    // 如果没有直接下载链接，打开网页
    if (!_updateDownloadUrl.endsWith('.exe')) {
        window.open(_updateDownloadUrl, '_blank');
        closeUpdateDialog();
        return;
    }
    
    // 显示进度条，隐藏按钮
    document.getElementById('update-progress').style.display = '';
    document.getElementById('update-dialog-footer').style.display = 'none';
    
    _updateUnlisten = await window.__TAURI__.event.listen('update-download-progress', (e) => {
        document.getElementById('update-progress-percent').textContent = e.payload + '%';
        document.getElementById('update-progress-fill').style.width = e.payload + '%';
    });
    
    try {
        await window.__TAURI__.core.invoke('download_and_install_update', {
            url: _updateDownloadUrl,
            version: _updateVersion
        });
    } catch (error) {
        document.getElementById('update-progress').style.display = 'none';
        document.getElementById('update-dialog-footer').style.display = '';
        const statusEl = document.getElementById('update-status');
        if (statusEl) statusEl.textContent = '下载更新失败: ' + (error.message || error);
        closeUpdateDialog();
    }
}

async function checkForUpdates(silent = false) {
    if (!window.__TAURI__) return;
    
    const statusEl = document.getElementById('update-status');
    const btn = document.getElementById('check-update-btn');
    
    if (!silent && statusEl) statusEl.textContent = '正在检查更新...';
    if (btn) btn.disabled = true;
    
    try {
        // 已安装的是 prerelease（含 -beta/-rc 等）时，列出全部 release 取第一条（含 prerelease）；
        // 稳定版用户走 /releases/latest，避免被 beta 推送打扰。
        const isPrerelease = APP_VERSION.includes('-');
        const apiUrl = isPrerelease
            ? `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5`
            : `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
        const resp = await fetch(apiUrl);
        if (!resp.ok) throw new Error('获取更新信息失败');

        const payload = await resp.json();
        const data = Array.isArray(payload) ? payload.find(r => !r.draft) : payload;
        if (!data) throw new Error('未找到可用的发布版本');
        const latestVersion = data.tag_name.replace(/^v/, '');
        
        if (compareVersions(latestVersion, APP_VERSION) > 0) {
            const assets = data.assets || [];
            const setupAsset = assets.find(a => a.name.endsWith('_setup.exe') || a.name.endsWith('-setup.exe'));
            showUpdateDialog(latestVersion, setupAsset?.browser_download_url, data.html_url, data.body);
            if (statusEl) statusEl.textContent = '';
        } else {
            if (!silent && statusEl) statusEl.textContent = '✅ 已是最新版本';
        }
    } catch (error) {
        if (!silent && statusEl) statusEl.textContent = '检查更新失败: ' + (error.message || error);
    }
    
    if (btn) btn.disabled = false;
}

// ============ 图源管理 ============
let editingSourceId = null; // 当前编辑的图源 ID
let editingBuiltin = false; // 是否正在编辑内置图源
let builtinDefaults = {};   // 内置图源原始默认值

async function loadBuiltinDefaults() {
    try {
        builtinDefaults = await TifApi.getBuiltinSources(getTianDiTuToken());
    } catch (e) {
        console.error('Failed to load builtin sources:', e);
    }
}

// === 图源编辑弹框 ===

function openSourceDialog(title, source) {
    document.getElementById('source-dialog-title').textContent = title;
    document.getElementById('source-dlg-name').value = source?.name || '';
    document.getElementById('source-dlg-url').value = source?.url || '';
    document.getElementById('source-dlg-subdomains').value =
        Array.isArray(source?.subdomains) ? source.subdomains.join(',') : (source?.subdomains || '');
    document.getElementById('source-dlg-maxzoom').value = source?.max_zoom || 18;
    document.getElementById('source-dialog').style.display = '';
}

function closeSourceDialog() {
    document.getElementById('source-dialog').style.display = 'none';
    editingSourceId = null;
    editingBuiltin = false;
}

function collectDialogSource() {
    const name = document.getElementById('source-dlg-name').value.trim();
    const url = document.getElementById('source-dlg-url').value.trim();
    if (!name || !url) { alert('请填写图源名称和 URL 模板'); return null; }
    return {
        name, url,
        subdomains: document.getElementById('source-dlg-subdomains').value.trim(),
        max_zoom: parseInt(document.getElementById('source-dlg-maxzoom').value) || 18
    };
}

async function confirmSourceDialog() {
    const data = collectDialogSource();
    if (!data) return;

    if (editingBuiltin && editingSourceId) {
        if (!appSettings.source_overrides) appSettings.source_overrides = [];
        const idx = appSettings.source_overrides.findIndex(s => s.id === editingSourceId);
        const entry = { id: editingSourceId, ...data };
        if (idx >= 0) { appSettings.source_overrides[idx] = entry; }
        else { appSettings.source_overrides.push(entry); }
    } else if (editingSourceId) {
        if (!appSettings.custom_sources) appSettings.custom_sources = [];
        const idx = appSettings.custom_sources.findIndex(s => s.id === editingSourceId);
        if (idx >= 0) {
            appSettings.custom_sources[idx] = { id: editingSourceId, ...data };
        }
    } else {
        if (!appSettings.custom_sources) appSettings.custom_sources = [];
        appSettings.custom_sources.push({ id: 'custom_' + Date.now(), ...data });
    }

    try {
        await TifApi.saveSettings(appSettings);
        closeSourceDialog();
        renderBuiltinSourcesList();
        renderCustomSourcesList();
        refreshMapLayers();
    } catch (error) {
        alert('保存失败: ' + error.message);
    }
}

function initSourceDialog() {
    document.getElementById('source-dialog-close').addEventListener('click', closeSourceDialog);
    document.getElementById('source-dialog-cancel').addEventListener('click', closeSourceDialog);
    document.getElementById('source-dialog-confirm').addEventListener('click', confirmSourceDialog);
    // 点击遮罩层关闭
    document.getElementById('source-dialog').addEventListener('click', (e) => {
        if (e.target.id === 'source-dialog') closeSourceDialog();
    });
}

// === 内置图源 ===

function editBuiltinSource(id) {
    const ovr = appSettings?.source_overrides?.find(s => s.id === id);
    const def = builtinDefaults[id];
    const source = ovr || def;
    if (!source) return;
    editingSourceId = id;
    editingBuiltin = true;
    openSourceDialog(`编辑: ${source.name}`, source);
}

async function resetBuiltinSource(id) {
    if (!appSettings.source_overrides) return;
    appSettings.source_overrides = appSettings.source_overrides.filter(s => s.id !== id);
    try {
        await TifApi.saveSettings(appSettings);
        renderBuiltinSourcesList();
        refreshMapLayers();
    } catch (error) {
        alert('重置失败: ' + error.message);
    }
}

function renderBuiltinSourcesList() {
    const listEl = document.getElementById('builtin-sources-list');
    if (!listEl) return;
    const ids = Object.keys(builtinDefaults).sort((a, b) => {
        return (builtinDefaults[a].name || a).localeCompare(builtinDefaults[b].name || b);
    });
    if (ids.length === 0) {
        listEl.innerHTML = '<p class="hint">加载中...</p>';
        return;
    }
    const overrideIds = new Set((appSettings?.source_overrides || []).map(s => s.id));
    listEl.innerHTML = ids.map(id => {
        const isModified = overrideIds.has(id);
        const src = isModified
            ? appSettings.source_overrides.find(s => s.id === id)
            : builtinDefaults[id];
        const name = src.name || id;
        const zoom = src.max_zoom || builtinDefaults[id]?.max_zoom || '?';
        const tag = isModified ? '<span class="source-tag source-tag-modified">已修改</span>' : '';
        return `<div class="source-item">
            <div class="source-item-info">
                <span class="source-item-name">${escapeHtml(name)}</span>
                <span class="badge badge-secondary" style="font-size:10px;padding:1px 5px">z${escapeHtml(zoom)}</span>
                ${tag}
            </div>
            <div class="source-item-actions">
                <button class="btn-icon btn-edit-builtin" data-id="${escapeAttr(id)}" title="编辑">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                ${isModified ? `<button class="btn-icon btn-reset-builtin" data-id="${escapeAttr(id)}" title="重置为默认">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
                </button>` : ''}
            </div>
        </div>`;
    }).join('');
}

function initBuiltinSourcesList() {
    const listEl = document.getElementById('builtin-sources-list');
    if (!listEl) return;
    listEl.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.btn-edit-builtin');
        if (editBtn) { editBuiltinSource(editBtn.dataset.id); return; }
        const resetBtn = e.target.closest('.btn-reset-builtin');
        if (resetBtn) resetBuiltinSource(resetBtn.dataset.id);
    });
}

// === 自定义图源 ===

function editCustomSource(id) {
    const source = appSettings?.custom_sources?.find(s => s.id === id);
    if (!source) return;
    editingSourceId = id;
    editingBuiltin = false;
    openSourceDialog(`编辑: ${source.name}`, source);
}

async function removeCustomSource(id) {
    if (!appSettings.custom_sources) return;
    appSettings.custom_sources = appSettings.custom_sources.filter(s => s.id !== id);
    try {
        await TifApi.saveSettings(appSettings);
        renderCustomSourcesList();
        refreshMapLayers();
    } catch (error) {
        alert('保存失败: ' + error.message);
    }
}

function renderCustomSourcesList() {
    const listEl = document.getElementById('custom-sources-list');
    if (!listEl) return;
    const sources = appSettings?.custom_sources || [];
    if (sources.length === 0) {
        listEl.innerHTML = '<p class="hint">暂无自定义图源</p>';
        return;
    }
    listEl.innerHTML = sources.map(s => `
        <div class="source-item">
            <div class="source-item-info">
                <span class="source-item-name">${escapeHtml(s.name)}</span>
                <span class="badge badge-secondary" style="font-size:10px;padding:1px 5px">z${escapeHtml(s.max_zoom)}</span>
            </div>
            <div class="source-item-actions">
                <button class="btn-icon btn-edit-source" data-id="${escapeAttr(s.id)}" title="编辑">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="btn-icon btn-delete-source" data-id="${escapeAttr(s.id)}" title="删除">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
            </div>
        </div>
    `).join('');
}

function initCustomSourcesList() {
    renderCustomSourcesList();
    const listEl = document.getElementById('custom-sources-list');
    if (!listEl) return;
    listEl.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.btn-delete-source');
        if (deleteBtn) { removeCustomSource(deleteBtn.dataset.id); return; }
        const editBtn = e.target.closest('.btn-edit-source');
        if (editBtn) editCustomSource(editBtn.dataset.id);
    });
}

async function saveAllSettings() {
    const statusEl = document.getElementById('settings-status');
    
    const settings = {
        tianditu_token: document.getElementById('tianditu-token-input').value.trim() || null,
        proxy_enabled: document.getElementById('proxy-checkbox').checked,
        proxy_url: document.getElementById('proxy-input').value.trim(),
        default_concurrency: parseInt(document.getElementById('default-concurrency').value),
        default_zoom: parseInt(document.getElementById('default-zoom').value),
        default_format: 'geotiff',
        default_source: 'osm',
        custom_sources: appSettings?.custom_sources || [],
        source_overrides: appSettings?.source_overrides || [],
        debug_mode: document.getElementById('debug-mode-checkbox').checked,
        memory_budget_mb: parseInt(document.getElementById('memory-budget-slider').value) || 2048
    };
    
    try {
        await TifApi.saveSettings(settings);
        appSettings = settings;
        statusEl.textContent = '✅ 设置已保存';
        statusEl.className = 'status-text success';
        
        // 应用设置到主界面
        applySettings(settings);
        
        // 刷新地图图层
        refreshMapLayers().then(() => {
            // wayback 模式下不应恢复底图
            if (currentMode === 'wayback') {
                Object.values(mapLayers).forEach(layer => {
                    if (map.hasLayer(layer)) map.removeLayer(layer);
                });
            }
        });
    } catch (error) {
        statusEl.textContent = '❌ 保存失败: ' + error.message;
        statusEl.className = 'status-text error';
    }
}

// ============ 缩放级别滑块 ============
function initZoomSlider() {
    const slider = document.getElementById('zoom-slider');
    const maxInput = document.getElementById('zoom-max-input');

    refreshZoomBadge();

    slider.addEventListener('input', (e) => {
        refreshZoomBadge();
        if (currentBounds) {
            estimateDownload();
        }
    });
    if (maxInput) {
        maxInput.addEventListener('input', () => {
            refreshZoomBadge();
            if (currentBounds) {
                estimateDownload();
            }
        });
    }
}

// 刷新 zoom badge 显示（读取 slider 当前值和 max）
function refreshZoomBadge() {
    const slider = document.getElementById('zoom-slider');
    const badge = document.getElementById('zoom-badge');
    if (!slider || !badge) return;

    const { zoom: z, zoomMax } = readZoomRange('zoom-slider', 'zoom-max-input');
    const maxZ = parseInt(slider.max);
    let level = '';
    if (z <= 3) level = '全球';
    else if (z <= 5) level = '大洲';
    else if (z <= 7) level = '国家';
    else if (z <= 9) level = '省域';
    else if (z <= 11) level = '城市';
    else if (z <= 13) level = '区县';
    else if (z <= 15) level = '街道';
    else if (z <= 17) level = '建筑';
    else if (z <= 19) level = '细节';
    else level = '超清';

    const rangeText = zoomMax > z ? `~z${zoomMax}` : '';
    badge.textContent = `z${z}${rangeText} · ${level}级 (最高z${maxZ})`;
}

// 根据图源更新 zoom slider 最大值
function updateZoomSliderMax(sourceKey) {
    const slider = document.getElementById('zoom-slider');
    if (!slider) return;

    // 从 tileSourceConfigs 查找当前图源的 max_zoom
    let maxZoom = 22;
    if (tileSourceConfigs && tileSourceConfigs[sourceKey]) {
        maxZoom = tileSourceConfigs[sourceKey].max_zoom || 22;
    }

    slider.max = maxZoom;

    const maxInput = document.getElementById('zoom-max-input');
    if (maxInput) {
        maxInput.max = maxZoom;
        if (maxInput.value && parseInt(maxInput.value) > maxZoom) {
            maxInput.value = maxZoom;
        }
    }

    // 如果当前值超出新的最大值，钳位到最大值
    if (parseInt(slider.value) > maxZoom) {
        slider.value = maxZoom;
    }

    refreshZoomBadge();

    if (currentBounds) {
        estimateDownload();
    }
}

// ============ 并发数滑块 ============
function initConcurrencySlider() {
    const slider = document.getElementById('concurrency-slider');
    const value = document.getElementById('concurrency-value');
    
    slider.addEventListener('input', (e) => {
        value.textContent = e.target.value;
    });
}

// ============ 压缩选项 ============
function initCompressOption() {
    const formatSelect = document.getElementById('format-select');
    const compressOption = document.getElementById('compress-option');
    const pyramidOption = document.getElementById('pyramid-option');
    
    function updateCompressVisibility() {
        const format = formatSelect.value;
        const isGeotiff = format === 'geotiff';
        compressOption.style.display = isGeotiff ? '' : 'none';
        pyramidOption.style.display = isGeotiff ? '' : 'none';
    }
    
    updateCompressVisibility();
    formatSelect.addEventListener('change', updateCompressVisibility);
}

// ============ 事件监听器初始化 ============
function initEventListeners() {
    // 搜索按钮
    document.getElementById('search-btn').addEventListener('click', searchPlace);
    document.getElementById('search-input').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') searchPlace();
    });
    
    // 省份选择
    document.getElementById('province-select').addEventListener('change', (e) => {
        onProvinceChange(e);
        updateVectorButtons();
    });
    
    // 城市选择
    document.getElementById('city-select').addEventListener('change', (e) => {
        onCityChange(e);
        updateVectorButtons();
    });
    
    // 区县选择
    document.getElementById('district-select').addEventListener('change', (e) => {
        onDistrictChange(e);
        updateVectorButtons();
    });
    
    // 加载边界按钮
    document.getElementById('load-boundary-btn').addEventListener('click', loadSelectedBoundary);
    
    // 缩放级别滑块 - 已在 initZoomSlider 中处理
    
    // 下载按钮
    document.getElementById('download-btn').addEventListener('click', startDownload);
    
    // 矢量下载按钮
    document.getElementById('download-osm-btn').addEventListener('click', downloadOSMData);
    document.getElementById('download-admin-btn').addEventListener('click', downloadAdminBoundary);
    
    // 矢量加载/清除按钮
    document.getElementById('load-vector-btn').addEventListener('click', () => {
        document.getElementById('vector-file-input').click();
    });
    document.getElementById('vector-file-input').addEventListener('change', loadVectorFile);
    document.getElementById('clear-vector-btn').addEventListener('click', clearVectorLayers);
    
    // 上传边界按钮
    document.getElementById('upload-boundary-btn').addEventListener('click', () => {
        document.getElementById('boundary-file-input').click();
    });
    document.getElementById('boundary-file-input').addEventListener('change', loadBoundaryFile);
    document.getElementById('clear-boundary-btn').addEventListener('click', clearBoundary);
}

// ============ 地名搜索 ============
async function searchPlace() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) return;
    
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '<div class="search-result-item">搜索中...</div>';
    
    try {
        const tiandituToken = getTianDiTuToken();
        const results = await TifApi.geocodeSearch(query, tiandituToken);
        
        if (results.length === 0) {
            resultsContainer.innerHTML = '<div class="search-result-item">未找到结果</div>';
            return;
        }
        
        resultsContainer.innerHTML = results.map((r, idx) => `
            <div class="search-result-item" data-idx="${idx}">
                <div class="name">${escapeHtml(r.name)}</div>
                <div class="detail">${escapeHtml(r.display_name)}</div>
            </div>
        `).join('');
        // 改用事件委托，避免 onclick 内联拼接导致的 XSS / JSON 注入风险
        Array.from(resultsContainer.querySelectorAll('.search-result-item')).forEach(el => {
            el.addEventListener('click', () => {
                const r = results[parseInt(el.dataset.idx, 10)];
                if (!r) return;
                // 行政区结果：直接加载边界
                if (r.kind === 'admin' && r.admin_code) {
                    loadAdminBoundaryByCode(r.admin_code, r.name);
                    document.getElementById('search-results').innerHTML = '';
                    return;
                }
                // POI 结果：仅定位
                goToLocation(r.lat, r.lng, r.bounds || null, r.address || null);
            });
        });
    } catch (error) {
        resultsContainer.innerHTML = '<div class="search-result-item">搜索失败</div>';
        console.error('Search error:', error);
    }
}

function goToLocation(lat, lng, bounds, address) {
    if (bounds) {
        map.fitBounds([
            [bounds.south, bounds.west],
            [bounds.north, bounds.east]
        ]);
    } else {
        map.setView([lat, lng], 14);
    }
    document.getElementById('search-results').innerHTML = '';
    
    // 自动选择行政区划
    if (address) {
        autoSelectAdminRegion(address);
    }
}

async function autoSelectAdminRegion(address) {

    // 尝试匹配字段 (Nominatim 返回字段可能不同)
    const provinceText = address.state || address.province || address.region;
    const cityText = address.city || address.town || address.municipality || address.prefecture; 
    const districtText = address.district || address.county || address.city_district || address.suburb;

    // 1. 选择省份
    const provinceSelect = document.getElementById('province-select');
    const provOption = findOptionByText(provinceSelect, provinceText);
    
    if (provOption) {
        provinceSelect.value = provOption.value;
        // 触发变更并等待加载完成
        await onProvinceChange({ target: provinceSelect });
        
        // 2. 选择城市
        const citySelect = document.getElementById('city-select');
        let cityOption = findOptionByText(citySelect, cityText);
        
        // 直辖市特殊处理 (如 address.state="Beijing", address.city="Beijing")
        if (!cityOption && provinceText) {
             // 尝试再次用省份名匹配城市 (直辖市通常省市同名)
             cityOption = findOptionByText(citySelect, provinceText);
        }
        
        if (cityOption) {
            citySelect.value = cityOption.value;
            await onCityChange({ target: citySelect });
            
            // 3. 选择区县
            const districtSelect = document.getElementById('district-select');
            const distOption = findOptionByText(districtSelect, districtText);
            
            if (distOption) {
                districtSelect.value = distOption.value;
                onDistrictChange({ target: districtSelect });
            }
        }
    }
}

function findOptionByText(select, text) {
    if (!text) return null;
    // 移除常见后缀进行模糊匹配
    const cleanText = text.replace(/(省|市|区|县|Autonomus Region|Municipality)$/i, '').trim();
    if (!cleanText) return null;
    
    for (let i = 0; i < select.options.length; i++) {
        const opt = select.options[i];
        if (!opt.value) continue;
        
        // 双向包含匹配
        const optText = opt.text.replace(/(省|市|区|县)$/i, '').trim();
        if (optText.includes(cleanText) || cleanText.includes(optText)) {
            return opt;
        }
    }
    return null;
}

// ============ 行政区划 ============
async function loadProvinces() {
    try {
        const provinces = await TifApi.getProvinces();
        
        if (!Array.isArray(provinces)) {
            console.error('Provinces response is not an array:', provinces);
            return;
        }
        
        const select = document.getElementById('province-select');
        select.innerHTML = '<option value="">请选择省份</option>';
        select.innerHTML += '<option value="100000">全国</option>';
        provinces.forEach(p => {
            select.innerHTML += `<option value="${p.code}">${p.name}</option>`;
        });
    } catch (error) {
        console.error('Failed to load provinces:', error);
    }
}

async function onProvinceChange(e) {
    const code = e.target.value;
    const citySelect = document.getElementById('city-select');
    const districtSelect = document.getElementById('district-select');
    
    citySelect.innerHTML = '<option value="">请选择城市</option>';
    citySelect.disabled = true;
    districtSelect.innerHTML = '<option value="">请先选择城市</option>';
    districtSelect.disabled = true;
    
    if (!code) return;
    
    try {
        const cities = await TifApi.getCities(code);
        
        if (!Array.isArray(cities)) {
            console.error('Cities response is not an array:', cities);
            return;
        }
        
        citySelect.disabled = false;
        cities.forEach(c => {
            citySelect.innerHTML += `<option value="${c.code}">${c.name}</option>`;
        });
    } catch (error) {
        console.error('Failed to load cities:', error);
    }
}

async function onCityChange(e) {
    const code = e.target.value;
    const districtSelect = document.getElementById('district-select');
    
    districtSelect.innerHTML = '<option value="">请选择区县</option>';
    districtSelect.disabled = true;
    
    if (!code) return;
    
    try {
        const districts = await TifApi.getDistricts(code);
        
        if (!Array.isArray(districts)) {
            console.error('Districts response is not an array:', districts);
            return;
        }
        
        districtSelect.disabled = false;
        districts.forEach(d => {
            districtSelect.innerHTML += `<option value="${d.code}">${d.name}</option>`;
        });
    } catch (error) {
        console.error('Failed to load districts:', error);
    }
}

function onDistrictChange(e) {
    // 选择区县后可以加载边界
}

async function loadSelectedBoundary() {
    // 获取选中的代码
    const districtCode = document.getElementById('district-select').value;
    const cityCode = document.getElementById('city-select').value;
    const provinceCode = document.getElementById('province-select').value;
    
    const code = districtCode || cityCode || provinceCode;
    
    if (!code) {
        alert('请先选择行政区划');
        return;
    }
    
    try {
        // 始终转换为 WGS-84 坐标（所有图源已统一到 WGS-84）
        const geojson = await TifApi.getAdminBoundary(code, true);
        
        // 清除之前的图层
        drawnItems.clearLayers();
        if (boundaryLayer) {
            map.removeLayer(boundaryLayer);
        }
        
        // 添加边界
        boundaryLayer = L.geoJSON(geojson, {
            style: {
                color: '#e74c3c',
                fillColor: '#e74c3c',
                fillOpacity: 0.2,
                weight: 2
            }
        }).addTo(map);
        
        // 适应边界（禁用动画避免瓦片渲染延迟）
        map.fitBounds(boundaryLayer.getBounds(), { animate: false });
        
        // 强制刷新地图尺寸和瓦片
        map.invalidateSize();
        setTimeout(() => {
            map.invalidateSize();
            map.eachLayer(layer => {
                if (layer.redraw) layer.redraw();
            });
        }, 200);
        
        // 设置当前边界
        const bounds = boundaryLayer.getBounds();
        currentBounds = {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
        
        // 从 GeoJSON 中提取多边形坐标用于裁剪
        currentPolygon = extractPolygonFromGeoJSON(geojson);
        
        updateSelectionInfo();
        estimateDownload();
        updateVectorButtons();
        syncSelectionToCesium();
    } catch (error) {
        console.error('Failed to load boundary:', error);
        alert('加载边界失败');
    }
}

/// 通过 adminCode 直接加载行政区边界（搜索结果点击时调用）
async function loadAdminBoundaryByCode(code, name) {
    try {
        const geojson = await TifApi.getAdminBoundary(code, true);
        drawnItems.clearLayers();
        if (boundaryLayer) {
            map.removeLayer(boundaryLayer);
        }
        boundaryLayer = L.geoJSON(geojson, {
            style: { color: '#e74c3c', fillColor: '#e74c3c', fillOpacity: 0.2, weight: 2 }
        }).addTo(map);
        map.fitBounds(boundaryLayer.getBounds(), { animate: false });
        map.invalidateSize();
        setTimeout(() => {
            map.invalidateSize();
            map.eachLayer(layer => { if (layer.redraw) layer.redraw(); });
        }, 200);
        const bounds = boundaryLayer.getBounds();
        currentBounds = {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
        currentPolygon = extractPolygonFromGeoJSON(geojson);
        updateSelectionInfo();
        estimateDownload();
        updateVectorButtons();
        syncSelectionToCesium();
    } catch (error) {
        console.error('加载行政区边界失败:', error);
        alert(`加载 ${name || code} 边界失败：${error.message || error}`);
    }
}

// ============ 选择信息更新 ============
function updateSelectionInfo() {
    const infoDiv = document.getElementById('selection-info');
    
    if (!currentBounds) {
        infoDiv.innerHTML = '<p>使用地图工具绘制区域，或选择行政区划</p>';
        return;
    }
    
    const { north, south, east, west } = currentBounds;
    infoDiv.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 0.75rem;">
            <div><span style="color:#666">北:</span> <span class="coords">${north.toFixed(6)}°</span></div>
            <div><span style="color:#666">南:</span> <span class="coords">${south.toFixed(6)}°</span></div>
            <div><span style="color:#666">西:</span> <span class="coords">${west.toFixed(6)}°</span></div>
            <div><span style="color:#666">东:</span> <span class="coords">${east.toFixed(6)}°</span></div>
        </div>
    `;
}

// ============ 下载估算 ============
async function estimateDownload() {
    if (!currentBounds) return;
    
    // 同时更新 wayback 估算（如果在 wayback 模式）
    if (currentMode === 'wayback') {
        estimateWaybackDownload();
    }

    const { zoom, zoomMax } = readZoomRange('zoom-slider', 'zoom-max-input');
    const estimateDiv = document.getElementById('estimate-info');
    const downloadBtn = document.getElementById('download-btn');
    
    // 收集当前格式和裁剪状态
    const formatSelect = document.getElementById('format-select');
    const cropCheckbox = document.getElementById('crop-to-shape');
    const format = formatSelect ? formatSelect.value : undefined;
    const cropToShape = cropCheckbox ? cropCheckbox.checked : false;
    
    try {
        const result = await TifApi.estimateDownload(currentBounds, zoom, format, cropToShape, zoomMax);
        
        if (result.allowed) {
            estimateDiv.className = 'estimate-card';
            let html = `
                <strong>${result.tile_count.toLocaleString()}</strong> 个瓦片 (${result.cols}列 × ${result.rows}行) · 约 <strong>${result.estimated_size_mb.toFixed(1)} MB</strong>
            `;
            // GeoTIFF 显示未压缩大小
            if (result.raw_size_mb) {
                html += ` · 未压缩 ${result.raw_size_mb.toFixed(0)} MB`;
            }
            // 显示预算信息（即使通过也可提示）
            if (result.budget_check && result.budget_check.estimated_peak_bytes) {
                const peakMB = Math.round(result.budget_check.estimated_peak_bytes / 1024 / 1024);
                const budgetMB = Math.round(result.budget_check.budget_bytes / 1024 / 1024);
                html += `<br><small style="color:#888">内存预估 ${peakMB} MB / ${budgetMB} MB</small>`;
            }
            // 大小说明（如压缩效率提示）
            if (result.size_note) {
                html += `<br><small style="color:#b08800">💡 ${result.size_note}</small>`;
            }
            estimateDiv.innerHTML = html;
            downloadBtn.disabled = false;
        } else {
            estimateDiv.className = 'estimate-card error';
            let html = result.warning || '不允许下载';
            if (result.budget_check && result.budget_check.suggestions && result.budget_check.suggestions.length > 0) {
                html += '<ul style="margin:4px 0;padding-left:18px;font-size:12px">';
                result.budget_check.suggestions.forEach(s => {
                    html += `<li>${s}</li>`;
                });
                html += '</ul>';
            }
            estimateDiv.innerHTML = html;
            downloadBtn.disabled = true;
        }
    } catch (error) {
        estimateDiv.className = 'estimate-card error';
        estimateDiv.innerHTML = '估算失败';
        downloadBtn.disabled = true;
    }
}

// ============ 桌面端检测 ============
function isDesktopApp() {
    // Tauri 或 pywebview
    return TifApi.isDesktopApp() || typeof window.pywebview !== 'undefined';
}

// ============ 下载 ============
async function startDownload() {
    if (!currentBounds) {
        alert('请先选择下载区域');
        return;
    }
    
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn.disabled) return; // 防止重复触发
    downloadBtn.disabled = true;
    
    // 获取文件格式和默认文件名
    const format = document.getElementById('format-select').value;
    const { zoom, zoomMax, hasRange } = readZoomRange('zoom-slider', 'zoom-max-input');
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const ext = format === 'geotiff' ? '.tif' : format === 'png' ? '.png' : '.jpg';
    const zoomLabel = formatZoomRangeLabel(zoom, zoomMax);
    const defaultFilename = `map_${timestamp}_${zoomLabel}${ext}`;
    
    // 桌面端：先让用户选择保存路径
    let savePath = null;
    if (isDesktopApp()) {
        try {
            if (TifApi._checkIsTauri()) {
                savePath = await TifApi.showSaveDialog(defaultFilename, [
                    { name: 'Image Files', extensions: [ext.slice(1)] }
                ]);
            } else if (window.pywebview) {
                savePath = await window.pywebview.api.save_file_dialog(defaultFilename);
            }
            if (!savePath) {
                resetDownloadButton(downloadBtn);
                return;
            }
        } catch (e) {
            console.error('保存对话框错误:', e);
            resetDownloadButton(downloadBtn);
            return;
        }
    }
    
    const useProxy = document.getElementById('proxy-checkbox').checked;
    const proxyUrl = document.getElementById('proxy-input').value.trim();
    const tiandituToken = getTianDiTuToken();
    const concurrency = parseInt(document.getElementById('concurrency-slider').value);
    const compression = format === 'geotiff' ? document.getElementById('compress-select').value : 'none';
    const buildPyramid = format === 'geotiff' && document.getElementById('pyramid-checkbox').checked;
    
    const request = {
        bounds: currentBounds,
        polygon: currentPolygon,
        zoom: zoom,
        zoom_max: hasRange ? zoomMax : null,
        source: document.getElementById('source-select').value,
        format: format,
        crop_to_shape: document.getElementById('crop-checkbox').checked,
        proxy: useProxy && proxyUrl ? proxyUrl : null,
        tianditu_token: tiandituToken || null,
        save_path: savePath || null,
        concurrency: concurrency,
        compression: compression,
        build_pyramid: buildPyramid
    };
    
    // Tauri 模式：创建下载任务
    if (TifApi._checkIsTauri()) {
        try {
            downloadBtn.innerHTML = '<span class="loading-spinner"></span> 探测瓦片...';

            // 探测选区中心的瓦片是否有数据
            const centerLat = (currentBounds.north + currentBounds.south) / 2;
            const centerLng = (currentBounds.east + currentBounds.west) / 2;
            const probeResult = await TifApi.probeTile(
                request.source,
                request.zoom_max || request.zoom,
                centerLat,
                centerLng,
                request.tianditu_token,
                request.proxy,
            );

            if (!probeResult.has_data) {
                const maxZoom = tileSourceConfigs[request.source]?.max_zoom || '?';
                const proceed = await TifApi.showAskDialog(
                    `探测发现该区域在 ${formatZoomRangeLabel(request.zoom, request.zoom_max || request.zoom)} 的最高级别可能无数据\n` +
                    `${probeResult.message}\n\n` +
                    `该图源最高支持 z${maxZoom}，但部分区域实际覆盖可能低于此级别。\n` +
                    `建议降低缩放级别后重试。\n\n` +
                    `是否仍然继续下载？`,
                    '⚠️ 瓦片探测警告'
                );
                if (!proceed) {
                    resetDownloadButton(downloadBtn);
                    return;
                }
            }

            downloadBtn.innerHTML = '<span class="loading-spinner"></span> 创建任务...';
            
            const sourceSelect = document.getElementById('source-select');
            const sourceName = sourceSelect.options[sourceSelect.selectedIndex]?.text || request.source;
            
            const result = await TifApi.createDownloadTask(request, defaultFilename, sourceName);
            
            // 在下载中心添加任务卡片
            addTaskCardToUI(result.task_id, defaultFilename, sourceName, request.zoom, result.tile_count);
            
            // 监听进度事件
            startTaskListener(result.task_id);
            
            // 跳转到下载中心
            switchToDownloadCenter();
        } catch (error) {
            console.error('创建任务失败:', error);
            alert('创建任务失败: ' + (error?.message || error || '未知错误'));
        } finally {
            resetDownloadButton(downloadBtn);
        }
        return;
    }
    
    // 非 Tauri 模式：直接下载
    try {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '<span class="loading-spinner"></span> 下载中...';
        await TifApi.downloadTiles(request);
        alert('下载完成');
    } catch (error) {
        alert('下载失败: ' + error.message);
    } finally {
        resetDownloadButton(downloadBtn);
    }
}

function resetDownloadButton(btn) {
    btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16">
            <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
            <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
        </svg>
        下载地图
    `;
    btn.disabled = false;
}


// ============ 矢量数据下载 ============

// 当前选中的行政区划代码
let currentAdminCode = null;

function updateVectorButtons() {
    const osmBtn = document.getElementById('download-osm-btn');
    const adminBtn = document.getElementById('download-admin-btn');
    const statusEl = document.getElementById('vector-status');
    
    // OSM 下载需要有边界框
    osmBtn.disabled = !currentBounds;
    
    // 行政区划下载需要选中行政区
    const districtCode = document.getElementById('district-select').value;
    const cityCode = document.getElementById('city-select').value;
    const provinceCode = document.getElementById('province-select').value;
    currentAdminCode = districtCode || cityCode || provinceCode;
    adminBtn.disabled = !currentAdminCode;
    
    // 更新状态提示
    if (currentBounds && currentAdminCode) {
        statusEl.textContent = '✅ 可下载 OSM 和行政边界';
    } else if (currentBounds) {
        statusEl.textContent = '✅ 可下载 OSM（选择行政区可下载边界）';
    } else if (currentAdminCode) {
        statusEl.textContent = '✅ 可下载行政边界（绘制区域可下载 OSM）';
    } else {
        statusEl.textContent = '绘制区域或选择行政区划后可下载';
    }
}

async function downloadOSMData() {
    if (!currentBounds) {
        alert('请先绘制或选择一个区域');
        return;
    }
    
    const featureType = document.getElementById('osm-feature-select').value;
    const featureSelect = document.getElementById('osm-feature-select');
    const featureLabel = featureSelect.options[featureSelect.selectedIndex]?.text || featureType;
    const statusEl = document.getElementById('vector-status');
    const osmBtn = document.getElementById('download-osm-btn');
    
    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const defaultFilename = `osm_${featureType}_${timestamp}.geojson`;
    
    // 桌面端：弹出保存对话框
    let savePath = null;
    if (isDesktopApp()) {
        try {
            savePath = await TifApi.showSaveDialog(defaultFilename, [
                { name: 'GeoJSON', extensions: ['geojson', 'json'] }
            ]);
            if (!savePath) return;
        } catch (e) {
            console.error('保存对话框错误:', e);
        }
    }
    
    // Tauri 模式：创建后台任务
    if (TifApi._checkIsTauri() && savePath) {
        try {
            osmBtn.disabled = true;
            const useProxy = document.getElementById('proxy-checkbox').checked;
            const proxyUrl = document.getElementById('proxy-input').value.trim();
            const proxy = useProxy && proxyUrl ? proxyUrl : null;
            
            const taskName = `OSM ${featureLabel}`;
            // OSM Overpass 只需第一个多边形环作为边界过滤
            const osmPolygon = currentPolygon ? currentPolygon[0] : null;
            const result = await TifApi.createOsmDownloadTask(
                currentBounds, featureType, savePath, proxy, osmPolygon, taskName
            );
            
            addTaskCardToUI(result.task_id, taskName, 'OSM Overpass', 0, 0);
            startTaskListener(result.task_id);
            switchToDownloadCenter();
            statusEl.textContent = '';
        } catch (error) {
            statusEl.textContent = `❌ ${error.message}`;
            alert('OSM 下载失败: ' + error.message);
        } finally {
            osmBtn.disabled = false;
        }
        return;
    }
    
    // 非 Tauri 模式：HTTP 回退
    osmBtn.disabled = true;
    statusEl.textContent = '⬇️ 正在下载 OSM 数据...';
    try {
        const useProxy = document.getElementById('proxy-checkbox').checked;
        const proxyUrl = document.getElementById('proxy-input').value.trim();
        const proxy = useProxy && proxyUrl ? proxyUrl : null;
        
        const params = new URLSearchParams({
            feature_type: featureType,
            south: currentBounds.south,
            west: currentBounds.west,
            north: currentBounds.north,
            east: currentBounds.east,
            output_format: 'geojson',
            proxy: proxy || ''
        });
        const response = await fetch(`/api/vector/osm?${params}`, { method: 'POST' });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'OSM 下载失败');
        }
        const content = await response.text();
        const filename = response.headers.get('X-Filename') || defaultFilename;
        downloadTextFile(content, filename, 'application/geo+json');
        statusEl.textContent = `✅ 下载完成: ${filename}`;
    } catch (error) {
        statusEl.textContent = `❌ ${error.message}`;
        alert('OSM 下载失败: ' + error.message);
    } finally {
        osmBtn.disabled = false;
        setTimeout(() => updateVectorButtons(), 3000);
    }
}

async function downloadAdminBoundary() {
    if (!currentAdminCode) {
        alert('请先选择行政区划');
        return;
    }
    
    const statusEl = document.getElementById('vector-status');
    const adminBtn = document.getElementById('download-admin-btn');
    
    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const defaultFilename = `admin_${currentAdminCode}_${timestamp}.geojson`;
    
    // 桌面端：弹出保存对话框
    let savePath = null;
    if (isDesktopApp()) {
        try {
            savePath = await TifApi.showSaveDialog(defaultFilename, [
                { name: 'GeoJSON', extensions: ['geojson', 'json'] }
            ]);
            if (!savePath) return;
        } catch (e) {
            console.error('保存对话框错误:', e);
        }
    }
    
    adminBtn.disabled = true;
    statusEl.textContent = '⬇️ 正在下载行政边界...';
    
    try {
        if (isDesktopApp() && savePath) {
            // Tauri 桌面端
            await TifApi.downloadAdminBoundaryFile(currentAdminCode, savePath);
            statusEl.textContent = `✅ 已保存: ${savePath}`;
            
            // 添加到下载历史
            try {
                const fs = await import('@tauri-apps/plugin-fs');
                const stat = await fs.stat(savePath);
                await TifApi.addDownloadRecord(
                    `行政边界 ${currentAdminCode}`,  // name
                    'admin_boundary',                // source
                    'DataV 行政边界',               // sourceName
                    0,                               // zoom (N/A)
                    'geojson',                       // format
                    savePath,                        // filePath
                    stat.size || 0,                  // fileSize
                    0,                               // tileCount (N/A)
                    0,                               // failedCount
                    true                             // success
                );
            } catch (e) {
                console.warn('添加下载记录失败:', e);
            }
        } else {
            // 网页端：使用 HTTP API
            const params = new URLSearchParams({
                code: currentAdminCode,
                output_format: 'geojson',
                full: 'true'
            });
            
            const response = await fetch(`/api/vector/admin_boundary?${params}`, {
                method: 'POST'
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || '下载失败');
            }
            
            const content = await response.text();
            const filename = response.headers.get('X-Filename') || defaultFilename;
            downloadTextFile(content, filename, 'application/geo+json');
            statusEl.textContent = `✅ 下载完成: ${filename}`;
        }
        
    } catch (error) {
        statusEl.textContent = `❌ ${error.message}`;
        alert('边界下载失败: ' + error.message);
    } finally {
        adminBtn.disabled = false;
        setTimeout(() => updateVectorButtons(), 3000);
    }
}

function downloadTextFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// ============ 矢量数据加载 ============

// 存储加载的矢量图层
let vectorLayers = [];

async function loadVectorFile(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    const statusEl = document.getElementById('vector-status');
    statusEl.textContent = '⬇️ 正在加载...';
    
    for (const file of files) {
        try {
            const filename = file.name.toLowerCase();
            let geojson;
            
            if (filename.endsWith('.geojson') || filename.endsWith('.json')) {
                // 直接读取 GeoJSON
                const text = await file.text();
                geojson = JSON.parse(text);
            } else if (filename.endsWith('.zip')) {
                // Shapefile ZIP - 需要后端处理
                statusEl.textContent = '⚠️ Shapefile 需要通过后端转换...';
                geojson = await convertShapefileToGeoJSON(file);
            } else {
                throw new Error('不支持的文件格式');
            }
            
            if (geojson) {
                addVectorToMap(geojson, file.name);
            }
        } catch (error) {
            console.error('Failed to load vector file:', error);
            statusEl.textContent = `❌ 加载失败: ${error.message}`;
        }
    }
    
    // 清空文件输入，允许重新选择相同文件
    event.target.value = '';
}

function addVectorToMap(geojson, filename) {
    const statusEl = document.getElementById('vector-status');
    
    // 随机颜色
    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12', '#1abc9c'];
    const color = colors[vectorLayers.length % colors.length];
    
    // 创建图层
    const layer = L.geoJSON(geojson, {
        style: {
            color: color,
            fillColor: color,
            fillOpacity: 0.3,
            weight: 2
        },
        pointToLayer: function(feature, latlng) {
            return L.circleMarker(latlng, {
                radius: 6,
                fillColor: color,
                color: '#fff',
                weight: 1,
                fillOpacity: 0.8
            });
        },
        onEachFeature: function(feature, layer) {
            // 添加弹窗显示属性
            if (feature.properties) {
                const props = Object.entries(feature.properties)
                    .filter(([k, v]) => v !== null && v !== '')
                    .slice(0, 10)  // 最多显示10个属性
                    .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`)
                    .join('<br>');
                if (props) {
                    layer.bindPopup(props);
                }
            }
        }
    }).addTo(map);
    
    vectorLayers.push({ layer, filename });
    
    // 缩放到图层范围
    try {
        const bounds = layer.getBounds();
        if (bounds.isValid()) {
            map.fitBounds(bounds);
            
            // 设置当前边界（用于下载）
            currentBounds = {
                north: bounds.getNorth(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                west: bounds.getWest()
            };
            updateSelectionInfo();
            updateVectorButtons();
        }
    } catch (e) {
        console.error('Could not fit bounds:', e);
    }
    
    // 统计要素数量
    let featureCount = 0;
    if (geojson.type === 'FeatureCollection') {
        featureCount = geojson.features ? geojson.features.length : 0;
    } else if (geojson.type === 'Feature') {
        featureCount = 1;
    }
    
    statusEl.textContent = `✅ 已加载: ${filename} (${featureCount} 个要素)`;
}

function clearVectorLayers() {
    vectorLayers.forEach(({ layer }) => {
        map.removeLayer(layer);
    });
    vectorLayers = [];
    
    document.getElementById('vector-status').textContent = '已清除所有矢量图层';
}

// ============ 上传自定义边界 ============

// 存储上传的边界图层
let uploadedBoundaryLayer = null;

async function loadBoundaryFile(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    const infoEl = document.getElementById('selection-info');
    infoEl.innerHTML = '<p class="hint">-- 正在加载边界文件...</p>';
    
    // 延迟执行，让 UI 有时间更新
    await new Promise(r => setTimeout(r, 50));
    
    try {
        const fileArray = Array.from(files);

        // 检测多文件批量：多个独立 .geojson 或多组 .shp
        const geojsonFiles = fileArray.filter(f => {
            const n = f.name.toLowerCase();
            return n.endsWith('.geojson') || n.endsWith('.json');
        });
        const shpFiles = fileArray.filter(f => f.name.toLowerCase().endsWith('.shp'));
        const isMultiFile = geojsonFiles.length > 1 || shpFiles.length > 1;

        let geojson;
        let filename;

        if (isMultiFile) {
            // 多文件批量模式：解析每个文件并合并
            infoEl.innerHTML = '<p class="hint">-- 正在解析多个文件...</p>';
            await new Promise(r => setTimeout(r, 50));
            const allFeatures = [];

            if (shpFiles.length > 1) {
                // 多组 Shapefile：按 .shp 基名分组
                const auxFiles = fileArray.filter(f => !f.name.toLowerCase().endsWith('.shp'));
                for (const sf of shpFiles) {
                    const baseName = sf.name.replace(/\.shp$/i, '');
                    const group = [sf, ...auxFiles.filter(af => {
                        const afBase = af.name.replace(/\.[^.]+$/, '');
                        return afBase.toLowerCase() === baseName.toLowerCase();
                    })];
                    const gj = await convertShapefilesToGeoJSON(group);
                    const features = gj.type === 'FeatureCollection' ? (gj.features || []) : [gj];
                    features.forEach(f => {
                        if (!f.properties) f.properties = {};
                        f.properties.__source_file = sf.name;
                        allFeatures.push(f);
                    });
                }
                filename = shpFiles.length + ' 个 Shapefile';
            } else {
                // 多个 GeoJSON
                for (const gf of geojsonFiles) {
                    const text = await gf.text();
                    const gj = JSON.parse(text);
                    const features = gj.type === 'FeatureCollection' ? (gj.features || []) : [gj];
                    features.forEach(f => {
                        if (!f.properties) f.properties = {};
                        f.properties.__source_file = gf.name;
                        allFeatures.push(f);
                    });
                }
                filename = geojsonFiles.length + ' 个 GeoJSON';
            }

            geojson = { type: 'FeatureCollection', features: allFeatures };
        } else {
            // 单文件模式（原逻辑）
            const shpFile = fileArray.find(f => f.name.toLowerCase().endsWith('.shp'));
            const geojsonFile = fileArray.find(f => {
                const n = f.name.toLowerCase();
                return n.endsWith('.geojson') || n.endsWith('.json');
            });

            if (shpFile) {
                infoEl.innerHTML = '<p class="hint">-- 正在转换 Shapefile...</p>';
                await new Promise(r => setTimeout(r, 50));
                geojson = await convertShapefilesToGeoJSON(fileArray);
                filename = shpFile.name;
            } else if (geojsonFile) {
                const text = await geojsonFile.text();
                geojson = JSON.parse(text);
                filename = geojsonFile.name;
            } else {
                throw new Error('请选择 .geojson 或 .shp 文件 (需同时选择 .shx, .dbf)');
            }
        }
        
        if (geojson) {
            // 检测多要素：仅桌面端支持独立下载模式
            const featureCount = geojson.type === 'FeatureCollection' ? (geojson.features || []).length : 0;
            if (featureCount > 1 && isDesktopApp()) {
                batchGeojson = { geojson, filename };
                showBatchModeDialog(featureCount);
            } else {
                setBoundaryFromGeoJSON(geojson, filename);
            }
        }
    } catch (error) {
        console.error('Failed to load boundary file:', error);
        infoEl.innerHTML = `<p class="hint" style="color:#dc3545">-- 加载失败: ${error.message}</p>`;
    }
    
    // 清空文件输入
    event.target.value = '';
}

function setBoundaryFromGeoJSON(geojson, filename) {
    // 清除之前的边界和绘制
    clearBoundary(false);
    
    // 直接使用 Leaflet 的 GeoJSON 图层来显示
    // 这样可以支持更多类型的几何图形
    uploadedBoundaryLayer = L.geoJSON(geojson, {
        style: {
            color: '#e74c3c',
            fillColor: '#e74c3c',
            fillOpacity: 0.2,
            weight: 2,
            dashArray: '5, 5'
        }
    }).addTo(map);
    
    // 检查是否成功加载
    const bounds = uploadedBoundaryLayer.getBounds();
    if (!bounds.isValid()) {
        map.removeLayer(uploadedBoundaryLayer);
        uploadedBoundaryLayer = null;
        throw new Error('无法从文件中提取有效的边界');
    }
    
    // 设置当前边界框
    currentBounds = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
    };
    
    // 尝试提取多边形用于裁剪
    const polygons = extractPolygonFromGeoJSON(geojson);
    if (polygons && polygons.length > 0 && polygons[0].length >= 3) {
        currentPolygon = polygons;
    } else {
        currentPolygon = null;
    }
    
    // 绑定弹窗
    uploadedBoundaryLayer.bindPopup(`<b>上传的边界</b><br>${filename || '未命名'}`);
    
    // 先强制刷新地图尺寸，确保容器尺寸正确
    map.invalidateSize({ animate: false });
    
    // 缩放到边界范围 - 禁用动画避免渲染问题
    map.fitBounds(bounds, { animate: false });
    
    // 同步 Leaflet 内部缩放状态
    if (map._animateToZoom !== map.getZoom()) {
        map._animateToZoom = map.getZoom();
    }
    
    // 触发 resize 事件强制重绘
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
    }, 100);
    
    // 更新界面
    updateSelectionInfo();
    estimateDownload();
    updateVectorButtons();
    syncSelectionToCesium();
    
    // 如果有多边形，自动勾选"按边界裁剪"
    if (currentPolygon) {
        document.getElementById('crop-checkbox').checked = true;
    }
}

function clearBoundary(showStatus = true) {
    // 清除上传的边界图层
    if (uploadedBoundaryLayer) {
        map.removeLayer(uploadedBoundaryLayer);
        uploadedBoundaryLayer = null;
    }
    
    // 清除绘制的图形
    if (drawnItems) {
        drawnItems.clearLayers();
    }
    
    // 清除行政边界
    if (boundaryLayer) {
        map.removeLayer(boundaryLayer);
        boundaryLayer = null;
    }
    
    // 重置状态
    currentBounds = null;
    currentPolygon = null;
    
    // 更新界面
    updateSelectionInfo();
    document.getElementById('download-btn').disabled = true;
    document.getElementById('estimate-info').innerHTML = '';
    updateVectorButtons();

    // 清除 Cesium 上的选区显示
    if (cesiumDrawEntity && cesiumViewer) {
        cesiumViewer.entities.remove(cesiumDrawEntity);
        cesiumDrawEntity = null;
    }
    cleanCesiumDrawing();
    
}

async function convertShapefilesToGeoJSON(files) {
    // 使用前端 shpjs 库解析 Shapefile
    if (typeof shp === 'undefined') {
        throw new Error('Shapefile 解析库未加载');
    }
    
    // 检查是否有 ZIP 文件
    const zipFile = files.find(f => f.name.toLowerCase().endsWith('.zip'));
    if (zipFile) {
        const arrayBuffer = await zipFile.arrayBuffer();
        return await shp(arrayBuffer);
    }
    
    // 检查是否有完整的 Shapefile 组件 (.shp, .shx, .dbf)
    const shpFile = files.find(f => f.name.toLowerCase().endsWith('.shp'));
    const shxFile = files.find(f => f.name.toLowerCase().endsWith('.shx'));
    const dbfFile = files.find(f => f.name.toLowerCase().endsWith('.dbf'));
    const prjFile = files.find(f => f.name.toLowerCase().endsWith('.prj'));
    
    if (!shpFile) {
        throw new Error('未找到 .shp 文件');
    }
    
    // shpjs 需要同时提供 shp 和 dbf
    const shpBuffer = await shpFile.arrayBuffer();
    const dbfBuffer = dbfFile ? await dbfFile.arrayBuffer() : null;
    
    // 使用 shp.combine 方法
    const geojson = await shp.combine([shp.parseShp(shpBuffer), dbfBuffer ? shp.parseDbf(dbfBuffer) : []]);
    
    return geojson;
}

// ============ 批量 Shapefile 下载 ============

function showBatchModeDialog(featureCount) {
    const hint = batchGeojson.filename.match(/\d+\s*个/)
        ? `${batchGeojson.filename}，共 ${featureCount} 个要素，请选择下载模式：`
        : `文件中包含 ${featureCount} 个要素，请选择下载模式：`;
    document.getElementById('batch-mode-info').textContent = hint;
    document.querySelector('input[name="batch-mode"][value="merge"]').checked = true;
    document.getElementById('batch-mode-dialog').style.display = 'flex';
}

function showBatchPanel() {
    const features = batchGeojson.geojson.features;
    const keys = BatchDownload.collectPropertyKeys(features);
    const nameField = BatchDownload.recommendNameField(keys);

    // 命名字段下拉
    const select = document.getElementById('batch-name-field');
    select.innerHTML = keys.map(k => {
        const label = k === '__source_file' ? '来源文件名' : escapeHtml(k);
        return `<option value="${escapeAttr(k)}" ${k === nameField ? 'selected' : ''}>${label}</option>`;
    }).join('') + '<option value="__index__">序号 (001, 002, ...)</option>';

    renderBatchFeatureList(features, nameField || '__index__');
    select.onchange = () => renderBatchFeatureList(features, select.value);

    document.getElementById('batch-panel-dialog').style.display = 'flex';

    // 在地图上显示全部要素
    setBoundaryFromGeoJSON(batchGeojson.geojson, batchGeojson.filename);
}

function renderBatchFeatureList(features, nameField) {
    const list = document.getElementById('batch-feature-list');
    let html = '';
    features.forEach((f, i) => {
        const bbox = BatchDownload.featureBbox(f);
        const area = bbox ? BatchDownload.bboxAreaKm2(bbox) : 0;
        const name = nameField === '__index__'
            ? String(i + 1).padStart(3, '0')
            : (f.properties && f.properties[nameField] != null
                ? String(f.properties[nameField])
                : String(i + 1).padStart(3, '0'));
        html += `
            <label class="batch-feature-item">
                <input type="checkbox" class="batch-feature-check" data-index="${i}" checked>
                <span class="batch-feature-index">${String(i + 1).padStart(3, '0')}</span>
                <span class="batch-feature-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
                <span class="batch-feature-area">${area.toFixed(2)} km&sup2;</span>
            </label>`;
    });
    list.innerHTML = html;
    updateBatchSummary();
}

function updateBatchSummary() {
    if (!batchGeojson) return;
    const total = batchGeojson.geojson.features.length;
    const checked = document.querySelectorAll('#batch-feature-list .batch-feature-check:checked').length;
    document.getElementById('batch-summary').textContent = `已选 ${checked} / ${total}`;
    document.getElementById('batch-panel-start').disabled = checked === 0;
}

async function startBatchDownload() {
    if (!batchGeojson) return;

    const features = batchGeojson.geojson.features;
    const nameField = document.getElementById('batch-name-field').value;
    const batchConcurrency = parseInt(document.getElementById('batch-concurrency').value);

    // 选中的要素索引
    const selectedIndices = [];
    document.querySelectorAll('#batch-feature-list .batch-feature-check:checked').forEach(cb => {
        selectedIndices.push(parseInt(cb.dataset.index));
    });
    if (selectedIndices.length === 0) return;

    // 共享下载参数
    const format = document.getElementById('format-select').value;
    const zoom = parseInt(document.getElementById('zoom-slider').value);
    const ext = format === 'geotiff' ? '.tif' : format === 'png' ? '.png' : '.jpg';
    const useProxy = document.getElementById('proxy-checkbox').checked;
    const proxyUrl = document.getElementById('proxy-input').value.trim();
    const tiandituToken = getTianDiTuToken();
    const concurrency = parseInt(document.getElementById('concurrency-slider').value);
    const compression = format === 'geotiff' ? document.getElementById('compress-select').value : 'none';
    const buildPyramid = format === 'geotiff' && document.getElementById('pyramid-checkbox').checked;
    const cropToShape = document.getElementById('crop-checkbox').checked;
    const sourceKey = document.getElementById('source-select').value;
    const sourceSelect = document.getElementById('source-select');
    const sourceName = sourceSelect.options[sourceSelect.selectedIndex]?.text || sourceKey;

    // 选择输出目录
    let batchDir = null;
    try {
        if (window.__TAURI__?.dialog) {
            batchDir = await window.__TAURI__.dialog.open({
                directory: true,
                title: '选择批量下载输出目录'
            });
        }
        if (!batchDir) return;
    } catch (e) {
        console.error('选择目录失败:', e);
        return;
    }

    // 生成文件名并去重
    let rawNames = selectedIndices.map(i => {
        const f = features[i];
        if (nameField === '__index__') return String(i + 1).padStart(3, '0');
        return f.properties && f.properties[nameField] != null
            ? BatchDownload.sanitizeFilename(f.properties[nameField], i + 1)
            : String(i + 1).padStart(3, '0');
    });
    rawNames = BatchDownload.deduplicateFilenames(rawNames);

    // 关闭面板，切换到下载中心
    document.getElementById('batch-panel-dialog').style.display = 'none';
    switchToDownloadCenter();

    // 路径拼接
    const sep = batchDir.includes('/') ? '/' : '\\';
    const tasks = selectedIndices.map((featureIdx, i) => ({
        feature: features[featureIdx],
        filename: `${rawNames[i]}_z${zoom}${ext}`,
        savePath: `${batchDir}${sep}${rawNames[i]}_z${zoom}${ext}`
    }));

    // 按 batchConcurrency 并发调度
    let active = 0;
    const queue = [...tasks];

    function launchNext() {
        while (active < batchConcurrency && queue.length > 0) {
            const task = queue.shift();
            active++;
            launchOne(task).finally(() => {
                active--;
                launchNext();
            });
        }
    }

    async function launchOne(task) {
        const bbox = BatchDownload.featureBbox(task.feature);
        if (!bbox) {
            console.error('无法计算边界:', task.filename);
            return;
        }
        const polygon = BatchDownload.extractFeaturePolygon(task.feature);
        const request = {
            bounds: bbox,
            polygon: cropToShape ? polygon : null,
            zoom: zoom,
            source: sourceKey,
            format: format,
            crop_to_shape: cropToShape && polygon != null,
            proxy: useProxy && proxyUrl ? proxyUrl : null,
            tianditu_token: tiandituToken || null,
            save_path: task.savePath,
            concurrency: concurrency,
            compression: compression,
            build_pyramid: buildPyramid
        };
        try {
            const result = await TifApi.createDownloadTask(request, task.filename, sourceName);
            addTaskCardToUI(result.task_id, task.filename, sourceName, zoom, result.tile_count);
            startTaskListener(result.task_id);
        } catch (err) {
            console.error(`批量任务 ${task.filename} 创建失败:`, err);
        }
    }

    launchNext();
}

// 批量面板事件绑定（DOMContentLoaded 后执行）
function initBatchEvents() {
    // 模式选择对话框
    document.getElementById('batch-mode-confirm').addEventListener('click', () => {
        const mode = document.querySelector('input[name="batch-mode"]:checked').value;
        document.getElementById('batch-mode-dialog').style.display = 'none';
        if (mode === 'merge') {
            setBoundaryFromGeoJSON(batchGeojson.geojson, batchGeojson.filename);
            batchGeojson = null;
        } else {
            showBatchPanel();
        }
    });
    document.getElementById('batch-mode-cancel').addEventListener('click', () => {
        document.getElementById('batch-mode-dialog').style.display = 'none';
        batchGeojson = null;
    });
    document.getElementById('batch-mode-close').addEventListener('click', () => {
        document.getElementById('batch-mode-dialog').style.display = 'none';
        batchGeojson = null;
    });

    // 要素列表面板
    document.getElementById('batch-select-all').addEventListener('click', () => {
        document.querySelectorAll('#batch-feature-list .batch-feature-check').forEach(cb => cb.checked = true);
        updateBatchSummary();
    });
    document.getElementById('batch-invert-select').addEventListener('click', () => {
        document.querySelectorAll('#batch-feature-list .batch-feature-check').forEach(cb => cb.checked = !cb.checked);
        updateBatchSummary();
    });
    document.getElementById('batch-feature-list').addEventListener('change', (e) => {
        if (e.target.classList.contains('batch-feature-check')) updateBatchSummary();
    });
    document.getElementById('batch-panel-start').addEventListener('click', startBatchDownload);
    document.getElementById('batch-panel-cancel').addEventListener('click', () => {
        document.getElementById('batch-panel-dialog').style.display = 'none';
    });
    document.getElementById('batch-panel-close').addEventListener('click', () => {
        document.getElementById('batch-panel-dialog').style.display = 'none';
    });
}

// ============ 下载历史记录 ============

async function loadDownloadHistory() {
    const listEl = document.getElementById('history-list');
    if (!listEl) return;
    
    try {
        const records = await TifApi.getDownloadHistory();
        
        if (!records || records.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <p>暂无下载记录</p>
                    <span class="hint">完成下载后，记录将显示在这里</span>
                </div>
            `;
            return;
        }
        
        listEl.innerHTML = records.map(record => renderHistoryCard(record)).join('');
    } catch (error) {
        console.error('Failed to load download history:', error);
        listEl.innerHTML = '<p class="status-text error">加载历史记录失败</p>';
    }
}

function renderHistoryCard(record) {
    const statusClass = record.status === 'completed' ? 'success' : 'failed';
    const statusIcon = record.status === 'completed' 
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    
    const fileSize = formatFileSize(record.file_size);
    const date = new Date(record.created_at).toLocaleString('zh-CN');
    const logFile = record.log_file || '';
    const isFailed = record.status === 'failed';
    const duration = record.duration_secs != null ? formatDuration(record.duration_secs) : '';
    const isTiff = record.format === 'geotiff' || (record.file_path && record.file_path.endsWith('.tif'));
    const pyramidTag = record.has_pyramid ? '<span class="tag tag-pyramid">pyramid</span>' : '';
    const canBuildPyramid = !isFailed && isTiff && !record.has_pyramid;
    
    return `
        <div class="history-card" data-id="${escapeAttr(record.id)}" data-path="${escapeAttr(record.file_path)}" data-log-file="${escapeAttr(logFile)}">
            <div class="history-card-header">
                <span class="history-card-title">${escapeHtml(record.name)}${pyramidTag}</span>
                <span class="history-card-status ${statusClass}">${statusIcon}</span>
            </div>
            <div class="history-card-meta">
                <span>${escapeHtml(record.source_name)}</span>
                ${record.zoom > 0 ? `<span>z${Number(record.zoom)}</span>` : ''}
                <span>${Number(record.tile_count)} ${record.zoom > 0 ? '瓦片' : '节点'}</span>
                ${record.file_size > 0 ? `<span>${escapeHtml(fileSize)}</span>` : ''}
                ${duration ? `<span>⏱ ${duration}</span>` : ''}
            </div>
            ${isFailed ? '' : `<div class="history-card-path">${escapeHtml(record.file_path)}</div>`}
            <div class="history-card-meta">
                <span>${escapeHtml(date)}</span>
            </div>
            <div class="history-card-actions">
                ${isFailed ? '' : '<button class="btn btn-outline btn-sm btn-open-folder">打开文件夹</button>'}
                ${canBuildPyramid ? '<button class="btn btn-outline btn-sm btn-build-pyramid">构建金字塔</button>' : ''}
                ${logFile ? '<button class="btn btn-outline btn-sm btn-view-log">日志</button>' : ''}
                <button class="btn btn-outline btn-sm btn-delete-record">删除</button>
            </div>
            <div class="history-log-panel" style="display:none"></div>
        </div>
    `;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function formatDuration(secs) {
    if (secs < 60) return secs + 's';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h + 'h ' + m + 'm';
}

// 使用事件委托处理历史记录按钮点击，避免内联 onclick 的路径转义问题
function initHistoryListEvents() {
    const listEl = document.getElementById('history-list');
    if (!listEl) return;
    
    listEl.addEventListener('click', async (e) => {
        const card = e.target.closest('.history-card');
        if (!card) return;
        
        if (e.target.closest('.btn-open-folder')) {
            const filePath = card.dataset.path;
            try {
                await TifApi.openFileLocation(filePath);
            } catch (error) {
                alert('打开文件夹失败: ' + error.message);
            }
        } else if (e.target.closest('.btn-view-log')) {
            const logFile = card.dataset.logFile;
            const panel = card.querySelector('.history-log-panel');
            if (!panel || !logFile) return;
            
            if (panel.style.display === 'none') {
                try {
                    const logs = await TifApi.readLogFile(logFile);
                    if (logs.length === 0) {
                        panel.innerHTML = '<div class="task-log-content" style="padding:8px;color:#999">日志文件为空或已删除</div>';
                    } else {
                        const logContent = logs.map(l => {
                            const cls = l.level === 'ERROR' ? 'log-error' : l.level === 'WARN' ? 'log-warn' : '';
                            return `<div class="task-log-line ${cls}"><span class="log-time">${escapeHtml(l.timestamp)}</span> ${escapeHtml(l.message)}</div>`;
                        }).join('');
                        panel.innerHTML = `
                            <div class="task-log-toolbar">
                                <button class="btn-copy-log btn-copy-history-log" title="复制日志">📋 复制</button>
                            </div>
                            <div class="task-log-content">${logContent}</div>
                        `;
                        // 绑定复制按钮
                        panel.querySelector('.btn-copy-history-log')?.addEventListener('click', async () => {
                            const text = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
                            try {
                                await navigator.clipboard.writeText(text);
                                const btn = panel.querySelector('.btn-copy-history-log');
                                if (btn) { btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = '📋 复制', 1500); }
                            } catch (err) { console.error('复制失败:', err); }
                        });
                    }
                    panel.style.display = 'block';
                } catch (err) {
                    panel.innerHTML = '<div class="task-log-content" style="padding:8px;color:#f66">读取日志失败: ' + escapeHtml(err.toString()) + '</div>';
                    panel.style.display = 'block';
                }
            } else {
                panel.style.display = 'none';
            }
        } else if (e.target.closest('.btn-build-pyramid')) {
            const btn = e.target.closest('.btn-build-pyramid');
            const id = card.dataset.id;
            const filePath = card.dataset.path;
            btn.disabled = true;
            btn.textContent = '构建中...';
            const unlisten = await window.__TAURI__.event.listen('pyramid-progress', (ev) => {
                const d = ev.payload;
                if (d.record_id === id) {
                    btn.textContent = `金字塔 ${d.current + 1}/${d.total}`;
                }
            });
            try {
                await TifApi.buildPyramidForFile(id, filePath);
                unlisten();
                loadDownloadHistory();
            } catch (error) {
                unlisten();
                alert('金字塔构建失败: ' + error.message);
                btn.disabled = false;
                btn.textContent = '构建金字塔';
            }
        } else if (e.target.closest('.btn-delete-record')) {
            const id = card.dataset.id;
            const ok = await TifApi.showAskDialog('删除记录', '确定要删除这条记录吗？');
            if (!ok) return;
            try {
                await TifApi.deleteDownloadRecord(id);
                loadDownloadHistory();
            } catch (error) {
                alert('删除失败: ' + error.message);
            }
        }
    });
}

async function clearAllHistory() {
    const ok = await TifApi.showAskDialog('清空记录', '确定要清空所有下载记录吗？\n此操作不会删除已下载的文件。');
    if (!ok) return;
    
    try {
        await TifApi.clearDownloadHistory();
        loadDownloadHistory();
    } catch (error) {
        alert('清空失败: ' + error.message);
    }
}

// 下载完成后添加记录
async function addDownloadToHistory(name, source, sourceName, zoom, format, filePath, fileSize, tileCount, failedCount, success) {
    try {
        await TifApi.addDownloadRecord(name, source, sourceName, zoom, format, filePath, fileSize, tileCount, failedCount, success);
    } catch (error) {
        console.error('Failed to add download record:', error);
    }
}

// ============ 任务管理 ============

function switchToDownloadCenter() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    
    tabBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    tabPanels.forEach(p => p.classList.remove('active'));
    
    const historyBtn = document.querySelector('[data-tab="history"]');
    if (historyBtn) {
        historyBtn.classList.add('active');
        historyBtn.setAttribute('aria-selected', 'true');
    }
    document.getElementById('tab-history').classList.add('active');
}

function addTaskCardToUI(taskId, name, sourceName, zoom, tileCount) {
    const listEl = document.getElementById('active-tasks-list');
    if (!listEl) return;
    
    // 清除空状态
    const emptyState = listEl.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    
    taskLogs[taskId] = [];
    const startTime = Date.now();
    const startStr = new Date(startTime).toLocaleTimeString();
    const html = `
        <div class="task-card" data-task-id="${escapeAttr(taskId)}" data-status="pending" data-start-time="${startTime}">
            <div class="task-card-header">
                <span class="task-card-title">${escapeHtml(name)}</span>
                <span class="task-card-status">等待中</span>
            </div>
            <div class="task-card-meta">
                <span>${escapeHtml(sourceName)}</span>
                ${zoom > 0 ? `<span>z${Number(zoom)}</span>` : ''}
                <span>${Number(tileCount).toLocaleString()} ${zoom > 0 ? '瓦片' : '节点'}</span>
                <span class="task-card-timer" title="开始于 ${startStr}">⏱ 0s</span>
            </div>
            <div class="task-progress-bar">
                <div class="task-progress-fill" style="width: 0%"></div>
            </div>
            <div class="task-card-message">准备下载...</div>
            <div class="task-card-actions">
                <button class="btn btn-outline btn-sm btn-toggle-log" title="查看日志">日志</button>
                <button class="btn btn-outline btn-sm btn-pause-task">暂停</button>
                <button class="btn btn-outline btn-sm btn-cancel-task">取消</button>
            </div>
            <div class="task-log-panel" style="display:none"></div>
        </div>
    `;
    listEl.insertAdjacentHTML('afterbegin', html);

    // 启动实时计时器
    taskTimers[taskId] = setInterval(() => {
        const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
        if (!card) { clearInterval(taskTimers[taskId]); delete taskTimers[taskId]; return; }
        const timerEl = card.querySelector('.task-card-timer');
        if (timerEl) {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            timerEl.textContent = elapsed >= 60 ? `⏱ ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `⏱ ${elapsed}s`;
        }
    }, 1000);
}

async function startTaskListener(taskId) {
    if (!window.__TAURI__?.event) return;
    
    const unlisten = await window.__TAURI__.event.listen(`task-progress-${taskId}`, (e) => {
        updateTaskCard(e.payload);
    });
    activeTaskListeners[taskId] = unlisten;
    
    // 同时监听日志事件
    const unlistenLog = await window.__TAURI__.event.listen(`task-log-${taskId}`, (e) => {
        appendTaskLog(taskId, e.payload);
    });
    activeTaskLogListeners[taskId] = unlistenLog;
}

function stopTaskListener(taskId) {
    if (activeTaskListeners[taskId]) {
        activeTaskListeners[taskId]();
        delete activeTaskListeners[taskId];
    }
    if (activeTaskLogListeners[taskId]) {
        activeTaskLogListeners[taskId]();
        delete activeTaskLogListeners[taskId];
    }
}

function appendTaskLog(taskId, log) {
    if (!taskLogs[taskId]) taskLogs[taskId] = [];
    taskLogs[taskId].push(log);
    // 限制内存中最多500条
    if (taskLogs[taskId].length > 500) {
        taskLogs[taskId] = taskLogs[taskId].slice(-500);
    }
    // 如果日志面板已展开，实时更新
    const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
    if (!card) return;
    const panel = card.querySelector('.task-log-panel');
    if (panel && panel.style.display !== 'none') {
        renderTaskLogPanel(taskId, panel);
    }
}

function renderTaskLogPanel(taskId, panel) {
    const logs = taskLogs[taskId] || [];
    const logContent = logs.map(l => {
        const cls = l.level === 'ERROR' ? 'log-error' : l.level === 'WARN' ? 'log-warn' : '';
        return `<div class="task-log-line ${cls}"><span class="log-time">${escapeHtml(l.timestamp)}</span> ${escapeHtml(l.message)}</div>`;
    }).join('');
    panel.innerHTML = `
        <div class="task-log-toolbar">
            <button class="btn-copy-log" data-task-id="${escapeAttr(taskId)}" title="复制日志">复制</button>
        </div>
        <div class="task-log-content">${logContent}</div>
    `;
    // 事件委托绑定复制按钮，避免 onclick 内联 taskId 注入
    const copyBtn = panel.querySelector('.btn-copy-log');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => copyTaskLogs(copyBtn.dataset.taskId));
    }
    // 自动滚动到底部
    const content = panel.querySelector('.task-log-content');
    if (content) content.scrollTop = content.scrollHeight;
}

async function copyTaskLogs(taskId) {
    const logs = taskLogs[taskId] || [];
    const text = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
    try {
        await navigator.clipboard.writeText(text);
        // 短暂显示反馈
        const btn = document.querySelector(`.task-card[data-task-id="${taskId}"] .btn-copy-log`);
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = '✓ 已复制';
            setTimeout(() => btn.textContent = orig, 1500);
        }
    } catch (e) {
        console.error('复制失败:', e);
    }
}

async function toggleTaskLog(taskId) {
    const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
    if (!card) return;
    const panel = card.querySelector('.task-log-panel');
    if (!panel) return;
    
    if (panel.style.display === 'none') {
        // 展开：先加载已有日志
        if (!taskLogs[taskId] || taskLogs[taskId].length === 0) {
            try {
                taskLogs[taskId] = await TifApi.getTaskLogs(taskId);
            } catch (e) {
                taskLogs[taskId] = [];
            }
        }
        panel.style.display = 'block';
        renderTaskLogPanel(taskId, panel);
    } else {
        panel.style.display = 'none';
    }
}

const TASK_STATUS_TEXT = {
    'pending': '等待中',
    'downloading': '下载中',
    'paused': '已暂停',
    'processing': '处理中',
    'merging': '拼接中',
    'exporting': '导出中',
    'building_pyramid': '构建金字塔',
    'completed': '已完成',
    'failed': '失败',
    'cancelled': '已取消'
};

function updateTaskCard(payload) {
    const { task_id, status, progress, completed, total, message } = payload;
    const card = document.querySelector(`.task-card[data-task-id="${task_id}"]`);
    if (!card) return;
    
    card.dataset.status = status;
    
    // paused/resumed 事件的 progress=0 表示保留当前进度
    const fill = card.querySelector('.task-progress-fill');
    if (fill && progress > 0) fill.style.width = `${progress}%`;
    
    const msgEl = card.querySelector('.task-card-message');
    if (msgEl && message) msgEl.textContent = message;
    
    const statusEl = card.querySelector('.task-card-status');
    if (statusEl) statusEl.textContent = TASK_STATUS_TEXT[status] || status;
    
    // 更新暂停按钮
    const pauseBtn = card.querySelector('.btn-pause-task');
    if (pauseBtn) {
        if (status === 'paused') {
            pauseBtn.textContent = '继续';
        } else if (status === 'downloading') {
            pauseBtn.textContent = '暂停';
        } else if (['merging', 'exporting', 'completed', 'failed', 'cancelled'].includes(status)) {
            pauseBtn.style.display = 'none';
        }
    }
    
    // 完成/失败/取消时处理
    if (['completed', 'failed', 'cancelled'].includes(status)) {
        stopTaskListener(task_id);

        // 停止计时器，显示最终时长
        if (taskTimers[task_id]) {
            clearInterval(taskTimers[task_id]);
            delete taskTimers[task_id];
        }
        const startTs = parseInt(card.dataset.startTime || '0');
        if (startTs > 0) {
            const elapsed = Math.floor((Date.now() - startTs) / 1000);
            const timerEl = card.querySelector('.task-card-timer');
            if (timerEl) {
                const durStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
                timerEl.textContent = `⏱ ${durStr}`;
                timerEl.title = `${new Date(startTs).toLocaleTimeString()} → ${new Date().toLocaleTimeString()}`;
            }
        }
        
        if (status === 'completed') {
            // 完成的任务 2 秒后自动移除
            setTimeout(() => {
                removeTaskCardFromUI(task_id);
                TifApi.removeTask(task_id);
            }, 2000);
            loadDownloadHistory();
        } else {
            // 失败/取消的任务 5 秒后自动移除（留阅读时间）
            const actionsEl = card.querySelector('.task-card-actions');
            if (actionsEl) {
                actionsEl.innerHTML = '<button class="btn btn-outline btn-sm btn-remove-task">移除</button>';
            }
            setTimeout(() => {
                removeTaskCardFromUI(task_id);
                TifApi.removeTask(task_id);
            }, 5000);
            if (status === 'failed') loadDownloadHistory();
        }
    }
}

async function refreshActiveTasks() {
    const listEl = document.getElementById('active-tasks-list');
    if (!listEl) return;
    
    try {
        const tasks = await TifApi.getActiveTasks();
        
        if (!tasks || tasks.length === 0) {
            listEl.innerHTML = '<div class="empty-state small"><p>暂无活动任务</p></div>';
            return;
        }
        
        listEl.innerHTML = tasks.map(renderTaskCardFromInfo).join('');
        
        for (const task of tasks) {
            if (!['completed', 'failed', 'cancelled'].includes(task.status) && !activeTaskListeners[task.id]) {
                startTaskListener(task.id);
            }
        }
    } catch (error) {
        console.error('Failed to refresh tasks:', error);
    }
}

function renderTaskCardFromInfo(task) {
    const isActive = !['completed', 'failed', 'cancelled'].includes(task.status);
    const isPaused = task.status === 'paused';
    return `
        <div class="task-card" data-task-id="${task.id}" data-status="${task.status}">
            <div class="task-card-header">
                <span class="task-card-title">${task.name}</span>
                <span class="task-card-status">${TASK_STATUS_TEXT[task.status] || task.status}</span>
            </div>
            <div class="task-card-meta">
                <span>${task.source_name}</span>
                <span>z${task.zoom}</span>
                <span>${task.total.toLocaleString()} 瓦片</span>
                <span class="task-card-timer">⏱ --</span>
            </div>
            <div class="task-progress-bar">
                <div class="task-progress-fill" style="width: ${task.progress || 0}%"></div>
            </div>
            <div class="task-card-message">${task.message || ''}</div>
            <div class="task-card-actions">
                <button class="btn btn-outline btn-sm btn-toggle-log" title="查看日志">日志</button>
                ${isActive
                    ? `<button class="btn btn-outline btn-sm btn-pause-task">${isPaused ? '继续' : '暂停'}</button>
                       <button class="btn btn-outline btn-sm btn-cancel-task">取消</button>`
                    : '<button class="btn btn-outline btn-sm btn-remove-task">移除</button>'
                }
            </div>
            <div class="task-log-panel" style="display:none"></div>
        </div>
    `;
}

// ============ 断点续传 ============

async function loadResumableTasks() {
    try {
        const tasks = await TifApi.getResumableTasks();
        const section = document.getElementById('resumable-tasks-section');
        const listEl = document.getElementById('resumable-tasks-list');
        if (!section || !listEl) return;
        
        if (!tasks || tasks.length === 0) {
            section.style.display = 'none';
            return;
        }
        
        section.style.display = 'block';
        listEl.innerHTML = tasks.map(t => {
            const req = t.request;
            return `
                <div class="task-card resumable" data-task-id="${t.task_id}">
                    <div class="task-card-header">
                        <span class="task-card-title">${t.task_name}</span>
                        <span class="task-card-status" style="color:var(--warning)">已中断</span>
                    </div>
                    <div class="task-card-meta">
                        <span>${t.source_name}</span>
                        <span>z${req.zoom}</span>
                        <span>${t.tile_count.toLocaleString()} 瓦片</span>
                        <span>${t.created_at}</span>
                    </div>
                    <div class="task-card-actions">
                        <button class="btn btn-primary btn-sm btn-resume-task">继续下载</button>
                        <button class="btn btn-outline btn-sm btn-discard-task">丢弃</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load resumable tasks:', error);
    }
}

function initResumableTaskEvents() {
    const listEl = document.getElementById('resumable-tasks-list');
    if (!listEl) return;
    
    listEl.addEventListener('click', async (e) => {
        const card = e.target.closest('.task-card');
        if (!card) return;
        const taskId = card.dataset.taskId;
        
        if (e.target.closest('.btn-resume-task')) {
            try {
                const result = await TifApi.resumeTask(taskId);
                // 移除恢复卡片，添加活动任务卡片
                card.remove();
                const section = document.getElementById('resumable-tasks-section');
                const list = document.getElementById('resumable-tasks-list');
                if (section && list && !list.querySelector('.task-card')) {
                    section.style.display = 'none';
                }
                addTaskCardToUI(result.task_id, '恢复: ' + card.querySelector('.task-card-title').textContent, '', 0, result.tile_count);
                startTaskListener(result.task_id);
            } catch (error) {
                alert('恢复失败: ' + error);
            }
        } else if (e.target.closest('.btn-discard-task')) {
            const ok = await TifApi.showAskDialog('丢弃任务', '确定丢弃此任务？已下载的瓦片缓存将被删除。');
            if (!ok) return;
            await TifApi.discardResumableTask(taskId);
            card.remove();
            const section = document.getElementById('resumable-tasks-section');
            const list = document.getElementById('resumable-tasks-list');
            if (section && list && !list.querySelector('.task-card')) {
                section.style.display = 'none';
            }
        }
    });
}

function removeTaskCardFromUI(taskId) {
    if (taskTimers[taskId]) { clearInterval(taskTimers[taskId]); delete taskTimers[taskId]; }
    const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
    if (card) card.remove();
    
    const listEl = document.getElementById('active-tasks-list');
    if (listEl && !listEl.querySelector('.task-card')) {
        listEl.innerHTML = '<div class="empty-state small"><p>暂无活动任务</p></div>';
    }
}

function initTaskListEvents() {
    const listEl = document.getElementById('active-tasks-list');
    if (!listEl) return;
    
    listEl.addEventListener('click', async (e) => {
        const card = e.target.closest('.task-card');
        if (!card) return;
        const taskId = card.dataset.taskId;
        
        if (e.target.closest('.btn-toggle-log')) {
            toggleTaskLog(taskId);
        } else if (e.target.closest('.btn-pause-task')) {
            await TifApi.togglePauseTask(taskId);
        } else if (e.target.closest('.btn-cancel-task')) {
            await TifApi.cancelTask(taskId);
        } else if (e.target.closest('.btn-remove-task')) {
            await TifApi.removeTask(taskId);
            delete taskLogs[taskId];
            card.remove();
            if (!listEl.querySelector('.task-card')) {
                listEl.innerHTML = '<div class="empty-state small"><p>暂无活动任务</p></div>';
            }
        }
    });
}

// ============ 3D Tiles 面板 ============
let tiles3dAnalyzed = null; // 缓存解析结果

function initTiles3dPanel() {
    // 数据源类型切换 (URL / Ion)
    const urlBtn = document.getElementById('source-type-url');
    const ionBtn = document.getElementById('source-type-ion');
    if (urlBtn && ionBtn) {
        urlBtn.addEventListener('click', () => switchTiles3dSource('url'));
        ionBtn.addEventListener('click', () => switchTiles3dSource('ion'));
    }

    // 并发数滑块
    const slider = document.getElementById('tiles3d-concurrency-slider');
    const value = document.getElementById('tiles3d-concurrency-value');
    if (slider && value) {
        slider.addEventListener('input', () => { value.textContent = slider.value; });
    }

    // 解析按钮
    const analyzeBtn = document.getElementById('analyze-3dtiles-btn');
    if (analyzeBtn) {
        analyzeBtn.addEventListener('click', analyzeTiles3d);
    }

    // 下载按钮
    const downloadBtn = document.getElementById('download-3dtiles-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', startTiles3dDownload);
    }

    // 预览本地模型按钮
    const previewLocalBtn = document.getElementById('preview-local-3dtiles-btn');
    if (previewLocalBtn) {
        previewLocalBtn.addEventListener('click', previewLocal3dTiles);
    }

    // Ion token 自动持久化
    const ionTokenInput = document.getElementById('ion-token');
    if (ionTokenInput) {
        ionTokenInput.addEventListener('blur', async () => {
            const val = ionTokenInput.value.trim();
            if (appSettings && appSettings.cesium_ion_token !== val) {
                appSettings.cesium_ion_token = val || null;
                try { await TifApi.saveSettings(appSettings); } catch (e) { /* silent */ }
            }
        });
    }
}

function switchTiles3dSource(type) {
    document.getElementById('source-type-url').classList.toggle('active', type === 'url');
    document.getElementById('source-type-ion').classList.toggle('active', type === 'ion');
    document.getElementById('source-url-panel').style.display = type === 'url' ? '' : 'none';
    document.getElementById('source-ion-panel').style.display = type === 'ion' ? '' : 'none';
}

function buildTiles3dSource() {
    const isIon = document.getElementById('source-type-ion').classList.contains('active');
    if (isIon) {
        const assetId = parseInt(document.getElementById('ion-asset-id').value);
        const token = document.getElementById('ion-token').value.trim();
        if (!assetId || !token) { alert('请填写 Asset ID 和 Token'); return null; }
        return { type: 'cesium_ion', asset_id: assetId, access_token: token };
    } else {
        const url = document.getElementById('tileset-url-input').value.trim();
        if (!url) { alert('请输入 tileset.json URL'); return null; }
        const referer = document.getElementById('tiles3d-referer-input')?.value?.trim();
        const headers = {};
        if (referer) headers['Referer'] = referer;
        return { type: 'url', tileset_url: url, headers };
    }
}

function getProxyConfig() {
    const enabled = document.getElementById('proxy-checkbox')?.checked;
    const url = document.getElementById('proxy-input')?.value?.trim();
    return enabled && url ? url : null;
}

function showTiles3dExtent(extent) {
    // 在 Cesium 中飞到 extent
    if (!cesiumViewer || !extent || extent.length < 4) return;
    cesiumViewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(extent[0], extent[1], extent[2], extent[3]),
        duration: 1.5
    });
}

async function previewLocal3dTiles() {
    if (!window.__TAURI__?.dialog) return;

    const btn = document.getElementById('preview-local-3dtiles-btn');
    try {
        const filePath = await window.__TAURI__.dialog.open({
            filters: [{ name: 'Tileset JSON', extensions: ['json'] }],
            multiple: false,
            title: '选择 tileset.json'
        });
        if (!filePath) return;

        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner"></span> 加载中...';

        // 确保在 3D Tiles 模式
        if (currentMode !== '3dtiles') switchMode('3dtiles');

        // 等待 Cesium 初始化完成
        await new Promise(resolve => {
            const check = () => cesiumViewer ? resolve() : requestAnimationFrame(check);
            check();
        });

        // 提取目录路径，启动本地文件服务器
        const dirPath = filePath.substring(0, Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')));
        const fileName = filePath.substring(dirPath.length + 1);
        const baseUrl = await window.__TAURI__.core.invoke('serve_local_tiles', { dirPath });
        const tilesetUrl = baseUrl + '/' + encodeURIComponent(fileName);

        // 清除旧 tileset
        if (cesiumTileset) {
            cesiumViewer.scene.primitives.remove(cesiumTileset);
            cesiumTileset = null;
        }
        hideCesiumControls();

        const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl);
        cesiumTileset = cesiumViewer.scene.primitives.add(tileset);
        cesiumViewer.zoomTo(tileset);
        showCesiumControls();
    } catch (e) {
        console.error('本地 3D Tiles 加载失败:', e);
        alert('加载失败: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg> 预览本地模型`;
    }
}

async function loadTilesetInCesium(source) {
    if (!cesiumViewer) return;

    // 清除旧 tileset
    if (cesiumTileset) {
        cesiumViewer.scene.primitives.remove(cesiumTileset);
        cesiumTileset = null;
    }
    hideCesiumControls();

    const onTilesetLoaded = (tileset) => {
        cesiumTileset = cesiumViewer.scene.primitives.add(tileset);
        cesiumViewer.zoomTo(tileset);
        showCesiumControls();
    };

    try {
        if (source.type === 'cesium_ion') {
            // 设置 Ion token 后通过 IonResource 加载
            Cesium.Ion.defaultAccessToken = source.access_token;
            const resource = await Cesium.IonResource.fromAssetId(source.asset_id);
            Cesium.Cesium3DTileset.fromUrl(resource)
                .then(onTilesetLoaded)
                .catch(e => console.error('Cesium Ion tileset 加载失败:', e));
        } else {
            let url = source.tileset_url;

            // Referer 保护源：启动反向代理，CesiumJS 通过 localhost 加载
            const hasReferer = source.headers && source.headers['Referer'];
            if (hasReferer) {
                try {
                    // 从 tileset_url 提取 base（去掉最后的文件名），保留 query 给代理层
                    const urlObj = new URL(source.tileset_url);
                    const pathParts = urlObj.pathname.split('/');
                    const tilesetFile = pathParts.pop(); // e.g. "tileset.json"
                    urlObj.pathname = pathParts.join('/');
                    // base 含 query（如 ?token=mars3d），代理会附加到所有转发请求
                    const baseUrl = urlObj.origin + urlObj.pathname + urlObj.search;

                    const proxyBase = await TifApi.startTileProxy(baseUrl, source.headers);
                    // CesiumJS 使用干净的代理 URL，query 由代理层自动附加
                    url = proxyBase + '/' + tilesetFile;
                    console.info('预览通过反向代理:', url);
                } catch (e) {
                    console.warn('启动反向代理失败，尝试直连:', e);
                }
            }

            Cesium.Cesium3DTileset.fromUrl(url)
                .then(onTilesetLoaded)
                .catch(e => console.error('Tileset 加载失败:', e));
        }
    } catch (e) {
        console.error('Cesium tileset 加载异常:', e);
    }
}

async function analyzeTiles3d() {
    const source = buildTiles3dSource();
    if (!source) return;

    const btn = document.getElementById('analyze-3dtiles-btn');
    const infoCard = document.getElementById('tiles3d-info');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> 解析中...';
    infoCard.style.display = 'none';

    try {
        const summary = await TifApi.analyze3dTiles(source, getProxyConfig());
        tiles3dAnalyzed = { source, summary };

        const hasReferer = source.type === 'url' && source.headers && source.headers['Referer'];
        infoCard.style.display = '';
        infoCard.innerHTML = `
            <div class="info-row"><span>瓦片总数</span><strong>${summary.total_tiles}</strong></div>
            <div class="info-row"><span>含内容瓦片</span><strong>${summary.content_tiles}</strong></div>
            <div class="info-row"><span>最大深度</span><strong>${summary.max_depth}</strong></div>
            <div class="info-row"><span>层级数</span><strong>${summary.levels}</strong></div>
            ${summary.has_external_tilesets ? '<div class="info-row text-muted" style="font-size:12px"><span>⚠ 含外部 tileset 引用，以上为根级统计</span></div>' : ''}
            ${hasReferer ? '<div class="info-row text-muted" style="font-size:12px"><span>ℹ Referer 保护源：通过本地代理预览</span></div>' : ''}
        `;

        // 在地图上渲染 extent
        showTiles3dExtent(summary.extent);

        // 在 Cesium 中预览 tileset
        await loadTilesetInCesium(source);

        // 有选区时自动估算
        if (currentBounds || currentPolygon) {
            await estimateTiles3d();
        }

        document.getElementById('download-3dtiles-btn').disabled = false;
    } catch (error) {
        infoCard.style.display = '';
        infoCard.innerHTML = `<p class="text-error">解析失败: ${error.message || error}</p>`;
        document.getElementById('download-3dtiles-btn').disabled = true;
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <path d="m21 21-4.35-4.35"/>
            </svg>
            解析数据源`;
    }
}

async function estimateTiles3d() {
    if (!tiles3dAnalyzed) return;

    const polygon = currentPolygon || (currentBounds ? [
        { lat: currentBounds.south, lng: currentBounds.west },
        { lat: currentBounds.north, lng: currentBounds.west },
        { lat: currentBounds.north, lng: currentBounds.east },
        { lat: currentBounds.south, lng: currentBounds.east },
        { lat: currentBounds.south, lng: currentBounds.west }
    ] : null);
    if (!polygon) return;

    // 转为 [lng, lat] 数组
    const coords = (Array.isArray(polygon[0]) ? polygon[0] : polygon)
        .map(p => [p.lng, p.lat]);

    const estimateCard = document.getElementById('tiles3d-estimate');
    estimateCard.innerHTML = '<span class="loading-spinner"></span> 估算中...';

    try {
        const est = await TifApi.estimate3dTiles(tiles3dAnalyzed.source, coords, getProxyConfig());
        estimateCard.innerHTML = `
            <div class="info-row"><span>选区内瓦片</span><strong>${est.filtered_tiles}</strong></div>
            <div class="info-row"><span>需下载内容</span><strong>${est.content_tiles}</strong></div>
        `;
    } catch (error) {
        estimateCard.innerHTML = `<p class="text-error">估算失败: ${error.message || error}</p>`;
    }
}

async function startTiles3dDownload() {
    const source = buildTiles3dSource();
    if (!source) return;

    // 选择保存目录
    let savePath = null;
    if (TifApi._checkIsTauri && TifApi._checkIsTauri()) {
        try {
            savePath = await window.__TAURI__.dialog.open({
                directory: true,
                title: '选择 3D Tiles 保存目录'
            });
            if (!savePath) return;
        } catch (e) {
            console.error('目录选择失败:', e);
            return;
        }
    }

    const polygon = currentPolygon || (currentBounds ? [
        { lat: currentBounds.south, lng: currentBounds.west },
        { lat: currentBounds.north, lng: currentBounds.west },
        { lat: currentBounds.north, lng: currentBounds.east },
        { lat: currentBounds.south, lng: currentBounds.east },
        { lat: currentBounds.south, lng: currentBounds.west }
    ] : null);

    // 转为 [lng, lat] 数组
    const coords = polygon
        ? (Array.isArray(polygon[0]) ? polygon[0] : polygon).map(p => [p.lng, p.lat])
        : null;

    const concurrency = parseInt(document.getElementById('tiles3d-concurrency-slider').value);

    const request = {
        source,
        polygon: coords && coords.length >= 3 ? coords : null,
        save_path: savePath,
        proxy: getProxyConfig(),
        concurrency
    };

    const downloadBtn = document.getElementById('download-3dtiles-btn');
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const taskName = `3dtiles_${timestamp}`;

    try {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '<span class="loading-spinner"></span> 创建任务...';

        const result = await TifApi.create3dTilesTask(request, taskName);

        addTaskCardToUI(result.task_id, taskName, '3D Tiles', 0, result.tile_count);
        startTaskListener(result.task_id);
        switchToDownloadCenter();
    } catch (error) {
        alert('创建任务失败: ' + (error.message || error));
    } finally {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            下载模型`;
    }
}

// ============ Cesium 模型调控面板 ============

function initCesiumControls() {
    // 折叠/展开
    const header = document.querySelector('.cesium-controls-header');
    const body = document.getElementById('cesium-controls-body');
    const toggleBtn = document.getElementById('cesium-controls-toggle');
    if (header) {
        header.addEventListener('click', () => {
            body.classList.toggle('collapsed');
            toggleBtn.classList.toggle('collapsed');
        });
    }

    // 显示精度（maximumScreenSpaceError）
    const sseSlider = document.getElementById('sse-slider');
    const sseValue = document.getElementById('sse-value');
    if (sseSlider) {
        sseSlider.addEventListener('input', () => {
            sseValue.textContent = sseSlider.value;
            if (cesiumTileset) {
                cesiumTileset.maximumScreenSpaceError = Number(sseSlider.value);
            }
        });
    }

    // 透明度
    const opacitySlider = document.getElementById('opacity-slider');
    const opacityValue = document.getElementById('opacity-value');
    if (opacitySlider) {
        opacitySlider.addEventListener('input', () => {
            opacityValue.textContent = opacitySlider.value;
            if (cesiumTileset) {
                const alpha = Number(opacitySlider.value) / 100;
                cesiumTileset.style = new Cesium.Cesium3DTileStyle({
                    color: `color("white", ${alpha})`
                });
            }
        });
    }

    // 应用位置偏移
    document.getElementById('apply-offset-btn')?.addEventListener('click', applyPositionOffset);

    // 重置
    document.getElementById('reset-controls-btn')?.addEventListener('click', resetCesiumControls);

    // 显示瓦片包围盒
    const bvCheckbox = document.getElementById('show-bounding-volumes');
    if (bvCheckbox) {
        bvCheckbox.addEventListener('change', () => {
            if (cesiumTileset) {
                cesiumTileset.debugShowBoundingVolume = bvCheckbox.checked;
            }
        });
    }
}

function showCesiumControls() {
    const panel = document.getElementById('cesium-controls');
    if (panel) panel.style.display = '';
    if (cesiumTileset) {
        // 同步 SSE 精度
        const sseSlider = document.getElementById('sse-slider');
        if (sseSlider) cesiumTileset.maximumScreenSpaceError = Number(sseSlider.value);
        // 同步包围盒开关
        const bv = document.getElementById('show-bounding-volumes');
        if (bv) cesiumTileset.debugShowBoundingVolume = bv.checked;
    }
}

function hideCesiumControls() {
    const panel = document.getElementById('cesium-controls');
    if (panel) panel.style.display = 'none';
}

function applyPositionOffset() {
    if (!cesiumTileset || !cesiumViewer) return;

    const lng = Number(document.getElementById('offset-lng').value) || 0;
    const lat = Number(document.getElementById('offset-lat').value) || 0;
    const height = Number(document.getElementById('offset-height').value) || 0;

    if (lng === 0 && lat === 0 && height === 0) {
        // 重置 modelMatrix
        cesiumTileset.modelMatrix = Cesium.Matrix4.IDENTITY.clone();
        return;
    }

    // 获取 tileset 原始包围球中心
    const center = cesiumTileset.boundingSphere.center;
    const cart = Cesium.Cartographic.fromCartesian(center);

    // 计算偏移后的新位置
    const newCart = new Cesium.Cartographic(
        cart.longitude + Cesium.Math.toRadians(lng),
        cart.latitude + Cesium.Math.toRadians(lat),
        cart.height + height
    );

    // 计算从原位置到新位置的变换矩阵
    const oldTransform = Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartographic.toCartesian(cart)
    );
    const newTransform = Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartographic.toCartesian(newCart)
    );

    const inverseOld = Cesium.Matrix4.inverse(oldTransform, new Cesium.Matrix4());
    const offsetMatrix = Cesium.Matrix4.multiply(newTransform, inverseOld, new Cesium.Matrix4());

    cesiumTileset.modelMatrix = offsetMatrix;
}

function resetCesiumControls() {
    // 重置所有控件值
    const sseSlider = document.getElementById('sse-slider');
    const sseValue = document.getElementById('sse-value');
    const opacitySlider = document.getElementById('opacity-slider');
    const opacityValue = document.getElementById('opacity-value');

    if (sseSlider) { sseSlider.value = 8; sseValue.textContent = '8'; }
    if (opacitySlider) { opacitySlider.value = 100; opacityValue.textContent = '100'; }
    document.getElementById('offset-lng').value = 0;
    document.getElementById('offset-lat').value = 0;
    document.getElementById('offset-height').value = 0;

    if (cesiumTileset) {
        cesiumTileset.maximumScreenSpaceError = 8;
        cesiumTileset.style = undefined;
        cesiumTileset.modelMatrix = Cesium.Matrix4.IDENTITY.clone();
        cesiumTileset.debugShowBoundingVolume = false;
    }
    const bvCheckbox = document.getElementById('show-bounding-volumes');
    if (bvCheckbox) bvCheckbox.checked = false;
}

// ============ CesiumJS 绘图工具 ============

let cesiumDrawHandler = null;   // ScreenSpaceEventHandler
let cesiumDrawMode = null;      // 'rect' | 'polygon' | null
let cesiumDrawPoints = [];      // 绘制中的点 [{lng, lat}, ...]
let cesiumDrawEntity = null;    // 选区显示 Entity
let cesiumDrawTempEntities = []; // 临时绘制辅助 Entities

function initCesiumDrawTools() {
    const rectBtn = document.getElementById('cesium-draw-rect');
    const polyBtn = document.getElementById('cesium-draw-polygon');
    if (!rectBtn || !polyBtn) return;

    rectBtn.addEventListener('click', () => startCesiumDraw('rect'));
    polyBtn.addEventListener('click', () => startCesiumDraw('polygon'));
}

function startCesiumDraw(mode) {
    if (!cesiumViewer) return;

    // 如果正在绘制，先取消
    cleanCesiumDrawing();

    cesiumDrawMode = mode;
    cesiumDrawPoints = [];

    // 高亮当前按钮
    const rectBtn = document.getElementById('cesium-draw-rect');
    const polyBtn = document.getElementById('cesium-draw-polygon');
    rectBtn.classList.toggle('active', mode === 'rect');
    polyBtn.classList.toggle('active', mode === 'polygon');

    // 提示
    const hint = mode === 'rect'
        ? '在地球上点击两个角点绘制矩形（右键取消）'
        : '在地球上点击绘制多边形顶点，双击或右键结束（右键取消）';
    showSelectionHint(hint);

    // 更改鼠标光标
    cesiumViewer.canvas.style.cursor = 'crosshair';

    // 创建事件处理器
    cesiumDrawHandler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.canvas);

    // 左键点击：添加点
    cesiumDrawHandler.setInputAction((click) => {
        const cartesian = cesiumViewer.camera.pickEllipsoid(
            click.position, cesiumViewer.scene.globe.ellipsoid
        );
        if (!cartesian) return;

        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lng = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);

        cesiumDrawPoints.push({ lng, lat });

        // 画点标记
        const pointEntity = cesiumViewer.entities.add({
            position: cartesian,
            point: { pixelSize: 8, color: Cesium.Color.fromCssColorString('#3B82F6') }
        });
        cesiumDrawTempEntities.push(pointEntity);

        if (mode === 'rect' && cesiumDrawPoints.length === 2) {
            finishCesiumDraw();
        }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 左键双击：结束多边形
    if (mode === 'polygon') {
        cesiumDrawHandler.setInputAction(() => {
            if (cesiumDrawPoints.length >= 3) {
                finishCesiumDraw();
            }
        }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }

    // 鼠标移动：实时预览
    cesiumDrawHandler.setInputAction((movement) => {
        if (cesiumDrawPoints.length === 0) return;
        const cartesian = cesiumViewer.camera.pickEllipsoid(
            movement.endPosition, cesiumViewer.scene.globe.ellipsoid
        );
        if (!cartesian) return;

        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lng = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);

        // 更新预览
        updateCesiumDrawPreview(lng, lat);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // 右键：取消
    cesiumDrawHandler.setInputAction(() => {
        cleanCesiumDrawing();
        showSelectionHint('绘制已取消');
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
}

function updateCesiumDrawPreview(curLng, curLat) {
    // 移除旧预览线
    cesiumDrawTempEntities = cesiumDrawTempEntities.filter(e => {
        if (e._isPreview) {
            cesiumViewer.entities.remove(e);
            return false;
        }
        return true;
    });

    if (cesiumDrawMode === 'rect' && cesiumDrawPoints.length === 1) {
        const p = cesiumDrawPoints[0];
        const positions = Cesium.Cartesian3.fromDegreesArray([
            p.lng, p.lat,
            curLng, p.lat,
            curLng, curLat,
            p.lng, curLat,
        ]);
        const previewEntity = cesiumViewer.entities.add({
            polygon: {
                hierarchy: positions,
                material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.2),
                outline: true,
                outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
                outlineWidth: 2,
            }
        });
        previewEntity._isPreview = true;
        cesiumDrawTempEntities.push(previewEntity);
    } else if (cesiumDrawMode === 'polygon' && cesiumDrawPoints.length >= 1) {
        const coords = [];
        cesiumDrawPoints.forEach(p => { coords.push(p.lng, p.lat); });
        coords.push(curLng, curLat);
        if (coords.length >= 6) {
            const positions = Cesium.Cartesian3.fromDegreesArray(coords);
            const previewEntity = cesiumViewer.entities.add({
                polygon: {
                    hierarchy: positions,
                    material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.15),
                    outline: true,
                    outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
                    outlineWidth: 2,
                }
            });
            previewEntity._isPreview = true;
            cesiumDrawTempEntities.push(previewEntity);
        }
    }
}

function finishCesiumDraw() {
    if (cesiumDrawMode === 'rect' && cesiumDrawPoints.length === 2) {
        const p1 = cesiumDrawPoints[0];
        const p2 = cesiumDrawPoints[1];
        currentBounds = {
            west: Math.min(p1.lng, p2.lng),
            south: Math.min(p1.lat, p2.lat),
            east: Math.max(p1.lng, p2.lng),
            north: Math.max(p1.lat, p2.lat),
        };
        currentPolygon = null;
    } else if (cesiumDrawMode === 'polygon' && cesiumDrawPoints.length >= 3) {
        currentPolygon = [cesiumDrawPoints.map(p => ({ lat: p.lat, lng: p.lng }))];
        const lngs = cesiumDrawPoints.map(p => p.lng);
        const lats = cesiumDrawPoints.map(p => p.lat);
        currentBounds = {
            west: Math.min(...lngs),
            south: Math.min(...lats),
            east: Math.max(...lngs),
            north: Math.max(...lats),
        };
    }

    // 清理临时图形，显示最终选区
    cleanCesiumTempEntities();
    showCesiumSelection();

    // 清理绘制状态
    if (cesiumDrawHandler) {
        cesiumDrawHandler.destroy();
        cesiumDrawHandler = null;
    }
    cesiumDrawMode = null;
    cesiumDrawPoints = [];
    if (cesiumViewer) {
        cesiumViewer.canvas.style.cursor = '';
    }

    // 取消按钮高亮
    document.getElementById('cesium-draw-rect')?.classList.remove('active');
    document.getElementById('cesium-draw-polygon')?.classList.remove('active');

    // 更新选区信息和按钮状态
    updateSelectionInfo();

    // 同步到 Leaflet（如果用户切回 TIF 模式需要看到选区）
    syncSelectionToLeaflet();
}

function cleanCesiumDrawing() {
    cesiumDrawMode = null;
    cesiumDrawPoints = [];
    if (cesiumDrawHandler) {
        cesiumDrawHandler.destroy();
        cesiumDrawHandler = null;
    }
    cleanCesiumTempEntities();
    if (cesiumViewer) {
        cesiumViewer.canvas.style.cursor = '';
    }
    document.getElementById('cesium-draw-rect')?.classList.remove('active');
    document.getElementById('cesium-draw-polygon')?.classList.remove('active');
}

function cleanCesiumTempEntities() {
    if (!cesiumViewer) return;
    cesiumDrawTempEntities.forEach(e => cesiumViewer.entities.remove(e));
    cesiumDrawTempEntities = [];
}

/// 在 Cesium 上显示当前选区（矩形或多边形）
function showCesiumSelection() {
    if (!cesiumViewer) return;

    // 移除旧选区
    if (cesiumDrawEntity) {
        cesiumViewer.entities.remove(cesiumDrawEntity);
        cesiumDrawEntity = null;
    }

    if (currentPolygon && currentPolygon.length > 0) {
        const coords = [];
        const ring = currentPolygon[0];
        ring.forEach(p => { coords.push(p.lng, p.lat); });
        if (coords.length >= 6) {
            cesiumDrawEntity = cesiumViewer.entities.add({
                polygon: {
                    hierarchy: Cesium.Cartesian3.fromDegreesArray(coords),
                    material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.25),
                    outline: true,
                    outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
                    outlineWidth: 2,
                }
            });
        }
    } else if (currentBounds) {
        const { west, south, east, north } = currentBounds;
        cesiumDrawEntity = cesiumViewer.entities.add({
            rectangle: {
                coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
                material: Cesium.Color.fromCssColorString('#3B82F6').withAlpha(0.25),
                outline: true,
                outlineColor: Cesium.Color.fromCssColorString('#3B82F6'),
                outlineWidth: 2,
            }
        });
    }
}

/// 行政区/上传边界后，同步选区到 Cesium 地球显示
function syncSelectionToCesium() {
    if (!cesiumViewer || currentMode !== '3dtiles') return;
    showCesiumSelection();

    // 飞到选区位置
    if (currentBounds) {
        cesiumViewer.camera.flyTo({
            destination: Cesium.Rectangle.fromDegrees(
                currentBounds.west, currentBounds.south,
                currentBounds.east, currentBounds.north
            ),
            duration: 1.5,
        });
    }
}

/// Cesium 上绘制的选区同步到 Leaflet
function syncSelectionToLeaflet() {
    if (!map || !drawnItems) return;
    drawnItems.clearLayers();
    if (boundaryLayer) {
        map.removeLayer(boundaryLayer);
        boundaryLayer = null;
    }

    if (currentPolygon && currentPolygon.length > 0) {
        const latlngs = currentPolygon[0].map(p => [p.lat, p.lng]);
        const layer = L.polygon(latlngs, { color: '#3B82F6', weight: 2, fillOpacity: 0.1 });
        drawnItems.addLayer(layer);
        map.fitBounds(layer.getBounds());
    } else if (currentBounds) {
        const { west, south, east, north } = currentBounds;
        const layer = L.rectangle([[south, west], [north, east]], { color: '#3B82F6', weight: 2, fillOpacity: 0.1 });
        drawnItems.addLayer(layer);
        map.fitBounds(layer.getBounds());
    }
}

function showSelectionHint(msg) {
    const info = document.getElementById('selection-info');
    if (info) info.innerHTML = `<p class="hint">${msg}</p>`;
}

// ============ 瓦片矩形包围盒可视化 ============
// 使用 CesiumJS 原生 debugShowBoundingVolume 显示（在 initCesiumControls 中绑定）

// ============ 历史影像模块 (Esri Wayback) ============
let waybackVersionsLoaded = false;
let waybackVersions = [];       // { id, date, title, layer_id }
let waybackPreviewLayer = null; // Leaflet tile layer for preview
let timelineVersions = [];

async function loadWaybackVersions() {
    const select = document.getElementById('wayback-version-select');
    const loadBtn = document.getElementById('wayback-load-versions-btn');
    const mapLoading = document.getElementById('map-loading');
    if (!select) return;

    select.disabled = true;
    select.innerHTML = '<option value="">加载中...</option>';
    if (loadBtn) loadBtn.disabled = true;
    if (mapLoading) mapLoading.style.display = '';

    try {
        const useProxy = document.getElementById('proxy-checkbox')?.checked;
        const proxyUrl = document.getElementById('proxy-input')?.value?.trim();
        const proxy = useProxy && proxyUrl ? proxyUrl : null;

        waybackVersions = await TifApi.getWaybackVersions(proxy);
        waybackVersionsLoaded = true;

        select.innerHTML = '';
        waybackVersions.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.date + '  (' + v.title + ')';
            opt.dataset.date = v.date;
            opt.dataset.layerId = v.layer_id;
            select.appendChild(opt);
        });
        select.disabled = false;

        // 选中第一个版本时预览，并初始化时间轴
        if (waybackVersions.length > 0) {
            updateWaybackPreview();
            initTimeline();
            populateBatchList();
        }
    } catch (e) {
        select.innerHTML = '<option value="">加载失败: ' + e.message + '</option>';
        console.error('加载 Wayback 版本失败:', e);
    } finally {
        if (loadBtn) loadBtn.disabled = false;
        if (mapLoading) mapLoading.style.display = 'none';
    }
}

function updateWaybackPreview() {
    const select = document.getElementById('wayback-version-select');
    if (!select || !select.value) return;

    // select.value 就是 version id（数字 key，如 "22869"）
    const versionId = select.value;

    // 移除旧预览
    if (waybackPreviewLayer && map) {
        map.removeLayer(waybackPreviewLayer);
    }

    // 添加 Wayback 瓦片图层作为预览
    const url = `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${versionId}/{z}/{y}/{x}`;
    waybackPreviewLayer = L.tileLayer(url, {
        maxZoom: 19,
        attribution: 'Esri Wayback'
    });
    if (map) {
        waybackPreviewLayer.addTo(map);
    }
}

function initWaybackPanel() {
    // 加载按钮
    const loadBtn = document.getElementById('wayback-load-versions-btn');
    if (loadBtn) loadBtn.addEventListener('click', loadWaybackVersions);

    // 版本切换 → 更新预览 + 同步时间轴
    const versionSelect = document.getElementById('wayback-version-select');
    if (versionSelect) versionSelect.addEventListener('change', () => {
        updateWaybackPreview();
        syncTimelineFromSelect();
    });

    // 缩放滑块
    const zoomSlider = document.getElementById('wayback-zoom-slider');
    const zoomMaxInput = document.getElementById('wayback-zoom-max-input');
    const zoomBadge = document.getElementById('wayback-zoom-badge');
    if (zoomSlider && zoomBadge) {
        function updateWaybackZoomBadge(val) {
            const z = parseInt(val);
            const { zoomMax } = readZoomRange('wayback-zoom-slider', 'wayback-zoom-max-input');
            let level = '';
            if (z <= 3) level = '全球';
            else if (z <= 5) level = '大洲';
            else if (z <= 7) level = '国家';
            else if (z <= 9) level = '省域';
            else if (z <= 11) level = '城市';
            else if (z <= 13) level = '区县';
            else if (z <= 15) level = '街道';
            else if (z <= 17) level = '建筑';
            else level = '细节';
            const rangeText = zoomMax > z ? `~z${zoomMax}` : '';
            zoomBadge.textContent = `z${z}${rangeText} · ${level}级`;
        }
        updateWaybackZoomBadge(zoomSlider.value);
        zoomSlider.addEventListener('input', e => {
            updateWaybackZoomBadge(e.target.value);
            estimateWaybackDownload();
        });
        if (zoomMaxInput) {
            zoomMaxInput.addEventListener('input', () => {
                updateWaybackZoomBadge(zoomSlider.value);
                estimateWaybackDownload();
            });
        }
    }

    // 并发数滑块
    const concSlider = document.getElementById('wayback-concurrency-slider');
    const concValue = document.getElementById('wayback-concurrency-value');
    if (concSlider && concValue) {
        concSlider.addEventListener('input', e => { concValue.textContent = e.target.value; });
    }

    // 压缩选项与格式联动
    const formatSelect = document.getElementById('wayback-format-select');
    const compressOpt = document.getElementById('wayback-compress-option');
    if (formatSelect && compressOpt) {
        function updateWaybackCompress() {
            compressOpt.style.display = formatSelect.value === 'geotiff' ? '' : 'none';
        }
        updateWaybackCompress();
        formatSelect.addEventListener('change', updateWaybackCompress);
    }

    // 下载按钮
    const dlBtn = document.getElementById('download-wayback-btn');
    if (dlBtn) dlBtn.addEventListener('click', startWaybackDownload);

    // 探测最大缩放级别
    const probeBtn = document.getElementById('wayback-probe-zoom-btn');
    if (probeBtn) probeBtn.addEventListener('click', probeWaybackMaxZoom);

    // 批量下载
    initWaybackBatch();
}

async function probeWaybackMaxZoom() {
    const versionSelect = document.getElementById('wayback-version-select');
    const probeBtn = document.getElementById('wayback-probe-zoom-btn');
    if (!versionSelect || !versionSelect.value || !map) return;

    const center = map.getCenter();
    const versionId = versionSelect.value;
    const useProxy = document.getElementById('proxy-checkbox')?.checked;
    const proxyUrl = document.getElementById('proxy-input')?.value?.trim();
    const proxy = useProxy && proxyUrl ? proxyUrl : null;

    probeBtn.disabled = true;
    probeBtn.textContent = '探测中...';

    try {
        const maxZoom = await TifApi.probeWaybackMaxZoom(versionId, center.lat, center.lng, proxy);
        const zoomSlider = document.getElementById('wayback-zoom-slider');
        if (zoomSlider) {
            zoomSlider.value = maxZoom;
            zoomSlider.dispatchEvent(new Event('input'));
        }
        probeBtn.textContent = `最大 z${maxZoom}`;
        setTimeout(() => { probeBtn.textContent = '探测最大级别'; }, 3000);
    } catch (e) {
        probeBtn.textContent = '探测失败';
        setTimeout(() => { probeBtn.textContent = '探测最大级别'; }, 3000);
        console.error('探测最大缩放失败:', e);
    } finally {
        probeBtn.disabled = false;
    }
}

async function estimateWaybackDownload() {
    if (!currentBounds || currentMode !== 'wayback') return;

    const { zoom, zoomMax } = readZoomRange('wayback-zoom-slider', 'wayback-zoom-max-input');
    const estimateDiv = document.getElementById('wayback-estimate-info');
    const dlBtn = document.getElementById('download-wayback-btn');

    try {
        const format = document.getElementById('wayback-format-select')?.value;
        const cropToShape = document.getElementById('wayback-crop-checkbox')?.checked || false;
        const result = await TifApi.estimateDownload(currentBounds, zoom, format, cropToShape, zoomMax);
        if (result.allowed) {
            estimateDiv.className = 'estimate-card';
            estimateDiv.innerHTML = `<strong>${result.tile_count.toLocaleString()}</strong> 个瓦片 · 约 <strong>${result.estimated_size_mb.toFixed(1)} MB</strong>`;
            dlBtn.disabled = false;
        } else {
            estimateDiv.className = 'estimate-card error';
            estimateDiv.innerHTML = result.warning;
            dlBtn.disabled = true;
        }
    } catch (e) {
        estimateDiv.className = 'estimate-card error';
        estimateDiv.innerHTML = '估算失败';
        dlBtn.disabled = true;
    }
}

async function startWaybackDownload() {
    const versionSelect = document.getElementById('wayback-version-select');
    if (!versionSelect || !versionSelect.value) {
        alert('请先选择影像日期');
        return;
    }
    if (!currentBounds) {
        alert('请先选择下载区域');
        return;
    }

    const dlBtn = document.getElementById('download-wayback-btn');
    const selectedOpt = versionSelect.selectedOptions[0];
    const versionId = versionSelect.value;
    const versionDate = selectedOpt.dataset.date;

    const format = document.getElementById('wayback-format-select').value;
    const { zoom, zoomMax, hasRange } = readZoomRange('wayback-zoom-slider', 'wayback-zoom-max-input');
    const concurrency = parseInt(document.getElementById('wayback-concurrency-slider').value);
    const compression = format === 'geotiff' ? document.getElementById('wayback-compress-select').value : 'none';

    const ext = format === 'geotiff' ? '.tif' : format === 'png' ? '.png' : '.jpg';
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const zoomLabel = formatZoomRangeLabel(zoom, zoomMax);
    const defaultFilename = `wayback_${versionDate}_${zoomLabel}_${timestamp}${ext}`;

    // 选择保存路径
    let savePath = null;
    if (TifApi._checkIsTauri()) {
        try {
            savePath = await TifApi.showSaveDialog(defaultFilename, [
                { name: 'Image Files', extensions: [ext.slice(1)] }
            ]);
            if (!savePath) return;
        } catch (e) {
            console.error('保存对话框错误:', e);
        }
    }

    const useProxy = document.getElementById('proxy-checkbox')?.checked;
    const proxyUrl = document.getElementById('proxy-input')?.value?.trim();

    const request = {
        bounds: currentBounds,
        polygon: currentPolygon,
        zoom: zoom,
        zoom_max: hasRange ? zoomMax : null,
        source: 'esri_wayback',
        format: format,
        crop_to_shape: document.getElementById('wayback-crop-checkbox').checked,
        proxy: useProxy && proxyUrl ? proxyUrl : null,
        tianditu_token: null,
        save_path: savePath,
        concurrency: concurrency,
        compression: compression
    };

    const taskName = `Wayback ${versionDate} ${zoomLabel}`;

    try {
        dlBtn.disabled = true;
        dlBtn.innerHTML = '<span class="loading-spinner"></span> 创建任务...';

        const result = await TifApi.createWaybackTask(request, versionId, versionDate, taskName);

        addTaskCardToUI(result.task_id, defaultFilename, `Esri Wayback ${versionDate}`, zoom, result.tile_count);
        startTaskListener(result.task_id);
        switchToDownloadCenter();
    } catch (e) {
        alert('创建任务失败: ' + e.message);
    } finally {
        dlBtn.disabled = false;
        dlBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            下载历史影像`;
    }
}

// ===== 时间轴组件 =====

// 时间轴内部的升序版本数组（initTimeline 初始化后可用）

function initTimeline() {
    const slider = document.getElementById('timeline-slider');
    const dateEl = document.getElementById('timeline-current-date');
    const prevBtn = document.getElementById('timeline-prev-btn');
    const nextBtn = document.getElementById('timeline-next-btn');
    const labelsEl = document.getElementById('timeline-labels');
    const timelineEl = document.getElementById('wayback-timeline');
    if (!slider || !waybackVersions.length) return;

    // 版本按日期升序排列用于时间轴（waybackVersions 是降序的）
    timelineVersions = [...waybackVersions].reverse();

    // 清除旧事件（防止重复绑定）
    const newSlider = slider.cloneNode(true);
    slider.parentNode.replaceChild(newSlider, slider);
    newSlider.min = 0;
    newSlider.max = timelineVersions.length - 1;
    newSlider.value = timelineVersions.length - 1;

    // 生成年份刻度 + 日期点
    labelsEl.innerHTML = '';
    const years = new Set();
    timelineVersions.forEach(v => years.add(v.date.slice(0, 4)));
    const yearArr = [...years].sort();
    const step = Math.max(1, Math.ceil(yearArr.length / 12));
    for (let i = 0; i < yearArr.length; i += step) {
        const label = document.createElement('span');
        label.className = 'timeline-label';
        label.textContent = yearArr[i];
        labelsEl.appendChild(label);
    }
    const lastYear = yearArr[yearArr.length - 1];
    if (labelsEl.lastChild && labelsEl.lastChild.textContent !== lastYear) {
        const label = document.createElement('span');
        label.className = 'timeline-label';
        label.textContent = lastYear;
        labelsEl.appendChild(label);
    }

    // 生成日期点（dots）
    const dotsContainer = document.getElementById('timeline-dots');
    if (dotsContainer) {
        dotsContainer.innerHTML = '';
        timelineVersions.forEach((v, i) => {
            const dot = document.createElement('span');
            dot.className = 'timeline-dot';
            dot.style.left = (i / (timelineVersions.length - 1) * 100) + '%';
            dot.title = v.date;
            dot.dataset.index = i;
            dot.addEventListener('click', () => {
                const s = document.getElementById('timeline-slider');
                if (s) { s.value = i; s.dispatchEvent(new Event('input')); }
            });
            dotsContainer.appendChild(dot);
        });
    }

    // 应用某个索引
    function applyTimelineIndex(idx) {
        const v = timelineVersions[idx];
        if (!v) return;
        dateEl.textContent = v.date;

        // 同步侧栏 select
        const select = document.getElementById('wayback-version-select');
        if (select) select.value = v.id;

        // 高亮当前点
        if (dotsContainer) {
            dotsContainer.querySelectorAll('.timeline-dot').forEach((d, i) => {
                d.classList.toggle('active', i === idx);
            });
        }

        // 更新地图预览
        updateWaybackPreviewByVersion(v);
    }

    applyTimelineIndex(parseInt(newSlider.value));

    newSlider.addEventListener('input', () => {
        applyTimelineIndex(parseInt(newSlider.value));
    });

    // 显示时间轴
    if (timelineEl) timelineEl.style.display = '';

    // 前进/后退按钮
    if (prevBtn) {
        const newPrev = prevBtn.cloneNode(true);
        prevBtn.parentNode.replaceChild(newPrev, prevBtn);
        newPrev.addEventListener('click', () => {
            const s = document.getElementById('timeline-slider');
            const idx = parseInt(s.value);
            if (idx > 0) { s.value = idx - 1; s.dispatchEvent(new Event('input')); }
        });
    }
    if (nextBtn) {
        const newNext = nextBtn.cloneNode(true);
        nextBtn.parentNode.replaceChild(newNext, nextBtn);
        newNext.addEventListener('click', () => {
            const s = document.getElementById('timeline-slider');
            const idx = parseInt(s.value);
            if (idx < timelineVersions.length - 1) { s.value = idx + 1; s.dispatchEvent(new Event('input')); }
        });
    }
}

/** 下拉框切换后同步时间轴位置 */
function syncTimelineFromSelect() {
    const select = document.getElementById('wayback-version-select');
    const slider = document.getElementById('timeline-slider');
    const dateEl = document.getElementById('timeline-current-date');
    const dotsContainer = document.getElementById('timeline-dots');
    if (!select || !slider || !timelineVersions.length) return;

    const idx = timelineVersions.findIndex(v => v.id === select.value);
    if (idx >= 0) {
        slider.value = idx;
        if (dateEl) dateEl.textContent = timelineVersions[idx].date;
        if (dotsContainer) {
            dotsContainer.querySelectorAll('.timeline-dot').forEach((d, i) => {
                d.classList.toggle('active', i === idx);
            });
        }
    }
}

function updateWaybackPreviewByVersion(v) {
    if (!v) return;
    // 移除旧预览
    if (waybackPreviewLayer && map) {
        map.removeLayer(waybackPreviewLayer);
    }
    // v.id 是数字 key（如 "22869"），用于瓦片 URL
    const url = `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${v.id}/{z}/{y}/{x}`;
    waybackPreviewLayer = L.tileLayer(url, {
        maxZoom: 19,
        attribution: 'Esri Wayback'
    });
    if (map) {
        waybackPreviewLayer.addTo(map);
    }
}

// ===== 批量下载 =====

function populateBatchList() {
    const listEl = document.getElementById('wayback-batch-list');
    if (!listEl || !waybackVersions.length) return;

    listEl.innerHTML = '';
    waybackVersions.forEach(v => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = v.id;
        cb.dataset.date = v.date;
        cb.addEventListener('change', updateBatchCount);
        const text = document.createTextNode(` ${v.date}  (${v.title})`);
        label.appendChild(cb);
        label.appendChild(text);
        listEl.appendChild(label);
    });
    updateBatchCount();
}

function updateBatchCount() {
    const count = document.querySelectorAll('#wayback-batch-list input:checked').length;
    const countEl = document.getElementById('wayback-batch-count');
    const batchBtn = document.getElementById('wayback-batch-download-btn');
    if (countEl) countEl.textContent = count;
    if (batchBtn) batchBtn.disabled = count === 0 || !currentBounds;
}

function initWaybackBatch() {
    const selectAll = document.getElementById('wayback-batch-select-all');
    const selectNone = document.getElementById('wayback-batch-select-none');
    const batchBtn = document.getElementById('wayback-batch-download-btn');

    if (selectAll) selectAll.addEventListener('click', () => {
        document.querySelectorAll('#wayback-batch-list input[type="checkbox"]').forEach(cb => { cb.checked = true; });
        updateBatchCount();
    });
    if (selectNone) selectNone.addEventListener('click', () => {
        document.querySelectorAll('#wayback-batch-list input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        updateBatchCount();
    });
    if (batchBtn) batchBtn.addEventListener('click', startBatchWaybackDownload);

    // 单个/批量切换
    document.querySelectorAll('.wayback-dl-mode').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.wayback-dl-mode').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const mode = btn.dataset.dlmode;
            document.getElementById('wayback-single-download').style.display = mode === 'single' ? '' : 'none';
            document.getElementById('wayback-batch-download').style.display = mode === 'batch' ? '' : 'none';
            const incEl = document.getElementById('wayback-incremental-download');
            if (incEl) incEl.style.display = mode === 'incremental' ? '' : 'none';
        });
    });

    // 增量下载（按拍摄日期）
    initWaybackIncremental();
}

// ==================== Wayback 增量下载（按拍摄日期） ====================

let waybackScanFootprints = []; // 上次扫描结果（兼容保留）
let waybackScanReleases = []; // 上次扫描的 release 汇总（主用）

function initWaybackIncremental() {
    const scanBtn = document.getElementById('wayback-scan-btn');
    if (!scanBtn) return;
    scanBtn.addEventListener('click', startWaybackScan);
    document.getElementById('wayback-inc-select-all')?.addEventListener('click', () => {
        document.querySelectorAll('#wayback-incremental-list input[type="checkbox"]').forEach(cb => cb.checked = true);
        updateIncrementalCount();
    });
    document.getElementById('wayback-inc-select-none')?.addEventListener('click', () => {
        document.querySelectorAll('#wayback-incremental-list input[type="checkbox"]').forEach(cb => cb.checked = false);
        updateIncrementalCount();
    });
    document.getElementById('wayback-coverage-threshold')?.addEventListener('input', renderIncrementalList);
    document.getElementById('wayback-dominant-threshold')?.addEventListener('input', renderIncrementalList);
    document.getElementById('wayback-only-latest-per-year')?.addEventListener('change', renderIncrementalList);
    document.getElementById('wayback-incremental-download-btn')?.addEventListener('click', startIncrementalDownload);
}

async function startWaybackScan() {
    if (!currentBounds) {
        alert('请先选择下载区域');
        return;
    }
    const { zoom } = readZoomRange('wayback-zoom-slider', 'wayback-zoom-max-input');
    // 简化：用同一 zoom 作为 min/max；后续可加范围选择器
    const zMin = Math.max(zoom - 1, 1);
    const zMax = Math.min(zoom + 1, 22);

    const useProxy = document.getElementById('proxy-checkbox')?.checked;
    const proxyUrl = document.getElementById('proxy-input')?.value?.trim();

    const scanBtn = document.getElementById('wayback-scan-btn');
    const progressEl = document.getElementById('wayback-scan-progress');
    const progressBar = document.getElementById('wayback-scan-progress-bar');
    const progressText = document.getElementById('wayback-scan-progress-text');
    const progressPct = document.getElementById('wayback-scan-progress-pct');
    const summaryEl = document.getElementById('wayback-scan-summary');

    scanBtn.disabled = true;
    scanBtn.textContent = '扫描中…';
    summaryEl.style.display = 'none';
    document.getElementById('wayback-incremental-list').style.display = 'none';
    document.getElementById('wayback-incremental-actions').style.display = 'none';
    document.getElementById('wayback-incremental-filters').style.display = 'none';

    const bbox = [currentBounds.west, currentBounds.south, currentBounds.east, currentBounds.north];

    try {
        const scanModeEl = document.querySelector('input[name="wayback-scan-mode"]:checked');
        const scanMode = scanModeEl ? scanModeEl.value : 'fast';
        const res = await TifApi.scanWaybackMetadata({
            bbox,
            zoom_min: zMin,
            zoom_max: zMax,
            force_refresh: false,
            proxy: useProxy && proxyUrl ? proxyUrl : null,
            scan_mode: scanMode
        });

        if (res.kind === 'result') {
            // 缓存命中，直接展示
            onWaybackScanComplete(res);
        } else if (res.kind === 'scanning') {
            // 后台扫描中，轮询进度
            progressEl.style.display = '';
            progressBar.style.width = '0%';
            progressText.textContent = `扫描中（共 ${res.total} 个查询）…`;
            await pollWaybackScanProgress(res.scan_id, res.total, bbox, zMin, zMax);
        }
    } catch (e) {
        console.error('扫描失败:', e);
        alert('扫描失败: ' + (e?.message || e || '未知错误'));
        scanBtn.disabled = false;
        scanBtn.textContent = '扫描影像清单';
        progressEl.style.display = 'none';
    }
}

async function pollWaybackScanProgress(scanId, total, bbox, zMin, zMax) {
    const progressBar = document.getElementById('wayback-scan-progress-bar');
    const progressText = document.getElementById('wayback-scan-progress-text');
    const progressPct = document.getElementById('wayback-scan-progress-pct');
    const scanBtn = document.getElementById('wayback-scan-btn');

    // 每 1.5 秒轮询一次进度；扫描结束后再次调用 scan 拿缓存结果
    while (true) {
        await new Promise(r => setTimeout(r, 1500));
        let progress;
        try {
            progress = await TifApi.getWaybackScanProgress(scanId);
        } catch (e) {
            console.warn('进度查询失败:', e);
            continue;
        }
        if (!progress) {
            // 扫描已结束（progress 被清理），重新调 scan 拿缓存结果
            try {
                const final = await TifApi.scanWaybackMetadata({
                    bbox, zoom_min: zMin, zoom_max: zMax, force_refresh: false
                });
                if (final.kind === 'result') {
                    onWaybackScanComplete(final);
                    return;
                }
            } catch (e) {
                console.error('获取最终结果失败:', e);
                alert('扫描失败: ' + (e?.message || e || '未知错误'));
            }
            scanBtn.disabled = false;
            scanBtn.textContent = '扫描影像清单';
            return;
        }
        const pct = total > 0 ? Math.round(progress.current / total * 100) : 0;
        progressBar.style.width = pct + '%';
        progressPct.textContent = pct + '%';
        progressText.textContent = `${progress.current}/${total} · 已发现 ${progress.footprints_so_far} 个 footprint · ${progress.elapsed_sec}s`;
    }
}

function onWaybackScanComplete(res) {
    const result = res.kind === 'result' ? res : res;
    waybackScanFootprints = result.footprints || [];
    waybackScanReleases = result.releases || [];
    const scanBtn = document.getElementById('wayback-scan-btn');
    const progressEl = document.getElementById('wayback-scan-progress');
    const summaryEl = document.getElementById('wayback-scan-summary');

    scanBtn.disabled = false;
    scanBtn.textContent = '重新扫描';
    progressEl.style.display = 'none';

    const releasesWithData = waybackScanReleases.length;
    const dateSet = new Set(waybackScanReleases.map(r => r.dominant_capture_date).filter(Boolean));
    summaryEl.style.display = '';
    summaryEl.innerHTML = `扫描了 <strong>${result.releases_scanned}</strong> 个 release，区域内有数据的 <strong>${releasesWithData}</strong> 个，主导拍摄日期 <strong>${dateSet.size}</strong> 个。`;

    document.getElementById('wayback-incremental-filters').style.display = '';
    const helpEl = document.getElementById('wayback-result-help');
    if (helpEl) helpEl.style.display = '';
    document.getElementById('wayback-incremental-list').style.display = '';
    document.getElementById('wayback-incremental-actions').style.display = '';
    renderIncrementalList();
}

function renderIncrementalList() {
    const listEl = document.getElementById('wayback-incremental-list');
    if (!listEl) return;
    const covThreshold = parseFloat(document.getElementById('wayback-coverage-threshold')?.value || '0') / 100;
    const domThreshold = parseFloat(document.getElementById('wayback-dominant-threshold')?.value || '0') / 100;
    const onlyLatest = document.getElementById('wayback-only-latest-per-year')?.checked;

    let items = waybackScanReleases.filter(r =>
        (r.coverage_ratio || 0) >= covThreshold &&
        (r.dominant_ratio || 0) >= domThreshold &&
        r.dominant_capture_date
    );

    if (onlyLatest) {
        // 按主导拍摄日期年份去重，保留 release_num 最大（最新 release）
        const seenYear = new Map();
        for (const r of items) {
            const year = r.dominant_capture_date.slice(0, 4);
            const prev = seenYear.get(year);
            if (!prev || (r.release_num || 0) > (prev.release_num || 0)) {
                seenYear.set(year, r);
            }
        }
        items = Array.from(seenYear.values()).sort((a, b) => (b.release_num || 0) - (a.release_num || 0));
    }

    if (items.length === 0) {
        listEl.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px;">无符合条件的 release</div>';
        listEl.dataset.items = '[]';
        updateIncrementalCount();
        return;
    }

    listEl.innerHTML = items.map((r, idx) => {
        const cov = Math.round((r.coverage_ratio || 0) * 100);
        const dom = Math.round((r.dominant_ratio || 0) * 100);
        const sourceColor = (r.source_name || '').includes('Vivid') ? '#4caf50' : (r.source_name || '').includes('Maxar') ? '#2196f3' : '#9e9e9e';
        // 次要拍摄日期 tooltip：列出全部分布
        const breakdown = (r.captures || []).slice(0, 6).map(c =>
            `${c.capture_date_str} ${(c.ratio * 100).toFixed(0)}% (${c.source_name || '未知'} ${(c.resolution_m || 0).toFixed(2)}m)`
        ).join('\n');
        const moreCount = Math.max(0, (r.captures || []).length - 6);
        const tooltip = breakdown + (moreCount > 0 ? `\n…还有 ${moreCount} 个` : '');
        const resStr = r.resolution_m > 0 ? `${r.resolution_m.toFixed(2)}m` : '?';
        return `<label class="wayback-release-item" title="${tooltip.replace(/"/g, '&quot;')}">
            <input type="checkbox" data-idx="${idx}" class="wayback-inc-cb" checked>
            <span class="source-dot" style="background:${sourceColor};"></span>
            <span class="release-main">
                <span class="release-title">${r.dominant_capture_date}</span>
                <span class="release-sub"> · ${r.source_name || '未知源'} · ${resStr}</span>
                <div class="release-meta">release ${r.release_date} · 主导 ${dom}%${(r.captures || []).length > 1 ? ` · 共 ${r.captures.length} 个日期` : ''}</div>
            </span>
            <span class="release-coverage">覆盖 ${cov}%</span>
        </label>`;
    }).join('');

    listEl.dataset.items = JSON.stringify(items);

    listEl.querySelectorAll('.wayback-inc-cb').forEach(cb => {
        cb.addEventListener('change', updateIncrementalCount);
    });
    updateIncrementalCount();
}

function updateIncrementalCount() {
    const checked = document.querySelectorAll('#wayback-incremental-list input:checked').length;
    document.getElementById('wayback-inc-count').textContent = checked;
    document.getElementById('wayback-incremental-download-btn').disabled = checked === 0;
}

async function startIncrementalDownload() {
    if (!currentBounds) {
        alert('请先选择下载区域');
        return;
    }
    const listEl = document.getElementById('wayback-incremental-list');
    const items = JSON.parse(listEl.dataset.items || '[]');
    const checked = Array.from(document.querySelectorAll('#wayback-incremental-list input:checked'));
    if (checked.length === 0) return;

    const selectedFootprints = checked.map(cb => {
        const r = items[parseInt(cb.dataset.idx)];
        return {
            release_id: r.release_id,
            release_date: r.release_date,
            capture_date_str: r.dominant_capture_date,
            source_name: r.source_name,
            resolution_m: r.resolution_m
        };
    });

    const btn = document.getElementById('wayback-incremental-download-btn');
    btn.disabled = true;
    btn.textContent = '选择保存目录…';

    let saveDir = null;
    if (TifApi._checkIsTauri()) {
        try {
            saveDir = await window.__TAURI__.dialog.open({
                directory: true,
                title: '选择保存目录'
            });
        } catch (e) { console.error(e); }
    }
    if (!saveDir) {
        btn.disabled = false;
        btn.textContent = '下载选中的服务';
        return;
    }

    const format = document.getElementById('wayback-format-select').value;
    const ext = format === 'geotiff' ? 'tif' : format === 'png' ? 'png' : 'jpg';
    const zoom = parseInt(document.getElementById('wayback-zoom-slider').value);
    const compression = format === 'geotiff' ? document.getElementById('wayback-compress-select').value : 'none';
    const useProxy = document.getElementById('proxy-checkbox')?.checked;
    const proxyUrl = document.getElementById('proxy-input')?.value?.trim();
    const polygon = currentPolygon ? (Array.isArray(currentPolygon[0]) ? currentPolygon[0] : currentPolygon) : null;

    const savePathBase = `${saveDir}\\wayback_inc.${ext}`;

    btn.textContent = `创建 ${selectedFootprints.length} 个任务…`;
    try {
        const result = await TifApi.downloadWaybackIncremental({
            bounds: currentBounds,
            zoom,
            zoom_max: hasRange ? zoomMax : null,
            format,
            save_path: savePathBase,
            footprints: selectedFootprints,
            crop_to_shape: document.getElementById('wayback-crop-checkbox').checked,
            polygon,
            compression,
            build_pyramid: false,
            proxy: useProxy && proxyUrl ? proxyUrl : null
        });
        for (let i = 0; i < result.task_ids.length; i++) {
            const tid = result.task_ids[i];
            const fp = selectedFootprints[i];
            const safeSrc = (fp.source_name || '').replace(/[\s/\\]/g, '_');
            const taskName = `Wayback ${fp.capture_date_str} · ${safeSrc} · ${fp.resolution_m.toFixed(2)}m`;
            addTaskCardToUI(tid, `${taskName} · ${zoomLabel}`, `Esri Wayback ${fp.release_date}`, zoom, 0);
            startTaskListener(tid);
        }
        btn.textContent = `已创建 ${result.task_ids.length} 个任务`;
        switchToDownloadCenter();
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = '下载选中的服务';
        }, 1500);
    } catch (e) {
        console.error('增量下载失败:', e);
        alert('增量下载失败: ' + (e?.message || e || '未知错误'));
        btn.disabled = false;
        btn.textContent = '下载选中的服务';
    }
}

async function startBatchWaybackDownload() {
    if (!currentBounds) {
        alert('请先选择下载区域');
        return;
    }

    const checked = document.querySelectorAll('#wayback-batch-list input:checked');
    if (checked.length === 0) return;

    const batchBtn = document.getElementById('wayback-batch-download-btn');
    batchBtn.disabled = true;
    batchBtn.textContent = '创建任务中...';

    const format = document.getElementById('wayback-format-select').value;
    const { zoom, zoomMax, hasRange } = readZoomRange('wayback-zoom-slider', 'wayback-zoom-max-input');
    const zoomLabel = formatZoomRangeLabel(zoom, zoomMax);
    const concurrency = parseInt(document.getElementById('wayback-concurrency-slider').value);
    const compression = format === 'geotiff' ? document.getElementById('wayback-compress-select').value : 'none';
    const useProxy = document.getElementById('proxy-checkbox')?.checked;
    const proxyUrl = document.getElementById('proxy-input')?.value?.trim();
    const ext = format === 'geotiff' ? '.tif' : format === 'png' ? '.png' : '.jpg';

    // 选择保存目录
    let saveDir = null;
    if (TifApi._checkIsTauri()) {
        try {
            saveDir = await window.__TAURI__.dialog.open({
                directory: true,
                title: '选择批量下载保存目录'
            });
            if (!saveDir) { batchBtn.disabled = false; batchBtn.textContent = '批量下载选中版本'; return; }
        } catch (e) {
            console.error('保存对话框错误:', e);
        }
    }

    let created = 0;
    for (const cb of checked) {
        const versionId = cb.value;
        const versionDate = cb.dataset.date;
        const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const filename = `wayback_${versionDate}_${zoomLabel}_${timestamp}${ext}`;
        const savePath = saveDir ? `${saveDir}\\${filename}` : null;

        const request = {
            bounds: currentBounds,
            polygon: currentPolygon,
            zoom,
            zoom_max: hasRange ? zoomMax : null,
            source: 'esri_wayback',
            format,
            crop_to_shape: document.getElementById('wayback-crop-checkbox').checked,
            proxy: useProxy && proxyUrl ? proxyUrl : null,
            tianditu_token: null,
            save_path: savePath,
            concurrency,
            compression
        };

        const taskName = `Wayback ${versionDate} ${zoomLabel}`;

        try {
            batchBtn.textContent = `创建中 (${++created}/${checked.length})...`;
            const result = await TifApi.createWaybackTask(request, versionId, versionDate, taskName);
            addTaskCardToUI(result.task_id, filename, `Esri Wayback ${versionDate}`, zoom, result.tile_count);
            startTaskListener(result.task_id);
        } catch (e) {
            console.error(`批量任务 ${versionDate} 创建失败:`, e);
        }
    }

    batchBtn.disabled = false;
    batchBtn.textContent = '批量下载选中版本';
    if (created > 0) switchToDownloadCenter();
}
