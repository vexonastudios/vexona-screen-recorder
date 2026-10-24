const path = require("node:path");
const { fileURLToPath } = require("node:url");
function assertSender(event, window, expectedFile) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw Error("Untrusted IPC sender.");
  const url = new URL(event.senderFrame.url);
  if (
    url.protocol !== "file:" ||
    url.search ||
    path.resolve(fileURLToPath(url)) !== path.resolve(expectedFile)
  )
    throw Error("Untrusted IPC page.");
}
function protectWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  return window;
}
module.exports = { assertSender, protectWindow };
