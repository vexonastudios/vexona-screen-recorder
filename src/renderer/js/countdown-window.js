const numberEl = document.getElementById("number");
const container = document.getElementById("container");

if (window.snapforge) {
  window.snapforge.onCountdownTick((num) => {
    numberEl.textContent = num;
    // Reset animation
    numberEl.style.animation = "none";
    container.style.animation = "none";
    numberEl.offsetHeight; // force reflow
    numberEl.style.animation =
      "countdownPulse 0.8s cubic-bezier(0.16, 1, 0.3, 1)";
    container.style.animation = "ringPulse 0.8s cubic-bezier(0.16, 1, 0.3, 1)";
  });
}
