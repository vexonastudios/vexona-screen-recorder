// Bound device startup and release streams that arrive after cancellation/timeout.
const CaptureRuntime = {
  async getMedia(constraints, current = () => true, timeout = 30000) {
    let expired = false,
      timer;
    const pending = navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        if (expired || !current()) {
          stream.getTracks().forEach((track) => track.stop());
          throw Error("Capture preparation was cancelled. Try again.");
        }
        return stream;
      });
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(
              Error(
                "Capture permission or device timed out. Check permissions and try again.",
              ),
            );
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
  playVideo(video, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", ready);
        video.removeEventListener("error", failed);
      };
      const ready = () => {
        if (video.videoWidth > 0 && video.readyState >= 2) {
          cleanup();
          resolve();
        }
      };
      const failed = () => {
        cleanup();
        reject(Error("Capture did not provide a usable video frame."));
      };
      const timer = setTimeout(failed, timeout);
      video.addEventListener("loadeddata", ready);
      video.addEventListener("error", failed, { once: true });
      Promise.resolve(video.play()).then(ready, failed);
    });
  },
};
if (typeof module !== "undefined") module.exports = { CaptureRuntime };
else window.CaptureRuntime = CaptureRuntime;
