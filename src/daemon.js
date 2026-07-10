"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, fork, spawn } = require("node:child_process");
const { loadLocalEnv } = require("./env");
loadLocalEnv();

const { startServer } = require("./server");
const { runCollectorLoop } = require("./collector");

const ROOT = path.resolve(__dirname, "..");
const PID_FILE = path.join(ROOT, "storage", "baijia-daemon.pid");
const HEARTBEAT_FILE = path.join(ROOT, "storage", "baijia-daemon.heartbeat");
const port = Number(process.env.PORT || 4173);
const LOGIC_UPDATE_ENABLED = String(process.env.BAIJIA_LOGIC_UPDATE_ENABLED || "true").toLowerCase() !== "false";
const LOGIC_UPDATE_INTERVAL_MS = Number(process.env.BAIJIA_LOGIC_UPDATE_INTERVAL_MS || 60 * 60 * 1000);
const LOGIC_UPDATE_START_DELAY_MS = Number(process.env.BAIJIA_LOGIC_UPDATE_START_DELAY_MS || 90_000);
const LOGIC_UPDATE_CHECKS = Number(process.env.BAIJIA_LOGIC_UPDATE_CHECKS || 60);
const LOGIC_UPDATE_LIMIT = Number(process.env.BAIJIA_LOGIC_UPDATE_LIMIT || 1800);
const LOGIC_UPDATE_HISTORY_LIMIT = Number(process.env.BAIJIA_LOGIC_UPDATE_HISTORY_LIMIT || 360);
const LOGIC_UPDATE_MANUAL_HISTORY_LIMIT = Number(process.env.BAIJIA_LOGIC_UPDATE_MANUAL_HISTORY_LIMIT || 40);
const STARTUP_BACKUP_DELAY_MS = Number(process.env.BAIJIA_STARTUP_BACKUP_DELAY_MS || 30_000);
const DAILY_BACKUP_INTERVAL_MS = Number(process.env.BAIJIA_DAILY_BACKUP_INTERVAL_MS || 60 * 60 * 1000);
let collectorWorker = null;
let collectorRestartTimer = null;
let logicUpdateProcess = null;
let logicUpdateStartTimer = null;
let startupBackupTimer = null;
let backupProcess = null;
let heartbeatReady = false;
let shuttingDown = false;

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
}

function touchHeartbeat() {
  fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), "utf8");
}

function markHeartbeatReady(reason = "ready") {
  heartbeatReady = true;
  touchHeartbeat();
  console.log(`Daemon heartbeat ready (${reason}).`);
}

function startDailyBackup(reason = "daemon-daily") {
  if (backupProcess || shuttingDown) return;
  const script = path.join(ROOT, "scripts", "backup-db.mjs");
  if (!fs.existsSync(script)) {
    console.error(`Daily backup skipped: missing ${script}`);
    return;
  }
  backupProcess = spawn(process.execPath, [script, "--daily", reason], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  console.log(`Daily backup check started (${reason}), pid=${backupProcess.pid}`);
  backupProcess.on("error", (error) => {
    console.error(`Daily backup failed to start: ${error.message}`);
    backupProcess = null;
  });
  backupProcess.on("exit", (code, signal) => {
    const pid = backupProcess?.pid || 0;
    backupProcess = null;
    if (shuttingDown) return;
    if (code === 0) {
      console.log(`Daily backup check finished, pid=${pid}`);
    } else {
      console.error(`Daily backup exited, pid=${pid}, code=${code}, signal=${signal || ""}`);
    }
  });
  backupProcess.unref();
}

function scheduleStartupBackup() {
  if (STARTUP_BACKUP_DELAY_MS < 0 || startupBackupTimer || shuttingDown) return;
  startupBackupTimer = setTimeout(() => {
    startupBackupTimer = null;
    startDailyBackup("daemon-start");
  }, Math.max(0, STARTUP_BACKUP_DELAY_MS));
  startupBackupTimer.unref();
}

function startCollectorWorker() {
  if (collectorWorker || shuttingDown) return;
  const workerPath = path.join(__dirname, "collector-worker.js");
  collectorWorker = fork(workerPath, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      BAIJIA_COLLECTOR_WORKER: "true"
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });
  console.log(`Collector worker started, pid=${collectorWorker.pid}`);
  collectorWorker.on("exit", (code, signal) => {
    const pid = collectorWorker?.pid || 0;
    collectorWorker = null;
    if (shuttingDown) return;
    console.error(`Collector worker exited, pid=${pid}, code=${code}, signal=${signal || ""}. Restart in 10 seconds.`);
    collectorRestartTimer = setTimeout(() => {
      collectorRestartTimer = null;
      startCollectorWorker();
    }, 10_000);
  });
}

function startLogicUpdate(reason = "hourly") {
  if (!LOGIC_UPDATE_ENABLED || logicUpdateProcess || shuttingDown) return;
  const script = path.join(ROOT, "scripts", "report-logic-hit-rates.mjs");
  if (!fs.existsSync(script)) {
    console.error(`Logic update skipped: missing ${script}`);
    return;
  }
  logicUpdateProcess = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: {
      ...process.env,
      BAIJIA_LOGIC_REPORT_CHECKS: String(LOGIC_UPDATE_CHECKS),
      BAIJIA_LOGIC_REPORT_LIMIT: String(LOGIC_UPDATE_LIMIT),
      BAIJIA_LOGIC_REPORT_HISTORY_LIMIT: String(LOGIC_UPDATE_HISTORY_LIMIT),
      BAIJIA_LOGIC_REPORT_MANUAL_HISTORY_LIMIT: String(LOGIC_UPDATE_MANUAL_HISTORY_LIMIT)
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  console.log(`Logic calibration started (${reason}), pid=${logicUpdateProcess.pid}`);
  logicUpdateProcess.on("error", (error) => {
    console.error(`Logic calibration failed to start: ${error.message}`);
    logicUpdateProcess = null;
  });
  logicUpdateProcess.on("exit", (code, signal) => {
    const pid = logicUpdateProcess?.pid || 0;
    logicUpdateProcess = null;
    if (shuttingDown) return;
    if (code === 0) {
      console.log(`Logic calibration finished, pid=${pid}`);
    } else {
      console.error(`Logic calibration exited, pid=${pid}, code=${code}, signal=${signal || ""}`);
    }
  });
  logicUpdateProcess.unref();
}

function stopLogicUpdate() {
  if (logicUpdateStartTimer) {
    clearTimeout(logicUpdateStartTimer);
    logicUpdateStartTimer = null;
  }
  if (logicUpdateProcess) {
    try {
      logicUpdateProcess.kill("SIGTERM");
    } catch (_) {}
    logicUpdateProcess = null;
  }
}

function stopBackupJob() {
  if (startupBackupTimer) {
    clearTimeout(startupBackupTimer);
    startupBackupTimer = null;
  }
  if (backupProcess) {
    try {
      backupProcess.kill("SIGTERM");
    } catch (_) {}
    backupProcess = null;
  }
}

function stopCollectorWorker() {
  if (collectorRestartTimer) {
    clearTimeout(collectorRestartTimer);
    collectorRestartTimer = null;
  }
  if (collectorWorker) {
    try {
      collectorWorker.kill("SIGTERM");
    } catch (_) {}
    collectorWorker = null;
  }
}

acquireLock();
const isCollectorOnly = String(process.env.BAIJIA_DAEMON_ONLY || process.env.COLLECTOR_ONLY || "").toLowerCase() === "true";
if (!isCollectorOnly) {
  const server = startServer(port);
  server.on("listening", () => {
    markHeartbeatReady("http-listening");
    scheduleStartupBackup();
  });
  server.on("error", (error) => {
    console.error(`HTTP server failed: ${error.message}`);
    process.exit(1);
  });
} else {
  markHeartbeatReady("collector-only");
  scheduleStartupBackup();
}

const heartbeatTimer = setInterval(() => {
  if (heartbeatReady) touchHeartbeat();
}, 15000);
const backupTimer = setInterval(() => startDailyBackup("daemon-daily"), Math.max(15 * 60 * 1000, DAILY_BACKUP_INTERVAL_MS));
const logicUpdateTimer = LOGIC_UPDATE_ENABLED && !isCollectorOnly
  ? setInterval(() => startLogicUpdate("hourly"), Math.max(15 * 60 * 1000, LOGIC_UPDATE_INTERVAL_MS))
  : null;
if (logicUpdateTimer) {
  logicUpdateStartTimer = setTimeout(() => {
    logicUpdateStartTimer = null;
    startLogicUpdate("startup");
  }, Math.max(10_000, LOGIC_UPDATE_START_DELAY_MS));
}
process.on("SIGINT", () => {
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  clearInterval(backupTimer);
  if (logicUpdateTimer) clearInterval(logicUpdateTimer);
  stopCollectorWorker();
  stopLogicUpdate();
  stopBackupJob();
  removePidFiles();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  clearInterval(backupTimer);
  if (logicUpdateTimer) clearInterval(logicUpdateTimer);
  stopCollectorWorker();
  stopLogicUpdate();
  stopBackupJob();
  removePidFiles();
  process.exit(0);
});
process.on("exit", () => {
  shuttingDown = true;
  stopCollectorWorker();
  stopLogicUpdate();
  stopBackupJob();
  removePidFiles();
});

if (String(process.env.GOODWIN_ENABLE_COLLECTOR || "false").toLowerCase() === "true") {
  if (isCollectorOnly) {
    runCollectorLoop().catch((error) => {
      console.error(`Collector loop failed: ${error.message}`);
      process.exitCode = 1;
    });
  } else {
    startCollectorWorker();
  }
} else {
  console.log("Goodwin collector disabled. Set GOODWIN_ENABLE_COLLECTOR=true in .env.local to enable it.");
}
