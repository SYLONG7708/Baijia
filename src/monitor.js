const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./env");
const { openDatabase, getAllRounds, getRoundIngestSummary, getStatus, setStatus, logEvent } = require("./db");
const { buildModelSelection } = require("./model-selection");
const { buildValidation } = require("./validation");

const INTERVAL_MS = Math.max(15_000, Number(process.env.MONITOR_INTERVAL_MS || 60_000));
const STALE_WARN_MS = Math.max(INTERVAL_MS, Number(process.env.MONITOR_STALE_WARN_MS || 10 * 60_000));
const STALE_CRITICAL_MS = Math.max(STALE_WARN_MS, Number(process.env.MONITOR_STALE_CRITICAL_MS || 30 * 60_000));
const REPORT_PATH = path.join(DATA_DIR, "monitor-reports.jsonl");

let lastTotalRounds = 0;
let lastState = "";

function parseDbTime(value) {
  if (!value) return 0;
  const text = String(value).includes("T") ? String(value) : `${String(value).replace(" ", "T")}Z`;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function minutes(ms) {
  return Math.round((ms / 60_000) * 10) / 10;
}

function monitorState(summary, scraper, deltaSinceLastCheck) {
  const now = Date.now();
  const latestInsertedAtMs = parseDbTime(summary.latestRound?.insertedAt);
  const ageMs = latestInsertedAtMs ? now - latestInsertedAtMs : Number.POSITIVE_INFINITY;
  const canReadNewInfo = deltaSinceLastCheck > 0 || summary.recent.last5m > 0;

  if (canReadNewInfo) {
    return {
      state: "READING",
      canReadNewInfo: true,
      reason: "New reliable rounds were recorded recently.",
      latestAgeMinutes: latestInsertedAtMs ? minutes(ageMs) : null
    };
  }
  if (scraper.health === "RATE_LIMITED") {
    return {
      state: "RATE_LIMITED",
      canReadNewInfo: false,
      reason: "Allbet trial page returned request frequency limit [5001].",
      latestAgeMinutes: latestInsertedAtMs ? minutes(ageMs) : null
    };
  }
  if (scraper.health === "NO_WEBSOCKET") {
    return {
      state: "NO_WEBSOCKET",
      canReadNewInfo: false,
      reason: "Page is loaded but no Allbet websocket data stream is connected.",
      latestAgeMinutes: latestInsertedAtMs ? minutes(ageMs) : null
    };
  }
  if (ageMs >= STALE_CRITICAL_MS) {
    return {
      state: "STALE_CRITICAL",
      canReadNewInfo: false,
      reason: "No reliable new round has been recorded for the critical threshold.",
      latestAgeMinutes: latestInsertedAtMs ? minutes(ageMs) : null
    };
  }
  if (ageMs >= STALE_WARN_MS) {
    return {
      state: "STALE_WARN",
      canReadNewInfo: false,
      reason: "No reliable new round has been recorded for the warning threshold.",
      latestAgeMinutes: latestInsertedAtMs ? minutes(ageMs) : null
    };
  }
  return {
    state: "WAITING",
    canReadNewInfo: false,
    reason: "Monitor is waiting for the next reliable live round.",
    latestAgeMinutes: latestInsertedAtMs ? minutes(ageMs) : null
  };
}

function buildMonitorReport(monitor, validation) {
  const issueTables = (validation.issueTables || []).map((table) => ({
    code: table.code,
    severity: table.severity,
    currentRoundNo: table.currentRoundNo,
    latestRoundNo: table.latestRound?.roundNo || 0,
    missingCount: table.missingRoundNos?.length || 0,
    snapshotOnlyCount: table.snapshotOnlyRoundNos?.length || 0,
    snapshotConflictCount: table.snapshotConflicts?.length || 0,
    shiftedCount: table.snapshotShiftedMatches?.length || 0,
    conflictCount: table.conflicts?.length || 0
  }));
  const summary = validation.summary || {};
  return {
    generatedAt: monitor.lastCheckAt,
    intervalSeconds: Math.round(INTERVAL_MS / 1000),
    canReadNewInfo: Boolean(monitor.canReadNewInfo),
    monitorState: monitor.state,
    totalRounds: monitor.totalRounds,
    deltaSinceLastCheck: monitor.deltaSinceLastCheck,
    recent5m: monitor.recent?.last5m || 0,
    recent15m: monitor.recent?.last15m || 0,
    latestRound: monitor.latestRound,
    validationSummary: summary,
    hasIssues: Boolean((summary.warn || 0) + (summary.error || 0)),
    warnTables: summary.warn || 0,
    errorTables: summary.error || 0,
    issueTables,
    reportPath: REPORT_PATH
  };
}

function writeMonitorReport(report) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.appendFileSync(REPORT_PATH, `${JSON.stringify(report)}\n`, "utf8");
}

function checkOnce() {
  const status = getStatus();
  const scraper = status.scraper || {};
  const summary = getRoundIngestSummary();
  const allRounds = getAllRounds();
  const validation = buildValidation(allRounds);
  const modelSelection = buildModelSelection(allRounds, { limit: 1200, warmup: 45 });
  const deltaSinceLastCheck = lastTotalRounds > 0
    ? Math.max(0, summary.totalRounds - lastTotalRounds)
    : 0;
  lastTotalRounds = summary.totalRounds;

  const state = monitorState(summary, scraper, deltaSinceLastCheck);
  const monitor = {
    running: true,
    pid: process.pid,
    checking24h: true,
    intervalSeconds: Math.round(INTERVAL_MS / 1000),
    lastCheckAt: new Date().toISOString(),
    ...state,
    totalRounds: summary.totalRounds,
    latestId: summary.latestId,
    latestRound: summary.latestRound
      ? {
        tableCode: summary.latestRound.tableCode,
        roundNo: summary.latestRound.roundNo,
        outcome: summary.latestRound.outcome,
        sourceEvent: summary.latestRound.sourceEvent,
        insertedAt: summary.latestRound.insertedAt,
        observedAt: summary.latestRound.observedAt
      }
      : null,
    recent: summary.recent,
    deltaSinceLastCheck,
    scraperHealth: scraper.health || "",
    scraperLastWebsocketAt: scraper.lastWebsocketAt || "",
    scraperLastRateLimitAt: scraper.lastRateLimitAt || ""
  };
  const report = buildMonitorReport(monitor, validation);
  monitor.report = report;
  try {
    writeMonitorReport(report);
  } catch (error) {
    report.writeError = error.message;
    logEvent("warn", "monitor report write failed", error.message);
  }

  setStatus("monitor", monitor);
  setStatus("validation", validation);
  setStatus("modelSelection", modelSelection);
  if (monitor.state !== lastState) {
    const level = monitor.canReadNewInfo ? "info" : "warn";
    logEvent(level, "monitor state changed", monitor);
    lastState = monitor.state;
  }
  return monitor;
}

function run() {
  openDatabase();
  setStatus("monitor", {
    running: true,
    pid: process.pid,
    checking24h: true,
    startedAt: new Date().toISOString(),
    intervalSeconds: Math.round(INTERVAL_MS / 1000)
  });
  logEvent("info", "monitor started", { pid: process.pid, intervalMs: INTERVAL_MS });
  checkOnce();
  setInterval(() => {
    try {
      checkOnce();
    } catch (error) {
      setStatus("monitor", {
        running: true,
        pid: process.pid,
        checking24h: true,
        error: error.message,
        lastCheckAt: new Date().toISOString()
      });
      logEvent("error", "monitor check failed", error.stack || error.message);
    }
  }, INTERVAL_MS);
}

function shutdown() {
  setStatus("monitor", {
    running: false,
    pid: process.pid,
    stoppedAt: new Date().toISOString()
  });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run();
