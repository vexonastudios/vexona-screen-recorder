const { spawn } = require("node:child_process");
const binary = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const rootIndex = process.argv.indexOf("--app-root");
if (rootIndex >= 0)
  env.VEXONA_TEST_APP_ROOT = require("node:path").resolve(
    process.argv[rootIndex + 1],
  );
const child = spawn(binary, ["tests/native-smoke.cjs"], {
  cwd: require("node:path").resolve(__dirname, ".."),
  env,
  stdio: "inherit",
  windowsHide: true,
});
process.on("SIGINT", () => {
  child.kill();
  process.exit(130);
});
process.on("SIGTERM", () => {
  child.kill();
  process.exit(143);
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
const watchdog = setTimeout(() => {
  console.error("Native test process deadline reached.");
  child.kill();
  process.exitCode = 1;
}, 55000);
child.on("exit", (code) => {
  clearTimeout(watchdog);
  process.exitCode = code ?? 1;
});
