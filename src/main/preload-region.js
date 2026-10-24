const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("snapforge", {
  regionSelected: (region) => ipcRenderer.invoke("region-selected", region),
  regionRecordStart: (region) =>
    ipcRenderer.invoke("region-record-start", region),
  regionCancelled: () => ipcRenderer.invoke("region-cancelled"),
  onRegionContext: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("region-context", handler);
    return () => ipcRenderer.removeListener("region-context", handler);
  },
});
