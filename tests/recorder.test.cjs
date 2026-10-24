const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs");
function load() {
  const states = [],
    toasts = [],
    elements = {};
  const element = () => ({
    style: {},
    hidden: true,
    disabled: false,
    checked: false,
    value: "",
    classList: { toggle() {} },
    addEventListener() {},
    querySelector() {
      return null;
    },
  });
  for (const id of [
    "save-error",
    "save-recovery",
    "retry-save",
    "retry-save-elsewhere",
    "recording-status",
    "opt-webcam",
  ])
    elements[id] = element();
  elements["opt-system-audio"] = { checked: false };
  elements["opt-mic-audio"] = { checked: false };
  elements["opt-resolution"] = { value: "source" };
  elements["opt-framerate"] = { value: "30" };
  const window = {
    snapforge: {
      updateRecordingState: async (...args) => states.push(args.at(-1)),
      hideCountdown: async () => {},
      showCountdown: async () => {
        throw Error("countdown failure");
      },
      openFile: async () => {},
      openFolder: async () => {},
    },
    soundEngine: undefined,
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
    },
    navigator: { mediaDevices: {} },
    App: {
      showToast: (...args) => toasts.push(args),
      showToastWithAction: () => {},
    },
    console,
    Date,
    Blob,
    Uint8Array,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(
    fs.readFileSync(
      require.resolve("../src/renderer/js/capture-runtime"),
      "utf8",
    ),
    context,
  );
  vm.runInContext(
    fs
      .readFileSync(require.resolve("../src/renderer/js/recorder"), "utf8")
      .replace(
        "window.recorder = new Recorder();",
        "globalThis.Recorder=Recorder;",
      ),
    context,
  );
  const recorder = Object.create(context.Recorder.prototype);
  Object.assign(recorder, {
    state: "idle",
    selectedSourceId: "screen:1",
    btnRecord: element(),
    btnRecordLabel: element(),
    btnPause: element(),
    btnPauseLabel: element(),
    recIndicator: element(),
    previewVideo: {},
    previewEl: element(),
    recordRegion: null,
    isRecording: false,
    isPaused: false,
  });
  recorder.cleanupStreams = () => {
    recorder.cleaned = (recorder.cleaned || 0) + 1;
  };
  return { context, window, recorder, states, toasts, elements };
}
test("countdown failure always unlocks Record and closes capture preparation", async () => {
  const { recorder, states } = load();
  await recorder.startRecordingWithCountdown();
  assert.equal(recorder.isStarting, false);
  assert.equal(recorder.state, "idle");
  assert.ok(recorder.cleaned);
  assert.deepEqual(states, ["preparing", "idle"]);
});
test("failed canvas setup cleans the acquired capture stream and propagates a retryable error", async () => {
  const { recorder, context } = load();
  let stopped = false;
  context.navigator.mediaDevices.getUserMedia = async () => ({
    getTracks: () => [{ stop: () => (stopped = true) }],
  });
  recorder.stopMicPreview = () => {};
  recorder.setupCompositeCanvas = async () => {
    throw Error("canvas failure");
  };
  recorder.cleanupStreams = () =>
    recorder.screenStream?.getTracks().forEach((track) => track.stop());
  await assert.rejects(recorder.startRecording(), /canvas/);
  assert.equal(stopped, true);
});
test("Saving and Failed states prevent a second recording and old cleanup cannot stop a new session", async () => {
  const { recorder } = load();
  let started = false,
    finish;
  recorder.startRecordingWithCountdown = async () => {
    started = true;
  };
  recorder.state = "saving";
  recorder.writer = {
    finish: () => new Promise((resolve) => (finish = resolve)),
  };
  const saving = recorder.onRecordingStop(recorder.writer);
  await recorder.toggleRecording();
  assert.equal(started, false);
  finish("/fixture.webm");
  await saving;
  assert.equal(recorder.state, "idle");
  assert.equal(recorder.writer, null);
  recorder.state = "failed";
  await recorder.toggleRecording();
  assert.equal(started, false);
});
test("failed finalization keeps buffered writer and exposes retry instead of claiming success", async () => {
  const { recorder, elements } = load();
  const writer = {
    overflow: false,
    finish: async () => {
      throw Error("disk full");
    },
  };
  recorder.writer = writer;
  await recorder.onRecordingStop(writer);
  assert.equal(recorder.state, "failed");
  assert.equal(recorder.writer, writer);
  assert.equal(elements["save-recovery"].hidden, false);
  assert.match(elements["save-error"].textContent, /disk full/);
});

test("resuming manually during disk backpressure keeps capture and timer paused", async () => {
  const { recorder } = load();
  recorder.isRecording = true;
  recorder.isPaused = true;
  recorder._bufferPaused = true;
  recorder.mediaRecorder = {
    state: "paused",
    resume() {
      throw Error("must stay paused");
    },
  };
  recorder.startTimer = () => {
    throw Error("must not count paused time");
  };
  recorder.togglePause();
  assert.equal(recorder.isPaused, false);
  assert.equal(recorder.state, "paused");
});

test("permission timeout releases a device stream that arrives late", async () => {
  const { context, window } = load();
  let release,
    stopped = false;
  context.navigator.mediaDevices.getUserMedia = () =>
    new Promise((resolve) => (release = resolve));
  const pending = window.CaptureRuntime.getMedia({}, () => true, 5);
  await assert.rejects(pending, /timed out/);
  release({
    getTracks: () => [
      {
        stop() {
          stopped = true;
        },
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, true);
});
