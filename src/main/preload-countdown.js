const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapforge', {
  onCountdownTick: (callback) => {
    const handler = (_, num) => callback(num);
    ipcRenderer.on('countdown-tick', handler);
    return () => ipcRenderer.removeListener('countdown-tick', handler);
  }
});
