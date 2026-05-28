/**
 * Vexona Screen Recorder — Main App Controller
 * Fixes: #21 (global error handling)
 */

class App {
  constructor() {
    this.currentPage = 'record';
    this.init();
  }

  init() {
    this.setupWindowControls();
    this.setupNavigation();
    this.setupEventListeners();
    this.setupErrorHandling();
    this.setupOptionsToggle();
    this.loadSettings();
    // Initialize sound engine — wires mute button + global click listener
    window.soundEngine?.init();
  }

  // ── Options Toggle ──
  setupOptionsToggle() {
    const toggle = document.getElementById('options-toggle');
    const panel = document.getElementById('options-panel');
    if (toggle && panel) {
      toggle.addEventListener('click', () => {
        const isOpen = panel.style.display !== 'none';
        panel.style.display = isOpen ? 'none' : 'block';
        toggle.classList.toggle('open', !isOpen);
      });
    }
  }

  // ── Window Controls (#6 — custom resize support) ──
  setupWindowControls() {
    document.getElementById('btn-minimize').addEventListener('click', () => window.snapforge.minimize());
    document.getElementById('btn-maximize').addEventListener('click', () => window.snapforge.maximize());
    document.getElementById('btn-close').addEventListener('click', () => window.snapforge.close());
  }

  // ── Navigation ──
  setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        this.navigateTo(page);
      });
    });
  }

  navigateTo(page) {
    if (page === this.currentPage) return;

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageEl = document.getElementById(`page-${page}`);
    if (pageEl) {
      pageEl.classList.add('active');
      pageEl.style.animation = 'none';
      pageEl.offsetHeight;
      pageEl.style.animation = '';
    }

    this.currentPage = page;

    if (page === 'gallery' && window.galleryManager) {
      window.galleryManager.refresh();
    }
    if (page === 'record' && window.recorder) {
      window.recorder.loadSources();
    }
  }

  // ── Event Listeners ──
  setupEventListeners() {
    window.snapforge.onToggleRecording(() => {
      if (window.recorder) {
        window.recorder.toggleRecording();
      }
    });

    window.snapforge.onTogglePause(() => {
      if (window.recorder) {
        window.recorder.togglePause();
      }
    });

    window.snapforge.onScreenshotSaved((data) => {
      window.soundEngine?.playShutter();
      App.showToast('Screenshot saved!', 'success');
    });
  }

  // ── Global Error Handling (#21) ──
  setupErrorHandling() {
    window.addEventListener('unhandledrejection', (event) => {
      console.error('Unhandled promise rejection:', event.reason);
      App.showToast('An unexpected error occurred', 'error');
    });

    window.addEventListener('error', (event) => {
      console.error('Uncaught error:', event.error);
      App.showToast('An unexpected error occurred', 'error');
    });
  }

  // ── Settings ──
  loadSettings() {
    window.snapforge.getSaveDirs().then(dirs => {
      document.getElementById('path-recordings').textContent = dirs.recordings;
      document.getElementById('path-screenshots').textContent = dirs.screenshots;
    });

    // Browse buttons for save locations (#1)
    document.getElementById('btn-browse-recordings')?.addEventListener('click', async () => {
      const newDir = await window.snapforge.chooseDirectory('recordings');
      if (newDir) {
        document.getElementById('path-recordings').textContent = newDir;
        App.showToast('Recordings folder updated', 'success');
      }
    });

    document.getElementById('btn-browse-screenshots')?.addEventListener('click', async () => {
      const newDir = await window.snapforge.chooseDirectory('screenshots');
      if (newDir) {
        document.getElementById('path-screenshots').textContent = newDir;
        App.showToast('Screenshots folder updated', 'success');
      }
    });

    const colorInput = document.getElementById('cursor-color');
    const colorLabel = document.getElementById('cursor-color-label');
    const colorSwatch = document.getElementById('cursor-color-swatch');
    if (colorInput) {
      colorInput.addEventListener('input', (e) => {
        if (colorLabel) colorLabel.textContent = e.target.value;
        // U7: live swatch
        if (colorSwatch) colorSwatch.style.background = e.target.value;
      });
    }

    const sizeInput = document.getElementById('cursor-size');
    const sizeValue = document.getElementById('cursor-size-value');
    if (sizeInput) {
      sizeInput.addEventListener('input', (e) => {
        sizeValue.textContent = `${e.target.value}px`;
      });
    }
  }

  // ── Toast Notifications ──
  // noSound: pass true when the caller has already played its own sound
  static showToast(message, type = 'info', duration = 3000, noSound = false) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // Play the appropriate UI sound for this notification type
    if (!noSound) {
      if (type === 'error') {
        window.soundEngine?.playError();
      } else if (type === 'success') {
        window.soundEngine?.playSaveSuccess();
      }
    }

    const icons = {
      success: '✅',
      error: '❌',
      info: 'ℹ️',
      warning: '⚠️'
    };

    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icons[type] || icons.info;

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;

    toast.appendChild(iconSpan);
    toast.appendChild(msgSpan);
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // U3: Toast with an inline action button (e.g. "Copy Path")
  static showToastWithAction(message, type = 'success', actionLabel = '', actionFn = null, duration = 5000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type} toast-with-action`;

    if (type === 'success') window.soundEngine?.playSaveSuccess();
    if (type === 'error')   window.soundEngine?.playError();

    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icons[type] || icons.info;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;

    toast.appendChild(iconSpan);
    toast.appendChild(msgSpan);

    if (actionLabel && actionFn) {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action-btn';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        actionFn();
        App.showToast('Copied!', 'info', 1500, true);
      });
      toast.appendChild(actionBtn);
    }

    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ── Utilities ──
  // #10: Always use HH:MM:SS for consistent display
  static formatTime(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  static formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  static formatDate(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(diff / 3600000);

    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hrs < 24) return `${hrs}h ago`;

    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}

// Initialize
const app = new App();
