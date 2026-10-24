class ScreenshotManager {
  constructor() {
    this.lastCapture = null;
    this.busy = false;
    this.init();
  }
  init() {
    document
      .getElementById("btn-ss-fullscreen")
      .addEventListener("click", () => this.captureFullScreen());
    document
      .getElementById("btn-ss-region")
      .addEventListener("click", () => this.captureRegion());
    const delayed = document.getElementById("btn-ss-delayed");
    delayed.addEventListener("click", () => this.captureDelayed());
    delayed.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.captureDelayed();
      }
    });
    document
      .getElementById("btn-ss-window")
      .addEventListener("click", () => this.captureWindow());
    document
      .getElementById("delay-seconds")
      .addEventListener("click", (event) => event.stopPropagation());
    document
      .getElementById("btn-ss-copy")
      ?.addEventListener("click", () => this.copyToClipboard());
    document
      .getElementById("btn-ss-save")
      ?.addEventListener("click", () => this.saveScreenshot());
    window.snapforge.onRegionCapture((data) => {
      if (data.purpose === "screenshot") this.captureRegionArea(data);
    });
  }
  async captureFullScreen() {
    try {
      const sources = (await window.snapforge.getSources()).filter((source) =>
        source.id.startsWith("screen:"),
      );
      if (!sources.length)
        throw Error("No screen available. Check screen-recording permission.");
      if (sources.length === 1) await this.captureWindowSource(sources[0].id);
      else this.showWindowPicker(sources, "Select a screen");
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }
  captureRegion() {
    window.snapforge
      .openRegionSelector({
        purpose: "screenshot",
        displayId: window.recorder?.selectedDisplayId,
      })
      .catch((error) => App.showToast(error.message, "error"));
  }
  async captureRegionArea(region) {
    try {
      const sources = await window.snapforge.getSources(),
        source = sources.find(
          (source) => source.display_id === region.displayId,
        );
      if (!source) throw Error("The selected display disconnected.");
      await this.captureWindowSource(source.id, region);
    } catch (error) {
      App.showToast(error.message, "error");
      await window.snapforge.restore();
    }
  }
  async captureWindow() {
    try {
      this.showWindowPicker(
        (await window.snapforge.getSources()).filter((source) =>
          source.id.startsWith("window:"),
        ),
        "Select a window",
      );
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }
  showWindowPicker(sources, title) {
    const dialog = document.createElement("dialog");
    dialog.className = "source-picker";
    const heading = document.createElement("h2");
    heading.textContent = title;
    dialog.appendChild(heading);
    if (!sources.length) {
      const message = document.createElement("p");
      message.textContent =
        "No capture sources found. Check permissions and try again.";
      dialog.appendChild(message);
    }
    const grid = document.createElement("div");
    grid.className = "source-grid";
    for (const source of sources) {
      const button = document.createElement("button");
      button.className = "source-item";
      const image = document.createElement("img");
      image.src = source.thumbnail;
      image.alt = "";
      const name = document.createElement("span");
      name.textContent = source.name;
      button.append(image, name);
      button.addEventListener("click", () => {
        dialog.close();
        dialog.remove();
        this.captureWindowSource(source.id);
      });
      grid.appendChild(button);
    }
    dialog.appendChild(grid);
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      dialog.close();
      dialog.remove();
    });
    dialog.appendChild(cancel);
    dialog.addEventListener("cancel", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }
  async captureWindowSource(sourceId, region) {
    if (this.busy) return;
    this.busy = true;
    let stream, video;
    try {
      await window.snapforge.minimize();
      await new Promise((resolve) => setTimeout(resolve, 250));
      stream = await window.CaptureRuntime.getMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
          },
        },
      });
      video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await window.CaptureRuntime.playVideo(video);
      const vw = video.videoWidth,
        vh = video.videoHeight;
      if (!vw || !vh) throw Error("Screen capture did not provide a frame.");
      const canvas = document.createElement("canvas");
      let x = 0,
        y = 0,
        w = vw,
        h = vh;
      if (region) {
        const bounds = region.bounds;
        if (!bounds?.width || !bounds?.height)
          throw Error("Display information changed. Select the region again.");
        x = Math.round((region.x * vw) / bounds.width);
        y = Math.round((region.y * vh) / bounds.height);
        w = Math.min(Math.round((region.width * vw) / bounds.width), vw - x);
        h = Math.min(Math.round((region.height * vh) / bounds.height), vh - y);
      }
      if (w < 1 || h < 1 || w * h > 100000000)
        throw Error("Invalid screenshot dimensions.");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(video, x, y, w, h, 0, 0, w, h);
      this.showPreview(canvas.toDataURL("image/png"));
      App.showToast("Screenshot captured. Click Save to keep it.", "info");
    } catch (error) {
      App.showToast("Screenshot failed: " + error.message, "error");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      this.busy = false;
      await window.snapforge.restore().catch(() => {});
    }
  }
  async captureDelayed() {
    if (this.busy) return;
    this.busy = true;
    const overlay = document.getElementById("countdown-overlay"),
      number = document.getElementById("countdown-number");
    try {
      overlay.style.display = "flex";
      for (
        let i = Number(document.getElementById("delay-seconds").value) || 3;
        i > 0;
        i--
      ) {
        number.textContent = String(i);
        window.soundEngine?.playCountdownBeep();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      overlay.style.display = "none";
      this.busy = false;
    }
    await this.captureFullScreen();
  }
  showPreview(dataURL) {
    this.lastCapture = dataURL;
    document.getElementById("screenshot-preview").src = dataURL;
    document.getElementById("screenshot-preview-card").style.display = "block";
  }
  async copyToClipboard() {
    if (!this.lastCapture) return;
    try {
      const blob = await (await fetch(this.lastCapture)).blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      App.showToast("Copied to clipboard.", "success");
    } catch {
      App.showToast("Could not copy. Save the image instead.", "error");
    }
  }
  async saveScreenshot() {
    if (!this.lastCapture) return;
    try {
      const file = await window.snapforge.saveScreenshot(this.lastCapture);
      App.showToastWithAction(
        "Screenshot saved.",
        "success",
        "Show in folder",
        () => window.snapforge.openFolder(file),
      );
    } catch (error) {
      App.showToast("Could not save: " + error.message, "error");
    }
  }
}
window.screenshotManager = new ScreenshotManager();
