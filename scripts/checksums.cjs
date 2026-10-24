const fs = require("node:fs"),
  path = require("node:path"),
  { createHash } = require("node:crypto");
// electron-builder uses hyphens in updater URLs. GitHub rewrites spaces to
// periods on upload, so normalize the actual files before hashing/uploading.
for (const name of fs.readdirSync("dist")) {
  if (!/\.(exe|dmg|zip|blockmap)$/.test(name)) continue;
  const canonical = name.replace(/\s+/g, "-");
  if (name === canonical) continue;
  const target = path.join("dist", canonical);
  if (fs.existsSync(target))
    throw Error("Release filename collision: " + canonical);
  fs.renameSync(path.join("dist", name), target);
}
for (const name of fs
  .readdirSync("dist")
  .filter((name) => /^latest.*\.yml$/.test(name))) {
  const yaml = fs.readFileSync(path.join("dist", name), "utf8");
  const entries = [
    ...yaml.matchAll(
      /- url:\s*([^\r\n]+)\r?\n\s+sha512:\s*([^\r\n]+)\r?\n\s+size:\s*(\d+)/g,
    ),
  ];
  if (!entries.length)
    throw Error("Updater manifest contains no files: " + name);
  for (const [, file, hash, size] of entries) {
    if (
      path.basename(file) !== file ||
      /\s/.test(file) ||
      !fs.existsSync(path.join("dist", file))
    )
      throw Error("Updater URL has no matching release file: " + file);
    const data = fs.readFileSync(path.join("dist", file));
    if (
      data.length !== Number(size) ||
      createHash("sha512").update(data).digest("base64") !== hash.trim()
    )
      throw Error("Updater checksum mismatch: " + file);
  }
}
const files = fs
  .readdirSync("dist")
  .filter(
    (name) =>
      /\.(exe|dmg|zip|blockmap)$/.test(name) || /^latest.*\.yml$/.test(name),
  );
const report = files.sort().map((name) => ({
  name,
  bytes: fs.statSync(path.join("dist", name)).size,
  sha256: createHash("sha256")
    .update(fs.readFileSync(path.join("dist", name)))
    .digest("hex"),
}));
const platform = process.platform;
fs.writeFileSync(
  path.join("dist", platform + "-SHA256.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify({ platform, artifacts: report.length }));
