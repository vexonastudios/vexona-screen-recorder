const fs = require("node:fs"),
  path = require("node:path"),
  { createHash } = require("node:crypto");
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
