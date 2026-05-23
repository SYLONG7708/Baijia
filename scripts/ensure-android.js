const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const androidDir = path.join(root, "android");

if (!fs.existsSync(androidDir)) {
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["cap", "add", "android"], {
    cwd: root,
    stdio: "inherit",
    shell: false
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
