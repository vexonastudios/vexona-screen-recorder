const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, Tray, Menu, nativeImage, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

// Keep references to prevent garbage collection
let mainWindow = null;
let regionWindow = null;
let regionOverlayWindow = null;
let countdownWindow = null;
let playerWindow = null;
let floatingWindow = null;
let tray = null;
let isRecording = false;
let isPaused = false;
let cursorPollInterval = null;

// Save directories (mutable — user can change via settings #1)
let saveDirRecordings = path.join(os.homedir(), 'Videos', 'Vexona Screen Recorder');
let saveDirScreenshots = path.join(os.homedir(), 'Pictures', 'Vexona Screen Recorder');

// Persist directory settings
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (settings.saveDirRecordings) saveDirRecordings = settings.saveDirRecordings;
      if (settings.saveDirScreenshots) saveDirScreenshots = settings.saveDirScreenshots;
    }
  } catch (e) { /* use defaults */ }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      saveDirRecordings,
      saveDirScreenshots
    }));
  } catch (e) { /* ignore */ }
}

// Ensure directories exist
function ensureDirs() {
  [saveDirRecordings, saveDirScreenshots].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Validate that a file path is within our managed directories (security)
function isPathAllowed(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(path.resolve(saveDirRecordings)) ||
         resolved.startsWith(path.resolve(saveDirScreenshots));
}

function createMainWindow() {
  let windowBounds = { width: 1280, height: 850 };
  const boundsFile = path.join(app.getPath('userData'), 'window-bounds.json');
  try {
    if (fs.existsSync(boundsFile)) {
      windowBounds = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
    }
  } catch (e) { /* use defaults */ }

  mainWindow = new BrowserWindow({
    ...windowBounds,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0a0f',
    // Use .ico on Windows (required for taskbar/Alt+Tab), fall back to .png
    icon: fs.existsSync(path.join(__dirname, '..', 'assets', 'icon.ico'))
      ? path.join(__dirname, '..', 'assets', 'icon.ico')
      : path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // #14: Debounce saveBounds to avoid sync I/O spam during drag/resize
  let saveBoundsTimer = null;
  const saveBounds = () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const bounds = mainWindow.getBounds();
        fs.writeFileSync(boundsFile, JSON.stringify(bounds));
      } catch (e) { /* ignore */ }
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Region selection window
function createRegionWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;

  regionWindow = new BrowserWindow({
    x: 0, y: 0, width, height,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  regionWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'capture.html'));
  regionWindow.setIgnoreMouseEvents(false);
  regionWindow.on('closed', () => { regionWindow = null; });
}

// System Tray
function createTray() {
  // Prefer .ico > .png > .svg for tray (Windows needs raster format)
  const icoPath = path.join(__dirname, '..', 'assets', 'tray-icon.ico');
  const pngPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  const svgPath = path.join(__dirname, '..', 'assets', 'tray-icon.svg');

  let trayImg;
  if (fs.existsSync(pngPath)) {
    trayImg = nativeImage.createFromPath(pngPath).resize({ width: 20, height: 20 });
  } else if (fs.existsSync(svgPath)) {
    trayImg = nativeImage.createFromPath(svgPath).resize({ width: 20, height: 20 });
  } else {
    trayImg = nativeImage.createFromDataURL(createTrayIconDataURL());
  }
  tray = new Tray(trayImg);
  tray.setToolTip('Vexona Screen Recorder');
  updateTrayMenu();
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function createTrayIconDataURL() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAArVJREFUWEftlk1IVFEUx3/nzYyOH+M4fqQmampqaphaaFJhUIlFUdBCqE0QEUURLYKW0aJFi4I2QYugTUFQEBFBRUREJJGVWfmRaWqm4+g4Ojrz5kTnMm/GeeO8GYegC4d3z73n/O7/nHvuvYL/XIQ/q4jFE/LRhDIQCuZSSilj8Xm9ZhCR/z6AMCGZSrJWBFggCJbS0kKB2D+A0CRASsBNwEcgHVgtpcyVUmrJoiSAUEDQ6kV6PJAPGbNUSTdwpQbABbyPPPsL8NLs34CHfTMPvOifxrWnAM3Aa8ABKTUAqyh/TJKNkFIlJB9Iy/Kf0oFmOQ7cpLEUABsBt4CPJZSV2kPlRKJy8Y+kbAmZcjsGRB5FRMZKh5QPxMbOBjwBnAFeK5yb/D7bzzNQ29z0NNTUBe3AK7Zi/lHwEPhwEggF3DmFl4C7S3VnQdPJ8BFmY8/G4bkMKF3vVV+X4bdBjkOgHxBLpVSHgUOA9cAd4BSoGdXfGlIJkY/z1j4ND3Mz91ecn/7oc4xLXyimzkVLyKRCkVEJ5ApgNlQjISeKRzwNeAb4Bz0opLxFZRGJN/lbLl2dDGR67sJDqCKdyT5CxJUAx9z5e2xdNQ3dT0JOcV3K1m3HBVQIyUKj/bqFULyq2Rq7HcqcJ9+n+1R0uiSuQqUF/h9E43eN5DX0PQhdwQfRnOcGC/fS78/rjjP07TtC03HLuHFJ9X9fYuHy/2PjVi5VjCdwBXi2tL91jMa+5bXaW/c3R2pqGziehpwq7FJH+o4K7Q8qD46MDoyMjI2Nj5BNCm4cAAvA76xWb3T/oM6T3m/P7B3VXxpbGTkDFB0ZK52LJF2lAG7heAlsCxSGrFKSl0LSr+yqNxYkokAicBZ4EmKKfxD8BPYL0UojDI+Ev3cRsR/+FfeH7G7yKYT7KnAAAAAElFTkSuQmCC';
}

// Red pulsing icon for recording state
function createRecordingTrayIcon() {
  // 16x16 red circle PNG (base64)
  const size = { width: 16, height: 16 };
  const img = nativeImage.createEmpty();
  // Build a simple red icon programmatically using a canvas-like approach
  // We'll create it from a data URL of a red circle
  const redIconDataURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhklEQVQ4T2NkoBAwUqifYdQABgb//zOwMDIyMjIwMjIyMjJCGIyMjAwMDAwMDKMGDHoD/v8HMhgYgQwGBgYGmAEMDAwMjCMNGDUAagBUAzMDAwMDAxsbGwMbGxsbAzs7OxsbGzs7OxsDOzs7GwM7OzsbAzs7OxsDOzs7GwM7OzsbgxoAAP7IBhCTlKO8AAAAAElFTkSuQmCC';
  return nativeImage.createFromDataURL(redIconDataURL).resize({ width: 16 });
}


function updateTrayMenu() {
  if (!tray) return;
  // Swap icon: red during recording, normal otherwise
  let icon;
  if (isRecording) {
    icon = createRecordingTrayIcon();
  } else {
    const pngPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    const svgPath = path.join(__dirname, '..', 'assets', 'tray-icon.svg');
    if (fs.existsSync(pngPath)) {
      icon = nativeImage.createFromPath(pngPath).resize({ width: 16, height: 16 });
    } else if (fs.existsSync(svgPath)) {
      icon = nativeImage.createFromPath(svgPath).resize({ width: 16, height: 16 });
    } else {
      icon = nativeImage.createFromDataURL(createTrayIconDataURL()).resize({ width: 16 });
    }
  }
  tray.setImage(icon);

  const appIconPath = path.join(__dirname, '..', 'assets', 'icon.svg');
  const menuHeaderIcon = fs.existsSync(appIconPath)
    ? nativeImage.createFromPath(appIconPath).resize({ width: 16, height: 16 })
    : nativeImage.createFromDataURL(createTrayIconDataURL()).resize({ width: 16 });

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Vexona Screen Recorder', enabled: false, icon: menuHeaderIcon },
    { type: 'separator' },
    { label: '📸 Screenshot (Full Screen)', click: () => takeScreenshot('fullscreen') },
    { label: '📐 Screenshot (Region)', click: () => takeScreenshot('region') },
    { type: 'separator' },
    {
      label: isRecording ? '⏹ Stop Recording' : '🔴 Start Recording',
      click: () => { if (mainWindow) { mainWindow.webContents.send('toggle-recording'); mainWindow.show(); } }
    },
    { type: 'separator' },
    { label: 'Open Vexona Screen Recorder', click: () => { if (mainWindow) mainWindow.show(); } },
    { label: 'Open Captures Folder', click: () => shell.openPath(saveDirRecordings) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

// Screenshot
async function takeScreenshot(mode) {
  ensureDirs();
  if (mode === 'region') { createRegionWindow(); return; }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: screen.getPrimaryDisplay().size
  });

  if (sources.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(saveDirScreenshots, `Vexona_${timestamp}.png`);
    fs.writeFileSync(filePath, sources[0].thumbnail.toPNG());
    if (mainWindow) {
      mainWindow.webContents.send('screenshot-saved', { filePath, mode });
      mainWindow.show();
    }
  }
}

// Global hotkeys
function registerHotkeys() {
  globalShortcut.register('PrintScreen', () => takeScreenshot('fullscreen'));
  globalShortcut.register('CommandOrControl+Shift+S', () => takeScreenshot('region'));
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (mainWindow) mainWindow.webContents.send('toggle-recording');
  });
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (mainWindow) mainWindow.webContents.send('toggle-pause');
  });
}

// ─── Cursor position polling for recording overlay (#4) ───
// Cursor tracking state for velocity-based click detection
let lastCursorPos = null;
let cursorVelocityHistory = [];
let cursorStillFrames = 0;
const CLICK_VELOCITY_THRESHOLD = 2;   // pixels per poll — "stopped"
const CLICK_MOVING_THRESHOLD = 40;    // pixels per poll — must have been moving fast (deliberate)
const CLICK_STILL_FRAMES_NEEDED = 3;  // consecutive still frames to trigger
const CLICK_COOLDOWN = 4000;          // 4s cooldown — prevent constant triggering
let lastClickTime = 0;

function startCursorPolling() {
  stopCursorPolling();
  lastCursorPos = null;
  cursorVelocityHistory = [];
  cursorStillFrames = 0;

  cursorPollInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const display = screen.getPrimaryDisplay();
    const relX = point.x / display.size.width;
    const relY = point.y / display.size.height;

    // Send position update
    mainWindow.webContents.send('cursor-position', { relX, relY, screenX: point.x, screenY: point.y });

    // Velocity-based click detection
    if (lastCursorPos) {
      const dx = point.x - lastCursorPos.x;
      const dy = point.y - lastCursorPos.y;
      const velocity = Math.sqrt(dx * dx + dy * dy);

      // Keep a rolling window of recent velocities (last ~10 frames = 330ms)
      cursorVelocityHistory.push(velocity);
      if (cursorVelocityHistory.length > 10) cursorVelocityHistory.shift();

      // Check: was the cursor moving recently?
      // #16: Guard against empty array (Math.max(...[]) = -Infinity)
      const histSlice = cursorVelocityHistory.length > 2 ? cursorVelocityHistory.slice(0, -2) : [];
      const recentMax = histSlice.length > 0 ? Math.max(...histSlice) : 0;
      const wasMoving = recentMax > CLICK_MOVING_THRESHOLD;

      if (velocity < CLICK_VELOCITY_THRESHOLD) {
        cursorStillFrames++;
      } else {
        cursorStillFrames = 0;
      }

      // Trigger "click" when: cursor was moving → now stopped for 2 frames
      const now = Date.now();
      if (wasMoving && cursorStillFrames >= CLICK_STILL_FRAMES_NEEDED && (now - lastClickTime) > CLICK_COOLDOWN) {
        lastClickTime = now;
        mainWindow.webContents.send('cursor-click', { relX, relY });
      }
    }

    lastCursorPos = { x: point.x, y: point.y };
  }, 33); // ~30fps
}

function stopCursorPolling() {
  if (cursorPollInterval) {
    clearInterval(cursorPollInterval);
    cursorPollInterval = null;
  }
  lastCursorPos = null;
  cursorVelocityHistory = [];
  cursorStillFrames = 0;
}

// ─── IPC Handlers ───

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    display_id: s.display_id
  }));
});

// Single-shot recording save — receives entire recording as Uint8Array
ipcMain.handle('save-recording-direct', (event, data, customName) => {
  ensureDirs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = customName && typeof customName === 'string'
    ? customName.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60)
    : null;
  const fileName = safeName ? `${safeName}_${timestamp}.webm` : `Vexona_${timestamp}.webm`;
  const filePath = path.join(saveDirRecordings, fileName);
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    fs.writeFileSync(filePath, buf);
    console.log(`Recording saved: ${filePath} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    return filePath;
  } catch (err) {
    console.error('Failed to save recording:', err);
    throw err;
  }
});

// Show file in folder (used by player window)
ipcMain.handle('show-in-folder', (event, filePath) => {
  if (filePath && typeof filePath === 'string') {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.handle('save-screenshot', async (event, { dataURL, fileName }) => {
  ensureDirs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = fileName || `Vexona_${timestamp}.png`;
  const filePath = path.join(saveDirScreenshots, name);
  const base64Data = dataURL.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  return filePath;
});

ipcMain.handle('get-save-dirs', () => {
  return { recordings: saveDirRecordings, screenshots: saveDirScreenshots };
});

// Settings: choose directory (#1)
ipcMain.handle('choose-directory', async (event, { type }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Choose ${type === 'recordings' ? 'Recordings' : 'Screenshots'} Folder`,
    defaultPath: type === 'recordings' ? saveDirRecordings : saveDirScreenshots,
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const newDir = result.filePaths[0];
    if (type === 'recordings') {
      saveDirRecordings = newDir;
    } else {
      saveDirScreenshots = newDir;
    }
    ensureDirs();
    saveSettings();
    return newDir;
  }
  return null;
});

ipcMain.handle('get-captures', async () => {
  ensureDirs();
  const captures = [];

  if (fs.existsSync(saveDirRecordings)) {
    const files = fs.readdirSync(saveDirRecordings).filter(f => f.endsWith('.webm'));
    files.forEach(f => {
      const fullPath = path.join(saveDirRecordings, f);
      const stat = fs.statSync(fullPath);
      captures.push({ name: f, path: fullPath, type: 'recording', size: stat.size, created: stat.birthtime.toISOString() });
    });
  }

  if (fs.existsSync(saveDirScreenshots)) {
    const files = fs.readdirSync(saveDirScreenshots).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
    files.forEach(f => {
      const fullPath = path.join(saveDirScreenshots, f);
      const stat = fs.statSync(fullPath);
      captures.push({ name: f, path: fullPath, type: 'screenshot', size: stat.size, created: stat.birthtime.toISOString() });
    });
  }

  return captures.sort((a, b) => new Date(b.created) - new Date(a.created));
});

// #1: open-file — use built-in player for WebM (Windows doesn't support VP9 natively)
ipcMain.handle('open-file', (event, filePath) => {
  if (!isPathAllowed(filePath)) return;
  if (filePath.endsWith('.webm')) {
    openPlayerWindow(filePath);
  } else {
    shell.openPath(filePath);
  }
});

ipcMain.handle('open-folder', (event, filePath) => {
  if (!isPathAllowed(filePath)) return;
  shell.showItemInFolder(filePath);
});

// #2: Added path validation to prevent arbitrary folder opening
ipcMain.handle('open-directory', (event, dirPath) => {
  const resolved = path.resolve(dirPath);
  if (resolved !== path.resolve(saveDirRecordings) && resolved !== path.resolve(saveDirScreenshots)) return;
  shell.openPath(dirPath);
});

ipcMain.handle('delete-file', (event, filePath) => {
  if (!isPathAllowed(filePath)) return false;
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('update-recording-state', (event, { recording, paused, region }) => {
  isRecording = recording;
  isPaused = paused;
  updateTrayMenu();
  if (tray) {
    tray.setToolTip(isRecording ? (isPaused ? 'Vexona Screen Recorder — Paused' : 'Vexona Screen Recorder — Recording...') : 'Vexona Screen Recorder');
  }

  // Manage floating controls window
  if (recording && !floatingWindow) {
    createFloatingControls();
  } else if (!recording && floatingWindow) {
    destroyFloatingControls();
  }
  if (floatingWindow) {
    floatingWindow.webContents.send('floating-pause-state', paused);
  }

  // Manage region overlay window
  if (recording && region) {
    createRegionOverlay(region);
  } else if (!recording) {
    destroyRegionOverlay();
  }

  // Auto-minimize main window when recording starts, restore when it stops
  if (recording && mainWindow && !paused) {
    mainWindow.minimize();
  } else if (!recording && mainWindow) {
    mainWindow.show();
  }

  // Cursor polling for composite canvas (#4)
  if (recording) {
    startCursorPolling();
  } else {
    stopCursorPolling();
  }
});

ipcMain.handle('update-floating-timer', (event, time) => {
  if (floatingWindow) {
    floatingWindow.webContents.send('floating-timer-update', time);
  }
});

ipcMain.handle('floating-action', (event, action) => {
  if (mainWindow) {
    if (action === 'stop') mainWindow.webContents.send('toggle-recording');
    else if (action === 'pause') mainWindow.webContents.send('toggle-pause');
  }
});

// Window control handlers
ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window-maximize', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);
ipcMain.handle('window-resize-by', (event, widthDiff, heightDiff) => {
  if (mainWindow && !mainWindow.isMaximized()) {
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width + widthDiff,
      height: bounds.height + heightDiff
    });
  }
});

// Floating countdown overlay
ipcMain.handle('show-countdown', () => {
  createCountdownWindow();
});
ipcMain.handle('countdown-tick', (event, num) => {
  if (countdownWindow && !countdownWindow.isDestroyed()) {
    countdownWindow.webContents.send('countdown-tick', num);
  }
});
ipcMain.handle('hide-countdown', () => {
  destroyCountdownWindow();
});

// #8: Region selection IPC — with purpose tracking to avoid dual handlers
let regionPurpose = 'screenshot'; // 'screenshot' or 'recording'
ipcMain.handle('open-region-selector', (event, { purpose } = {}) => {
  regionPurpose = purpose || 'screenshot';
  createRegionWindow();
});
ipcMain.handle('region-selected', (event, region) => {
  if (regionWindow) { regionWindow.close(); regionWindow = null; }
  if (mainWindow) mainWindow.webContents.send('region-capture', { ...region, purpose: regionPurpose });
});
// Direct "draw region → Record" flow: sets region AND starts recording in one step
ipcMain.handle('region-record-start', (event, region) => {
  if (regionWindow) { regionWindow.close(); regionWindow = null; }
  if (mainWindow) {
    mainWindow.webContents.send('region-capture', { ...region, purpose: 'recording' });
    // Small delay so the region-capture handler sets up state before we trigger recording
    setTimeout(() => {
      mainWindow.webContents.send('toggle-recording');
    }, 250);
  }
});
ipcMain.handle('region-cancelled', () => {
  if (regionWindow) { regionWindow.close(); regionWindow = null; }
  if (mainWindow) mainWindow.show();
});

// Floating recording controls — invisible to screen capture
function createFloatingControls() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  floatingWindow = new BrowserWindow({
    width: 280, height: 52,
    x: screenW - 300, y: screenH - 72,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-floating.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });

  floatingWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'floating-controls.html'));
  floatingWindow.setContentProtection(true);
  floatingWindow.setIgnoreMouseEvents(false);
  floatingWindow.on('closed', () => { floatingWindow = null; });
}

// Region overlay — shows recording boundary on screen, invisible to capture
function createRegionOverlay(region) {
  destroyRegionOverlay();

  // Add padding for the label above and border width
  const padding = 30;
  const borderW = 4;
  const overlayX = Math.max(0, region.x - borderW);
  const overlayY = Math.max(0, region.y - padding);
  const overlayW = region.width + borderW * 2;
  const overlayH = region.height + padding + borderW;

  regionOverlayWindow = new BrowserWindow({
    x: overlayX, y: overlayY,
    width: overlayW, height: overlayH,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-region-overlay.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });

  regionOverlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'region-overlay.html'));
  regionOverlayWindow.setContentProtection(true);
  regionOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  regionOverlayWindow.on('closed', () => { regionOverlayWindow = null; });

  // Send region info once the page is ready
  regionOverlayWindow.webContents.on('did-finish-load', () => {
    regionOverlayWindow.webContents.send('region-overlay-info', {
      width: region.width,
      height: region.height
    });
  });
}

function destroyRegionOverlay() {
  if (regionOverlayWindow) { regionOverlayWindow.close(); regionOverlayWindow = null; }
}

function destroyFloatingControls() {
  if (floatingWindow) { floatingWindow.close(); floatingWindow = null; }
}

// Built-in video player for WebM (Windows doesn't support VP9)
function openPlayerWindow(filePath) {
  // Close existing player if open
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.close();
  }

  playerWindow = new BrowserWindow({
    width: 960, height: 600,
    minWidth: 480, minHeight: 360,
    frame: false, transparent: false,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload-player.js'),
      contextIsolation: true, nodeIntegration: false,
      webSecurity: false  // Allow file:// protocol for local video playback
    }
  });

  playerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'player.html'));
  playerWindow.on('closed', () => { playerWindow = null; });

  // Send the file path once the page is ready
  playerWindow.webContents.on('did-finish-load', () => {
    if (playerWindow && !playerWindow.isDestroyed()) {
      playerWindow.webContents.send('play-file', filePath);
    }
  });
}

// Countdown overlay — centered on screen, content-protected
function createCountdownWindow() {
  destroyCountdownWindow();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.size;
  const size = 180;

  countdownWindow = new BrowserWindow({
    width: size, height: size,
    x: Math.round((sw - size) / 2),
    y: Math.round((sh - size) / 2),
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-countdown.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });

  countdownWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'countdown.html'));
  countdownWindow.setContentProtection(true);
  countdownWindow.setIgnoreMouseEvents(true, { forward: true });
  countdownWindow.on('closed', () => { countdownWindow = null; });
}

function destroyCountdownWindow() {
  if (countdownWindow) { countdownWindow.close(); countdownWindow = null; }
}

// Auto-updater events
autoUpdater.on('update-available', (info) => {
  console.log('Update available.', info);
});
autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded.', info);
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: 'A new version of Vexona Screen Recorder has been downloaded. Restart the application to apply the updates.',
    buttons: ['Restart', 'Later']
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});
autoUpdater.on('error', (err) => {
  console.error('Error in auto-updater.', err);
});

// App lifecycle
app.whenReady().then(() => {
  loadSettings();
  ensureDirs();
  createMainWindow();
  createTray();
  registerHotkeys();

  // Check for updates
  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    console.error('Auto-updater error on startup:', e);
  }
});

app.on('window-all-closed', () => { /* keep tray alive */ });
app.on('activate', () => { if (!mainWindow) createMainWindow(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  stopCursorPolling();
  destroyRegionOverlay();
  destroyFloatingControls();
  destroyCountdownWindow();
});

process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (error) => { console.error('Uncaught Exception:', error); });
