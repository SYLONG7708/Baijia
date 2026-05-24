const fs = require("node:fs");
const path = require("node:path");
const { PUBLIC_API_BASE } = require("../src/env");
const { TABLE_GROUPS, TARGET_TABLES } = require("../src/tables");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const wwwDir = path.join(root, "www");

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

fs.rmSync(wwwDir, { recursive: true, force: true });
copyDir(publicDir, wwwDir);
fs.writeFileSync(path.join(wwwDir, "app-config.json"), `${JSON.stringify({
  publicApiBase: PUBLIC_API_BASE,
  tableGroups: TABLE_GROUPS,
  tables: TARGET_TABLES
}, null, 2)}\n`);
console.log(`Copied ${publicDir} to ${wwwDir}`);
