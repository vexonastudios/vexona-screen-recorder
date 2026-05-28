/**
 * Vexona Screen Recorder — UI Sound Engine
 *
 * Synthesizes all UI audio feedback via the Web Audio API.
 * Uses a single, lazily-created AudioContext that is NEVER routed into the
 * recording pipeline, so no sound ever bleeds into the captured video.
 *
 * Exposed as: window.soundEngine
 */

class SoundEngine {
  constructor() {
    this._ctx = null;
    // Q3: migrate old key transparently
    const legacy = localStorage.getItem('snapforge_sound_muted');
    if (legacy !== null && !localStorage.getItem('vexona_sound_muted')) {
      localStorage.setItem('vexona_sound_muted', legacy);
      localStorage.removeItem('snapforge_sound_muted');
    }
    this._muted = localStorage.getItem('vexona_sound_muted') === 'true';
  }

  // ── AudioContext — lazy-init + resume on demand ──
  getCtx() {
    if (!this._ctx || this._ctx.state === 'closed') {
      this._ctx = new AudioContext();
    }
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }
    return this._ctx;
  }

  // ── Mute control ──
  get muted() { return this._muted; }
  set muted(val) {
    this._muted = val;
    localStorage.setItem('vexona_sound_muted', val ? 'true' : 'false');
    this._updateToggleBtn();
  }

  toggle() {
    this.muted = !this._muted;
  }

  _updateToggleBtn() {
    const btn = document.getElementById('btn-sound-toggle');
    if (!btn) return;
    const icon = btn.querySelector('.sound-icon');
    if (icon) icon.textContent = this._muted ? '🔇' : '🔊';
    btn.title = this._muted ? 'Sounds muted — click to unmute' : 'Sounds on — click to mute';
    btn.classList.toggle('muted', this._muted);
  }

  // ── Internal oscillator helper ──
  _osc(type, freq, startTime, duration, gainPeak = 0.3, destination = null) {
    const ctx = this.getCtx();
    const dest = destination || ctx.destination;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);

    // Attack + release envelope
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }

  // ── Internal noise burst helper (for shutter) ──
  _noise(startTime, duration, gainPeak = 0.15) {
    const ctx = this.getCtx();
    const sampleRate = ctx.sampleRate;
    const bufLen = Math.ceil(sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufLen, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // High-pass filter — gives it that crisp camera-click character
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 4000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainPeak, startTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    source.connect(hpf);
    hpf.connect(gain);
    gain.connect(ctx.destination);

    source.start(startTime);
    source.stop(startTime + duration + 0.01);
  }

  // ── Sound Definitions ──

  /** Ultra-soft 8kHz tick — subtle UI click feedback */
  playClick() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    this._osc('sine', 8000, t, 0.008, 0.07);
  }

  /** Countdown beep — single mid-high sine (replaces recorder's playCountdownBeep) */
  playCountdownBeep() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    this._osc('sine', 660, t, 0.12, 0.25);
  }

  /** Recording start — 3-note ascending arpeggio: feels energetic and ready */
  playRecStart() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    this._osc('sine', 330, t,        0.12, 0.30);
    this._osc('sine', 440, t + 0.10, 0.12, 0.30);
    this._osc('sine', 550, t + 0.20, 0.18, 0.35);
  }

  /** Recording stop — descending sweep: signals "done" */
  playRecStop() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.25);

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.30, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.35);
  }

  /** Pause — single mid bip */
  playPause() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    this._osc('sine', 400, t,        0.08, 0.22);
    this._osc('sine', 400, t + 0.10, 0.08, 0.22);
  }

  /** Resume — two-tone da-dum (ascending, more energetic than pause) */
  playResume() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    this._osc('sine', 400, t,        0.10, 0.22);
    this._osc('sine', 550, t + 0.12, 0.14, 0.28);
  }

  /** Screenshot shutter — high-pass noise burst + click pop */
  playShutter() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    // Mechanical pop component
    this._osc('square', 3200, t, 0.015, 0.25);
    // Noise component (the "hiss" of a shutter)
    this._noise(t + 0.005, 0.035, 0.18);
    // Trailing click
    this._osc('sine', 6000, t + 0.03, 0.012, 0.12);
  }

  /** Save success — gentle rising chime triplet */
  playSaveSuccess() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    this._osc('sine', 392, t,        0.22, 0.22); // G4
    this._osc('sine', 523, t + 0.09, 0.22, 0.22); // C5
    this._osc('sine', 659, t + 0.18, 0.28, 0.28); // E5
  }

  /** Error — low descending buzz */
  playError() {
    if (this._muted) return;
    const ctx = this.getCtx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(280, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.22);

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  // ── Initialization ──
  init() {
    // Sync the mute toggle button state on load
    this._updateToggleBtn();

    // Wire the mute toggle button
    const btn = document.getElementById('btn-sound-toggle');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't trigger the global click sound for this
        this.toggle();
      });
    }

    // Global click sound: all buttons and interactive elements within the app window
    document.addEventListener('click', (e) => {
      if (this._muted) return;
      const target = e.target.closest('button, .source-item, .nav-item, .action-card, .filter-btn, .gallery-item');
      if (!target) return;
      // Skip the record / pause buttons — they have richer sounds
      const skipIds = ['btn-record', 'btn-pause', 'btn-sound-toggle'];
      if (skipIds.some(id => target.id === id || target.closest(`#${id}`))) return;
      this.playClick();
    }, true); // capture phase so it fires before any stopPropagation
  }
}

window.soundEngine = new SoundEngine();
