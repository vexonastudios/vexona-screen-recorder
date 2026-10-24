const timer = document.getElementById("timer");
const recDot = document.getElementById("rec-dot");
const statusLabel = document.getElementById("status-label");
const btnPause = document.getElementById("btn-pause");
const btnStop = document.getElementById("btn-stop");

let isPaused = false;

// Listen for timer updates from main process
window.snapforge.onTimerUpdate((time) => {
  timer.textContent = time;
});

window.snapforge.onPauseStateChange((paused) => {
  isPaused = paused;
  recDot.className = paused ? "rec-dot paused" : "rec-dot";
  statusLabel.className = paused ? "status-label paused" : "status-label";
  statusLabel.textContent = paused ? "PAUSED" : "REC";

  // Swap pause/resume icon
  btnPause.innerHTML = paused
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  btnPause.title = paused ? "Resume" : "Pause";
});

btnPause.addEventListener("click", () => {
  window.snapforge.floatingAction("pause");
});

btnStop.addEventListener("click", () => {
  window.snapforge.floatingAction("stop");
});
