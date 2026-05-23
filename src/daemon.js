const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ROOT, LOG_DIR, SCRAPER_ENABLED } = require("./env");
const { openDatabase, setStatus, logEvent } = require("./db");

openDatabase();
fs.mkdirSync(LOG_DIR, { recursive: true });

const children = new Map();
const stopping = new Set();
const daemonPidPath = path.join(ROOT, "data", "daemon.pid");

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

function heartbeat() {
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
logEvent("info", "daemon started", { pid: process.pid, scraperEnabled: SCRAPER_ENABLED });

startProcess("server", ["src/server.js"]);
if (SCRAPER_ENABLED) startProcess("scraper", ["src/scraper.js"]);
startProcess("monitor", ["src/monitor.js"]);

setInterval(heartbeat, 10000);
heartbeat();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
