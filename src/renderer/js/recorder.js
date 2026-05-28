/**
 * Vexona Screen Recorder
 * Features: countdown beeps, region recording, cursor tracking, auto-zoom
 */

class Recorder {
  constructor() {
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.screenStream = null;
    this.micStream = null;
    this.compositeStream = null;
    this.selectedSourceId = null;
    this.isRecording = false;
    this.isPaused = false;
    this.isStarting = false; // #12: double-click guard
    this.startTime = 0;
    this.elapsed = 0;
    this.timerInterval = null;

    // Audio — separate contexts for preview vs recording (#6)
    this.recordingAudioCtx = null;
    this.micPreviewCtx = null;
    this.micAnalyser = null;
    this.micGainNode = null;   // preview gain node — updated live by slider
    this.micGainValue = 1.0;   // persisted so recording uses same level
    this.micAnimFrame = null;
    // NOTE: UI beep/click sounds are handled by window.soundEngine (sounds.js)

    // Canvas compositing
    this.compositeCanvas = null;
    this.compositeCtx = null;
    this.compositeAnimFrame = null;

    // Cursor / zoom state — #5: defaults read from HTML in init()
    this.cursorHighlightEnabled = true;
    this.clickEffectsEnabled = true;
    this.autoZoomEnabled = true;
    this.cursorColor = '#059669';
    this.cursorSize = 40;
    this.zoomLevel = 1.35;
    this.zoomDuration = 400;
    this.cursorEffects = [];
    this.systemCursorPos = null;
    this.zoomState = { active: false, x: 0, y: 0, progress: 0, phase: 'idle' };

    // Region recording
    this.recordRegion = null;

    // Active recording framerate — used by composite render loop
    this._framerate = 30;

    // Cleanup refs
    this._removeCursorListener = null;
    this._removeClickListener = null;

    // Webcam overlay
    this.webcamEnabled = false;
    this.webcamStream = null;
    this.webcamVideo = null;
    this.webcamSize = 220;
    this.webcamShape = 'circle';
    this.webcamCorner = 'bottom-right';

    // Auto-stop
    this._autoStopTimeout = null;
    this._autoStopWarnTimeout = null;

    // Bitrates (stored for file-size estimate)
    this._videoBitrate = 8000000;
    this._audioBitrate = 192000;

    this.init();
  }

  init() {
    this.bindElements();
    this.bindEvents();
    this.loadSources();
    this.setupSystemCursorTracking();
    this.syncDefaultsFromHTML();
    this.loadSettings(); // restore persisted preferences
    // B3: Clean up streams if window is closed (e.g. during countdown)
    window.addEventListener('beforeunload', () => this.cleanupStreams());
  }

  // #5: Read actual defaults from HTML dropdowns so code and UI agree
  syncDefaultsFromHTML() {
    const zoomLevelEl = document.getElementById('zoom-level');
    if (zoomLevelEl) this.zoomLevel = parseFloat(zoomLevelEl.value);
    const zoomDurationEl = document.getElementById('zoom-duration');
    if (zoomDurationEl) this.zoomDuration = parseInt(zoomDurationEl.value);
    const cursorColorEl = document.getElementById('cursor-color');
    if (cursorColorEl) this.cursorColor = cursorColorEl.value;
    const cursorSizeEl = document.getElementById('cursor-size');
    if (cursorSizeEl) this.cursorSize = parseInt(cursorSizeEl.value);
  }

  bindElements() {
    this.btnRecord = document.getElementById('btn-record');
    this.btnRecordLabel = document.getElementById('btn-record-label');
    this.btnPause = document.getElementById('btn-pause');
    this.btnPauseLabel = document.getElementById('btn-pause-label');
    this.btnRefresh = document.getElementById('btn-refresh-sources');
    this.sourceGrid = document.getElementById('source-grid');
    this.previewEl = document.getElementById('recording-preview');
    this.previewVideo = document.getElementById('preview-video');
    this.previewTime = document.getElementById('preview-time');
    this.previewFilesize = document.getElementById('preview-filesize');
    this.previewStatus = document.getElementById('preview-status');
    this.recIndicator = document.getElementById('recording-indicator');
    this.recTimer = document.getElementById('rec-timer');
    this.micLevelContainer = document.getElementById('mic-level-container');
    this.micLevelFill = document.getElementById('mic-level-fill');
    this.micDeviceSelect = document.getElementById('mic-device-select');
  }

  bindEvents() {
    this.btnRecord.addEventListener('click', () => this.toggleRecording());
    this.btnPause.addEventListener('click', () => this.togglePause());
    this.btnRefresh.addEventListener('click', () => this.loadSources());

    const btnRegion = document.getElementById('btn-record-region');
    if (btnRegion) {
      btnRegion.addEventListener('click', () => this.startRegionSelect());
    }

    // Preset region buttons
    document.querySelectorAll('[data-preset-region]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [w, h] = btn.dataset.presetRegion.split('x').map(Number);
        this.setPresetRegion(w, h, btn.dataset.presetLabel || `${w}×${h}`);
      });
    });

    // YouTube quality preset
    const btnYtPreset = document.getElementById('btn-yt-preset');
    if (btnYtPreset) btnYtPreset.addEventListener('click', () => this.setYoutubePreset());

    document.getElementById('opt-mic-audio').addEventListener('change', async (e) => {
      const deviceRow = document.getElementById('mic-device-row');
      if (e.target.checked) {
        // Show the UI INSTANTLY — don't wait for permission dialog
        if (deviceRow) deviceRow.style.display = 'flex';
        this.micLevelContainer.style.display = 'flex';
        // Start preview right away with default mic
        await this.startMicPreview();
        // Enumerate real device labels in background (doesn't block UI)
        this.loadMicDevices().catch(() => {});
      } else {
        if (deviceRow) deviceRow.style.display = 'none';
        this.micLevelContainer.style.display = 'none';
        this.stopMicPreview();
      }
    });

    // Re-start preview when user picks a different device
    document.getElementById('mic-device-select')?.addEventListener('change', async () => {
      if (document.getElementById('opt-mic-audio').checked) {
        this.stopMicPreview();
        await this.startMicPreview();
      }
    });

    // Mic gain slider — updates gain node in real time
    document.getElementById('mic-gain')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.micGainValue = val;
      if (this.micGainNode) this.micGainNode.gain.value = val;
      const pct = Math.round(val * 100);
      const label = document.getElementById('mic-gain-label');
      if (label) label.textContent = `${pct}%`;
    });

    document.getElementById('opt-cursor-highlight').addEventListener('change', (e) => {
      this.cursorHighlightEnabled = e.target.checked;
    });
    document.getElementById('opt-click-effects').addEventListener('change', (e) => {
      this.clickEffectsEnabled = e.target.checked;
    });
    document.getElementById('opt-auto-zoom').addEventListener('change', (e) => {
      this.autoZoomEnabled = e.target.checked;
    });

    document.getElementById('cursor-color')?.addEventListener('input', (e) => {
      this.cursorColor = e.target.value;
    });
    document.getElementById('cursor-size')?.addEventListener('input', (e) => {
      this.cursorSize = parseInt(e.target.value);
    });
    document.getElementById('zoom-level')?.addEventListener('change', (e) => {
      this.zoomLevel = parseFloat(e.target.value);
    });
    document.getElementById('zoom-duration')?.addEventListener('change', (e) => {
      this.zoomDuration = parseInt(e.target.value);
    });

    // All settings changes auto-save
    const settingIds = ['opt-mic-audio','opt-system-audio','opt-resolution','opt-framerate',
      'opt-bitrate','opt-audio-bitrate','opt-cursor-highlight','opt-click-effects',
      'opt-auto-zoom','cursor-color','cursor-size','zoom-level','zoom-duration',
      'mic-gain','opt-auto-stop','webcam-size','webcam-shape','webcam-corner'];
    settingIds.forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => this.saveSettings());
      document.getElementById(id)?.addEventListener('input', () => this.saveSettings());
    });

    // Webcam toggle
    document.getElementById('opt-webcam')?.addEventListener('change', async (e) => {
      const controls = document.getElementById('webcam-controls');
      if (e.target.checked) {
        if (controls) controls.style.display = 'flex';
        // Expand window to accommodate controls (approx 75px height)
        window.snapforge.resizeBy(0, 75);
        await this.startWebcam();
      } else {
        if (controls) controls.style.display = 'none';
        // Shrink window back
        window.snapforge.resizeBy(0, -75);
        this.stopWebcam();
      }
      this.saveSettings();
    });

    // Visual webcam size picker — sync buttons ↔ hidden select
    const wspPicker = document.getElementById('webcam-size-picker');
    if (wspPicker) {
      wspPicker.addEventListener('click', async (e) => {
        const btn = e.target.closest('.wsp-btn');
        if (!btn) return;
        // Update active button
        wspPicker.querySelectorAll('.wsp-btn').forEach(b => b.classList.remove('wsp-active'));
        btn.classList.add('wsp-active');
        // Sync hidden select
        const val = btn.dataset.value;
        const sel = document.getElementById('webcam-size');
        if (sel) { sel.value = val; sel.dispatchEvent(new Event('change')); }
        // U2: Scale preview bubble proportionally (small=56 medium=84 large=112)
        const previewWrap = document.getElementById('webcam-preview-wrap');
        if (previewWrap) {
          const sizeMap = { '160': '56px', '220': '84px', '300': '112px' };
          const dim = sizeMap[val] || '84px';
          previewWrap.style.width  = dim;
          previewWrap.style.height = dim;
        }
      });
    }

    // Webcam device/size/shape/corner changes restart the stream
    ['webcam-device','webcam-size','webcam-shape','webcam-corner'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', async () => {
        this.webcamSize   = parseInt(document.getElementById('webcam-size')?.value || 220);
        this.webcamShape  = document.getElementById('webcam-shape')?.value || 'circle';
        this.webcamCorner = document.getElementById('webcam-corner')?.value || 'bottom-right';
        // Update preview bubble shape to match
        const previewWrap  = document.getElementById('webcam-preview-wrap');
        const previewInner = previewWrap?.querySelector('.webcam-preview-inner');
        if (previewWrap && previewInner) {
          const isCircle = this.webcamShape === 'circle';
          previewWrap.style.borderRadius  = isCircle ? '50%' : '16px';
          previewInner.style.borderRadius = isCircle ? '50%' : '14px';
        }
        if (this.webcamEnabled) {
          this.stopWebcam();
          await this.startWebcam();
        }
        this.saveSettings();
      });
    });

    // Hotkey modal
    document.getElementById('btn-hotkeys')?.addEventListener('click', () => {
      document.getElementById('hotkey-modal').style.display = 'flex';
    });
    document.getElementById('btn-close-hotkeys')?.addEventListener('click', () => {
      document.getElementById('hotkey-modal').style.display = 'none';
    });
    document.getElementById('hotkey-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '?' && !e.ctrlKey && !e.altKey) {
        const modal = document.getElementById('hotkey-modal');
        if (modal) modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
      }
      if (e.key === 'Escape') {
        const modal = document.getElementById('hotkey-modal');
        if (modal) modal.style.display = 'none';
      }
    });

    // #8: Listen for region selection
    window.snapforge.onRegionCapture((data) => {
      if (data.purpose !== 'recording') return;
      this.recordRegion = { x: data.x, y: data.y, width: data.width, height: data.height };
      this.selectedSourceId = '__screen__';
      this.btnRecord.disabled = false;
      // U1: hide source hint when region is chosen
      const hint = document.getElementById('source-hint');
      if (hint) hint.style.display = 'none';
      document.querySelectorAll('.source-item').forEach(s => s.classList.remove('selected'));
      App.showToast(`Region selected: ${data.width}×${data.height}`, 'info');
      const badge = document.getElementById('region-badge');
      if (badge) {
        badge.style.display = 'inline-flex';
        badge.textContent = `${data.width}×${data.height}`;
      }
    });
  }

  // ── Settings Persistence ──
  saveSettings() {
    const get = (id) => document.getElementById(id);
    const settings = {
      micEnabled:      get('opt-mic-audio')?.checked,
      systemAudio:     get('opt-system-audio')?.checked,
      resolution:      get('opt-resolution')?.value,
      framerate:       get('opt-framerate')?.value,
      bitrate:         get('opt-bitrate')?.value,
      audioBitrate:    get('opt-audio-bitrate')?.value,
      cursorHighlight: get('opt-cursor-highlight')?.checked,
      clickEffects:    get('opt-click-effects')?.checked,
      autoZoom:        get('opt-auto-zoom')?.checked,
      cursorColor:     get('cursor-color')?.value,
      cursorSize:      get('cursor-size')?.value,
      zoomLevel:       get('zoom-level')?.value,
      zoomDuration:    get('zoom-duration')?.value,
      micGain:         get('mic-gain')?.value,
      autoStop:        get('opt-auto-stop')?.value,
      webcamEnabled:   get('opt-webcam')?.checked,
      webcamSize:      get('webcam-size')?.value,
      webcamShape:     get('webcam-shape')?.value,
      webcamCorner:    get('webcam-corner')?.value,
    };
    try { localStorage.setItem('vexona_settings', JSON.stringify(settings)); } catch (e) {}
  }

  loadSettings() {
    let s;
    try { s = JSON.parse(localStorage.getItem('vexona_settings') || localStorage.getItem('snapforge_settings') || 'null'); } catch (e) { return; }
    if (!s) return;
    const set = (id, val, prop = 'value') => {
      const el = document.getElementById(id);
      if (!el || val === undefined || val === null) return;
      if (prop === 'checked') el.checked = val;
      else el.value = val;
    };
    set('opt-system-audio',   s.systemAudio, 'checked');
    set('opt-resolution',     s.resolution);
    set('opt-framerate',      s.framerate);
    set('opt-bitrate',        s.bitrate);
    set('opt-audio-bitrate',  s.audioBitrate);
    set('opt-cursor-highlight', s.cursorHighlight, 'checked');
    set('opt-click-effects',  s.clickEffects, 'checked');
    set('opt-auto-zoom',      s.autoZoom, 'checked');
    set('cursor-color',       s.cursorColor);
    set('cursor-size',        s.cursorSize);
    set('zoom-level',         s.zoomLevel);
    set('zoom-duration',      s.zoomDuration);
    set('opt-auto-stop',      s.autoStop);
    set('webcam-size',        s.webcamSize);
    set('webcam-shape',       s.webcamShape);
    set('webcam-corner',      s.webcamCorner);
    // Mic gain
    if (s.micGain !== undefined) {
      set('mic-gain', s.micGain);
      this.micGainValue = parseFloat(s.micGain);
      const label = document.getElementById('mic-gain-label');
      if (label) label.textContent = `${Math.round(this.micGainValue * 100)}%`;
    }
    // Sync internal state from restored values
    if (s.cursorHighlight !== undefined) this.cursorHighlightEnabled = s.cursorHighlight;
    if (s.clickEffects    !== undefined) this.clickEffectsEnabled    = s.clickEffects;
    if (s.autoZoom        !== undefined) this.autoZoomEnabled        = s.autoZoom;
    if (s.cursorColor)  this.cursorColor  = s.cursorColor;
    if (s.cursorSize)   this.cursorSize   = parseInt(s.cursorSize);
    if (s.zoomLevel)    this.zoomLevel    = parseFloat(s.zoomLevel);
    if (s.zoomDuration) this.zoomDuration = parseInt(s.zoomDuration);
    // Webcam state
    if (s.webcamSize)   this.webcamSize   = parseInt(s.webcamSize);
    if (s.webcamShape)  this.webcamShape  = s.webcamShape;
    if (s.webcamCorner) this.webcamCorner = s.webcamCorner;
    // Sync visual size picker to restored value
    if (s.webcamSize) {
      const picker = document.getElementById('webcam-size-picker');
      if (picker) {
        picker.querySelectorAll('.wsp-btn').forEach(b => {
          b.classList.toggle('wsp-active', b.dataset.value === String(s.webcamSize));
        });
      }
    }
    // Restore mic toggle (triggers preview start)
    if (s.micEnabled) {
      const micToggle = document.getElementById('opt-mic-audio');
      if (micToggle && !micToggle.checked) {
        micToggle.checked = true;
        micToggle.dispatchEvent(new Event('change'));
      }
    }
    // Restore webcam toggle
    if (s.webcamEnabled) {
      const wc = document.getElementById('opt-webcam');
      if (wc && !wc.checked) {
        wc.checked = true;
        wc.dispatchEvent(new Event('change'));
      }
    }
  }

  // ── Webcam Overlay ──
  async startWebcam() {
    try {
      const deviceId = document.getElementById('webcam-device')?.value;
      const constraints = { video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false };
      this.webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.webcamVideo = document.createElement('video');
      this.webcamVideo.srcObject = this.webcamStream;
      this.webcamVideo.muted = true;
      await this.webcamVideo.play();
      this.webcamEnabled = true;

      // Show preview bubble
      const previewVid = document.getElementById('webcam-preview');
      if (previewVid) previewVid.srcObject = this.webcamStream;

      // Update local options from selects
      this.webcamSize   = parseInt(document.getElementById('webcam-size')?.value  || 220);
      this.webcamShape  = document.getElementById('webcam-shape')?.value  || 'circle';
      this.webcamCorner = document.getElementById('webcam-corner')?.value || 'bottom-right';

      // B2: Enumerate cameras once after permission is granted, populate device select
      await this.loadWebcamDevices();
    } catch (err) {
      console.error('Webcam error:', err);
      App.showToast('Could not access webcam', 'error');
      document.getElementById('opt-webcam').checked = false;
      document.getElementById('webcam-controls').style.display = 'none';
    }
  }

  stopWebcam() {
    this.webcamEnabled = false;
    if (this.webcamStream) { this.webcamStream.getTracks().forEach(t => t.stop()); this.webcamStream = null; }
    this.webcamVideo = null;
    const previewVid = document.getElementById('webcam-preview');
    if (previewVid) previewVid.srcObject = null;
  }

  // B2: One-time camera enumeration (called once when webcam is first enabled)
  async loadWebcamDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      const sel = document.getElementById('webcam-device');
      if (!sel) return;
      const prevVal = sel.value;
      sel.innerHTML = '';
      cams.forEach((c, i) => {
        const opt = document.createElement('option');
        opt.value = c.deviceId;
        opt.textContent = c.label || `Camera ${i + 1}`;
        sel.appendChild(opt);
      });
      // Restore previously-selected camera if still available
      if (prevVal && [...sel.options].some(o => o.value === prevVal)) sel.value = prevVal;
    } catch (err) {
      console.warn('Could not enumerate cameras:', err);
    }
  }

  // Draw webcam onto composite canvas (called from renderComposite)
  drawWebcam(ctx, canvasW, canvasH) {
    if (!this.webcamEnabled || !this.webcamVideo || this.webcamVideo.readyState < 2) return;
    const size = this.webcamSize;
    const pad  = 20;
    let x, y;
    switch (this.webcamCorner) {
      case 'top-left':     x = pad; y = pad; break;
      case 'top-right':    x = canvasW - size - pad; y = pad; break;
      case 'bottom-left':  x = pad; y = canvasH - size - pad; break;
      default:             x = canvasW - size - pad; y = canvasH - size - pad; // bottom-right
    }
    ctx.save();
    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 16;
    // Clip path
    ctx.beginPath();
    if (this.webcamShape === 'circle') {
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    } else {
      const r = 16;
      ctx.roundRect(x, y, size, size, r);
    }
    ctx.clip();
    ctx.shadowColor = 'transparent';
    // Cover-crop: fit webcam into square without stretching (like object-fit: cover)
    const vw = this.webcamVideo.videoWidth  || size;
    const vh = this.webcamVideo.videoHeight || size;
    const videoAspect = vw / vh;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (videoAspect > 1) {
      // Landscape camera — crop the sides
      sw = vh; sx = (vw - sw) / 2;
    } else if (videoAspect < 1) {
      // Portrait camera — crop top/bottom
      sh = vw; sy = (vh - sh) / 2;
    }
    // Draw mirrored (natural for webcam)
    ctx.translate(x + size, y);
    ctx.scale(-1, 1);
    ctx.drawImage(this.webcamVideo, sx, sy, sw, sh, 0, 0, size, size);
    ctx.restore();
    // Multi-layer glow border — outer purple shadow, inner cyan ring, specular highlight
    // Outer glow
    ctx.save();
    ctx.beginPath();
    if (this.webcamShape === 'circle') {
      ctx.arc(x + size / 2, y + size / 2, size / 2 + 3, 0, Math.PI * 2);
    } else {
      ctx.roundRect(x - 3, y - 3, size + 6, size + 6, 19);
    }
    ctx.strokeStyle = 'rgba(5, 150, 105, 0.4)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();
    // Main crisp border
    ctx.save();
    ctx.beginPath();
    if (this.webcamShape === 'circle') {
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    } else {
      ctx.roundRect(x, y, size, size, 16);
    }
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
    // Specular highlight arc (top-left shine)
    ctx.save();
    ctx.beginPath();
    if (this.webcamShape === 'circle') {
      ctx.arc(x + size / 2, y + size / 2, size / 2, -Math.PI * 0.75, -Math.PI * 0.1);
    } else {
      ctx.moveTo(x + 16, y + 1.5);
      ctx.lineTo(x + size * 0.55, y + 1.5);
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  // ── Auto-Stop ──
  setupAutoStop(minutes) {
    this.clearAutoStop();
    if (!minutes || minutes <= 0) return;
    const ms = minutes * 60 * 1000;
    // U4: warn at the lesser of 30s or 20% of total session length
    const warnAt = Math.min(30000, ms * 0.2);
    const warnMs = ms - warnAt;
    if (warnMs > 0) {
      this._autoStopWarnTimeout = setTimeout(() => {
        const secsLeft = Math.round(warnAt / 1000);
        App.showToast(`Recording will auto-stop in ${secsLeft} seconds`, 'warning', 4000);
      }, warnMs);
    }
    this._autoStopTimeout = setTimeout(() => {
      App.showToast('Auto-stop: recording limit reached', 'info');
      this.stopRecording();
    }, ms);
  }

  clearAutoStop() {
    if (this._autoStopTimeout) { clearTimeout(this._autoStopTimeout); this._autoStopTimeout = null; }
    if (this._autoStopWarnTimeout) { clearTimeout(this._autoStopWarnTimeout); this._autoStopWarnTimeout = null; }
  }

  // ── File Size Estimate ──
  formatFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `~${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `~${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  setupSystemCursorTracking() {
    this._removeCursorListener = window.snapforge.onCursorPosition((pos) => {
      this.systemCursorPos = pos;
    });

    this._removeClickListener = window.snapforge.onCursorClick((pos) => {
      if (this.isRecording) {
        this.triggerClickEffect(pos.relX, pos.relY);
        // Audible click cue — only plays if not muted; isolated from recording audio
        window.soundEngine?.playClick();
      }
    });
  }

  // #18: Minimize main window before opening region selector
  startRegionSelect() {
    window.snapforge.minimize();
    setTimeout(() => {
      window.snapforge.openRegionSelector({ purpose: 'recording' });
    }, 300);
  }

  // Set a preset region centered on screen
  setPresetRegion(w, h, label) {
    const screenW = window.screen.width;
    const screenH = window.screen.height;
    const x = Math.max(0, Math.round((screenW - w) / 2));
    const y = Math.max(0, Math.round((screenH - h) / 2));
    this.recordRegion = { x, y, width: Math.min(w, screenW), height: Math.min(h, screenH) };
    this.selectedSourceId = '__screen__';
    this.btnRecord.disabled = false;
    // U1: hide source hint when region is chosen
    const hint = document.getElementById('source-hint');
    if (hint) hint.style.display = 'none';
    document.querySelectorAll('.source-item').forEach(s => s.classList.remove('selected'));
    const badge = document.getElementById('region-badge');
    if (badge) {
      badge.style.display = 'inline-flex';
      badge.textContent = `${this.recordRegion.width}×${this.recordRegion.height}`;
    }
    App.showToast(`Preset region: ${label} — centered on screen`, 'info');
  }

  // ── YouTube / Quality Helpers ──

  // Returns video bitrate in bps, auto-calculated from canvas dimensions and framerate
  // based on YouTube's recommended upload bitrates
  getVideoBitrate(canvasW, canvasH, framerate, bitrateOverride) {
    if (bitrateOverride && bitrateOverride !== 'auto') return parseInt(bitrateOverride);
    const pixels = canvasW * canvasH;
    // YouTube recommends ~1.5× bitrate for 60fps vs 30fps
    const fpsMultiplier = framerate >= 48 ? 1.5 : 1.0;
    let base;
    if      (pixels >= 3840 * 2000) base = 35_000_000; // 4K UHD
    else if (pixels >= 2560 * 1400) base = 16_000_000; // 1440p QHD
    else if (pixels >= 1920 * 1000) base =  8_000_000; // 1080p FHD
    else if (pixels >= 1280 *  700) base =  5_000_000; // 720p HD
    else                            base =  2_500_000; // <720p
    return Math.round(base * fpsMultiplier);
  }

  // Apply YouTube-optimised quality settings to all controls
  setYoutubePreset() {
    const resEl          = document.getElementById('opt-resolution');
    const fpsEl          = document.getElementById('opt-framerate');
    const bitrateEl      = document.getElementById('opt-bitrate');
    const audioBitrateEl = document.getElementById('opt-audio-bitrate');
    if (resEl)          resEl.value = '1080';
    if (fpsEl)          fpsEl.value = '60';
    if (bitrateEl)      bitrateEl.value = '12000000';  // 12 Mbps — YouTube 1080p/60fps target
    if (audioBitrateEl) audioBitrateEl.value = '192000'; // 192 kbps — YouTube recommended

    // Open the options panel so the user can see the applied settings
    const panel  = document.getElementById('options-panel');
    const toggle = document.getElementById('options-toggle');
    if (panel && panel.style.display === 'none') {
      panel.style.display = 'block';
      if (toggle) toggle.classList.add('open');
    }

    // Pulse the button for tactile feedback
    const btn = document.getElementById('btn-yt-preset');
    if (btn) {
      btn.classList.add('active');
      setTimeout(() => btn.classList.remove('active'), 2000);
    }
    App.showToast('YouTube optimized ✓  1080p · 60fps · 12 Mbps VP9 · 192 kbps', 'success');
  }

  // NOTE: All UI beep/click sounds are handled by window.soundEngine (sounds.js).
  // These stubs remain for safety in case anything calls them before full delegation.

  // ── AudioContext management (#6: separate contexts) ──
  getRecordingAudioContext() {
    if (!this.recordingAudioCtx || this.recordingAudioCtx.state === 'closed') {
      this.recordingAudioCtx = new AudioContext();
    }
    return this.recordingAudioCtx;
  }

  closeRecordingAudioContext() {
    if (this.recordingAudioCtx && this.recordingAudioCtx.state !== 'closed') {
      this.recordingAudioCtx.close().catch(() => {});
      this.recordingAudioCtx = null;
    }
  }

  // ── Source Loading ──
  async loadSources() {
    this.sourceGrid.innerHTML = `
      <div class="source-loading">
        <div class="spinner"></div>
        <span>Loading sources...</span>
      </div>
    `;

    try {
      const sources = await window.snapforge.getSources();
      this.renderSources(sources);
    } catch (err) {
      this.sourceGrid.innerHTML = `<div class="source-loading"><span>Failed to load sources</span></div>`;
    }
  }

  renderSources(sources) {
    this.sourceGrid.innerHTML = '';
    sources.forEach(source => {
      const item = document.createElement('div');
      item.className = 'source-item';
      if (source.id === this.selectedSourceId) item.classList.add('selected');

      const thumb = document.createElement('img');
      thumb.className = 'source-thumb';
      thumb.src = source.thumbnail;
      thumb.alt = source.name;

      const nameEl = document.createElement('div');
      nameEl.className = 'source-name';
      nameEl.title = source.name;
      nameEl.textContent = source.name;

      item.appendChild(thumb);
      item.appendChild(nameEl);

      item.addEventListener('click', () => {
        document.querySelectorAll('.source-item').forEach(s => s.classList.remove('selected'));
        item.classList.add('selected');
        this.selectedSourceId = source.id;
        this.recordRegion = null;
        this.btnRecord.disabled = false;
        // U1: hide the hint once a source is chosen
        const hint = document.getElementById('source-hint');
        if (hint) hint.style.display = 'none';
        const badge = document.getElementById('region-badge');
        if (badge) badge.style.display = 'none';
      });

      this.sourceGrid.appendChild(item);
    });
  }

  // ── Mic Device Enumeration ──

  async loadMicDevices() {
    // By the time this runs, startMicPreview already has a live stream so
    // enumerateDevices will return real labels (permission already granted).
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      this.updateMicDeviceSelect(audioInputs);
    } catch (err) {
      console.warn('Could not enumerate audio devices:', err);
    }
  }

  updateMicDeviceSelect(devices) {
    const select = document.getElementById('mic-device-select');
    if (!select) return;

    const prevValue = select.value;
    select.innerHTML = '';

    devices.forEach((device, i) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      // Label may be empty before permission is granted
      opt.textContent = device.label || `Microphone ${i + 1}`;
      select.appendChild(opt);
    });

    // Restore previously-selected device if still available
    if (prevValue && [...select.options].some(o => o.value === prevValue)) {
      select.value = prevValue;
    }
  }

  getSelectedMicDeviceId() {
    const select = document.getElementById('mic-device-select');
    return select?.value || undefined;
  }

  // ── Mic Preview (#6: uses its own AudioContext) ──
  async startMicPreview() {
    try {
      const deviceId = this.getSelectedMicDeviceId();
      const audioConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : true;

      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });

      if (!this.micPreviewCtx || this.micPreviewCtx.state === 'closed') {
        this.micPreviewCtx = new AudioContext();
      }
      if (this.micPreviewCtx.state === 'suspended') {
        await this.micPreviewCtx.resume();
      }

      const micSource = this.micPreviewCtx.createMediaStreamSource(this.micStream);
      this.micAnalyser = this.micPreviewCtx.createAnalyser();
      this.micAnalyser.fftSize = 1024;
      this.micAnalyser.smoothingTimeConstant = 0.7;

      // Insert gain node between source and analyser so the slider works in real-time
      this.micGainNode = this.micPreviewCtx.createGain();
      this.micGainNode.gain.value = this.micGainValue;

      // CRITICAL: Chromium stops processing nodes not connected to destination.
      // Route through a silent GainNode (gain=0) to keep the graph active.
      const silentGain = this.micPreviewCtx.createGain();
      silentGain.gain.value = 0;
      micSource.connect(this.micGainNode);
      this.micGainNode.connect(this.micAnalyser);
      this.micAnalyser.connect(silentGain);
      silentGain.connect(this.micPreviewCtx.destination);

      const dataArray = new Float32Array(this.micAnalyser.fftSize);
      // Fresh DOM ref in case bindElements ran before this element existed
      const fillEl = document.getElementById('mic-level-fill') || this.micLevelFill;

      const updateLevel = () => {
        if (!this.micAnalyser) return;

        this.micAnalyser.getFloatTimeDomainData(dataArray);

        // Compute RMS
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
        const rms = Math.sqrt(sum / dataArray.length);

        // Convert to dB — this is how real VU meters work.
        // Map: -60 dB (noise floor) → 0%, 0 dB (clip) → 100%
        // Typical speech: -30 to -15 dB → 50% to 75%
        const db = rms > 0.00001 ? 20 * Math.log10(rms) : -100;
        const pct = Math.max(0, Math.min(100, (db + 60) * (100 / 60)));

        if (fillEl) {
          fillEl.style.width = `${pct}%`;
          if (pct > 80) {
            fillEl.style.background = '#ef4444';      // red — clipping
          } else if (pct > 55) {
            fillEl.style.background = '#f59e0b';      // amber — loud
          } else {
            fillEl.style.background = 'linear-gradient(135deg, #10b981, #34d399)'; // green — normal
          }
        }

        this.micAnimFrame = requestAnimationFrame(updateLevel);
      };
      updateLevel();
    } catch (err) {
      console.error('[MIC] startMicPreview error:', err);
      App.showToast('Microphone access denied', 'error');
    }
  }

  stopMicPreview() {
    if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
    if (this.micAnimFrame) { cancelAnimationFrame(this.micAnimFrame); this.micAnimFrame = null; }
    this.micAnalyser = null;
    this.micGainNode = null;
    if (this.micLevelFill) this.micLevelFill.style.width = '0%';
    if (this.micPreviewCtx && this.micPreviewCtx.state !== 'closed') {
      this.micPreviewCtx.close().catch(() => {});
      this.micPreviewCtx = null;
    }
  }

  // ── Recording ──
  async toggleRecording() {
    // #12: guard against double-click during countdown
    if (this.isStarting) return;

    if (this.isRecording) {
      this.stopRecording();
    } else {
      // #9: check source before wasting 3s on countdown
      if (!this.selectedSourceId) {
        App.showToast('Please select a source first', 'warning');
        return;
      }
      await this.startRecordingWithCountdown();
    }
  }

  async startRecordingWithCountdown() {
    this.isStarting = true; // #12

    // Use floating countdown window instead of in-app overlay
    await window.snapforge.showCountdown();
    // Give the window a moment to load
    await new Promise(r => setTimeout(r, 400));

    for (let i = 3; i > 0; i--) {
      await window.snapforge.countdownTick(i);
      window.soundEngine?.playCountdownBeep();
      await new Promise(r => setTimeout(r, 1000));
    }

    await window.snapforge.hideCountdown();
    window.soundEngine?.playRecStart();

    try {
      await this.startRecording();
    } finally {
      this.isStarting = false; // #12
    }
  }

  async startRecording() {
    const systemAudio = document.getElementById('opt-system-audio').checked;
    const micAudio = document.getElementById('opt-mic-audio').checked;
    const resolution = document.getElementById('opt-resolution').value;
    const framerate = parseInt(document.getElementById('opt-framerate').value);

    // #11: stop mic preview before recording to avoid conflicts
    this.stopMicPreview();

    try {
      let sourceId = this.selectedSourceId;
      if (sourceId === '__screen__') {
        const sources = await window.snapforge.getSources();
        const screenSource = sources.find(s => s.id.startsWith('screen:'));
        if (!screenSource) throw new Error('No screen source available');
        sourceId = screenSource.id;
      }

      const videoConstraints = {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: framerate
        }
      };

      if (resolution !== 'source' && !this.recordRegion) {
        const h = parseInt(resolution);
        videoConstraints.mandatory.maxHeight = h;
      }

      this.screenStream = await navigator.mediaDevices.getUserMedia({
        audio: systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
        video: videoConstraints
      });

      await this.setupCompositeCanvas(framerate);

      // #6: Use dedicated recording AudioContext
      const ctx = this.getRecordingAudioContext();
      const dest = ctx.createMediaStreamDestination();
      let hasAudio = false;

      if (systemAudio && this.screenStream.getAudioTracks().length > 0) {
        const sysSource = ctx.createMediaStreamSource(new MediaStream(this.screenStream.getAudioTracks()));
        sysSource.connect(dest);
        hasAudio = true;
      }

      if (micAudio) {
        try {
          const deviceId = this.getSelectedMicDeviceId();
          const audioConstraints = deviceId
            ? { deviceId: { exact: deviceId } }
            : true;
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false
          });
          const micSource = ctx.createMediaStreamSource(micStream);
          // Apply the same gain the user set during preview
          const recGain = ctx.createGain();
          recGain.gain.value = this.micGainValue;
          micSource.connect(recGain);
          recGain.connect(dest);
          hasAudio = true;
          this._recordingMicStream = micStream;
        } catch (err) {
          console.warn('Could not add mic audio:', err);
          App.showToast('Could not access microphone for recording', 'warning');
        }
      }

      const canvasStream = this.compositeCanvas.captureStream(framerate);
      const finalTracks = [...canvasStream.getVideoTracks()];
      if (hasAudio) finalTracks.push(...dest.stream.getAudioTracks());
      this.compositeStream = new MediaStream(finalTracks);

      this.previewVideo.srcObject = this.compositeStream;
      this.previewEl.style.display = 'block';

      this.recordedChunks = [];
      this.cursorEffects = [];

      // Determine bitrates — VP9+Opus optimal for YouTube (Chromium supports natively)
      const bitrateOverride = document.getElementById('opt-bitrate')?.value || 'auto';
      const audioBitrate    = parseInt(document.getElementById('opt-audio-bitrate')?.value || '192000');
      const videoBitrate    = this.getVideoBitrate(
        this.compositeCanvas.width, this.compositeCanvas.height, framerate, bitrateOverride
      );
      console.log(`Bitrate targets — Video: ${(videoBitrate/1e6).toFixed(1)} Mbps | Audio: ${audioBitrate/1000} kbps`);
      // Store for file size estimate
      this._videoBitrate = videoBitrate;
      this._audioBitrate = audioBitrate;

      // Codec priority: VP9+Opus → VP9 → VP8+Opus → VP8 → browser default
      let recorder = null;
      const codecs = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp8',
        'video/webm'
      ];
      const recorderOptions = {
        videoBitsPerSecond: videoBitrate,
        ...(hasAudio ? { audioBitsPerSecond: audioBitrate } : {})
      };
      for (const codec of codecs) {
        if (MediaRecorder.isTypeSupported(codec)) {
          try {
            recorder = new MediaRecorder(this.compositeStream, { mimeType: codec, ...recorderOptions });
            console.log(`Codec: ${codec}`);
            break;
          } catch (e) { continue; }
        }
      }
      if (!recorder) {
        recorder = new MediaRecorder(this.compositeStream, recorderOptions);
      }
      this.mediaRecorder = recorder;

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => this.onRecordingStop();
      // Use timeslice to collect data incrementally
      this.mediaRecorder.start(1000);

      this.isRecording = true;
      this.isPaused = false;
      this.startTime = Date.now();
      this.elapsed = 0;
      this.startTimer();
      this.updateUI();

      window.snapforge.updateRecordingState(true, false, this.recordRegion || null);
      const label = this.recordRegion ? `Recording region ${this.recordRegion.width}×${this.recordRegion.height}` : 'Recording started!';
      App.showToast(label, 'info');

      // Setup auto-stop
      const autoStopMin = parseInt(document.getElementById('opt-auto-stop')?.value || 0);
      this.setupAutoStop(autoStopMin);
    } catch (err) {
      console.error('Recording failed:', err);
      App.showToast('Failed to start recording: ' + err.message, 'error');
      this.isStarting = false; // #12
    }
  }

  stopRecording() {
    this.isRecording = false;
    this.isPaused = false;
    this.stopTimer();
    this.updateUI();
    this.clearAutoStop();
    window.snapforge.updateRecordingState(false, false);
    window.soundEngine?.playRecStop();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  cleanupStreams() {
    this.stopCompositeCanvas();
    if (this.screenStream) { this.screenStream.getTracks().forEach(t => t.stop()); this.screenStream = null; }
    if (this._recordingMicStream) { this._recordingMicStream.getTracks().forEach(t => t.stop()); this._recordingMicStream = null; }
    if (this.compositeStream) { this.compositeStream.getTracks().forEach(t => t.stop()); this.compositeStream = null; }
    this.closeRecordingAudioContext();
  }

  togglePause() {
    if (!this.isRecording || !this.mediaRecorder) return;
    if (this.isPaused) {
      this.mediaRecorder.resume();
      this.isPaused = false;
      this.startTime = Date.now() - (this.elapsed * 1000);
      this.stopTimer();
      this.startTimer();
      window.soundEngine?.playResume();
    } else {
      this.mediaRecorder.pause();
      this.isPaused = true;
      this.stopTimer();
      window.soundEngine?.playPause();
    }
    this.updateUI();
    window.snapforge.updateRecordingState(true, this.isPaused);
  }

  // ── Save + auto-open ──
  async onRecordingStop() {
    console.log(`Recording stopped. Chunks: ${this.recordedChunks.length}`);

    if (this.recordedChunks.length === 0) {
      App.showToast('No recording data captured', 'error');
      this.cleanupStreams();
      return;
    }

    const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder?.mimeType || 'video/webm' });
    console.log(`Blob size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

    if (blob.size < 1000) {
      App.showToast('Recording too small — may be empty', 'error');
      this.cleanupStreams();
      return;
    }

    try {
      // Convert entire blob to ArrayBuffer, then Uint8Array for IPC
      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      console.log(`Sending ${uint8.length} bytes to main process...`);

      const customName = document.getElementById('output-filename')?.value?.trim() || null;
      const filePath = await window.snapforge.saveRecordingDirect(uint8, customName);
      window.soundEngine?.playSaveSuccess();
      // U3: Show save toast with an inline "Copy Path" button
      App.showToastWithAction('Recording saved!', 'success', 'Copy Path', () => {
        if (filePath) navigator.clipboard.writeText(filePath).catch(() => {});
      });

      this.previewVideo.srcObject = null;
      this.previewEl.style.display = 'none';

      if (filePath) {
        window.snapforge.openFile(filePath);
      }
    } catch (err) {
      console.error('Failed to save recording:', err);
      window.soundEngine?.playError();
      App.showToast('Failed to save recording: ' + err.message, 'error', 3000, true); // noSound: sound already played above
    } finally {
      this.cleanupStreams();
    }
  }

  // ── Timer ──
  startTimer() {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      this.elapsed = (Date.now() - this.startTime) / 1000;
      const fullTime = App.formatTime(this.elapsed);
      this.previewTime.textContent = fullTime;
      this.recTimer.textContent = fullTime;
      window.snapforge.updateFloatingTimer(fullTime);
      // File size estimate
      if (this.previewFilesize) {
        const totalBps = (this._videoBitrate + this._audioBitrate) / 8;
        const estimatedBytes = totalBps * this.elapsed;
        this.previewFilesize.textContent = this.formatFileSize(estimatedBytes);
      }
    }, 200);
  }

  stopTimer() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
  }

  // ── UI Updates ──
  updateUI() {
    if (this.isRecording) {
      this.btnRecord.classList.add('recording');
      this.btnRecordLabel.textContent = 'Stop Recording';
      this.btnPause.style.display = 'flex';
      this.recIndicator.style.display = 'flex';

      if (this.isPaused) {
        this.btnPauseLabel.textContent = 'Resume';
        const dot = this.previewStatus.querySelector('.status-dot');
        const label = this.previewStatus.querySelector('span');
        if (dot) dot.className = 'status-dot paused';
        if (label) { label.textContent = 'Paused'; label.style.color = 'var(--accent-amber)'; }
      } else {
        this.btnPauseLabel.textContent = 'Pause';
        const dot = this.previewStatus.querySelector('.status-dot');
        const label = this.previewStatus.querySelector('span');
        if (dot) dot.className = 'status-dot recording';
        if (label) { label.textContent = 'Recording'; label.style.color = ''; }
      }
    } else {
      this.btnRecord.classList.remove('recording');
      this.btnRecordLabel.textContent = 'Start Recording';
      this.btnPause.style.display = 'none';
      this.recIndicator.style.display = 'none';
    }
  }

  // ── Composite Canvas ──
  async setupCompositeCanvas(framerate) {
    this._sourceVideo = document.createElement('video');
    this._sourceVideo.srcObject = this.screenStream;
    this._sourceVideo.muted = true;
    await this._sourceVideo.play();

    await new Promise(resolve => {
      if (this._sourceVideo.videoWidth > 0) return resolve();
      this._sourceVideo.addEventListener('loadedmetadata', resolve, { once: true });
    });

    const vw = this._sourceVideo.videoWidth;
    const vh = this._sourceVideo.videoHeight;

    // #7: Use video dimensions (actual pixels) for region mapping, not screen.width
    if (this.recordRegion) {
      const r = this.recordRegion;
      // screen.width is logical pixels; video may be physical pixels
      // Use the ratio between video size and screen size for proper DPI mapping
      const scaleX = vw / window.screen.width;
      const scaleY = vh / window.screen.height;
      this._regionInVideo = {
        x: Math.round(r.x * scaleX),
        y: Math.round(r.y * scaleY),
        w: Math.round(r.width * scaleX),
        h: Math.round(r.height * scaleY)
      };
      this.compositeCanvas = document.createElement('canvas');
      this.compositeCanvas.width = this._regionInVideo.w;
      this.compositeCanvas.height = this._regionInVideo.h;
    } else {
      this._regionInVideo = null;
      this.compositeCanvas = document.createElement('canvas');
      this.compositeCanvas.width = vw;
      this.compositeCanvas.height = vh;
    }

    // Store the actual video-to-screen ratio for cursor mapping
    this._videoScaleX = vw / window.screen.width;
    this._videoScaleY = vh / window.screen.height;

    this.compositeCtx = this.compositeCanvas.getContext('2d');
    // High-quality interpolation — helps with region scale-ups and high-DPI displays
    this.compositeCtx.imageSmoothingEnabled = true;
    this.compositeCtx.imageSmoothingQuality = 'high';
    // Store framerate so the render loop fires at the correct interval
    this._framerate = framerate;
    this.cursorEffects = [];
    this.zoomState = { active: false, x: 0, y: 0, progress: 0, phase: 'idle' };
    this.renderComposite();
  }

  stopCompositeCanvas() {
    if (this.compositeAnimFrame) { cancelAnimationFrame(this.compositeAnimFrame); this.compositeAnimFrame = null; }
    if (this._compositeTimer) { clearTimeout(this._compositeTimer); this._compositeTimer = null; }
    if (this._sourceVideo) { this._sourceVideo.srcObject = null; this._sourceVideo = null; }
  }

  // Draw a region from the source video onto the canvas without stretching.
  // If the region exceeds the video bounds (e.g. 1080×1920 portrait on a 1920×1080 landscape screen)
  // we clamp the source and map only the valid pixels to the proportionally correct canvas area.
  // The remainder stays black (from clearRect), giving clean letterboxing/pillarboxing.
  drawRegionCovered(ctx, video, region, dstW, dstH) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Clamp source rect to the actual video frame
    const srcX = Math.max(0, region.x);
    const srcY = Math.max(0, region.y);
    const srcW = Math.min(region.w, vw - srcX);
    const srcH = Math.min(region.h, vh - srcY);

    if (srcW <= 0 || srcH <= 0) return; // nothing visible

    // What fraction of the requested region is actually in-bounds?
    const offX  = (srcX - region.x) / region.w; // left offset fraction
    const offY  = (srcY - region.y) / region.h; // top  offset fraction
    const fracW = srcW / region.w;               // width  coverage fraction
    const fracH = srcH / region.h;               // height coverage fraction

    // Map those fractions to canvas destination coordinates
    const destX = offX  * dstW;
    const destY = offY  * dstH;
    const destW = fracW * dstW;
    const destH = fracH * dstH;

    ctx.drawImage(video, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
  }

  renderComposite() {
    const ctx = this.compositeCtx;
    const canvas = this.compositeCanvas;
    const video = this._sourceVideo;

    if (!ctx || !video || !canvas) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const region = this._regionInVideo;

    // Handle auto-zoom
    if (this.zoomState.active && this.autoZoomEnabled) {
      const z = this.zoomState;
      const scale = 1 + (this.zoomLevel - 1) * z.progress;
      ctx.save();
      ctx.translate(z.x, z.y);
      ctx.scale(scale, scale);
      ctx.translate(-z.x, -z.y);
      if (region) {
        this.drawRegionCovered(ctx, video, region, w, h);
      } else {
        ctx.drawImage(video, 0, 0, w, h);
      }
      ctx.restore();
    } else {
      if (region) {
        this.drawRegionCovered(ctx, video, region, w, h);
      } else {
        ctx.drawImage(video, 0, 0, w, h);
      }
    }

    // Draw cursor highlight
    const cursorPos = this.systemCursorPos;
    if (this.cursorHighlightEnabled && cursorPos) {
      let px, py;
      if (region) {
        const sourceVw = this._sourceVideo.videoWidth;
        const sourceVh = this._sourceVideo.videoHeight;
        const screenCursorVx = cursorPos.relX * sourceVw;
        const screenCursorVy = cursorPos.relY * sourceVh;
        px = screenCursorVx - region.x;
        py = screenCursorVy - region.y;
        if (px < 0 || py < 0 || px > w || py > h) { px = null; }
      } else {
        px = cursorPos.relX * w;
        py = cursorPos.relY * h;
      }

      if (px !== null) {
        const scaleFactor = w / 1920;
        const size = this.cursorSize * Math.max(scaleFactor, 0.5);

        const gradient = ctx.createRadialGradient(px, py, 0, px, py, size);
        gradient.addColorStop(0, this.cursorColor + '40');
        gradient.addColorStop(0.7, this.cursorColor + '20');
        gradient.addColorStop(1, this.cursorColor + '00');
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, size * 0.6, 0, Math.PI * 2);
        ctx.strokeStyle = this.cursorColor + '90';
        ctx.lineWidth = 2.5 * Math.max(scaleFactor, 0.5);
        ctx.stroke();
      }
    }

    // Draw click ripple effects
    const now = performance.now();
    this.cursorEffects = this.cursorEffects.filter(effect => {
      const elapsed = now - effect.startTime;
      const duration = 600;
      const progress = Math.min(elapsed / duration, 1);
      if (progress >= 1) return false;

      const eased = 1 - Math.pow(1 - progress, 3);
      const scaleFactor = w / 1920;
      const maxR = 50 * Math.max(scaleFactor, 0.5);
      const radius = maxR * eased;
      const opacity = 0.7 * (1 - progress);

      let ex, ey;
      if (region) {
        const sourceVw = this._sourceVideo.videoWidth;
        const sourceVh = this._sourceVideo.videoHeight;
        ex = effect.relX * sourceVw - region.x;
        ey = effect.relY * sourceVh - region.y;
        if (ex < 0 || ey < 0 || ex > w || ey > h) return false;
      } else {
        ex = effect.relX * w;
        ey = effect.relY * h;
      }

      ctx.beginPath();
      ctx.arc(ex, ey, radius, 0, Math.PI * 2);
      ctx.strokeStyle = this.cursorColor + Math.round(opacity * 255).toString(16).padStart(2, '0');
      ctx.lineWidth = 3 * (1 - progress) * Math.max(scaleFactor, 0.5);
      ctx.stroke();

      return true;
    });

    // Advance zoom animation
    if (this.zoomState.active) {
      const z = this.zoomState;
      const elapsed = now - z.startTime;
      const zoomIn = this.zoomDuration;
      const hold = 800;
      const total = zoomIn + hold + zoomIn;

      if (elapsed < zoomIn) {
        z.progress = 1 - Math.pow(1 - (elapsed / zoomIn), 3);
      } else if (elapsed < zoomIn + hold) {
        z.progress = 1;
      } else if (elapsed < total) {
        z.progress = Math.pow(1 - ((elapsed - zoomIn - hold) / zoomIn), 3);
      } else {
        z.active = false;
        z.progress = 0;
      }
    }

    // Use setTimeout instead of requestAnimationFrame — rAF stops when window is minimized!
    // Fire at the user-selected FPS (e.g. 16.67ms for 60fps, 33.33ms for 30fps)

    // Draw webcam overlay (always on top of everything)
    this.drawWebcam(ctx, w, h);

    this._compositeTimer = setTimeout(() => this.renderComposite(), 1000 / (this._framerate || 30));
  }

  triggerClickEffect(relX, relY) {
    if (this.clickEffectsEnabled) {
      this.cursorEffects.push({ relX, relY, startTime: performance.now() });
    }

    if (this.autoZoomEnabled && !this.zoomState.active && this.compositeCanvas) {
      const w = this.compositeCanvas.width;
      const h = this.compositeCanvas.height;
      let zx, zy;
      if (this._regionInVideo) {
        const sourceVw = this._sourceVideo.videoWidth;
        const sourceVh = this._sourceVideo.videoHeight;
        zx = relX * sourceVw - this._regionInVideo.x;
        zy = relY * sourceVh - this._regionInVideo.y;
        if (zx < 0 || zy < 0 || zx > w || zy > h) return;
      } else {
        zx = relX * w;
        zy = relY * h;
      }

      this.zoomState = {
        active: true,
        x: zx,
        y: zy,
        progress: 0,
        startTime: performance.now(),
        phase: 'in'
      };
    }
  }
}

// Initialize recorder
window.recorder = new Recorder();
