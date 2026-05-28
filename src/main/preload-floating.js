const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapforge', {
  // Send actions back to main window
  floatingAction: (action) => ipcRenderer.invoke('floating-action', action),

  // #20: Receive updates with cleanup support
  onTimerUpdate: (callback) => {
    const handler = (_, time) => callback(time);
    ipcRenderer.on('floating-timer-update', handler);
    return () => ipcRenderer.removeListener('floating-timer-update', handler);
  },
  onPauseStateChange: (callback) => {
    const handler = (_, paused) => callback(paused);
    ipcRenderer.on('floating-pause-state', handler);
    return () => ipcRenderer.removeListener('floating-pause-state', handler);
  }
});
