const { contextBridge, ipcRenderer } = require('electron');

let _filePath = null;

contextBridge.exposeInMainWorld('snapforge', {
  onPlayFile: (callback) => {
    ipcRenderer.on('play-file', (_, filePath) => {
      _filePath = filePath;
      callback(filePath);
    });
  },
  showInFolder: () => {
    if (_filePath) ipcRenderer.invoke('show-in-folder', _filePath);
  }
});
