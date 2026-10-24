const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const MAX_CHUNK = 2 * 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
const EXTENSIONS = new Set([".webm", ".png", ".jpg", ".jpeg"]);
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
async function containedFile(roots, file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    !EXTENSIONS.has(path.extname(file).toLowerCase())
  )
    throw Error("Invalid capture file.");
  const absolute = path.resolve(file);
  const entry = await fs.lstat(absolute);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw Error("Only regular capture files are allowed.");
  const real = await fs.realpath(absolute);
  for (const root of roots) {
    const realRoot = await fs.realpath(root).catch((error) => {
      if (["ENOENT", "ENODEV", "EIO"].includes(error.code)) return null;
      throw error;
    });
    if (!realRoot) continue;
    // Captures are immediate children; do not follow a nested junction.
    if (inside(realRoot, real) && path.dirname(real) === realRoot) return real;
  }
  throw Error("Capture is outside the selected folders.");
}
function validatePNG(dataURL) {
  if (
    typeof dataURL !== "string" ||
    dataURL.length > 45 * 1024 * 1024 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataURL)
  )
    throw Error("Expected a PNG image under 32 MB.");
  const data = Buffer.from(dataURL.slice(22), "base64");
  if (
    data.length < 33 ||
    data.length > 32 * 1024 * 1024 ||
    data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    data.toString("ascii", 12, 16) !== "IHDR"
  )
    throw Error("Invalid PNG image.");
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 16384 ||
    height > 16384 ||
    width * height > 100000000
  )
    throw Error("Screenshot dimensions are too large.");
  return data;
}
class CaptureStore {
  constructor({ journalDir, getRoots }) {
    this.journalDir = journalDir;
    this.getRoots = getRoots;
    this.sessions = new Map();
    this.completed = new Map();
    this.recoveredRoots = new Set();
  }
  async initialize() {
    await fs.mkdir(this.journalDir, { recursive: true });
  }
  async validFile(file) {
    return containedFile(
      [...Object.values(this.getRoots()), ...this.recoveredRoots],
      file,
    );
  }
  async begin(customName) {
    if (this.sessions.size || this.beginning)
      throw Error("Finish the current recording before starting another.");
    this.beginning = true;
    try {
      const root = await fs.realpath(this.getRoots().recordings);
      const space = await fs.statfs(root);
      if (space.bavail * space.bsize < 64 * 1024 * 1024)
        throw Error("Less than 64 MB free. Choose another recordings folder.");
      const id = randomUUID(),
        label =
          typeof customName === "string"
            ? customName.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 60)
            : "";
      const name = `${label || "Vexona"}_${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.webm`;
      const meta = {
        id,
        root,
        name,
        started: new Date().toISOString(),
        bytes: 0,
        next: 0,
      };
      const handle = await fs.open(
        path.join(root, `.${name}.part`),
        "wx+",
        0o600,
      );
      try {
        await fs.writeFile(
          path.join(this.journalDir, id + ".json"),
          JSON.stringify(meta),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        await handle.close();
        await fs.unlink(path.join(root, `.${name}.part`)).catch(() => {});
        throw error;
      }
      this.sessions.set(id, {
        ...meta,
        handle,
        chain: Promise.resolve(),
        lastHash: null,
      });
      return { id, maxChunk: MAX_CHUNK };
    } finally {
      this.beginning = false;
    }
  }
  session(id) {
    if (!ID.test(id || "") || !this.sessions.has(id))
      throw Error("Recording session not found.");
    return this.sessions.get(id);
  }
  async append(id, sequence, bytes) {
    const s = this.session(id);
    if (!s.handle || s.finishing)
      throw Error("Recording is already being finalized.");
    if (
      !(bytes instanceof Uint8Array) ||
      !bytes.byteLength ||
      bytes.byteLength > MAX_CHUNK ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      throw Error("Invalid recording chunk.");
    if ((s.pendingBytes || 0) + bytes.byteLength > 8 * MAX_CHUNK)
      throw Error("Recording write queue is full.");
    s.pendingBytes = (s.pendingBytes || 0) + bytes.byteLength;
    const data = Buffer.from(bytes),
      hash = createHash("sha256").update(data).digest("hex");
    const task = s.chain.then(async () => {
      if (sequence === s.next - 1 && hash === s.lastHash)
        return { next: s.next, bytes: s.bytes };
      if (sequence !== s.next)
        throw Error("Recording chunks arrived out of order.");
      // A timeslice can divide even the container header. Validate the prefix
      // across acknowledged slices instead of requiring four bytes in slice zero.
      if (s.bytes < 4) {
        const expected = Buffer.from("1a45dfa3", "hex");
        const count = Math.min(4 - s.bytes, data.length);
        if (
          !data
            .subarray(0, count)
            .equals(expected.subarray(s.bytes, s.bytes + count))
        )
          throw Error("Expected WebM recording data.");
      }
      // Roll back a partial write on error so Retry cannot duplicate a prefix.
      const offset = s.bytes;
      try {
        let written = 0;
        while (written < data.length) {
          const result = await s.handle.write(
            data,
            written,
            data.length - written,
            offset + written,
          );
          if (!result.bytesWritten) throw Error("Disk write made no progress.");
          written += result.bytesWritten;
        }
        await s.handle.truncate(offset + data.length);
        await s.handle.sync();
      } catch (error) {
        await s.handle.truncate(offset).catch(() => {});
        throw error;
      }
      s.bytes += data.length;
      s.next++;
      s.lastHash = hash;
      return { next: s.next, bytes: s.bytes };
    });
    s.chain = task.catch(() => {});
    return task.finally(() => {
      s.pendingBytes -= data.length;
    });
  }
  async closeSession(id) {
    const s = this.session(id);
    s.finishing = true;
    await s.chain;
    if (s.handle) {
      await s.handle.sync();
      await s.handle.close();
      s.handle = null;
    }
    return s;
  }
  async finish(id) {
    if (this.completed.has(id)) return this.completed.get(id);
    const s = await this.closeSession(id);
    const file = await this.promote(s);
    this.sessions.delete(id);
    this.completed.set(id, file);
    if (this.completed.size > 16)
      this.completed.delete(this.completed.keys().next().value);
    return file;
  }
  async preserve(id) {
    const s = this.session(id);
    s.finishing = true;
    await s.chain;
    if (s.handle) await s.handle.close();
    this.sessions.delete(id);
    if (!s.bytes) {
      await fs.unlink(path.join(s.root, `.${s.name}.part`)).catch(() => {});
      await fs.unlink(path.join(this.journalDir, id + ".json")).catch(() => {});
    }
    return s.id;
  }
  async promote(s) {
    const part = path.join(s.root, `.${s.name}.part`),
      target = path.join(s.root, s.name);
    const stat = await fs.lstat(part);
    const existing = await fs.lstat(target).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      existing &&
      !existing.isSymbolicLink() &&
      stat.dev === existing.dev &&
      stat.ino === existing.ino
    ) {
      await fs.unlink(part).catch(() => {});
      await fs
        .unlink(path.join(this.journalDir, s.id + ".json"))
        .catch(() => {});
      return target;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 4)
      throw Error("No recoverable recording data yet.");
    // link creates the final name atomically and never replaces an existing file.
    try {
      await fs.link(part, target);
    } catch (error) {
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code))
        throw error;
      await fs.copyFile(part, target, constants.COPYFILE_EXCL);
      const final = await fs.open(target, "r+");
      try {
        await final.sync();
      } finally {
        await final.close();
      }
    }
    await fs.unlink(part).catch(() => {});
    await fs.unlink(path.join(this.journalDir, s.id + ".json")).catch(() => {});
    return target;
  }
  async relocate(id, destination) {
    const s = this.session(id);
    await s.chain;
    const nextRoot = await fs.realpath(destination);
    if (nextRoot === s.root) return true;
    const old = path.join(s.root, `.${s.name}.part`),
      next = path.join(nextRoot, `.${s.name}.part`);
    if (s.handle) {
      await s.handle.sync();
      await s.handle.close();
      s.handle = null;
    }
    let handle,
      copied = false;
    try {
      await fs.copyFile(old, next, constants.COPYFILE_EXCL);
      copied = true;
      handle = await fs.open(next, "r+");
      await handle.sync();
      const meta = {
        id: s.id,
        root: nextRoot,
        name: s.name,
        started: s.started,
      };
      const temporary = path.join(this.journalDir, s.id + ".json.tmp");
      await fs.writeFile(temporary, JSON.stringify(meta), { mode: 0o600 });
      await fs.rename(temporary, path.join(this.journalDir, s.id + ".json"));
      s.root = nextRoot;
      s.handle = handle;
      s.finishing = false;
      this.recoveredRoots.add(nextRoot);
      await fs.unlink(old).catch(() => {});
      return true;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (copied) await fs.unlink(next).catch(() => {});
      s.handle = await fs.open(old, "r+").catch(() => null);
      s.finishing = false;
      throw error;
    }
  }
  async recoveries() {
    const found = [];
    for (const entry of await fs.readdir(this.journalDir)) {
      if (
        !/^[a-f0-9-]{36}\.json$/.test(entry) ||
        this.sessions.has(entry.slice(0, -5))
      )
        continue;
      try {
        const journal = path.join(this.journalDir, entry),
          file = await fs.lstat(journal);
        if (!file.isFile() || file.isSymbolicLink() || file.size > 4096)
          continue;
        const s = JSON.parse(await fs.readFile(journal, "utf8"));
        if (
          !ID.test(s.id) ||
          entry !== s.id + ".json" ||
          !path.isAbsolute(s.root) ||
          typeof s.name !== "string" ||
          path.basename(s.name) !== s.name ||
          !s.name.endsWith("_" + s.id + ".webm")
        )
          continue;
        let root, stat;
        try {
          root = await fs.realpath(s.root);
          stat = await fs.lstat(path.join(root, `.${s.name}.part`));
        } catch (error) {
          if (["ENOENT", "ENODEV", "EIO"].includes(error.code))
            found.push({
              id: s.id,
              name: s.name,
              root: s.root,
              bytes: 0,
              started: s.started,
              unavailable: true,
            });
          continue;
        }
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size >= 4)
          found.push({
            id: s.id,
            name: s.name,
            root,
            bytes: stat.size,
            started: s.started,
          });
      } catch {
        /* Missing/removable drives remain in the journal for later. */
      }
    }
    return found;
  }
  async recover(id, destination) {
    const s = (await this.recoveries()).find((s) => s.id === id);
    if (!s) throw Error("Recoverable recording not found.");
    if (s.unavailable)
      throw Error("Reconnect the original drive and refresh recoveries.");
    if (destination) {
      const root = await fs.realpath(destination),
        from = path.join(s.root, `.${s.name}.part`),
        to = path.join(root, s.name);
      await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      const handle = await fs.open(to, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Preserve the original until the user has the verified copy.
      this.recoveredRoots.add(root);
      return to;
    }
    const file = await this.promote(s);
    this.recoveredRoots.add(s.root);
    return file;
  }
  async screenshot(dataURL) {
    const data = validatePNG(dataURL),
      root = await fs.realpath(this.getRoots().screenshots);
    const name = `Vexona_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.png`,
      file = path.join(root, name);
    await fs.writeFile(file, data, { flag: "wx", mode: 0o600 });
    return file;
  }
}
module.exports = {
  CaptureStore,
  containedFile,
  inside,
  validatePNG,
  MAX_CHUNK,
};
