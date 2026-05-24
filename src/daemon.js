const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ROOT, LOG_DIR, SCRAPER_ENABLED, TELEGRAM_ENABLED, TRAINER_ENABLED } = require("./env");
const { openDatabase, getStatus, setStatus, logEvent } = require("./db");

openDatabase();
fs.mkdirSync(LOG_DIR, { recursive: true });

const children = new Map();
const stopping = new Set();
const daemonPidPath = path.join(ROOT, "data", "daemon.pid");
const MONITOR_WATCHDOG_MS = Math.max(120_000, Number(process.env.MONITOR_WATCHDOG_MS || 3 * 60_000));
const QUALITY_WATCHDOG_MS = Math.max(60_000, Number(process.env.QUALITY_WATCHDOG_MS || 2 * 60_000));
const QUALITY_WATCHDOG_WARN_TABLES = Math.max(1, Number(process.env.QUALITY_WATCHDOG_WARN_TABLES || 6));
const QUALITY_WATCHDOG_COOLDOWN_MS = Math.max(
  QUALITY_WATCHDOG_MS,
  Number(process.env.QUALITY_WATCHDOG_COOLDOWN_MS || 5 * 60_000)
);

let qualityIssueStartedAt = 0;
let streamIssueStartedAt = 0;
let lastScraperWatchdogRestartAt = 0;
let lastScraperWatchdogReason = "";

function logStream(name, ext) {
  return fs.createWriteStream(path.join(LOG_DIR, `${name}.${ext}`), { flags: "a" });
}

function startProcess(name, args, options = {}) {
  const stdout = logStream(name, "log");
  const stderr = logStream(name, "err");

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, BAIJIA_CHILD: name },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...options
  });

  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  children.set(name, child);
  setStatus(`${name}Process`, {
    running: true,
    pid: child.pid,
    startedAt: new Date().toISOString()
  });
  logEvent("info", `${name} process started`, { pid: child.pid });

  child.on("exit", (code, signal) => {
    stdout.end();
    stderr.end();
    children.delete(name);
    setStatus(`${name}Process`, {
      running: false,
      code,
      signal,
      exitedAt: new Date().toISOString()
    });
    logEvent(code === 0 ? "info" : "warn", `${name} process exited`, { code, signal });

    if (!stopping.has(name)) {
      const delayMs = code === 0 ? 5000 : 15000;
      setTimeout(() => startProcess(name, args, options), delayMs);
    }
  });

  return child;
}

function parseStatusTime(value) {
  if (!value) return 0;
  const text = String(value).includes("T") ? String(value) : `${String(value).replace(" ", "T")}Z`;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function restartChild(name, reason) {
  const child = children.get(name);
  if (!child || stopping.has(name)) return;
  logEvent("warn", `${name} watchdog restart`, {
    pid: child.pid,
    reason,
    watchdogMs: MONITOR_WATCHDOG_MS
  });
  child.kill("SIGTERM");
  setTimeout(() => {
    if (children.get(name) === child) child.kill("SIGKILL");
  }, 5000).unref();
}

function watchdog() {
  const monitorChild = children.get("monitor");
  if (!monitorChild) return;
  const started = parseStatusTime(getStatus().monitorProcess?.startedAt);
  if (started && Date.now() - started < MONITOR_WATCHDOG_MS) return;

  const monitor = getStatus().monitor || {};
  const lastCheckAt = parseStatusTime(monitor.lastCheckAt);
  if (!lastCheckAt) return;
  const staleMs = Date.now() - lastCheckAt;
  if (staleMs > MONITOR_WATCHDOG_MS) {
    restartChild("monitor", `lastCheckAt stale for ${Math.round(staleMs / 1000)} seconds`);
  }
}

function scraperQualityWatchdog() {
  const scraperChild = children.get("scraper");
  if (!scraperChild || stopping.has("scraper")) return;

  const status = getStatus();
  const monitor = status.monitor || {};
  const validation = status.validation || {};
  const scraper = status.scraper || {};
  const warnTables = Number(validation.summary?.warn ?? monitor.report?.warnTables ?? 0);
  const errorTables = Number(validation.summary?.error ?? monitor.report?.errorTables ?? 0);
  const rateLimited = monitor.state === "RATE_LIMITED" || scraper.health === "RATE_LIMITED";
  const streamTrouble = !rateLimited && (
    monitor.state === "NO_WEBSOCKET"
    || monitor.state === "STALE_CRITICAL"
    || scraper.health === "NO_WEBSOCKET"
  );
  const qualityTrouble = !rateLimited && (errorTables > 0 || warnTables >= QUALITY_WATCHDOG_WARN_TABLES);
  const now = Date.now();

  if (streamTrouble) {
    if (!streamIssueStartedAt) streamIssueStartedAt = now;
  } else {
    streamIssueStartedAt = 0;
  }

  if (qualityTrouble) {
    if (!qualityIssueStartedAt) qualityIssueStartedAt = now;
  } else {
    qualityIssueStartedAt = 0;
  }

  const streamIssueMs = streamIssueStartedAt ? now - streamIssueStartedAt : 0;
  const qualityIssueMs = qualityIssueStartedAt ? now - qualityIssueStartedAt : 0;
  let restartReason = "";
  if (streamIssueMs >= QUALITY_WATCHDOG_MS) {
    restartReason = `stream state ${monitor.state || scraper.health || "unknown"} persisted for ${Math.round(streamIssueMs / 1000)} seconds`;
  } else if (qualityIssueMs >= QUALITY_WATCHDOG_MS) {
    restartReason = `validation ${errorTables} error / ${warnTables} warn tables persisted for ${Math.round(qualityIssueMs / 1000)} seconds`;
  }

  if (restartReason && now - lastScraperWatchdogRestartAt >= QUALITY_WATCHDOG_COOLDOWN_MS) {
    lastScraperWatchdogRestartAt = now;
    lastScraperWatchdogReason = restartReason;
    qualityIssueStartedAt = 0;
    streamIssueStartedAt = 0;
    restartChild("scraper", restartReason);
  }

  setStatus("qualityWatchdog", {
    running: true,
    warnTableThreshold: QUALITY_WATCHDOG_WARN_TABLES,
    triggerSeconds: Math.round(QUALITY_WATCHDOG_MS / 1000),
    cooldownSeconds: Math.round(QUALITY_WATCHDOG_COOLDOWN_MS / 1000),
    rateLimited,
    warnTables,
    errorTables,
    streamState: monitor.state || scraper.health || "",
    qualityIssueSeconds: Math.round(qualityIssueMs / 1000),
    streamIssueSeconds: Math.round(streamIssueMs / 1000),
    lastScraperRestartAt: lastScraperWatchdogRestartAt
      ? new Date(lastScraperWatchdogRestartAt).toISOString()
      : "",
    lastScraperRestartReason: lastScraperWatchdogReason,
    updatedAt: new Date().toISOString()
  });
}

function heartbeat() {
  try {
    watchdog();
    scraperQualityWatchdog();
  } catch (error) {
    logEvent("warn", "daemon watchdog check failed", error.stack || error.message);
  }
  setStatus("daemon", {
    running: true,
    pid: process.pid,
    children: Array.from(children.entries()).map(([name, child]) => ({
      name,
      pid: child.pid
    })),
    heartbeatAt: new Date().toISOString()
  });
}

function shutdown() {
  setStatus("daemon", {
    running: false,
    pid: process.pid,
    stoppedAt: new Date().toISOString()
  });
  for (const [name, child] of children.entries()) {
    stopping.add(name);
    child.kill("SIGTERM");
  }
  try {
    fs.rmSync(daemonPidPath, { force: true });
  } catch {
    // Best effort cleanup only.
  }
  setTimeout(() => process.exit(0), 1500).unref();
}

fs.writeFileSync(daemonPidPath, String(process.pid));
setStatus("daemon", { running: true, pid: process.pid, startedAt: new Date().toISOString() });
logEvent("info", "daemon started", {
  pid: process.pid,
  scraperEnabled: SCRAPER_ENABLED,
  trainerEnabled: TRAINER_ENABLED,
  telegramEnabled: TELEGRAM_ENABLED
});

startProcess("server", ["src/server.js"]);
if (SCRAPER_ENABLED) startProcess("scraper", ["src/scraper.js"]);
startProcess("monitor", ["src/monitor.js"]);
if (TRAINER_ENABLED) startProcess("trainer", ["src/trainer.js"]);
if (TELEGRAM_ENABLED) startProcess("telegram", ["src/telegram-notifier.js"]);

setInterval(heartbeat, 10000);
heartbeat();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
