"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadLocalEnv } = require("./env");
loadLocalEnv();

const { startServer } = require("./server");
const { runCollectorLoop } = require("./collector");
const { maybeRunDailyBackup } = require("./backup");

const PID_FILE = path.resolve(__dirname, "..", "storage", "baijia-daemon.pid");
const HEARTBEAT_FILE = path.resolve(__dirname, "..", "storage", "baijia-daemon.heartbeat");
const port = Number(process.env.PORT || 4173);

function getProcessCommandLine(pid) {
  if (process.platform !== "win32") return "";
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`
      ],
      { encoding: "utf8", windowsHide: true, timeout: 3000 }
    ).trim();
  } catch (_) {
    return "";
  }
}

function isDaemonProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (_) {
    return false;
  }
  if (process.platform !== "win32") return true;
  const commandLine = getProcessCommandLine(pid).toLowerCase();
  const daemonScript = path.join("src", "daemon.js").toLowerCase();
  return commandLine.includes("node") && (
    commandLine.includes(daemonScript)
    || commandLine.includes(daemonScript.replace(/\\/g, "/"))
  );
}

function removePidFiles() {
  for (const file of [PID_FILE, HEARTBEAT_FILE]) {
    try {
      fs.unlinkSync(file);
    } catch (_) {}
  }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  if (fs.existsSync(PID_FILE)) {
    const oldPid = Number(String(fs.readFileSync(PID_FILE, "utf8")).trim());
    if (Number.isFinite(oldPid) && oldPid > 0 && isDaemonProcessAlive(oldPid)) {
      console.log(`daemon already running, pid=${oldPid}`);
      process.exit(0);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), "utf8");
}

function touchHeartbeat() {
  fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), "utf8");
}

acquireLock();
try {
  maybeRunDailyBackup("daemon-start");
} catch (error) {
  console.error(`Startup backup failed: ${error.message}`);
}
const isCollectorOnly = String(process.env.BAIJIA_DAEMON_ONLY || process.env.COLLECTOR_ONLY || "").toLowerCase() === "true";
if (!isCollectorOnly) {
  startServer(port);
}

const heartbeatTimer = setInterval(touchHeartbeat, 15000);
const backupTimer = setInterval(() => {
  try {
    maybeRunDailyBackup("daemon-daily");
  } catch (error) {
    console.error(`Daily backup failed: ${error.message}`);
  }
}, 60 * 60 * 1000);
process.on("SIGINT", () => {
  clearInterval(heartbeatTimer);
  clearInterval(backupTimer);
  removePidFiles();
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(heartbeatTimer);
  clearInterval(backupTimer);
  removePidFiles();
  process.exit(0);
});
process.on("exit", removePidFiles);

if (String(process.env.GOODWIN_ENABLE_COLLECTOR || "false").toLowerCase() === "true") {
  runCollectorLoop().catch((error) => {
    console.error(`Collector loop failed: ${error.message}`);
    process.exitCode = 1;
  });
} else {
  console.log("Goodwin collector disabled. Set GOODWIN_ENABLE_COLLECTOR=true in .env.local to enable it.");
}
