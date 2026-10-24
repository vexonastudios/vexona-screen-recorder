window.snapforge.onRegionContext((context) => {
  document.getElementById("btn-record-go").lastChild.textContent =
    context.purpose === "screenshot" ? "Capture" : "Record";
  document.getElementById("instructions").textContent =
    "Drag to select an area. Press Enter to confirm or Esc to cancel.";
});

const overlay = document.getElementById("overlay");
const selection = document.getElementById("selection");
const dimLabel = document.getElementById("dim-label");
const instructions = document.getElementById("instructions");
const toolbar = document.getElementById("toolbar");
const toolbarDim = document.getElementById("toolbar-dim");

let startX, startY;
let isDrawing = false;
let isConfirmed = false;
let isDragging = false;
let isResizing = false;
let resizeHandle = null;
let dragOffsetX, dragOffsetY;
let resizeStartRect = null;
let resizeStartMouse = null;

// Current region
let region = { x: 0, y: 0, w: 0, h: 0 };

function updateRegionDisplay() {
  selection.style.left = `${region.x}px`;
  selection.style.top = `${region.y}px`;
  selection.style.width = `${region.w}px`;
  selection.style.height = `${region.h}px`;

  dimLabel.style.left = `${region.x}px`;
  dimLabel.style.top = `${region.y + region.h + 8}px`;
  dimLabel.textContent = `${region.w} × ${region.h}`;

  toolbarDim.textContent = `${region.w} × ${region.h}`;
}

function confirmSelection() {
  isConfirmed = true;
  isDrawing = false;
  selection.classList.add("confirmed");
  dimLabel.style.display = "none";
  instructions.classList.add("hidden");
  toolbar.classList.add("visible");
  overlay.style.cursor = "default";
}

function resetToDrawing() {
  isConfirmed = false;
  selection.style.display = "none";
  selection.classList.remove("confirmed");
  dimLabel.style.display = "none";
  toolbar.classList.remove("visible");
  instructions.classList.remove("hidden");
  overlay.style.cursor = "crosshair";
}

// ── Drawing ──
overlay.addEventListener("mousedown", (e) => {
  if (isConfirmed) {
    // Check if clicking on the selection to drag it
    const r = selection.getBoundingClientRect();
    if (
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    ) {
      // Check for resize handle
      const handle = e.target.closest(".handle");
      if (handle) {
        isResizing = true;
        resizeHandle = handle.dataset.handle;
        resizeStartRect = { ...region };
        resizeStartMouse = { x: e.clientX, y: e.clientY };
        return;
      }
      // Start dragging
      isDragging = true;
      dragOffsetX = e.clientX - region.x;
      dragOffsetY = e.clientY - region.y;
      return;
    }
    // Clicked outside selection — start new drawing
    resetToDrawing();
  }

  // Start new drawing
  startX = e.clientX;
  startY = e.clientY;
  isDrawing = true;
  selection.style.display = "block";
  dimLabel.style.display = "block";
});

overlay.addEventListener("mousemove", (e) => {
  if (isResizing && resizeHandle) {
    const dx = e.clientX - resizeStartMouse.x;
    const dy = e.clientY - resizeStartMouse.y;
    const r = { ...resizeStartRect };

    // Apply resize based on handle
    if (resizeHandle.includes("r")) {
      r.w = Math.max(50, r.w + dx);
    }
    if (resizeHandle.includes("l")) {
      r.x = r.x + dx;
      r.w = Math.max(50, r.w - dx);
    }
    if (resizeHandle.includes("b")) {
      r.h = Math.max(50, r.h + dy);
    }
    if (resizeHandle.includes("t")) {
      r.y = r.y + dy;
      r.h = Math.max(50, r.h - dy);
    }

    region = {
      x: Math.max(0, Math.min(r.x, innerWidth - 20)),
      y: Math.max(0, Math.min(r.y, innerHeight - 20)),
      w: Math.min(r.w, innerWidth - Math.max(0, r.x)),
      h: Math.min(r.h, innerHeight - Math.max(0, r.y)),
    };
    updateRegionDisplay();
    return;
  }

  if (isDragging) {
    region.x = Math.max(
      0,
      Math.min(e.clientX - dragOffsetX, window.innerWidth - region.w),
    );
    region.y = Math.max(
      0,
      Math.min(e.clientY - dragOffsetY, window.innerHeight - region.h),
    );
    updateRegionDisplay();
    return;
  }

  if (!isDrawing) return;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);

  region = { x, y, w, h };
  updateRegionDisplay();
  selection.style.display = "block";
  dimLabel.style.display = "block";
});

overlay.addEventListener("mouseup", (e) => {
  if (isResizing) {
    isResizing = false;
    resizeHandle = null;
    return;
  }
  if (isDragging) {
    isDragging = false;
    return;
  }
  if (!isDrawing) return;
  isDrawing = false;

  if (region.w > 20 && region.h > 20) {
    confirmSelection();
  } else {
    selection.style.display = "none";
    dimLabel.style.display = "none";
  }
});

// ── Toolbar Actions ──
document.getElementById("btn-record-go").addEventListener("click", () => {
  if (region.w > 10 && region.h > 10) {
    window.snapforge.regionRecordStart({
      x: region.x,
      y: region.y,
      width: region.w,
      height: region.h,
    });
  }
});

document.getElementById("btn-redraw").addEventListener("click", () => {
  resetToDrawing();
});

document.getElementById("btn-cancel").addEventListener("click", () => {
  window.snapforge.regionCancelled();
});

// ── Keyboard ──
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.snapforge.regionCancelled();
  }
  if (e.key === "Enter" && isConfirmed && region.w > 10 && region.h > 10) {
    window.snapforge.regionRecordStart({
      x: region.x,
      y: region.y,
      width: region.w,
      height: region.h,
    });
  }
});
