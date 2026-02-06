(function() {
    // Check Tauri environment properly
    const checkTauri = () => {
        return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
    };

    // Tauri invoke
    const invoke = async (cmd, args = {}) => {
        if (!checkTauri()) throw new Error('Tauri not available');
        return await window.__TAURI__.core.invoke(cmd, args);
    };

    // API functions with proper fallback
    async function getTileSources(tiandituToken = null) {
        if (checkTauri()) {
            return await invoke('get_tile_sources', { tiandituToken });
        }
        const url = tiandituToken ? `/api/sources?tianditu_token=${encodeURIComponent(tiandituToken)}` : '/api/sources';
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to fetch sources');
        return res.json();
    }

    async function estimateDownload(bounds, zoom) {
        if (checkTauri()) {
            return await invoke('estimate_download', { bounds, zoom });
        }
        const res = await fetch('/api/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bounds, zoom })
        });
        if (!res.ok) throw new Error('Failed to estimate');
        return res.json();
    }

    async function downloadTiles(request, onProgress) {
        if (checkTauri()) {
            let unlisten = null;
            if (onProgress && window.__TAURI__.event) {
                unlisten = await window.__TAURI__.event.listen('download-progress', e => onProgress(e.payload));
            }
            try {
                // Tauri 模式: request 必须包含 save_path
                const result = await invoke('download_tiles', { request });
                return result; // { success, file_path, file_size, tile_count, failed_count }
            } finally {
                if (unlisten) unlisten();
            }
        }
        // HTTP fallback
        const res = await fetch('/api/download_with_progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Failed');
        const { task_id } = await res.json();
        return new Promise((resolve, reject) => {
            const es = new EventSource(`/api/download_progress/${task_id}`);
            es.onmessage = e => {
                const d = JSON.parse(e.data);
                if (onProgress) onProgress(d);
                if (d.status === 'completed') { es.close(); resolve({ taskId: task_id }); }
                else if (d.status === 'failed') { es.close(); reject(new Error(d.error)); }
            };
            es.onerror = () => { es.close(); reject(new Error('SSE failed')); };
        });
    }

    // ============ 任务 API ============
    async function createDownloadTask(request, taskName, sourceName) {
        if (checkTauri()) {
            return await invoke('create_download_task', { request, taskName, sourceName });
        }
        throw new Error('多任务下载仅支持桌面版');
    }

    async function getActiveTasks() {
        if (checkTauri()) return await invoke('get_active_tasks');
        return [];
    }

    async function cancelTask(taskId) {
        if (checkTauri()) return await invoke('cancel_task', { taskId });
        return false;
    }

    async function removeTask(taskId) {
        if (checkTauri()) return await invoke('remove_task', { taskId });
    }

    async function createOsmDownloadTask(bounds, featureType, savePath, proxy, polygon, taskName) {
        if (checkTauri()) {
            return await invoke('create_osm_download_task', {
                bounds, featureType, savePath,
                proxy: proxy || null,
                polygon: polygon || null,
                taskName
            });
        }
        throw new Error('多任务下载仅支持桌面版');
    }

    async function getProvinces() {
        if (checkTauri()) return await invoke('get_provinces');
        const res = await fetch('/api/admin/provinces');
        if (!res.ok) throw new Error('Failed');
        return res.json();
    }

    async function getCities(provinceCode) {
        if (checkTauri()) return await invoke('get_cities', { provinceCode });
        const res = await fetch(`/api/admin/cities?province_code=${provinceCode}`);
        if (!res.ok) throw new Error('Failed');
        return res.json();
    }

    async function getDistricts(cityCode) {
        if (checkTauri()) return await invoke('get_districts', { cityCode });
        const res = await fetch(`/api/admin/districts?city_code=${cityCode}`);
        if (!res.ok) throw new Error('Failed');
        return res.json();
    }

    async function getAdminBoundary(code, toWgs84 = true) {
        if (checkTauri()) return await invoke('get_admin_boundary', { code, toWgs84 });
        const res = await fetch(`/api/admin/boundary?code=${code}&to_wgs84=${toWgs84}`);
        if (!res.ok) throw new Error('Failed');
        return res.json();
    }

    async function geocodeSearch(query) {
        if (checkTauri()) return await invoke('geocode_search', { query });
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('Failed');
        return res.json();
    }

    async function showSaveDialog(filename, filters) {
        if (checkTauri() && window.__TAURI__.dialog) {
            return await window.__TAURI__.dialog.save({
                defaultPath: filename,
                filters: filters || [{ name: 'All', extensions: ['*'] }]
            });
        }
        return null;
    }

    function triggerBrowserDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ============ 历史记录 API ============
    async function getDownloadHistory() {
        if (checkTauri()) return await invoke('get_download_history');
        return [];
    }

    async function addDownloadRecord(name, source, sourceName, zoom, format, filePath, fileSize, tileCount, failedCount, success) {
        if (checkTauri()) {
            return await invoke('add_download_record', {
                name, source, sourceName, zoom, format, filePath, fileSize, tileCount, failedCount, success
            });
        }
        return null;
    }

    async function deleteDownloadRecord(id) {
        if (checkTauri()) return await invoke('delete_download_record', { id });
    }

    async function clearDownloadHistory() {
        if (checkTauri()) return await invoke('clear_download_history');
    }

    async function openFileLocation(filePath) {
        if (checkTauri()) return await invoke('open_file_location', { filePath });
    }

    async function openFile(filePath) {
        if (checkTauri()) return await invoke('open_file', { filePath });
    }

    // ============ 设置 API ============
    async function getSettings() {
        if (checkTauri()) return await invoke('get_settings');
        return {
            tianditu_token: null,
            proxy_enabled: true,
            proxy_url: 'http://127.0.0.1:10808',
            default_concurrency: 30,
            default_zoom: 15,
            default_format: 'geotiff',
            default_source: 'osm'
        };
    }

    async function saveSettings(settings) {
        if (checkTauri()) return await invoke('save_settings', { settings });
    }

    // ============ 矢量数据 API ============
    async function downloadOsmData(bounds, featureType, savePath, proxy, polygon) {
        if (checkTauri()) {
            return await invoke('download_osm_data', {
                bounds,
                featureType,
                savePath,
                proxy: proxy || null,
                polygon: polygon || null
            });
        }
        throw new Error('OSM 下载仅支持桌面版');
    }

    async function downloadAdminBoundaryFile(code, savePath) {
        if (checkTauri()) {
            return await invoke('download_admin_boundary_file', {
                code,
                savePath
            });
        }
        throw new Error('边界下载仅支持桌面版');
    }

    window.TifApi = {
        _checkIsTauri: checkTauri,
        isDesktopApp: checkTauri,
        getTileSources,
        estimateDownload,
        downloadTiles,
        getProvinces,
        getCities,
        getDistricts,
        getAdminBoundary,
        geocodeSearch,
        showSaveDialog,
        triggerBrowserDownload,
        // 历史记录
        getDownloadHistory,
        addDownloadRecord,
        deleteDownloadRecord,
        clearDownloadHistory,
        openFileLocation,
        openFile,
        // 设置
        getSettings,
        saveSettings,
        // 矢量数据
        downloadOsmData,
        downloadAdminBoundaryFile,
        // 任务管理
        createDownloadTask,
        createOsmDownloadTask,
        getActiveTasks,
        cancelTask,
        removeTask
    };

    console.log('[TifApi] Initialized, Tauri available:', checkTauri());
})();
