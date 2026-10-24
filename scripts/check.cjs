const fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process");
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
}
for (const file of walk("src"))
  if (/\.js$/.test(file))
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log("JavaScript syntax checks passed.");
