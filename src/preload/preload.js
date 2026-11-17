const { contextBridge, ipcRenderer } = require('electron');

// Everything the renderer is allowed to touch. No direct Node / process access
// from renderer code — it only ever calls these, which go through main.
contextBridge.exposeInMainWorld('api', {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, v) => cb(v)),

    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
    pickFolder: (current) => ipcRenderer.invoke('folder:pick', current),
    openFolder: (dir) => ipcRenderer.invoke('folder:open', dir),
    openLink: (url) => ipcRenderer.invoke('link:open', url),

    toolStatus: () => ipcRenderer.invoke('tools:status'),
    loadPlaylist: (url, browser) => ipcRenderer.invoke('playlist:load', { url, browser }),
    startDownload: (items, options) => ipcRenderer.invoke('download:start', { items, options }),
    cancelDownload: () => ipcRenderer.invoke('download:cancel'),
    onDownloadEvent: (cb) => {
        const h = (_e, ev) => cb(ev);
        ipcRenderer.on('download:event', h);
        return () => ipcRenderer.removeListener('download:event', h);
    },
});
