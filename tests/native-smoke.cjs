// Native Electron regression test. Generated media only; no user desktop, camera or microphone.
// The recorder window is shown without focus and truly minimized to test capture cadence.
const electron = require("electron"),
  { app, BrowserWindow, ipcMain, protocol } = electron;
const fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  vm = require("node:vm"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events"),
  { createRequire } = require("node:module");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vexona-native-test-"));
app.setPath("userData", temporary);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const windows = [],
  fakeApp = new EventEmitter();
fakeApp.getPath = () => temporary;
fakeApp.getVersion = () => requireApp("./../../package.json").version;
fakeApp.whenReady = () => ({
  then() {
    return { catch() {} };
  },
});
fakeApp.requestSingleInstanceLock = () => true;
fakeApp.exit = () => {};
let quit = false,
  installed = false;
fakeApp.quit = () => {
  quit = true;
};
const updater = new EventEmitter();
updater.quitAndInstall = () => {
  installed = true;
};
const display = {
  id: 1,
  bounds: { x: -640, y: 0, width: 640, height: 360 },
  size: { width: 640, height: 360 },
  workArea: { x: -640, y: 0, width: 640, height: 360 },
  scaleFactor: 1,
};
function TestWindow(options) {
  const win = new BrowserWindow({
    ...options,
    show: false,
    webPreferences: { ...options.webPreferences },
  });
  win.show = () => {};
  windows.push(win);
  return win;
}
const appRoot =
  process.env.VEXONA_TEST_APP_ROOT || path.resolve(__dirname, "..");
const requireApp = createRequire(path.join(appRoot, "src/main/main.js"));

const thumbnail = electron.nativeImage.createFromBitmap(
  Buffer.alloc(320 * 180 * 4, 120),
  { width: 320, height: 180 },
);
const fakeElectron = {
  ...electron,
  app: fakeApp,
  BrowserWindow: TestWindow,
  globalShortcut: { register() {}, unregisterAll() {} },
  screen: {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: -600, y: 30 }),
  },
  desktopCapturer: {
    getSources: async () => [
      {
        id: "screen:synthetic:0",
        display_id: "1",
        name: "Synthetic test display",
        thumbnail,
      },
    ],
  },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showOpenDialog: async () => ({ canceled: true }),
  },
};
const context = vm.createContext({
  require: (id) =>
    id === "electron"
      ? fakeElectron
      : id === "electron-updater"
        ? { autoUpdater: updater }
        : id === "os"
          ? { homedir: () => temporary }
          : requireApp(id),
  __dirname: path.join(appRoot, "src/main"),
  Buffer,
  URL,
  Response,
  console,
  process: { on() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});
vm.runInContext(
  fs.readFileSync(path.join(appRoot, "src/main/main.js"), "utf8"),
  context,
);
const timeout = setTimeout(() => {
  console.error("Native test timed out.");
  app.exit(1);
}, 45000);
(async () => {
  await app.whenReady();
  await vm.runInContext("store.initialize()", context);
  vm.runInContext(
    'ensureDirs();protocol.handle("vexona-media",request=>media.handle(request));createMainWindow();',
    context,
  );
  const win = windows[0],
    errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.message?.startsWith("Native test:")) console.log(event.message);
    if (event.level === "error") errors.push(event.message);
  });
  await new Promise((resolve, reject) => {
    win.webContents.once("did-finish-load", resolve);
    win.webContents.once("did-fail-load", (_e, code, description) =>
      reject(Error(code + " " + description)),
    );
  });
  win.showInactive();
  await win.webContents.executeJavaScript(
    `(async()=>{
  if(!window.snapforge||!window.recorder)throw Error('Sandboxed preload or app failed to initialize.');
  window.__nativeGetMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const originalAdd = RecordingWriter.prototype.add;
  RecordingWriter.prototype.add = function(blob) {
    const index = this.__chunkNumber = (this.__chunkNumber || 0) + 1;
    blob.slice(0,16).arrayBuffer().then(buffer => console.log('Native test: chunk '+JSON.stringify({ index, bytes:blob.size, type:blob.type, header:Array.from(new Uint8Array(buffer)).map(b=>b.toString(16).padStart(2,'0')).join('') })));
    return originalAdd.call(this, blob);
  };
  document.getElementById('opt-system-audio').checked=false;document.getElementById('opt-mic-audio').checked=false;
  window.__synthetic=document.createElement('canvas');__synthetic.width=640;__synthetic.height=360;window.__drawCount=0;
  window.__drawTimer=setInterval(()=>{const ctx=__synthetic.getContext('2d');ctx.fillStyle=__drawCount%2?'#1c6b44':'#f4e7ca';ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.font='40px sans-serif';ctx.fillText('Frame '+(++__drawCount),50,100);},33);
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>__synthetic.captureStream(30)});
  recorder.selectedSourceId='screen:synthetic:0';recorder.selectedDisplayId='1';recorder.sourceBounds={x:-640,y:0,width:640,height:360};
  recorder.recordRegion={x:100,y:40,width:320,height:180,displayId:'1',bounds:recorder.sourceBounds};
  await screenshotManager.captureWindowSource('screen:synthetic:0', recorder.recordRegion);
  if(!screenshotManager.lastCapture)throw Error('Synthetic region screenshot failed');
  window.__shot=await snapforge.saveScreenshot(screenshotManager.lastCapture);
  await recorder.setState('preparing');await recorder.startRecording();
 })()`,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const running = await win.webContents.executeJavaScript(
    `(async()=>{const deadline=Date.now()+12000;while(recorder.state==='recording'&&recorder.writer.bytes<1000&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));return {state:recorder.state,bytes:recorder.writer?.bytes||0,frames:__drawCount,queued:recorder.writer?.queuedBytes||0,background:document.visibilityState};})()`,
  );
  console.log("Native test: running " + JSON.stringify(running));
  assert.equal(running.state, "recording");
  assert.equal(
    win.isMinimized(),
    true,
    "The real native capture window did not minimize.",
  );
  assert.ok(running.bytes > 1000, JSON.stringify(running));
  assert.ok(running.frames > 15, JSON.stringify(running));
  assert.ok(running.queued < 32 * 1024 * 1024);
  updater.emit("update-downloaded", { version: "fixture" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(installed, false, "An update installed during recording.");
  console.log("Native test: stopping first take");
  await win.webContents.executeJavaScript(
    `(async()=>{recorder.stopRecording();await recorder._savePromise;clearInterval(__drawTimer);})()`,
  );
  console.log("Native test: first take stopped");
  const saved = await win.webContents.executeJavaScript(
    `(async()=>({state:recorder.state,writerCleared:recorder.writer===null,captures:await snapforge.getCaptures()}))()`,
  );
  assert.equal(saved.state, "idle");
  assert.equal(saved.writerCleared, true);
  assert.equal(saved.captures.length, 2);
  const shot = saved.captures.find((capture) => capture.type === "screenshot");
  const png = fs.readFileSync(shot.path);
  assert.equal(png.readUInt32BE(16), 320);
  assert.equal(png.readUInt32BE(20), 180);
  const capture = saved.captures.find(
    (capture) => capture.type === "recording",
  );
  assert.ok(fs.statSync(capture.path).size > 1000);
  assert.ok(
    fs
      .readFileSync(capture.path)
      .subarray(0, 4)
      .equals(Buffer.from("1a45dfa3", "hex")),
  );
  console.log("Native test: opening saved video");
  const playback = await win.webContents.executeJavaScript(
    `(async()=>{const video=document.createElement('video');video.muted=true;video.src=${JSON.stringify(capture.mediaURL)};document.body.appendChild(video);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Playback metadata timed out: '+video.readyState)),5000);video.onloadeddata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(Error('Playback failed'));};});await video.play();await new Promise(resolve=>setTimeout(resolve,600));const result={width:video.videoWidth,height:video.videoHeight,frames:video.getVideoPlaybackQuality().totalVideoFrames};video.pause();video.remove();return result;})()`,
    true,
  );
  assert.equal(playback.width, 320);
  assert.equal(playback.height, 180);
  assert.ok(playback.frames > 2, JSON.stringify(playback));
  console.log("Native test: first video played");
  await win.webContents.executeJavaScript(
    `(async()=>{
  document.getElementById('opt-system-audio').checked=true;
  window.__drawTimer=setInterval(()=>{const c=__synthetic.getContext('2d');c.fillStyle='#64bd86';c.fillRect(Date.now()%600,10,8,8);},33);
  console.log('Native test: creating synthetic audio');window.__audioContext=new AudioContext({sinkId:{type:'none'}});await __audioContext.resume();console.log('Native test: audio context running');const destination=__audioContext.createMediaStreamDestination(),oscillator=__audioContext.createOscillator();oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>new MediaStream([...__synthetic.captureStream(30).getVideoTracks(),...destination.stream.getAudioTracks()])});
  await recorder.setState('preparing');await recorder.startRecording();
 })()`,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 1600));
  console.log("Native test: saving audio before quit");
  await vm.runInContext("requestExit('quit')", context);
  assert.equal(quit, true, "Quit did not await the renderer save.");
  const audioTake = await win.webContents.executeJavaScript(
    `(async()=>{clearInterval(__drawTimer);await __audioContext.close();return (await snapforge.getCaptures())[0];})()`,
  );
  assert.ok(
    fs.readFileSync(audioTake.path).includes(Buffer.from("A_OPUS")),
    "Synthetic audio was not encoded.",
  );
  let osWindowCapture = null;
  if (process.platform === "win32") {
    // Capture only this generated test window by its exact native id. Never
    // enumerate or capture the user's screen, other windows, mic or camera.
    const fixture = new BrowserWindow({
      width: 640,
      height: 360,
      show: false,
      title: "Vexona generated capture fixture",
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    windows.push(fixture);
    await fixture.loadURL(
      "data:text/html," +
        encodeURIComponent(
          `<!doctype html><title>Vexona generated capture fixture</title><style>body{margin:0;display:grid;place-items:center;height:100vh;color:white;font:30px sans-serif}</style><h1>Generated capture test</h1><script>let n=0;setInterval(()=>{document.body.style.background=['#164c39','#79421c','#173868'][n++%3];document.querySelector('h1').textContent='Test frame '+n;},100);</script>`,
        ),
    );
    fixture.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const source = fixture.getMediaSourceId();
    assert.match(source, /^window:/);
    console.log(
      "Native test: recording the generated window through Windows capture",
    );
    await win.webContents.executeJavaScript(
      `(async()=>{
      document.getElementById('opt-system-audio').checked=false;
      Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:__nativeGetMedia});
      recorder.selectedSourceId=${JSON.stringify(source)};recorder.recordRegion=null;recorder.sourceBounds=null;
      await recorder.setState('preparing');await recorder.startRecording();
    })()`,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await win.webContents.executeJavaScript(
      `(async()=>{await recorder.stopRecording();})()`,
    );
    const take = await win.webContents.executeJavaScript(
      `(async()=>{if(recorder.state!=='idle')throw Error('OS capture did not save');return(await snapforge.getCaptures())[0];})()`,
    );
    const encoded = fs.readFileSync(take.path).toString("base64");
    osWindowCapture = await win.webContents.executeJavaScript(
      `(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'video/webm'}));
      const video=document.createElement('video');video.muted=true;video.src=url;document.body.appendChild(video);
      await CaptureRuntime.playVideo(video);
      const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const ctx=canvas.getContext('2d'),colors=new Set();
      const timer=setInterval(()=>{ctx.drawImage(video,video.videoWidth/4,video.videoHeight/2,1,1,0,0,1,1);colors.add(Array.from(ctx.getImageData(0,0,1,1).data).join(','));},40);
      await new Promise(resolve=>setTimeout(resolve,900));clearInterval(timer);
      const result={width:video.videoWidth,height:video.videoHeight,decodedFrames:video.getVideoPlaybackQuality().totalVideoFrames,distinctColors:colors.size};
      video.pause();video.remove();URL.revokeObjectURL(url);return result;
    })()`,
      true,
    );
    assert.ok(osWindowCapture.width > 100 && osWindowCapture.height > 100);
    assert.ok(
      osWindowCapture.decodedFrames > 3,
      JSON.stringify(osWindowCapture),
    );
    assert.ok(
      osWindowCapture.distinctColors >= 2,
      JSON.stringify(osWindowCapture),
    );
    fixture.destroy();
  }
  // A second native window with the same preload still cannot call the owner's IPC.
  const foreign = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(appRoot, "src/main/preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windows.push(foreign);
  await foreign.loadFile(path.join(appRoot, "src/renderer/index.html"));
  const denied = await foreign.webContents.executeJavaScript(
    `snapforge.beginRecording('forbidden').then(()=>false,()=>true)`,
  );
  assert.equal(denied, true);
  await fsp.mkdir(path.resolve(__dirname, "../test-output"), {
    recursive: true,
  });
  win.restore();
  win.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const image = await win.webContents.capturePage();
  await fsp.writeFile(
    path.resolve(__dirname, "../test-output/recorder-native.png"),
    image.toPNG(),
  );
  const report = {
    platform: process.platform,
    electron: process.versions.electron,
    syntheticOnly: true,
    realWindowMinimized: true,
    osWindowCapture,
    running,
    playback,
    forgedWindowDenied: denied,
    regionScreenshotSaved: true,
    recordingSaved: true,
    audioEncoded: true,
    quitAwaitedSave: quit,
    packaged: appRoot.endsWith(".asar"),
    errors,
  };
  fs.writeFileSync(
    path.resolve(
      __dirname,
      "../test-output/native-smoke-" + process.platform + ".json",
    ),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  clearTimeout(timeout);
  for (const w of windows) if (!w.isDestroyed()) w.destroy();
  await vm.runInContext("stopCursorPolling()", context);
  app.exit(0);
})().catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  for (const w of windows) if (!w.isDestroyed()) w.destroy();
  app.exit(1);
});
