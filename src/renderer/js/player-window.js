const video = document.getElementById("video");

// Receive file path from main process
if (window.snapforge) {
  window.snapforge.onPlayFile((capture) => {
    // Convert Windows path to file:// URL
    const fileUrl = capture.url;
    video.src = fileUrl;
    document.getElementById("title").textContent =
      "Vexona Screen Recorder - " + capture.name;
  });

  document.getElementById("btn-close").addEventListener("click", () => {
    window.close();
  });

  document.getElementById("btn-folder").addEventListener("click", () => {
    window.snapforge.showInFolder();
  });
}
