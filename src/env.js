"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadLocalEnv(root = path.resolve(__dirname, "..")) {
  const files = [".env", ".env.local"];
  for (const file of files) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    const lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

module.exports = {
  loadLocalEnv
};
