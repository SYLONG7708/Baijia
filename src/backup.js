"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("./store");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_DIR = path.join(ROOT, "storage");
const LOCAL_BACKUP_DIR = process.env.BAIJIA_BACKUP_DIR || path.join(ROOT, "backups");
const ARCHIVE_BACKUP_DIR = process.env.BAIJIA_ARCHIVE_BACKUP_DIR || path.join(
  os.homedir(),
  "Desktop",
  "CODEX \u5c08\u6848\u8cc7\u6599\u593e",
  "\u88fd\u4f5c\u904e\u7684 APP \u4ee5\u53ca\u8cc7\u6599",
  "Baijia_\u81ea\u52d5\u5099\u4efd"
);
const LAST_BACKUP_FILE = path.join(STORAGE_DIR, "baijia-last-backup-date.txt");

function backupDatabase(reason = "manual") {
  store.ensureStore();
  const timestamp = timestampForFile();
  const fileName = `baijia-db-${timestamp}.json`;
  const destinations = [];

  for (const dir of [LOCAL_BACKUP_DIR, ARCHIVE_BACKUP_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, fileName);
      fs.copyFileSync(store.DB_PATH, target);
      destinations.push(target);
    } catch (error) {
      destinations.push(`FAILED:${dir}:${error.message}`);
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    reason,
    source: store.DB_PATH,
    destinations
  };

  for (const dir of [LOCAL_BACKUP_DIR, ARCHIVE_BACKUP_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "backup-latest.json"), stringifyJsonAscii(manifest), "utf8");
    } catch (_) {}
  }

  return manifest;
}

function maybeRunDailyBackup(reason = "daily") {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const today = localDateStamp();
  let last = "";
  try {
    last = fs.readFileSync(LAST_BACKUP_FILE, "utf8").trim();
  } catch (_) {}
  if (last === today) return null;
  const manifest = backupDatabase(reason);
  fs.writeFileSync(LAST_BACKUP_FILE, today, "utf8");
  return manifest;
}

function timestampForFile() {
  const now = new Date();
  return `${localDateStamp(now).replace(/-/g, "")}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

function localDateStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function stringifyJsonAscii(value) {
  return JSON.stringify(value, null, 2).replace(/[^\x00-\x7F]/g, (char) => (
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

module.exports = {
  backupDatabase,
  maybeRunDailyBackup
};
