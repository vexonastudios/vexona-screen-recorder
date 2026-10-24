const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process"),
  { createHash } = require("node:crypto");
test("release files, updater URLs and checksums have the same canonical names", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "vexona-release-test-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dist"));
  const data = Buffer.from("disposable release fixture"),
    file = "Vexona-Screen-Recorder-Setup-1.0.8.exe";
  await fs.writeFile(
    path.join(root, "dist", "Vexona Screen Recorder Setup 1.0.8.exe"),
    data,
  );
  const yaml = `version: 1.0.8\nfiles:\n  - url: ${file}\n    sha512: ${createHash("sha512").update(data).digest("base64")}\n    size: ${data.length}\npath: ${file}\n`;
  await fs.writeFile(path.join(root, "dist", "latest.yml"), yaml);
  const run = () =>
    spawnSync(process.execPath, [path.resolve("scripts/checksums.cjs")], {
      cwd: root,
      encoding: "utf8",
    });
  assert.equal(run().status, 0);
  assert.deepEqual(await fs.readFile(path.join(root, "dist", file)), data);
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(root, "dist", process.platform + "-SHA256.json"),
      "utf8",
    ),
  );
  assert.equal(
    manifest.find((item) => item.name === file).sha256,
    createHash("sha256").update(data).digest("hex"),
  );
  await fs.writeFile(path.join(root, "dist", file), "tampered fixture");
  assert.notEqual(run().status, 0);
});
