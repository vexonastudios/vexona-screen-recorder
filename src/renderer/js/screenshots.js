/**
 * Vexona Screen Recorder — Screenshot Module
 * Fixes: #1 (region capture), #10 (XSS), #18 (select in button), #19 (duplicate save)
 */

class ScreenshotManager {
  constructor() {
    this.lastCapture = null;
    this.init();
  }

  init() {
    document.getElementById('btn-ss-fullscreen').addEventListener('click', () => this.captureFullScreen());
    document.getElementById('btn-ss-region').addEventListener('click', () => this.captureRegion());
    document.getElementById('btn-ss-window').addEventListener('click', () => this.captureWindow());
    document.getElementById('btn-ss-delayed').addEventListener('click', () => this.captureDelayed());
    // #13: keydown handler for div[role="button"] accessibility
    document.getElementById('btn-ss-delayed').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.captureDelayed(); }
    });

    // Preview actions
    document.getElementById('btn-ss-copy')?.addEventListener('click', () => this.copyToClipboard());
    document.getElementById('btn-ss-save')?.addEventListener('click', () => this.saveScreenshot());

    // Fix #18: Stop propagation on the delay select so clicking it doesn't trigger the card
    document.getElementById('delay-seconds')?.addEventListener('click', (e) => e.stopPropagation());

    // Listen for region capture from main process (#1)
    // #8: Only handle region captures intended for screenshots
    window.snapforge.onRegionCapture((data) => {
      if (data.purpose === 'recording') return; // ignore recording regions
      this.captureRegionArea(data);
    });
  }

  // Fix #19: captureFullScreen no longer auto-saves — shows preview first
  async captureFullScreen() {
    try {
      const sources = await window.snapforge.getSources();
      const screens = sources.filter(s => s.id.startsWith('screen:'));

      if (screens.length > 0) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screens[0].id
            }
          }
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();
        await new Promise(r => requestAnimationFrame(r));

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);

        stream.getTracks().forEach(t => t.stop());

        const dataURL = canvas.toDataURL('image/png');
        window.soundEngine?.playShutter(); // audible snap at capture moment
        this.showPreview(dataURL);
        App.showToast('Screenshot captured! Click Save to keep it.', 'info');
      }
    } catch (err) {
      console.error('Screenshot failed:', err);
      App.showToast('Screenshot failed: ' + err.message, 'error');
    }
  }

  // Fix #1: Region capture uses proper IPC to open full-screen overlay via main process
  captureRegion() {
    // Minimize the app window so it doesn't appear in the capture
    window.snapforge.minimize();

    // Small delay to let the window minimize animation complete
    setTimeout(() => {
      this.openRegionSelector();
    }, 300);
  }

  openRegionSelector() {
    // We capture the full screen first, then let the user select a region from it
    this.captureScreenForRegion();
  }

  async captureScreenForRegion() {
    try {
      const sources = await window.snapforge.getSources();
      const screens = sources.filter(s => s.id.startsWith('screen:'));

      if (screens.length === 0) {
        App.showToast('No screen found', 'error');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screens[0].id
          }
        }
      });

      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      await new Promise(r => requestAnimationFrame(r));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);

      stream.getTracks().forEach(t => t.stop());

      const fullScreenDataURL = canvas.toDataURL('image/png');

      // Now show the region selector overlay with the captured image
      this.showRegionOverlay(fullScreenDataURL, canvas.width, canvas.height);
    } catch (err) {
      console.error('Region capture failed:', err);
      App.showToast('Region capture failed', 'error');
    }
  }

  showRegionOverlay(backgroundDataURL, imgWidth, imgHeight) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 3000;
      cursor: crosshair;
      background: #000;
    `;

    // Show the captured screen as background
    const bgImg = document.createElement('img');
    bgImg.src = backgroundDataURL;
    bgImg.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      opacity: 0.5;
      pointer-events: none;
    `;
    overlay.appendChild(bgImg);

    const selectionBox = document.createElement('div');
    selectionBox.style.cssText = `
      position: absolute;
      border: 2px solid #059669;
      background: rgba(5, 150, 105, 0.1);
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.5);
      display: none;
      pointer-events: none;
    `;
    overlay.appendChild(selectionBox);

    const dimLabel = document.createElement('div');
    dimLabel.style.cssText = `
      position: absolute;
      background: #059669;
      color: white;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      display: none;
      pointer-events: none;
    `;
    overlay.appendChild(dimLabel);

    // Instructions
    const instructions = document.createElement('div');
    instructions.style.cssText = `
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(19, 19, 26, 0.9);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      padding: 10px 20px;
      color: #f1f5f9;
      font-size: 13px;
      font-weight: 500;
      pointer-events: none;
      z-index: 10;
    `;
    instructions.textContent = 'Click and drag to select a region • Press Esc to cancel';
    overlay.appendChild(instructions);

    let startX, startY, isDrawing = false;

    overlay.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      isDrawing = true;
      selectionBox.style.display = 'block';
      dimLabel.style.display = 'block';
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!isDrawing) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      selectionBox.style.left = `${x}px`;
      selectionBox.style.top = `${y}px`;
      selectionBox.style.width = `${w}px`;
      selectionBox.style.height = `${h}px`;

      dimLabel.style.left = `${x}px`;
      dimLabel.style.top = `${y + h + 8}px`;
      dimLabel.textContent = `${w} × ${h}`;
    });

    overlay.addEventListener('mouseup', (e) => {
      if (!isDrawing) return;
      isDrawing = false;

      const rect = bgImg.getBoundingClientRect();
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      overlay.remove();

      if (w > 10 && h > 10) {
        // Map overlay coordinates to image coordinates
        const scaleX = imgWidth / rect.width;
        const scaleY = imgHeight / rect.height;
        const cropX = (x - rect.left) * scaleX;
        const cropY = (y - rect.top) * scaleY;
        const cropW = w * scaleX;
        const cropH = h * scaleY;

        this.cropFromDataURL(backgroundDataURL, cropX, cropY, cropW, cropH);
      }

      // Restore the app window
      // Small timeout to avoid capturing the window restoration
      setTimeout(() => {
        window.snapforge.maximize().catch(() => {});
      }, 100);
    });

    overlay.setAttribute('tabindex', '0');
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
      }
    });

    document.body.appendChild(overlay);
    overlay.focus();
  }

  cropFromDataURL(dataURL, x, y, w, h) {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);

      const croppedDataURL = canvas.toDataURL('image/png');
      window.soundEngine?.playShutter(); // audible snap at capture moment
      this.showPreview(croppedDataURL);
      App.showToast('Region captured! Click Save to keep it.', 'info');
    };
    img.src = dataURL;
  }

  async captureRegionArea(region) {
    // This is called from the main-process region window
    await this.captureArea(region.x, region.y, region.width, region.height);
  }

  async captureArea(x, y, w, h) {
    try {
      const sources = await window.snapforge.getSources();
      const screens = sources.filter(s => s.id.startsWith('screen:'));

      if (screens.length > 0) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screens[0].id
            }
          }
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();
        await new Promise(r => requestAnimationFrame(r));

        const scaleX = video.videoWidth / window.screen.width;
        const scaleY = video.videoHeight / window.screen.height;

        const canvas = document.createElement('canvas');
        canvas.width = w * scaleX;
        canvas.height = h * scaleY;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, x * scaleX, y * scaleY, w * scaleX, h * scaleY, 0, 0, canvas.width, canvas.height);

        stream.getTracks().forEach(t => t.stop());

        const dataURL = canvas.toDataURL('image/png');
        this.showPreview(dataURL);
        App.showToast('Region captured! Click Save to keep it.', 'info');
      }
    } catch (err) {
      console.error('Region capture failed:', err);
      App.showToast('Region capture failed', 'error');
    }
  }

  async captureWindow() {
    try {
      const sources = await window.snapforge.getSources();
      const windows = sources.filter(s => s.id.startsWith('window:'));

      if (windows.length === 0) {
        App.showToast('No windows found', 'error');
        return;
      }

      this.showWindowPicker(windows);
    } catch (err) {
      console.error('Window capture failed:', err);
      App.showToast('Window capture failed', 'error');
    }
  }

  showWindowPicker(windows) {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 3000;
      background: rgba(10, 10, 15, 0.9);
      backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: pageIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      background: #13131a;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 16px;
      padding: 24px;
      max-width: 700px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    `;

    const title = document.createElement('h2');
    title.style.cssText = 'font-size:18px; font-weight:700; margin-bottom:16px; color:#f1f5f9;';
    title.textContent = 'Select Window';
    content.appendChild(title);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:12px;';

    // Fix #10: Build window items safely with textContent
    windows.forEach(w => {
      const item = document.createElement('div');
      item.className = 'source-item';
      item.style.cursor = 'pointer';
      item.dataset.id = w.id;

      const thumb = document.createElement('img');
      thumb.className = 'source-thumb';
      thumb.src = w.thumbnail;
      thumb.alt = w.name;

      const name = document.createElement('div');
      name.className = 'source-name';
      name.title = w.name;
      name.textContent = w.name;

      item.appendChild(thumb);
      item.appendChild(name);

      item.addEventListener('click', async () => {
        modal.remove();
        await this.captureWindowSource(w.id);
      });

      grid.appendChild(item);
    });

    content.appendChild(grid);

    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:16px; text-align:right;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => modal.remove());
    footer.appendChild(cancelBtn);
    content.appendChild(footer);

    modal.appendChild(content);
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  async captureWindowSource(sourceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        }
      });

      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      await new Promise(r => requestAnimationFrame(r));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);

      stream.getTracks().forEach(t => t.stop());

      const dataURL = canvas.toDataURL('image/png');
      this.showPreview(dataURL);
      App.showToast('Window captured! Click Save to keep it.', 'info');
    } catch (err) {
      console.error('Window capture failed:', err);
      App.showToast('Window capture failed', 'error');
    }
  }

  async captureDelayed() {
    const seconds = parseInt(document.getElementById('delay-seconds').value);
    const overlay = document.getElementById('countdown-overlay');
    const numberEl = document.getElementById('countdown-number');

    overlay.style.display = 'flex';

    for (let i = seconds; i > 0; i--) {
      numberEl.textContent = i;
      numberEl.style.animation = 'none';
      numberEl.offsetHeight;
      numberEl.style.animation = 'countdownPulse 1s cubic-bezier(0.16, 1, 0.3, 1)';
      // B5: Audible countdown beep on each tick
      window.soundEngine?.playCountdownBeep();
      await new Promise(r => setTimeout(r, 1000));
    }

    overlay.style.display = 'none';
    await this.captureFullScreen();
  }

  showPreview(dataURL) {
    this.lastCapture = dataURL;
    const previewCard = document.getElementById('screenshot-preview-card');
    const previewImg = document.getElementById('screenshot-preview');
    previewImg.src = dataURL;
    previewCard.style.display = 'block';
    previewCard.style.animation = 'none';
    previewCard.offsetHeight;
    previewCard.style.animation = 'pageIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
  }

  async copyToClipboard() {
    if (!this.lastCapture) return;
    try {
      const response = await fetch(this.lastCapture);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      App.showToast('Copied to clipboard!', 'success');
    } catch (err) {
      App.showToast('Failed to copy', 'error');
    }
  }

  async saveScreenshot() {
    if (!this.lastCapture) return;
    try {
      const filePath = await window.snapforge.saveScreenshot(this.lastCapture);
      window.soundEngine?.playSaveSuccess();
      App.showToast('Screenshot saved!', 'success', 3000, true); // noSound: sound already played above
    } catch (err) {
      window.soundEngine?.playError();
      App.showToast('Failed to save screenshot', 'error', 3000, true); // noSound: sound already played above
    }
  }
}

// Initialize
window.screenshotManager = new ScreenshotManager();
