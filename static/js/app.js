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
let layerControl = null; // 图层控制器引用
let activeTaskListeners = {}; // 活动任务的事件监听器 { taskId: unlisten函数 }

// ============ 工具函数 ============
/**
 * 从 GeoJSON 中提取多边形坐标
 * 支持 Polygon 和 MultiPolygon，返回最大的多边形
 */
function extractPolygonFromGeoJSON(geojson) {
    if (!geojson) return null;
    
    let coordinates = null;
    
    // 处理 FeatureCollection
    if (geojson.type === 'FeatureCollection' && geojson.features && geojson.features.length > 0) {
        const geometry = geojson.features[0].geometry;
        if (geometry.type === 'Polygon') {
            coordinates = geometry.coordinates[0]; // 外环
        } else if (geometry.type === 'MultiPolygon') {
            // 找最大的多边形（通常是主要边界）
            let maxLen = 0;
            for (const poly of geometry.coordinates) {
                if (poly[0].length > maxLen) {
                    maxLen = poly[0].length;
                    coordinates = poly[0];
                }
            }
        }
    } else if (geojson.type === 'Feature') {
        const geometry = geojson.geometry;
        if (geometry.type === 'Polygon') {
            coordinates = geometry.coordinates[0];
        } else if (geometry.type === 'MultiPolygon') {
            let maxLen = 0;
            for (const poly of geometry.coordinates) {
                if (poly[0].length > maxLen) {
                    maxLen = poly[0].length;
                    coordinates = poly[0];
                }
            }
        }
    }
    
    if (!coordinates) return null;
    
    // GeoJSON 坐标是 [lng, lat]，转换为 {lat, lng} 格式
    return coordinates.map(coord => ({
        lat: coord[1],
        lng: coord[0]
    }));
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', async function() {
    initTitlebar(); // 初始化标题栏控制
    await initSettings(); // 加载设置
    initMap();
    initDrawControls();
    initEventListeners();
    initTabNavigation();
    initZoomSlider();
    initConcurrencySlider();
    initCompressOption();
    initSettingsPanel();
    initHistoryListEvents();
    initTaskListEvents();
    loadProvinces();
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
            // 排除按钮点击
            if (e.target.closest('.titlebar-btn')) return;
            appWindow.startDragging();
        });
        
        // 双击标题栏最大化/还原
        titlebar.addEventListener('dblclick', async (e) => {
            if (e.target.closest('.titlebar-btn')) return;
            const isMaximized = await appWindow.isMaximized();
            if (isMaximized) {
                appWindow.unmaximize();
            } else {
                appWindow.maximize();
            }
        });
    }
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
            proxy_enabled: true,
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
}

function getTianDiTuToken() {
    return appSettings?.tianditu_token || '';
}

async function refreshMapLayers() {
    // 记录当前激活的图层
    let activeLayerKey = null;
    for (const [key, layer] of Object.entries(mapLayers)) {
        if (map.hasLayer(layer)) {
            activeLayerKey = key;
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
    
    // 重新加载图源
    await loadMapSources();
    
    // 恢复之前激活的图层（如果仍存在）
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
}

async function loadMapSources() {
    try {
        const customToken = getTianDiTuToken();
        const sources = await TifApi.getTileSources(customToken);
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
        } else if (firstLayer) {
            firstLayer.addTo(map);
        }
        
        if (layerControl) layerControl.remove();
        layerControl = L.control.layers(sortedBaseMaps).addTo(map);
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
    });
    
    // 当地图图层通过控件改变时，更新下拉框
    map.on('baselayerchange', function(e) {
        for (const [key, layer] of Object.entries(mapLayers)) {
            if (layer === e.layer) {
                sourceSelect.value = key;
                checkGcj02Warning(key);
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
            currentPolygon = latlngs.map(ll => ({ lat: ll.lat, lng: ll.lng }));
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
    });
    
    // 删除事件
    map.on(L.Draw.Event.DELETED, function(e) {
        currentBounds = null;
        currentPolygon = null;
        updateSelectionInfo();
        document.getElementById('download-btn').disabled = true;
        updateVectorButtons();
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
    
    // 清空历史按钮
    const clearHistoryBtn = document.getElementById('clear-history-btn');
    if (clearHistoryBtn) {
        clearHistoryBtn.addEventListener('click', clearAllHistory);
    }
    
    // 自定义图源
    const addSourceBtn = document.getElementById('add-custom-source-btn');
    if (addSourceBtn) {
        addSourceBtn.addEventListener('click', addOrUpdateCustomSource);
    }
    initCustomSourcesList();
    
    // 检查更新按钮
    const checkUpdateBtn = document.getElementById('check-update-btn');
    if (checkUpdateBtn) {
        checkUpdateBtn.addEventListener('click', () => checkForUpdates(false));
    }
}

// ============ 自动更新 ============

const APP_VERSION = '1.0.0';
const GITHUB_REPO = 'gaopengbin/tif-downloader';

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

async function checkForUpdates(silent = false) {
    if (!window.__TAURI__) return;
    
    const statusEl = document.getElementById('update-status');
    const btn = document.getElementById('check-update-btn');
    
    if (!silent && statusEl) statusEl.textContent = '正在检查更新...';
    if (btn) btn.disabled = true;
    
    try {
        const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
        if (!resp.ok) throw new Error('获取更新信息失败');
        
        const data = await resp.json();
        const latestVersion = data.tag_name.replace(/^v/, '');
        
        if (compareVersions(latestVersion, APP_VERSION) > 0) {
            const assets = data.assets || [];
            const setupAsset = assets.find(a => a.name.endsWith('_setup.exe') || a.name.endsWith('-setup.exe'));
            
            if (confirm(`发现新版本 v${latestVersion}，是否立即更新？`)) {
                if (setupAsset?.browser_download_url) {
                    if (statusEl) statusEl.textContent = '正在下载更新...';
                    // 监听下载进度
                    const unlisten = await window.__TAURI__.event.listen('update-download-progress', (e) => {
                        if (statusEl) statusEl.textContent = `下载中... ${e.payload}%`;
                    });
                    try {
                        await window.__TAURI__.core.invoke('download_and_install_update', {
                            url: setupAsset.browser_download_url,
                            version: latestVersion
                        });
                    } finally {
                        unlisten();
                    }
                } else {
                    // 没找到安装包，打开 Release 页面
                    window.open(data.html_url, '_blank');
                }
            } else {
                if (statusEl) statusEl.textContent = `v${latestVersion} 可用，已跳过`;
            }
        } else {
            if (!silent && statusEl) statusEl.textContent = '✅ 已是最新版本';
        }
    } catch (error) {
        if (!silent && statusEl) statusEl.textContent = '检查更新失败: ' + (error.message || error);
    }
    
    if (btn) btn.disabled = false;
}

// ============ 自定义图源管理 ============
let editingSourceId = null; // 当前编辑的图源 ID

async function addOrUpdateCustomSource() {
    const nameInput = document.getElementById('custom-source-name');
    const urlInput = document.getElementById('custom-source-url');
    const subdomainsInput = document.getElementById('custom-source-subdomains');
    const maxZoomInput = document.getElementById('custom-source-maxzoom');
    
    const name = nameInput.value.trim();
    const url = urlInput.value.trim();
    if (!name || !url) {
        alert('请填写图源名称和 URL 模板');
        return;
    }
    
    if (!appSettings.custom_sources) appSettings.custom_sources = [];
    
    if (editingSourceId) {
        // 更新已有图源
        const idx = appSettings.custom_sources.findIndex(s => s.id === editingSourceId);
        if (idx >= 0) {
            appSettings.custom_sources[idx] = {
                id: editingSourceId,
                name, url,
                subdomains: subdomainsInput.value.trim(),
                max_zoom: parseInt(maxZoomInput.value) || 18
            };
        }
    } else {
        // 新增图源
        appSettings.custom_sources.push({
            id: 'custom_' + Date.now(),
            name, url,
            subdomains: subdomainsInput.value.trim(),
            max_zoom: parseInt(maxZoomInput.value) || 18
        });
    }
    
    try {
        await TifApi.saveSettings(appSettings);
        clearSourceForm();
        renderCustomSourcesList();
        refreshMapLayers();
    } catch (error) {
        if (!editingSourceId) appSettings.custom_sources.pop();
        alert('保存失败: ' + error.message);
    }
}

function editCustomSource(id) {
    const source = appSettings?.custom_sources?.find(s => s.id === id);
    if (!source) return;
    
    document.getElementById('custom-source-name').value = source.name;
    document.getElementById('custom-source-url').value = source.url;
    document.getElementById('custom-source-subdomains').value = source.subdomains || '';
    document.getElementById('custom-source-maxzoom').value = source.max_zoom || 18;
    
    editingSourceId = id;
    const btn = document.getElementById('add-custom-source-btn');
    btn.innerHTML = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 更新图源';
}

function clearSourceForm() {
    document.getElementById('custom-source-name').value = '';
    document.getElementById('custom-source-url').value = '';
    document.getElementById('custom-source-subdomains').value = '';
    document.getElementById('custom-source-maxzoom').value = '18';
    editingSourceId = null;
    const btn = document.getElementById('add-custom-source-btn');
    btn.innerHTML = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 添加图源';
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

function renderCustomSourcesList() {
    const listEl = document.getElementById('custom-sources-list');
    if (!listEl) return;
    const sources = appSettings?.custom_sources || [];
    if (sources.length === 0) {
        listEl.innerHTML = '<p class="hint" style="margin-top:8px">暂无自定义图源</p>';
        return;
    }
    listEl.innerHTML = sources.map(s => `
        <div class="custom-source-item" style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-color,#e2e8f0);font-size:0.8rem">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">
                <strong>${s.name}</strong>
                <span style="color:#888;margin-left:4px">z${s.max_zoom}</span>
            </div>
            <div style="flex-shrink:0;margin-left:8px;display:flex;gap:4px">
                <button class="btn btn-outline btn-sm btn-edit-source" data-id="${s.id}">编辑</button>
                <button class="btn btn-outline btn-sm btn-delete-source" data-id="${s.id}">删除</button>
            </div>
        </div>
    `).join('');
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
        custom_sources: appSettings?.custom_sources || []
    };
    
    try {
        await TifApi.saveSettings(settings);
        appSettings = settings;
        statusEl.textContent = '✅ 设置已保存';
        statusEl.className = 'status-text success';
        
        // 应用设置到主界面
        applySettings(settings);
        
        // 刷新地图图层
        refreshMapLayers();
    } catch (error) {
        statusEl.textContent = '❌ 保存失败: ' + error.message;
        statusEl.className = 'status-text error';
    }
}

// ============ 缩放级别滑块 ============
function initZoomSlider() {
    const slider = document.getElementById('zoom-slider');
    const badge = document.getElementById('zoom-badge');
    
    function updateZoomBadge(value) {
        const z = parseInt(value);
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
        
        badge.textContent = `z${z} · ${level}级`;
    }
    
    updateZoomBadge(slider.value);
    
    slider.addEventListener('input', (e) => {
        updateZoomBadge(e.target.value);
        if (currentBounds) {
            estimateDownload();
        }
    });
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
    
    function updateCompressVisibility() {
        const format = formatSelect.value;
        compressOption.style.display = format === 'geotiff' ? '' : 'none';
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
        const results = await TifApi.geocodeSearch(query);
        
        if (results.length === 0) {
            resultsContainer.innerHTML = '<div class="search-result-item">未找到结果</div>';
            return;
        }
        
        resultsContainer.innerHTML = results.map(r => `
            <div class="search-result-item" onclick="goToLocation(${r.lat}, ${r.lng}, ${r.bounds ? JSON.stringify(r.bounds).replace(/"/g, '&quot;') : 'null'}, ${r.address ? JSON.stringify(r.address).replace(/"/g, '&quot;') : 'null'})">
                <div class="name">${r.name}</div>
                <div class="detail">${r.display_name}</div>
            </div>
        `).join('');
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
    } catch (error) {
        console.error('Failed to load boundary:', error);
        alert('加载边界失败');
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
    
    const zoom = parseInt(document.getElementById('zoom-slider').value);
    const estimateDiv = document.getElementById('estimate-info');
    const downloadBtn = document.getElementById('download-btn');
    
    try {
        const result = await TifApi.estimateDownload(currentBounds, zoom);
        
        if (result.allowed) {
            estimateDiv.className = 'estimate-card';
            estimateDiv.innerHTML = `
                <strong>${result.tile_count.toLocaleString()}</strong> 个瓦片 · 约 <strong>${result.estimated_size_mb.toFixed(1)} MB</strong>
            `;
            downloadBtn.disabled = false;
        } else {
            estimateDiv.className = 'estimate-card error';
            estimateDiv.innerHTML = result.warning;
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
    
    // 获取文件格式和默认文件名
    const format = document.getElementById('format-select').value;
    const zoom = document.getElementById('zoom-slider').value;
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const ext = format === 'geotiff' ? '.tif' : format === 'png' ? '.png' : '.jpg';
    const defaultFilename = `map_${timestamp}_z${zoom}${ext}`;
    
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
            if (!savePath) return;
        } catch (e) {
            console.error('保存对话框错误:', e);
        }
    }
    
    const useProxy = document.getElementById('proxy-checkbox').checked;
    const proxyUrl = document.getElementById('proxy-input').value.trim();
    const tiandituToken = getTianDiTuToken();
    const concurrency = parseInt(document.getElementById('concurrency-slider').value);
    const compress = format === 'geotiff' && document.getElementById('compress-checkbox').checked;
    
    const request = {
        bounds: currentBounds,
        polygon: currentPolygon,
        zoom: parseInt(zoom),
        source: document.getElementById('source-select').value,
        format: format,
        crop_to_shape: document.getElementById('crop-checkbox').checked,
        proxy: useProxy && proxyUrl ? proxyUrl : null,
        tianditu_token: tiandituToken || null,
        save_path: savePath || null,
        concurrency: concurrency,
        compress: compress
    };
    
    // Tauri 模式：创建下载任务
    if (TifApi._checkIsTauri()) {
        try {
            downloadBtn.disabled = true;
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
            alert('创建任务失败: ' + error.message);
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
            const result = await TifApi.createOsmDownloadTask(
                currentBounds, featureType, savePath, proxy, currentPolygon, taskName
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
                    .map(([k, v]) => `<b>${k}:</b> ${v}`)
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
    infoEl.innerHTML = '<p class="hint">⬇️ 正在加载边界文件...</p>';
    
    // 延迟执行，让 UI 有时间更新
    await new Promise(r => setTimeout(r, 50));
    
    try {
        // 检查是否是 Shapefile 组合
        const fileArray = Array.from(files);
        const shpFile = fileArray.find(f => f.name.toLowerCase().endsWith('.shp'));
        const geojsonFile = fileArray.find(f => f.name.toLowerCase().endsWith('.geojson') || f.name.toLowerCase().endsWith('.json'));
        
        let geojson;
        let filename;
        
        if (shpFile) {
            // Shapefile
            infoEl.innerHTML = '<p class="hint">⚙️ 正在转换 Shapefile...</p>';
            await new Promise(r => setTimeout(r, 50));
            geojson = await convertShapefilesToGeoJSON(fileArray);
            filename = shpFile.name;
        } else if (geojsonFile) {
            // 直接读取 GeoJSON
            const text = await geojsonFile.text();
            geojson = JSON.parse(text);
            filename = geojsonFile.name;
        } else {
            throw new Error('请选择 .geojson 或 .shp 文件 (需同时选择 .shx, .dbf)');
        }
        
        if (geojson) {
            setBoundaryFromGeoJSON(geojson, filename);
        }
    } catch (error) {
        console.error('Failed to load boundary file:', error);
        infoEl.innerHTML = `<p class="hint" style="color:#dc3545">❌ 加载失败: ${error.message}</p>`;
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
    const polygon = extractPolygonFromGeoJSON(geojson);
    if (polygon && polygon.length >= 3) {
        currentPolygon = polygon;
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
    
    return `
        <div class="history-card" data-id="${record.id}" data-path="${record.file_path.replace(/"/g, '&quot;')}">
            <div class="history-card-header">
                <span class="history-card-title">${record.name}</span>
                <span class="history-card-status ${statusClass}">${statusIcon}</span>
            </div>
            <div class="history-card-meta">
                <span>${record.source_name}</span>
                <span>z${record.zoom}</span>
                <span>${record.tile_count} 瓦片</span>
                <span>${fileSize}</span>
            </div>
            <div class="history-card-path">${record.file_path}</div>
            <div class="history-card-meta">
                <span>${date}</span>
            </div>
            <div class="history-card-actions">
                <button class="btn btn-outline btn-sm btn-open-folder">打开文件夹</button>
                <button class="btn btn-outline btn-sm btn-delete-record">删除</button>
            </div>
        </div>
    `;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
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
        } else if (e.target.closest('.btn-delete-record')) {
            const id = card.dataset.id;
            if (!confirm('确定要删除这条记录吗？')) return;
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
    if (!confirm('确定要清空所有下载记录吗？\n此操作不会删除已下载的文件。')) return;
    
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
    
    const html = `
        <div class="task-card" data-task-id="${taskId}" data-status="pending">
            <div class="task-card-header">
                <span class="task-card-title">${name}</span>
                <span class="task-card-status">等待中</span>
            </div>
            <div class="task-card-meta">
                <span>${sourceName}</span>
                <span>z${zoom}</span>
                <span>${tileCount.toLocaleString()} 瓦片</span>
            </div>
            <div class="task-progress-bar">
                <div class="task-progress-fill" style="width: 0%"></div>
            </div>
            <div class="task-card-message">准备下载...</div>
            <div class="task-card-actions">
                <button class="btn btn-outline btn-sm btn-cancel-task">取消</button>
            </div>
        </div>
    `;
    listEl.insertAdjacentHTML('afterbegin', html);
}

async function startTaskListener(taskId) {
    if (!window.__TAURI__?.event) return;
    
    const unlisten = await window.__TAURI__.event.listen(`task-progress-${taskId}`, (e) => {
        updateTaskCard(e.payload);
    });
    activeTaskListeners[taskId] = unlisten;
}

function stopTaskListener(taskId) {
    if (activeTaskListeners[taskId]) {
        activeTaskListeners[taskId]();
        delete activeTaskListeners[taskId];
    }
}

const TASK_STATUS_TEXT = {
    'pending': '等待中',
    'downloading': '下载中',
    'merging': '拼接中',
    'exporting': '导出中',
    'completed': '已完成',
    'failed': '失败',
    'cancelled': '已取消'
};

function updateTaskCard(payload) {
    const { task_id, status, progress, completed, total, message } = payload;
    const card = document.querySelector(`.task-card[data-task-id="${task_id}"]`);
    if (!card) return;
    
    card.dataset.status = status;
    
    const fill = card.querySelector('.task-progress-fill');
    if (fill) fill.style.width = `${progress}%`;
    
    const msgEl = card.querySelector('.task-card-message');
    if (msgEl && message) msgEl.textContent = message;
    
    const statusEl = card.querySelector('.task-card-status');
    if (statusEl) statusEl.textContent = TASK_STATUS_TEXT[status] || status;
    
    // 完成/失败/取消时处理
    if (['completed', 'failed', 'cancelled'].includes(status)) {
        stopTaskListener(task_id);
        
        if (status === 'completed') {
            // 完成的任务 2 秒后自动移除
            setTimeout(() => {
                removeTaskCardFromUI(task_id);
                TifApi.removeTask(task_id);
            }, 2000);
            loadDownloadHistory();
        } else {
            // 失败/取消的任务显示移除按钮
            const actionsEl = card.querySelector('.task-card-actions');
            if (actionsEl) {
                actionsEl.innerHTML = '<button class="btn btn-outline btn-sm btn-remove-task">移除</button>';
            }
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
            </div>
            <div class="task-progress-bar">
                <div class="task-progress-fill" style="width: ${task.progress || 0}%"></div>
            </div>
            <div class="task-card-message">${task.message || ''}</div>
            <div class="task-card-actions">
                ${isActive
                    ? '<button class="btn btn-outline btn-sm btn-cancel-task">取消</button>'
                    : '<button class="btn btn-outline btn-sm btn-remove-task">移除</button>'
                }
            </div>
        </div>
    `;
}

function removeTaskCardFromUI(taskId) {
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
        
        if (e.target.closest('.btn-cancel-task')) {
            await TifApi.cancelTask(taskId);
        } else if (e.target.closest('.btn-remove-task')) {
            await TifApi.removeTask(taskId);
            card.remove();
            if (!listEl.querySelector('.task-card')) {
                listEl.innerHTML = '<div class="empty-state small"><p>暂无活动任务</p></div>';
            }
        }
    });
}
