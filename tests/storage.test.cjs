const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const {
  CaptureStore,
  containedFile,
  validatePNG,
  MAX_CHUNK,
} = require("../src/main/capture-store");
const { mediaProtocol } = require("../src/main/media-protocol");
const header = Buffer.from("1a45dfa300010203040506070809", "hex");
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRdwAAAAASUVORK5CYII=";
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "vexona-recorder-test-")),
  );
  t.after(async () => {
    if (!path.basename(root).startsWith("vexona-recorder-test-"))
      throw Error("Unsafe test cleanup");
    await fs.rm(root, { recursive: true, force: true });
  });
  const roots = {
    recordings: path.join(root, "videos"),
    screenshots: path.join(root, "pictures"),
  };
  for (const dir of Object.values(roots)) await fs.mkdir(dir);
  const store = new CaptureStore({
    journalDir: path.join(root, "journal"),
    getRoots: () => roots,
  });
  await store.initialize();
  return { root, roots, store };
}
test("chunks persist before Stop; acknowledgments are idempotent; finalize never overwrites another capture", async (t) => {
  const { store, roots } = await fixture(t),
    session = await store.begin("Lesson ../ one");
  await store.append(session.id, 0, header);
  await store.append(session.id, 0, header);
  const partial = (await fs.readdir(roots.recordings))[0];
  assert.deepEqual(
    await fs.readFile(path.join(roots.recordings, partial)),
    header,
  );
  await assert.rejects(
    store.append(session.id, 3, Buffer.from("late")),
    /order/,
  );
  await assert.rejects(
    store.append(session.id, 1, Buffer.alloc(MAX_CHUNK + 1)),
    /chunk/,
  );
  const file = await store.finish(session.id);
  assert.equal(await store.finish(session.id), file);
  assert.deepEqual(await fs.readFile(file), header);
  const second = await store.begin("Lesson ../ one");
  await store.append(second.id, 0, header);
  const other = await store.finish(second.id);
  assert.notEqual(other, file);
  assert.deepEqual(await fs.readFile(file), header);
});
test("partial disk writes roll back and Retry writes exactly once", async (t) => {
  const { store } = await fixture(t),
    { id } = await store.begin();
  const s = store.session(id),
    write = s.handle.write.bind(s.handle);
  s.handle.write = async (data) => {
    await write(data, 0, 4, 0);
    throw Object.assign(Error("Disk full"), { code: "ENOSPC" });
  };
  await assert.rejects(store.append(id, 0, header), /Disk full/);
  assert.equal(s.bytes, 0);
  s.handle.write = write;
  await store.append(id, 0, header);
  const file = await store.finish(id);
  assert.deepEqual(await fs.readFile(file), header);
});
test("interrupted recordings recover after restart and can move to a new drive before retry", async (t) => {
  const { store, root, roots } = await fixture(t),
    { id } = await store.begin();
  await store.append(id, 0, header);
  await store.preserve(id);
  const restarted = new CaptureStore({
    journalDir: store.journalDir,
    getRoots: () => roots,
  });
  await restarted.initialize();
  assert.equal((await restarted.recoveries())[0].id, id);
  const recovered = await restarted.recover(id);
  assert.deepEqual(await fs.readFile(recovered), header);
  assert.equal((await restarted.recoveries()).length, 0);
  const next = await store.begin();
  await store.append(next.id, 0, header);
  const elsewhere = path.join(root, "elsewhere");
  await fs.mkdir(elsewhere);
  await store.relocate(next.id, elsewhere);
  await store.append(next.id, 1, Buffer.from("tail"));
  const file = await store.finish(next.id);
  assert.equal(path.dirname(file), elsewhere);
  assert.deepEqual(
    await fs.readFile(file),
    Buffer.concat([header, Buffer.from("tail")]),
  );
  assert.equal(await store.validFile(file), file);
});
test("folder-prefix tricks, nested junctions, arbitrary extensions and malformed PNGs are refused", async (t) => {
  const { store, root, roots } = await fixture(t);
  const sibling = roots.recordings + "-other";
  await fs.mkdir(sibling);
  const outside = path.join(sibling, "victim.webm");
  await fs.writeFile(outside, header);
  await assert.rejects(store.validFile(outside), /outside/);
  const script = path.join(roots.recordings, "run.exe");
  await fs.writeFile(script, "fixture");
  await assert.rejects(store.validFile(script), /Invalid/);
  const nested = path.join(roots.recordings, "linked");
  await fs.symlink(
    sibling,
    nested,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    containedFile([roots.recordings], path.join(nested, "victim.webm")),
    /outside/,
  );
  assert.throws(
    () =>
      validatePNG(
        "data:image/png;base64," +
          Buffer.from("not an image").toString("base64"),
      ),
    /Invalid/,
  );
  const bomb = validatePNG(png);
  bomb.writeUInt32BE(20000, 16);
  assert.throws(
    () => validatePNG("data:image/png;base64," + bomb.toString("base64")),
    /dimensions/,
  );
  const [a, b] = await Promise.all([
    store.screenshot(png),
    store.screenshot(png),
  ]);
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), roots.screenshots);
});
test("playback exposes opaque capture URLs and supports bounded seeking without disabling web security", async (t) => {
  const { store, roots } = await fixture(t),
    file = path.join(roots.recordings, "lesson #1 %.webm");
  await fs.writeFile(file, header);
  const media = mediaProtocol(store),
    url = await media.urlFor(file);
  assert.ok(!url.includes("lesson"));
  const result = await media.handle(
    new Request(url, { headers: { Range: "bytes=2-5" } }),
  );
  assert.equal(result.status, 206);
  assert.equal(
    result.headers.get("Content-Range"),
    "bytes 2-5/" + header.length,
  );
  assert.deepEqual(
    Buffer.from(await result.arrayBuffer()),
    header.subarray(2, 6),
  );
  assert.equal(
    (await media.handle(new Request(url, { headers: { Range: "bytes=999-" } })))
      .status,
    416,
  );
  assert.equal(
    (await media.handle(new Request("vexona-media://capture/not-a-token")))
      .status,
    404,
  );
  await fs.unlink(file);
  assert.equal((await media.handle(new Request(url))).status, 404);
});

test("simultaneous starts cannot reserve two disk sessions and a failed finalization can be retried", async (t) => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([store.begin(), store.begin()]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const { id } = results.find((result) => result.status === "fulfilled").value;
  await store.append(id, 0, header);
  const promote = store.promote.bind(store);
  store.promote = async () => {
    throw Error("destination unavailable");
  };
  await assert.rejects(store.finish(id), /unavailable/);
  assert.equal(store.sessions.size, 1);
  store.promote = promote;
  const file = await store.finish(id);
  assert.deepEqual(await fs.readFile(file), header);
});

test("a crash after atomic publication reconciles the same file and missing drives remain visible", async (t) => {
  const { store, roots } = await fixture(t);
  const { id } = await store.begin();
  await store.append(id, 0, header);
  const s = store.session(id);
  const part = path.join(s.root, `.${s.name}.part`),
    target = path.join(s.root, s.name);
  await fs.link(part, target);
  await store.preserve(id);
  assert.equal(await store.recover(id), target);
  assert.deepEqual(await fs.readFile(target), header);
  const next = await store.begin();
  await store.append(next.id, 0, header);
  await store.preserve(next.id);
  await fs.rename(roots.recordings, roots.recordings + "-disconnected");
  const recoveries = await store.recoveries();
  assert.equal(recoveries[0].unavailable, true);
  await assert.rejects(store.recover(next.id), /Reconnect/);
});

test("WebM header validation accepts fragmented headers and still rejects mismatches", async (t) => {
  const { store } = await fixture(t),
    { id } = await store.begin();
  await store.append(id, 0, header.subarray(0, 1));
  await assert.rejects(store.append(id, 1, Buffer.from([0])), /WebM/);
  await store.append(id, 1, header.subarray(1, 3));
  await store.append(id, 2, header.subarray(3));
  const file = await store.finish(id);
  assert.deepEqual(await fs.readFile(file), header);
});
