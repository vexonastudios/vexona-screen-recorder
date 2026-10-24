const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  { pathToFileURL } = require("node:url"),
  fs = require("node:fs");
const { assertSender } = require("../src/main/ipc-security");
test("privileged IPC accepts only the owning main frame and exact packaged page", () => {
  const file = path.resolve(__dirname, "../src/renderer/index.html"),
    frame = { url: pathToFileURL(file).href },
    contents = { mainFrame: frame },
    window = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => assertSender(event, window, file));
  assert.throws(
    () => assertSender({ ...event, sender: {} }, window, file),
    /sender/,
  );
  assert.throws(
    () =>
      assertSender({ ...event, senderFrame: { url: frame.url } }, window, file),
    /sender/,
  );
  frame.url = "https://untrusted.invalid";
  assert.throws(() => assertSender(event, window, file), /page/);
});
test("all windows keep sandbox and web security; every HTML page has CSP and external local scripts", () => {
  const root = path.resolve(__dirname, "../src/renderer");
  const main = fs.readFileSync(path.join(root, "../main/main.js"), "utf8");
  assert.ok(!/sandbox:\s*false|webSecurity:\s*false/.test(main));
  assert.ok(main.includes("backgroundThrottling: false"));
  for (const file of [
    "index.html",
    ...fs
      .readdirSync(path.join(root, "pages"))
      .filter((f) => f.endsWith(".html"))
      .map((f) => "pages/" + f),
  ]) {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(html.includes("Content-Security-Policy"), file);
    assert.ok(!/<script>/.test(html), file);
    assert.ok(!html.includes("https://fonts."), file);
  }
});
