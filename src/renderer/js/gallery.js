/**
 * Vexona Screen Recorder — Gallery Module
 * Fixes: #11 (actual thumbnails), #17 (open directory vs file)
 */

class GalleryManager {
  constructor() {
    this.captures = [];
    this.currentFilter = 'all';
    this.init();
  }

  init() {
    this.setupFilters();
    this.setupFolderButton();
  }

  setupFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentFilter = btn.dataset.filter;
        this.renderCaptures();
      });
    });
  }

  setupFolderButton() {
    // Fix #17: Use openDirectory for opening a folder
    // U5: Open the folder that corresponds to the current filter
    document.getElementById('btn-open-folder')?.addEventListener('click', async () => {
      const dirs = await window.snapforge.getSaveDirs();
      const dir = this.currentFilter === 'screenshot' ? dirs.screenshots : dirs.recordings;
      window.snapforge.openDirectory(dir);
    });
  }

  async refresh() {
    try {
      this.captures = await window.snapforge.getCaptures();
      this.renderCaptures();
    } catch (err) {
      console.error('Failed to load captures:', err);
    }
  }

  renderCaptures() {
    const grid = document.getElementById('gallery-grid');
    let filtered = this.captures;

    if (this.currentFilter !== 'all') {
      filtered = this.captures.filter(c => c.type === this.currentFilter);
    }

    if (filtered.length === 0) {
      grid.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'gallery-empty';
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48" opacity="0.4">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      `;
      const msg = document.createElement('p');
      msg.textContent = `No ${this.currentFilter === 'all' ? '' : this.currentFilter + ' '}captures yet`;
      empty.appendChild(msg);
      const hint = document.createElement('span');
      hint.textContent = 'Start recording or take a screenshot to see your captures here';
      empty.appendChild(hint);
      grid.appendChild(empty);
      return;
    }

    grid.innerHTML = '';

    filtered.forEach((capture, index) => {
      const item = document.createElement('div');
      item.className = 'gallery-item';
      item.style.animationDelay = `${index * 50}ms`;

      const isVideo = capture.type === 'recording';

      // Thumbnail area
      const thumbDiv = document.createElement('div');
      thumbDiv.className = 'gallery-thumb';

      // Fix #11: Show actual thumbnail images for screenshots
      if (!isVideo) {
        const thumbImg = document.createElement('img');
        // #17: Use proper URL encoding for paths with special characters
        thumbImg.src = `file:///${encodeURI(capture.path.replace(/\\/g, '/').replace(/^\//, ''))}`;
        thumbImg.alt = capture.name;
        thumbImg.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        thumbImg.onerror = () => {
          thumbImg.style.display = 'none';
          thumbDiv.innerHTML += `
            <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" opacity="0.4">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </div>
          `;
        };
        thumbDiv.appendChild(thumbImg);
      } else {
        const videoIcon = document.createElement('div');
        videoIcon.className = 'gallery-thumb-video';
        videoIcon.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" opacity="0.5"/>
          </svg>
        `;
        thumbDiv.appendChild(videoIcon);
      }

      // Type badge
      const badge = document.createElement('span');
      badge.className = `gallery-type-badge ${isVideo ? 'recording' : 'screenshot'}`;
      badge.textContent = isVideo ? 'Video' : 'Image';
      thumbDiv.appendChild(badge);

      item.appendChild(thumbDiv);

      // Info section — safe text rendering
      const info = document.createElement('div');
      info.className = 'gallery-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'gallery-name';
      nameEl.title = capture.name;
      nameEl.textContent = capture.name;
      info.appendChild(nameEl);

      const meta = document.createElement('div');
      meta.className = 'gallery-meta';
      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = App.formatFileSize(capture.size);
      const dateSpan = document.createElement('span');
      dateSpan.textContent = App.formatDate(capture.created);
      meta.appendChild(sizeSpan);
      meta.appendChild(dateSpan);
      info.appendChild(meta);

      item.appendChild(info);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'gallery-actions';

      const openBtn = this.createActionButton('Open', `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      `, () => window.snapforge.openFile(capture.path));

      const folderBtn = this.createActionButton('', `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      `, () => window.snapforge.openFolder(capture.path));
      folderBtn.title = 'Show in folder';

      const deleteBtn = this.createActionButton('', `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      `, async () => {
        // B4: Confirm before deleting
        if (!confirm(`Delete "${capture.name}"?\n\nThis cannot be undone.`)) return;
        const deleted = await window.snapforge.deleteFile(capture.path);
        if (deleted) {
          App.showToast('File deleted', 'info');
          this.refresh();
        }
      });
      deleteBtn.title = 'Delete';
      deleteBtn.style.color = 'var(--accent-red)';

      actions.appendChild(openBtn);
      actions.appendChild(folderBtn);
      actions.appendChild(deleteBtn);
      item.appendChild(actions);

      grid.appendChild(item);
    });
  }

  createActionButton(label, iconSvg, onClick) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.innerHTML = iconSvg;
    if (label) {
      const span = document.createElement('span');
      span.textContent = label;
      btn.appendChild(span);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }
}

// Initialize
window.galleryManager = new GalleryManager();
