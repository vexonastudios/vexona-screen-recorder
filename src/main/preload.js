const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snapforge", {
  getVersion: () => ipcRenderer.invoke("get-version"),
  // Screen sources
  getSources: () => ipcRenderer.invoke("get-sources"),

  beginRecording: (name) => ipcRenderer.invoke("recording-begin", name),
  appendRecording: (id, sequence, data) =>
    ipcRenderer.invoke("recording-append", id, sequence, data),
  finishRecording: (id) => ipcRenderer.invoke("recording-finish", id),
  preserveRecording: (id) => ipcRenderer.invoke("recording-preserve", id),
  relocateRecording: (id) => ipcRenderer.invoke("recording-relocate", id),
  getRecoveries: () => ipcRenderer.invoke("recording-recoveries"),
  recoverRecording: (id, elsewhere = false) =>
    ipcRenderer.invoke("recording-recover", id, elsewhere),
  exitComplete: (token, saved) =>
    ipcRenderer.invoke("recording-exit-complete", token, saved),
  onFinishBeforeExit: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("finish-before-exit", handler);
    return () => ipcRenderer.removeListener("finish-before-exit", handler);
  },
  updateRecordingState: (recording, paused, region, displayId, state) =>
    ipcRenderer.invoke("update-recording-state", {
      recording,
      paused,
      region: region || null,
      displayId,
      state: state || (recording ? "recording" : "idle"),
    }),
  updateFloatingTimer: (time) =>
    ipcRenderer.invoke("update-floating-timer", time),

  // Floating countdown
  showCountdown: () => ipcRenderer.invoke("show-countdown"),
  countdownTick: (num) => ipcRenderer.invoke("countdown-tick", num),
  hideCountdown: () => ipcRenderer.invoke("hide-countdown"),

  // Screenshots
  saveScreenshot: (dataURL) =>
    ipcRenderer.invoke("save-screenshot", { dataURL }),

  // File management
  getSaveDirs: () => ipcRenderer.invoke("get-save-dirs"),
  getCaptures: () => ipcRenderer.invoke("get-captures"),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  openFolder: (filePath) => ipcRenderer.invoke("open-folder", filePath),
  openDirectory: (dirPath) => ipcRenderer.invoke("open-directory", dirPath),
  deleteFile: (filePath) => ipcRenderer.invoke("delete-file", filePath),

  // Settings (#1)
  chooseDirectory: (type) => ipcRenderer.invoke("choose-directory", { type }),

  // Window controls
  restore: () => ipcRenderer.invoke("window-restore"),
  minimize: () => ipcRenderer.invoke("window-minimize"),
  maximize: () => ipcRenderer.invoke("window-maximize"),
  close: () => ipcRenderer.invoke("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  resizeBy: (widthDiff, heightDiff) =>
    ipcRenderer.invoke("window-resize-by", widthDiff, heightDiff),

  // Region selection
  openRegionSelector: (opts) =>
    ipcRenderer.invoke("open-region-selector", opts || {}),
  regionSelected: (region) => ipcRenderer.invoke("region-selected", region),
  regionRecordStart: (region) =>
    ipcRenderer.invoke("region-record-start", region),
  regionCancelled: () => ipcRenderer.invoke("region-cancelled"),

  // Events from main process â€” with cleanup functions
  onToggleRecording: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("toggle-recording", handler);
    return () => ipcRenderer.removeListener("toggle-recording", handler);
  },
  onTogglePause: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("toggle-pause", handler);
    return () => ipcRenderer.removeListener("toggle-pause", handler);
  },
  onScreenshotSaved: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("screenshot-saved", handler);
    return () => ipcRenderer.removeListener("screenshot-saved", handler);
  },
  onRegionCapture: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("region-capture", handler);
    return () => ipcRenderer.removeListener("region-capture", handler);
  },
  // System cursor position for composite canvas (#4)
  onCursorPosition: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("cursor-position", handler);
    return () => ipcRenderer.removeListener("cursor-position", handler);
  },
  // System cursor click (velocity-based detection)
  onCursorClick: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("cursor-click", handler);
    return () => ipcRenderer.removeListener("cursor-click", handler);
  },
});
