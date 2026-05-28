const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapforge', {
  onRegionInfo: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on('region-overlay-info', handler);
    return () => ipcRenderer.removeListener('region-overlay-info', handler);
  }
});
