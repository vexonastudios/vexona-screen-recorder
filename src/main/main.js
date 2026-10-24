const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  dialog,
  screen,
  shell,
  protocol,
  session,
  powerMonitor,
  powerSaveBlocker,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("node:crypto");
const { CaptureStore } = require("./capture-store");
const { assertSender, protectWindow } = require("./ipc-security");
const { mediaProtocol } = require("./media-protocol");
const { autoUpdater } = require("electron-updater");

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
let saveDirRecordings = path.join(
  os.homedir(),
  "Videos",
  "Vexona Screen Recorder",
);
let saveDirScreenshots = path.join(
  os.homedir(),
  "Pictures",
  "Vexona Screen Recorder",
);

// Persist directory settings
const settingsFile = path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (settings.saveDirRecordings)
        saveDirRecordings = settings.saveDirRecordings;
      if (settings.saveDirScreenshots)
        saveDirScreenshots = settings.saveDirScreenshots;
    }
  } catch (e) {
    /* use defaults */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        saveDirRecordings,
        saveDirScreenshots,
      }),
    );
  } catch (e) {
    /* ignore */
  }
}

// Ensure directories exist
function ensureDirs() {
  [saveDirRecordings, saveDirScreenshots].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Privileged operations are available only to their exact packaged window/frame.
const rendererPath = (...parts) =>
  path.join(__dirname, "..", "renderer", ...parts);
const store = new CaptureStore({
  journalDir: path.join(app.getPath("userData"), "recording-recovery"),
  getRoots: () => ({
    recordings: saveDirRecordings,
    screenshots: saveDirScreenshots,
  }),
});
const media = mediaProtocol(store);
let activeRegionKey = null;
let recordingState = "idle",
  recordingDisplay = null,
  powerBlocker = null,
  playerFile = null;
let exitPending = null,
  exitResolver = null,
  exitToken = null,
  pendingUpdate = null;
protocol.registerSchemesAsPrivileged([
  {
    scheme: "vexona-media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    let owner = mainWindow,
      file = rendererPath("index.html");
    if (
      ["region-selected", "region-record-start", "region-cancelled"].includes(
        channel,
      )
    ) {
      owner = regionWindow;
      file = rendererPath("pages", "capture.html");
    }
    if (channel === "floating-action") {
      owner = floatingWindow;
      file = rendererPath("pages", "floating-controls.html");
    }
    if (channel === "show-in-folder") {
      owner = playerWindow;
      file = rendererPath("pages", "player.html");
    }
    assertSender(event, owner, file);
    return callback(event, ...args);
  });
}
function safeWindow(options) {
  return protectWindow(
    new BrowserWindow({
      ...options,
      webPreferences: {
        ...options.webPreferences,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    }),
  );
}
function busy() {
  return (
    ["preparing", "recording", "paused", "saving"].includes(recordingState) ||
    store.sessions.size > 0
  );
}
async function requestExit(action = "quit") {
  if (exitPending) return exitPending;
  exitPending = (async () => {
    if (busy()) {
      mainWindow?.show();
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: "Save recording first",
        message: "Finish and save the current recording before closing?",
        buttons: ["Save and close", "Keep recording"],
        defaultId: 1,
        cancelId: 1,
      });
      if (result.response !== 0) return false;
      const saved = await new Promise((resolve) => {
        exitToken = randomUUID();
        exitResolver = resolve;
        const timer = setTimeout(() => {
          if (exitResolver === done) {
            exitResolver = null;
            resolve(false);
          }
        }, 30000);
        const done = (value) => {
          clearTimeout(timer);
          exitResolver = null;
          resolve(value);
        };
        exitResolver = done;
        mainWindow.webContents.send("finish-before-exit", { token: exitToken });
      });
      if (!saved) {
        await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "Recording still needs attention",
          message:
            "Closing was cancelled. Finish saving or recover the recording before trying again.",
          buttons: ["Keep open"],
        });
        return false;
      }
    }
    app.isQuitting = true;
    if (action === "update") autoUpdater.quitAndInstall();
    else app.quit();
    return true;
  })().finally(() => {
    exitPending = null;
  });
  return exitPending;
}
async function offerUpdate() {
  if (!pendingUpdate || busy() || exitPending) return;
  pendingUpdate = null;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Update ready",
    message:
      "A new Screen Recorder version is ready. Your recording has finished saving.",
    buttons: ["Restart", "Later"],
    defaultId: 1,
    cancelId: 1,
  });
  if (result.response === 0) await requestExit("update");
}
function selectedDisplay(id) {
  return (
    screen.getAllDisplays().find((d) => String(d.id) === String(id)) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  );
}
let regionDisplay = null;
function checkedRegion(region) {
  if (
    !regionDisplay ||
    !region ||
    ![region.x, region.y, region.width, region.height].every(Number.isFinite)
  )
    throw Error("Invalid capture region.");
  const b = regionDisplay.bounds,
    x = Math.max(0, Math.round(region.x)),
    y = Math.max(0, Math.round(region.y));
  const width = Math.min(Math.round(region.width), b.width - x),
    height = Math.min(Math.round(region.height), b.height - y);
  if (width < 20 || height < 20 || x >= b.width || y >= b.height)
    throw Error("Choose a region inside the selected screen.");
  return {
    x,
    y,
    width,
    height,
    displayId: String(regionDisplay.id),
    bounds: b,
  };
}

function createMainWindow() {
  let windowBounds = { width: 1280, height: 850 };
  const boundsFile = path.join(app.getPath("userData"), "window-bounds.json");
  try {
    if (fs.existsSync(boundsFile)) {
      windowBounds = JSON.parse(fs.readFileSync(boundsFile, "utf8"));
    }
  } catch (e) {
    /* use defaults */
  }

  mainWindow = safeWindow({
    ...windowBounds,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: "#0a0a0f",
    // Use .ico on Windows (required for taskbar/Alt+Tab), fall back to .png
    icon: fs.existsSync(path.join(__dirname, "..", "assets", "icon.ico"))
      ? path.join(__dirname, "..", "assets", "icon.ico")
      : path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
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
      } catch (e) {
        /* ignore */
      }
    }, 500);
  };
  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.on("render-process-gone", async () => {
    recordingState = "failed";
    isRecording = false;
    stopCursorPolling();
    destroyFloatingControls();
    destroyRegionOverlay();
    for (const id of [...store.sessions.keys()])
      await store.preserve(id).catch(() => {});
    if (powerBlocker !== null) {
      powerSaveBlocker.stop(powerBlocker);
      powerBlocker = null;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Region selection window
function createRegionWindow(displayId) {
  if (regionWindow) return;
  regionDisplay = selectedDisplay(displayId);
  const { x, y, width, height } = regionDisplay.bounds;
  regionWindow = safeWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: { preload: path.join(__dirname, "preload-region.js") },
  });
  regionWindow.webContents.once("did-finish-load", () =>
    regionWindow?.webContents.send("region-context", {
      purpose: regionPurpose,
      displayId: String(regionDisplay.id),
      bounds: regionDisplay.bounds,
    }),
  );
  regionWindow.loadFile(rendererPath("pages", "capture.html"));
  regionWindow.on("closed", () => {
    regionWindow = null;
  });
}

// System Tray
function createTray() {
  // Prefer .ico > .png > .svg for tray (Windows needs raster format)
  const icoPath = path.join(__dirname, "..", "assets", "tray-icon.ico");
  const pngPath = path.join(__dirname, "..", "assets", "tray-icon.png");
  const svgPath = path.join(__dirname, "..", "assets", "tray-icon.svg");

  let trayImg;
  if (fs.existsSync(pngPath)) {
    trayImg = nativeImage
      .createFromPath(pngPath)
      .resize({ width: 20, height: 20 });
  } else if (fs.existsSync(svgPath)) {
    trayImg = nativeImage
      .createFromPath(svgPath)
      .resize({ width: 20, height: 20 });
  } else {
    trayImg = nativeImage.createFromDataURL(createTrayIconDataURL());
  }
  tray = new Tray(trayImg);
  tray.setToolTip("Vexona Screen Recorder");
  updateTrayMenu();
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function createTrayIconDataURL() {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAArVJREFUWEftlk1IVFEUx3/nzYyOH+M4fqQmampqaphaaFJhUIlFUdBCqE0QEUURLYKW0aJFi4I2QYugTUFQEBFBRUREJJGVWfmRaWqm4+g4Ojrz5kTnMm/GeeO8GYegC4d3z73n/O7/nHvuvYL/XIQ/q4jFE/LRhDIQCuZSSilj8Xm9ZhCR/z6AMCGZSrJWBFggCJbS0kKB2D+A0CRASsBNwEcgHVgtpcyVUmrJoiSAUEDQ6kV6PJAPGbNUSTdwpQbABbyPPPsL8NLs34CHfTMPvOifxrWnAM3Aa8ABKTUAqyh/TJKNkFIlJB9Iy/Kf0oFmOQ7cpLEUABsBt4CPJZSV2kPlRKJy8Y+kbAmZcjsGRB5FRMZKh5QPxMbOBjwBnAFeK5yb/D7bzzNQ29z0NNTUBe3AK7Zi/lHwEPhwEggF3DmFl4C7S3VnQdPJ8BFmY8/G4bkMKF3vVV+X4bdBjkOgHxBLpVSHgUOA9cAd4BSoGdXfGlIJkY/z1j4ND3Mz91ecn/7oc4xLXyimzkVLyKRCkVEJ5ApgNlQjISeKRzwNeAb4Bz0opLxFZRGJN/lbLl2dDGR67sJDqCKdyT5CxJUAx9z5e2xdNQ3dT0JOcV3K1m3HBVQIyUKj/bqFULyq2Rq7HcqcJ9+n+1R0uiSuQqUF/h9E43eN5DX0PQhdwQfRnOcGC/fS78/rjjP07TtC03HLuHFJ9X9fYuHy/2PjVi5VjCdwBXi2tL91jMa+5bXaW/c3R2pqGziehpwq7FJH+o4K7Q8qD46MDoyMjI2Nj5BNCm4cAAvA76xWb3T/oM6T3m/P7B3VXxpbGTkDFB0ZK52LJF2lAG7heAlsCxSGrFKSl0LSr+yqNxYkokAicBZ4EmKKfxD8BPYL0UojDI+Ev3cRsR/+FfeH7G7yKYT7KnAAAAAElFTkSuQmCC";
}

// Red pulsing icon for recording state
function createRecordingTrayIcon() {
  // 16x16 red circle PNG (base64)
  const size = { width: 16, height: 16 };
  const img = nativeImage.createEmpty();
  // Build a simple red icon programmatically using a canvas-like approach
  // We'll create it from a data URL of a red circle
  const redIconDataURL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhklEQVQ4T2NkoBAwUqifYdQABgb//zOwMDIyMjIwMjIyMjJCGIyMjAwMDAwMDKMGDHoD/v8HMhgYgQwGBgYGmAEMDAwMjCMNGDUAagBUAzMDAwMDAxsbGwMbGxsbAzs7OxsbGzs7OxsDOzs7GwM7OzsbAzs7OxsDOzs7GwM7OzsbgxoAAP7IBhCTlKO8AAAAAElFTkSuQmCC";
  return nativeImage.createFromDataURL(redIconDataURL).resize({ width: 16 });
}

function updateTrayMenu() {
  if (!tray) return;
  // Swap icon: red during recording, normal otherwise
  let icon;
  if (isRecording) {
    icon = createRecordingTrayIcon();
  } else {
    const pngPath = path.join(__dirname, "..", "assets", "tray-icon.png");
    const svgPath = path.join(__dirname, "..", "assets", "tray-icon.svg");
    if (fs.existsSync(pngPath)) {
      icon = nativeImage
        .createFromPath(pngPath)
        .resize({ width: 16, height: 16 });
    } else if (fs.existsSync(svgPath)) {
      icon = nativeImage
        .createFromPath(svgPath)
        .resize({ width: 16, height: 16 });
    } else {
      icon = nativeImage
        .createFromDataURL(createTrayIconDataURL())
        .resize({ width: 16 });
    }
  }
  tray.setImage(icon);

  const appIconPath = path.join(__dirname, "..", "assets", "icon.svg");
  const menuHeaderIcon = fs.existsSync(appIconPath)
    ? nativeImage.createFromPath(appIconPath).resize({ width: 16, height: 16 })
    : nativeImage
        .createFromDataURL(createTrayIconDataURL())
        .resize({ width: 16 });

  const contextMenu = Menu.buildFromTemplate([
    { label: "Vexona Screen Recorder", enabled: false, icon: menuHeaderIcon },
    { type: "separator" },
    {
      label: "📸 Screenshot (Full Screen)",
      click: () => takeScreenshot("fullscreen"),
    },
    { label: "📐 Screenshot (Region)", click: () => takeScreenshot("region") },
    { type: "separator" },
    {
      label: isRecording ? "⏹ Stop Recording" : "🔴 Start Recording",
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send("toggle-recording");
          mainWindow.show();
        }
      },
    },
    { type: "separator" },
    {
      label: "Open Vexona Screen Recorder",
      click: () => {
        if (mainWindow) mainWindow.show();
      },
    },
    {
      label: "Open Captures Folder",
      click: () => shell.openPath(saveDirRecordings),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        requestExit("quit");
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

// Screenshot
async function takeScreenshot(mode) {
  ensureDirs();
  if (mode === "region") {
    createRegionWindow();
    return;
  }

  const display = selectedDisplay();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id));
  if (source) {
    const filePath = await store.screenshot(source.thumbnail.toDataURL());
    mainWindow?.webContents.send("screenshot-saved", { filePath, mode });
    mainWindow?.show();
  }
}

// Global hotkeys
function registerHotkeys() {
  globalShortcut.register("PrintScreen", () => takeScreenshot("fullscreen"));
  globalShortcut.register("CommandOrControl+Shift+S", () =>
    takeScreenshot("region"),
  );
  globalShortcut.register("CommandOrControl+Shift+R", () => {
    if (mainWindow) mainWindow.webContents.send("toggle-recording");
  });
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    if (mainWindow) mainWindow.webContents.send("toggle-pause");
  });
}

// ─── Cursor position polling for recording overlay (#4) ───
// Cursor tracking state for velocity-based click detection
let lastCursorPos = null;
let cursorVelocityHistory = [];
let cursorStillFrames = 0;
const CLICK_VELOCITY_THRESHOLD = 2; // pixels per poll — "stopped"
const CLICK_MOVING_THRESHOLD = 40; // pixels per poll — must have been moving fast (deliberate)
const CLICK_STILL_FRAMES_NEEDED = 3; // consecutive still frames to trigger
const CLICK_COOLDOWN = 4000; // 4s cooldown — prevent constant triggering
let lastClickTime = 0;

function startCursorPolling() {
  stopCursorPolling();
  lastCursorPos = null;
  cursorVelocityHistory = [];
  cursorStillFrames = 0;

  cursorPollInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const display = recordingDisplay || screen.getPrimaryDisplay();
    const relX = (point.x - display.bounds.x) / display.bounds.width;
    const relY = (point.y - display.bounds.y) / display.bounds.height;

    // Send position update
    mainWindow.webContents.send("cursor-position", {
      relX,
      relY,
      screenX: point.x,
      screenY: point.y,
    });

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
      const histSlice =
        cursorVelocityHistory.length > 2
          ? cursorVelocityHistory.slice(0, -2)
          : [];
      const recentMax = histSlice.length > 0 ? Math.max(...histSlice) : 0;
      const wasMoving = recentMax > CLICK_MOVING_THRESHOLD;

      if (velocity < CLICK_VELOCITY_THRESHOLD) {
        cursorStillFrames++;
      } else {
        cursorStillFrames = 0;
      }

      // Trigger "click" when: cursor was moving → now stopped for 2 frames
      const now = Date.now();
      if (
        wasMoving &&
        cursorStillFrames >= CLICK_STILL_FRAMES_NEEDED &&
        now - lastClickTime > CLICK_COOLDOWN
      ) {
        lastClickTime = now;
        mainWindow.webContents.send("cursor-click", { relX, relY });
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

handle("get-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    display_id: s.display_id,
    bounds:
      screen.getAllDisplays().find((d) => String(d.id) === s.display_id)
        ?.bounds || null,
  }));
});

// Acknowledged bounded chunks are synced to disk; no full recording crosses IPC.
handle("recording-begin", (_event, name) => store.begin(name));
handle("recording-append", (_event, id, sequence, data) =>
  store.append(id, sequence, data),
);
handle("recording-finish", (_event, id) => store.finish(id));
handle("recording-preserve", (_event, id) => store.preserve(id));
handle("recording-recoveries", () => store.recoveries());
handle("recording-relocate", async (_event, id) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Save recording to another folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return false;
  return store.relocate(id, result.filePaths[0]);
});
handle("recording-recover", async (_event, id, elsewhere) => {
  let destination;
  if (elsewhere) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Save recovered recording to",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    destination = result.filePaths[0];
  }
  return store.recover(id, destination);
});
handle("recording-exit-complete", (_event, token, saved) => {
  if (token === exitToken && exitResolver) exitResolver(saved === true);
});
handle("show-in-folder", () => {
  if (playerFile) shell.showItemInFolder(playerFile);
});
handle("save-screenshot", async (_event, { dataURL, fileName }) => {
  if (fileName !== undefined)
    throw Error("Screenshot filenames are generated by the app.");
  return store.screenshot(dataURL);
});

handle("get-version", () => app.getVersion());
handle("get-save-dirs", () => {
  return { recordings: saveDirRecordings, screenshots: saveDirScreenshots };
});

// Settings: choose directory (#1)
handle("choose-directory", async (event, { type }) => {
  if (!["recordings", "screenshots"].includes(type) || busy())
    throw Error("Finish saving before changing capture folders.");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Choose ${type === "recordings" ? "Recordings" : "Screenshots"} Folder`,
    defaultPath: type === "recordings" ? saveDirRecordings : saveDirScreenshots,
    properties: ["openDirectory", "createDirectory"],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const newDir = result.filePaths[0];
    if (type === "recordings") {
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

handle("get-captures", async () => {
  ensureDirs();
  const captures = [];

  if (fs.existsSync(saveDirRecordings)) {
    const files = fs
      .readdirSync(saveDirRecordings)
      .filter((f) => f.endsWith(".webm"));
    files.forEach((f) => {
      const fullPath = path.join(saveDirRecordings, f);
      const stat = fs.lstatSync(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      captures.push({
        name: f,
        path: fullPath,
        type: "recording",
        size: stat.size,
        created: stat.birthtime.toISOString(),
      });
    });
  }

  if (fs.existsSync(saveDirScreenshots)) {
    const files = fs
      .readdirSync(saveDirScreenshots)
      .filter((f) => f.endsWith(".png") || f.endsWith(".jpg"));
    files.forEach((f) => {
      const fullPath = path.join(saveDirScreenshots, f);
      const stat = fs.lstatSync(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      captures.push({
        name: f,
        path: fullPath,
        type: "screenshot",
        size: stat.size,
        created: stat.birthtime.toISOString(),
      });
    });
  }

  return Promise.all(
    captures
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .map(async (capture) => ({
        ...capture,
        mediaURL: await media.urlFor(capture.path),
      })),
  );
});

handle("open-file", async (_event, filePath) => {
  const file = await store.validFile(filePath);
  if (file.endsWith(".webm")) await openPlayerWindow(file);
  else await shell.openPath(file);
});
handle("open-folder", async (_event, filePath) =>
  shell.showItemInFolder(await store.validFile(filePath)),
);
handle("open-directory", async (_event, dirPath) => {
  if (
    !Object.values(store.getRoots()).some(
      (root) => path.resolve(root) === path.resolve(dirPath),
    )
  )
    throw Error("Invalid capture directory.");
  return shell.openPath(dirPath);
});
handle("delete-file", async (_event, filePath) => {
  await shell.trashItem(await store.validFile(filePath));
  return true;
});

handle(
  "update-recording-state",
  (event, { recording, paused, region, displayId, state }) => {
    if (
      ![
        "idle",
        "preparing",
        "recording",
        "paused",
        "saving",
        "failed",
      ].includes(state) ||
      typeof recording !== "boolean" ||
      typeof paused !== "boolean"
    )
      throw Error("Invalid recording state.");
    const display =
      recording || state === "preparing"
        ? selectedDisplay(region?.displayId || displayId)
        : recordingDisplay;
    if (recording && region) {
      const b = display.bounds;
      if (
        ![region.x, region.y, region.width, region.height].every(
          Number.isFinite,
        ) ||
        region.x < 0 ||
        region.y < 0 ||
        region.width < 20 ||
        region.height < 20 ||
        region.x + region.width > b.width ||
        region.y + region.height > b.height
      )
        throw Error("Capture region no longer fits the selected display.");
      region = {
        x: Math.round(region.x),
        y: Math.round(region.y),
        width: Math.round(region.width),
        height: Math.round(region.height),
        displayId: String(display.id),
        bounds: { ...b },
      };
    }
    recordingState = state;
    recordingDisplay = display;
    if (
      ["preparing", "recording", "paused", "saving"].includes(state) &&
      powerBlocker === null
    )
      powerBlocker = powerSaveBlocker.start("prevent-app-suspension");
    if (["idle", "failed"].includes(state) && powerBlocker !== null) {
      powerSaveBlocker.stop(powerBlocker);
      powerBlocker = null;
    }
    if (state === "idle")
      setTimeout(() => offerUpdate().catch(console.error), 0);
    isRecording = recording;
    isPaused = paused;
    updateTrayMenu();
    if (tray) {
      tray.setToolTip(
        isRecording
          ? isPaused
            ? "Vexona Screen Recorder — Paused"
            : "Vexona Screen Recorder — Recording..."
          : "Vexona Screen Recorder",
      );
    }

    // Manage floating controls window
    if (recording && !floatingWindow) {
      createFloatingControls();
    } else if (!recording && floatingWindow) {
      destroyFloatingControls();
    }
    if (floatingWindow) {
      floatingWindow.webContents.send("floating-pause-state", paused);
    }

    // Manage region overlay window
    if (recording && region) {
      const key = JSON.stringify(region);
      if (key !== activeRegionKey) {
        createRegionOverlay(region);
        activeRegionKey = key;
      }
    } else if (!recording) {
      activeRegionKey = null;
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
  },
);

handle("update-floating-timer", (event, time) => {
  if (floatingWindow) {
    floatingWindow.webContents.send("floating-timer-update", time);
  }
});

handle("floating-action", (event, action) => {
  if (mainWindow) {
    if (action === "stop") mainWindow.webContents.send("toggle-recording");
    else if (action === "pause") mainWindow.webContents.send("toggle-pause");
  }
});

// Window control handlers
handle("window-restore", () => mainWindow?.show());
handle("window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});
handle("window-maximize", () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});
handle("window-close", () => {
  if (mainWindow) mainWindow.close();
});
handle("window-is-maximized", () =>
  mainWindow ? mainWindow.isMaximized() : false,
);
handle("window-resize-by", (event, widthDiff, heightDiff) => {
  if (mainWindow && !mainWindow.isMaximized()) {
    if (
      !Number.isFinite(widthDiff) ||
      !Number.isFinite(heightDiff) ||
      Math.abs(widthDiff) > 200 ||
      Math.abs(heightDiff) > 200
    )
      throw Error("Invalid resize.");
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width + widthDiff,
      height: bounds.height + heightDiff,
    });
  }
});

// Floating countdown overlay
handle("show-countdown", () => {
  createCountdownWindow();
});
handle("countdown-tick", (event, num) => {
  if (countdownWindow && !countdownWindow.isDestroyed()) {
    countdownWindow.webContents.send("countdown-tick", num);
  }
});
handle("hide-countdown", () => {
  destroyCountdownWindow();
});

// #8: Region selection IPC — with purpose tracking to avoid dual handlers
let regionPurpose = "screenshot"; // 'screenshot' or 'recording'
handle("open-region-selector", (_event, { purpose, displayId } = {}) => {
  if (busy()) throw Error("Finish the recording first.");
  if (!["screenshot", "recording"].includes(purpose))
    throw Error("Invalid region purpose.");
  regionPurpose = purpose;
  mainWindow?.minimize();
  createRegionWindow(displayId);
});
function completeRegion(region, start) {
  const checked = checkedRegion(region),
    purpose = regionPurpose;
  regionWindow?.close();
  regionWindow = null;
  if (purpose === "recording") mainWindow?.show();
  mainWindow?.webContents.send("region-capture", {
    ...checked,
    purpose,
    start: start && purpose === "recording",
  });
}
handle("region-selected", (_event, region) => completeRegion(region, false));
handle("region-record-start", (_event, region) => completeRegion(region, true));
handle("region-cancelled", () => {
  regionWindow?.close();
  regionWindow = null;
  mainWindow?.show();
});

// Floating recording controls — invisible to screen capture
function createFloatingControls() {
  const primaryDisplay = recordingDisplay || screen.getPrimaryDisplay();
  const {
    x: screenX,
    y: screenY,
    width: screenW,
    height: screenH,
  } = primaryDisplay.workArea;

  floatingWindow = safeWindow({
    width: 280,
    height: 52,
    x: screenX + screenW - 300,
    y: screenY + screenH - 72,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-floating.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  floatingWindow.loadFile(
    path.join(__dirname, "..", "renderer", "pages", "floating-controls.html"),
  );
  floatingWindow.setContentProtection(true);
  floatingWindow.setIgnoreMouseEvents(false);
  floatingWindow.on("closed", () => {
    floatingWindow = null;
  });
}

// Region overlay — shows recording boundary on screen, invisible to capture
function createRegionOverlay(region) {
  destroyRegionOverlay();

  // Add padding for the label above and border width
  const padding = 30;
  const borderW = 4;
  const overlayX = (region.bounds?.x || 0) + region.x - borderW;
  const overlayY = (region.bounds?.y || 0) + region.y - padding;
  const overlayW = region.width + borderW * 2;
  const overlayH = region.height + padding + borderW;

  regionOverlayWindow = safeWindow({
    x: overlayX,
    y: overlayY,
    width: overlayW,
    height: overlayH,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-region-overlay.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  regionOverlayWindow.loadFile(
    path.join(__dirname, "..", "renderer", "pages", "region-overlay.html"),
  );
  regionOverlayWindow.setContentProtection(true);
  regionOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  regionOverlayWindow.on("closed", () => {
    regionOverlayWindow = null;
  });

  // Send region info once the page is ready
  regionOverlayWindow.webContents.on("did-finish-load", () => {
    regionOverlayWindow.webContents.send("region-overlay-info", {
      width: region.width,
      height: region.height,
    });
  });
}

function destroyRegionOverlay() {
  if (regionOverlayWindow) {
    regionOverlayWindow.close();
    regionOverlayWindow = null;
  }
}

function destroyFloatingControls() {
  if (floatingWindow) {
    floatingWindow.close();
    floatingWindow = null;
  }
}

// Built-in video player for WebM (Windows doesn't support VP9)
async function openPlayerWindow(filePath) {
  playerFile = await store.validFile(filePath);
  const playback = {
    url: await media.urlFor(playerFile),
    name: path.basename(playerFile),
  };
  // Close existing player if open
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.close();
  }

  playerWindow = safeWindow({
    width: 960,
    height: 600,
    minWidth: 480,
    minHeight: 360,
    frame: false,
    transparent: false,
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: path.join(__dirname, "preload-player.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  playerWindow.loadFile(
    path.join(__dirname, "..", "renderer", "pages", "player.html"),
  );
  playerWindow.on("closed", () => {
    playerWindow = null;
  });

  // Send the file path once the page is ready
  playerWindow.webContents.on("did-finish-load", () => {
    if (playerWindow && !playerWindow.isDestroyed()) {
      playerWindow.webContents.send("play-file", playback);
    }
  });
}

// Countdown overlay — centered on screen, content-protected
function createCountdownWindow() {
  destroyCountdownWindow();
  const primaryDisplay = recordingDisplay || selectedDisplay();
  const { x: dx, y: dy, width: sw, height: sh } = primaryDisplay.bounds;
  const size = 180;

  countdownWindow = safeWindow({
    width: size,
    height: size,
    x: dx + Math.round((sw - size) / 2),
    y: dy + Math.round((sh - size) / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-countdown.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  countdownWindow.loadFile(
    path.join(__dirname, "..", "renderer", "pages", "countdown.html"),
  );
  countdownWindow.setContentProtection(true);
  countdownWindow.setIgnoreMouseEvents(true, { forward: true });
  countdownWindow.on("closed", () => {
    countdownWindow = null;
  });
}

function destroyCountdownWindow() {
  if (countdownWindow) {
    countdownWindow.close();
    countdownWindow = null;
  }
}

// Auto-updater events
autoUpdater.on("update-available", (info) => {
  console.log("Update available.", info);
});
autoUpdater.on("update-downloaded", (info) => {
  pendingUpdate = info;
  offerUpdate().catch(console.error);
});
autoUpdater.on("error", (err) => {
  console.error("Error in auto-updater.", err);
});

// App lifecycle
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  mainWindow?.show();
  mainWindow?.focus();
});
app
  .whenReady()
  .then(async () => {
    await store.initialize();
    protocol.handle("vexona-media", (request) => media.handle(request));
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback) =>
        callback(
          contents === mainWindow?.webContents &&
            ["media", "display-capture"].includes(permission),
        ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission) =>
        contents === mainWindow?.webContents &&
        ["media", "display-capture"].includes(permission),
    );
    powerMonitor.on("suspend", () =>
      mainWindow?.webContents.send("finish-before-exit", { reason: "suspend" }),
    );
    loadSettings();
    try {
      ensureDirs();
    } catch (error) {
      saveDirRecordings = path.join(
        os.homedir(),
        "Videos",
        "Vexona Screen Recorder",
      );
      saveDirScreenshots = path.join(
        os.homedir(),
        "Pictures",
        "Vexona Screen Recorder",
      );
      ensureDirs();
      await dialog.showMessageBox({
        type: "warning",
        title: "Capture folder unavailable",
        message:
          "The saved capture folder is unavailable. Local default folders will be used. Reconnect the original drive to recover interrupted recordings.",
      });
    }
    createMainWindow();
    createTray();
    registerHotkeys();

    // Check for updates
    try {
      if (app.isPackaged)
        autoUpdater.checkForUpdatesAndNotify().catch(console.error);
    } catch (e) {
      console.error("Auto-updater error on startup:", e);
    }
  })
  .catch((error) => {
    console.error("Startup failed:", error);
    dialog.showErrorBox(
      "Screen Recorder could not start",
      "Check that your local folders are available and writable, then restart. Existing recordings and recovery files have been kept.",
    );
    app.exit(1);
  });

app.on("window-all-closed", () => {
  /* keep tray alive */
});
app.on("activate", () => {
  if (!mainWindow) createMainWindow();
});
app.on("before-quit", (event) => {
  if (!app.isQuitting) {
    event.preventDefault();
    requestExit("quit").catch(console.error);
    return;
  }
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  stopCursorPolling();
  destroyRegionOverlay();
  destroyFloatingControls();
  destroyCountdownWindow();
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  dialog.showErrorBox(
    "Screen Recorder stopped unexpectedly",
    "Restart the app and check recovery for data already written to disk.",
  );
  app.exit(1);
});
