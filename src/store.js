"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeRound, parseBulkRounds } = require("./roads");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.BAIJIA_DATA_DIR || path.join(ROOT, "data");
const DB_PATH = process.env.BAIJIA_DB_PATH || path.join(DATA_DIR, "baijia-db.json");
const STORAGE_DIR = process.env.BAIJIA_STORAGE_DIR || path.join(ROOT, "storage");
const DB_VERSION_PATH = path.join(STORAGE_DIR, "baijia-db.version.json");
const ANALYSIS_SNAPSHOT_PATH = path.join(STORAGE_DIR, "baijia-analysis-snapshot.json");
const RUN_HISTORY_LIMIT = Number(process.env.COLLECT_RUN_HISTORY_LIMIT || 1200);
const DB_WRITE_RETRIES = Number(process.env.BAIJIA_DB_WRITE_RETRIES || 8);
const DB_WRITE_RETRY_BASE_MS = Number(process.env.BAIJIA_DB_WRITE_RETRY_BASE_MS || 80);
const ANALYSIS_MAX_ROUNDS = Number(process.env.BAIJIA_ANALYSIS_MAX_ROUNDS || 24000);
const ANALYSIS_TABLE_MAX_ROUNDS = Number(process.env.BAIJIA_ANALYSIS_TABLE_MAX_ROUNDS || 1800);
const ANALYSIS_LIMIT_CAP = Number(process.env.BAIJIA_ANALYSIS_LIMIT_CAP || 60000);
const ANALYSIS_SNAPSHOT_ALL_LIMIT = Number(process.env.BAIJIA_ANALYSIS_SNAPSHOT_ALL_LIMIT || 7200);
const ANALYSIS_SNAPSHOT_TABLE_LIMIT = Number(process.env.BAIJIA_ANALYSIS_SNAPSHOT_TABLE_LIMIT || Math.max(ANALYSIS_TABLE_MAX_ROUNDS, 1800));
const TEMP_FILE_MAX_AGE_MS = Number(process.env.BAIJIA_TEMP_FILE_MAX_AGE_MS || 6 * 60 * 60 * 1000);
const TEMP_FILE_KEEP = Number(process.env.BAIJIA_TEMP_FILE_KEEP || 6);
const DEFAULT_TARGET_TABLE_CODES = [
  "B201", "B202", "B203", "B219", "B220",
  "B501", "B502", "B503", "B504", "B505", "B506", "B507",
  "B601", "B602", "B603", "B604", "B605", "B618",
  "C201", "C202", "C501", "C701",
  "IB201", "IB202",
  "Q201", "Q202", "Q204", "Q501", "Q502", "Q601", "Q701", "Q702",
  "V911", "V912", "V971", "V972"
];
const TARGET_TABLE_CODES = readTargetTableCodes();
const TARGET_TABLE_CODE_SET = new Set(TARGET_TABLE_CODES);
let dbCache = null;
let dbCacheKey = "";
const analysisRoundsCache = new Map();
let analysisTableOptionsCache = { key: "", value: null };
let analysisSnapshotCache = { key: "", value: null };
const ANALYSIS_ROUNDS_CACHE_MAX = Number(process.env.BAIJIA_ANALYSIS_ROUNDS_CACHE_MAX || 80);

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    writeDb(createEmptyDb());
  }
}

function isTargetBaccaratTable(table = {}) {
  if (table.provider !== "allbet") return false;
  const gameType = String(table.gameType || "").toLowerCase();
  if (gameType && gameType !== "baccarat") return false;
  if (isBlockchainBaccaratTable(table)) return false;
  return TARGET_TABLE_CODE_SET.has(getAllbetTableCode(table));
}

function isBlockchainBaccaratTable(table = {}) {
  const name = String(table.name || table.roomId || "");
  return /區塊鏈|区块链|block\s*chain|blockchain|chain/i.test(name);
}

function getTargetBaccaratTables(db = {}) {
  return (db.tables || [])
    .filter(isTargetBaccaratTable)
    .sort((left, right) => targetCodeIndex(left) - targetCodeIndex(right));
}

function isDisplayCandidateTable(table = {}) {
  if (table.provider === "manual") return true;
  return isTargetBaccaratTable(table);
}

function readTargetTableCodes() {
  const raw = String(process.env.GOODWIN_TARGET_TABLE_CODES || "").trim();
  const values = raw ? raw.split(/[,\s]+/) : DEFAULT_TARGET_TABLE_CODES;
  const seen = new Set();
  return values
    .map((value) => normalizeTableCode(value))
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

function normalizeTableCode(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/\b(?:IB\d{3}|[BQCV]\d{3})\b/);
  return match ? match[0] : "";
}

function getAllbetTableCode(table = {}) {
  return normalizeTableCode(table.tableCode || table.deskNo || table.name || table.roomId || "");
}

function targetCodeIndex(table = {}) {
  const index = TARGET_TABLE_CODES.indexOf(getAllbetTableCode(table));
  return index >= 0 ? index : TARGET_TABLE_CODES.length;
}

function createEmptyDb() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    tables: [],
    rounds: [],
    collector: {
      enabled: false,
      lastRunAt: "",
      lastOkAt: "",
      lastError: "",
      lastMessage: "",
      streakFailures: 0,
      runStartedAt: "",
      runLatencyMs: 0,
      lastFailureReason: "",
      nextRunAt: "",
      runIntervalMs: 0,
      lastRunScanned: 0,
      lastRunAdded: 0,
      noProgressStreak: 0,
      expectedBaccaratTables: 0,
      detectedBaccaratTables: 0,
      detailCapturedTables: 0,
      missingBaccaratTables: 0,
      lastRunTableIds: [],
      lastRunMissingTableIds: [],
      runHistory: []
    },
    snapshots: []
  };
}

function readDb() {
  ensureStore();
  try {
    const stat = fs.statSync(DB_PATH);
    const cacheKey = `${stat.mtimeMs}:${stat.size}`;
    if (dbCache && dbCacheKey === cacheKey) return dbCache;
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const db = migrateDb(parsed);
    dbCache = db;
    dbCacheKey = cacheKey;
    return db;
  } catch (error) {
    if (dbCache) return dbCache;
    const backupPath = `${DB_PATH}.broken-${Date.now()}`;
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, backupPath);
    const db = createEmptyDb();
    db.collector.lastError = `資料庫讀取失敗，已建立新檔。原檔備份：${backupPath}`;
    writeDb(db);
    return db;
  }
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = {
    ...db,
    updatedAt: new Date().toISOString()
  };
  const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const payload = JSON.stringify(next, null, 2);
  let lastError = null;
  for (let attempt = 0; attempt <= DB_WRITE_RETRIES; attempt += 1) {
    try {
      fs.writeFileSync(tmpPath, payload, "utf8");
      fs.renameSync(tmpPath, DB_PATH);
      const stat = fs.statSync(DB_PATH);
      dbCache = next;
      dbCacheKey = `${stat.mtimeMs}:${stat.size}`;
      analysisRoundsCache.clear();
      analysisTableOptionsCache = { key: "", value: null };
      writeDbVersion(next, stat);
      writeAnalysisSnapshot(next);
      cleanupTempFiles(DATA_DIR, `${path.basename(DB_PATH)}.`, ".tmp", TEMP_FILE_MAX_AGE_MS, TEMP_FILE_KEEP);
      return next;
    } catch (error) {
      lastError = error;
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (_) {}
      if (!isRetryableFileError(error) || attempt >= DB_WRITE_RETRIES) break;
      sleepSync(DB_WRITE_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError;
}

function writeDbVersion(db, stat = null) {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const latestRound = latestRoundAt(db.rounds || []);
    const summaryTables = (db.tables || []).filter((table) => table.summary).length;
    const verifiedSummaryTables = (db.tables || []).filter((table) => table.summary?.verified).length;
    const payload = {
      updatedAt: db.updatedAt || "",
      tables: Array.isArray(db.tables) ? db.tables.length : 0,
      allbetTables: getTargetBaccaratTables(db).length,
      summaryTables,
      verifiedSummaryTables,
      unverifiedSummaryTables: Math.max(0, summaryTables - verifiedSummaryTables),
      rounds: Array.isArray(db.rounds) ? db.rounds.length : 0,
      snapshots: Array.isArray(db.snapshots) ? db.snapshots.length : 0,
      latestRoundAt: latestRound,
      analysisVersion: buildAnalysisVersion(db, latestRound),
      dbMtimeMs: stat?.mtimeMs || 0,
      dbSize: stat?.size || 0,
      collector: buildStatusCollector(db.collector || {})
    };
    fs.writeFileSync(DB_VERSION_PATH, JSON.stringify(payload), "utf8");
  } catch (_) {}
}

function writeAnalysisSnapshot(db) {
  let tmpPath = "";
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    cleanupTempFiles(STORAGE_DIR, `${path.basename(ANALYSIS_SNAPSHOT_PATH)}.`, ".tmp", TEMP_FILE_MAX_AGE_MS, TEMP_FILE_KEEP);
    const latestRound = latestRoundAt(db.rounds || []);
    const analysisVersion = buildAnalysisVersion(db, latestRound);
    const tableById = new Map((db.tables || []).map((table) => [table.id, table]));
    const targetTables = getTargetBaccaratTables(db);
    const manualTables = (db.tables || []).filter((table) => table.provider === "manual");
    const snapshotTables = [...targetTables, ...manualTables];
    const allowedTableIds = new Set(snapshotTables.map((table) => table.id));
    const stats = buildRoundStats(db.rounds || []);
    const rounds = selectRecentAnalysisRounds(db.rounds || [], {
      allowedTableIds,
      tableById,
      perTableLimit: ANALYSIS_SNAPSHOT_TABLE_LIMIT
    }).sort(compareRounds);
    const payload = {
      createdAt: new Date().toISOString(),
      updatedAt: db.updatedAt || "",
      analysisVersion,
      allLimit: ANALYSIS_SNAPSHOT_ALL_LIMIT,
      tableLimit: ANALYSIS_SNAPSHOT_TABLE_LIMIT,
      tables: snapshotTables.map((table) => {
        const tableCode = table.provider === "allbet"
          ? getAllbetTableCode(table)
          : normalizeTableCode(table.tableCode || table.name || table.id);
        return {
          id: table.id,
          tableCode,
          name: table.name || tableCode,
          provider: table.provider || "",
          rounds: stats.get(table.id)?.rounds || 0,
          lastSeenAt: stats.get(table.id)?.lastSeenAt || table.lastSeenAt || ""
        };
      }),
      rounds
    };
    tmpPath = `${ANALYSIS_SNAPSHOT_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
    fs.renameSync(tmpPath, ANALYSIS_SNAPSHOT_PATH);
    tmpPath = "";
    const stat = fs.statSync(ANALYSIS_SNAPSHOT_PATH);
    analysisSnapshotCache = {
      key: `${stat.mtimeMs}:${stat.size}`,
      value: payload
    };
    cleanupTempFiles(STORAGE_DIR, `${path.basename(ANALYSIS_SNAPSHOT_PATH)}.`, ".tmp", TEMP_FILE_MAX_AGE_MS, TEMP_FILE_KEEP);
  } catch (_) {
    try {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
  }
}

function readDbVersionPayload() {
  try {
    if (!fs.existsSync(DB_VERSION_PATH)) return null;
    return JSON.parse(fs.readFileSync(DB_VERSION_PATH, "utf8"));
  } catch (_) {
    return null;
  }
}

function readAnalysisSnapshot() {
  try {
    if (!fs.existsSync(ANALYSIS_SNAPSHOT_PATH)) return null;
    const stat = fs.statSync(ANALYSIS_SNAPSHOT_PATH);
    const key = `${stat.mtimeMs}:${stat.size}`;
    const payload = analysisSnapshotCache.key === key
      ? analysisSnapshotCache.value
      : JSON.parse(fs.readFileSync(ANALYSIS_SNAPSHOT_PATH, "utf8"));
    const version = readDbVersionPayload();
    if (
      version?.analysisVersion
      && payload?.analysisVersion
      && String(version.analysisVersion) !== String(payload.analysisVersion)
    ) {
      return null;
    }
    analysisSnapshotCache = { key, value: payload };
    return payload;
  } catch (_) {
    return null;
  }
}

function buildAnalysisVersion(db, latestRound = "") {
  const roundCount = Array.isArray(db.rounds) ? db.rounds.length : 0;
  const tableCount = Array.isArray(db.tables) ? db.tables.length : 0;
  const lastRound = Array.isArray(db.rounds) ? db.rounds.at(-1) || {} : {};
  return [
    tableCount,
    roundCount,
    latestRound,
    lastRound.id || "",
    lastRound.tableId || "",
    lastRound.shoe || "",
    lastRound.handNumber || ""
  ].join("|");
}

function getAnalysisVersion() {
  const version = readDbVersionPayload();
  if (version?.analysisVersion) return String(version.analysisVersion);
  try {
    const db = readDb();
    const stat = fs.statSync(DB_PATH);
    writeDbVersion(db, stat);
    writeAnalysisSnapshot(db);
    return buildAnalysisVersion(db, latestRoundAt(db.rounds || []));
  } catch (_) {
    return "";
  }
}

function mutateDb(mutator) {
  const db = readDb();
  const result = mutator(db);
  writeDb(db);
  return result;
}

function migrateDb(db) {
  const next = {
    ...createEmptyDb(),
    ...db,
    tables: Array.isArray(db?.tables) ? db.tables : [],
    rounds: Array.isArray(db?.rounds) ? db.rounds : [],
    snapshots: Array.isArray(db?.snapshots) ? db.snapshots : [],
    collector: {
      ...createEmptyDb().collector,
      ...(db?.collector || {}),
      streakFailures: Number(db?.collector?.streakFailures || 0),
      runLatencyMs: Number(db?.collector?.runLatencyMs || 0),
      runIntervalMs: Number(db?.collector?.runIntervalMs || 0),
      lastRunScanned: Number(db?.collector?.lastRunScanned || 0),
      lastRunAdded: Number(db?.collector?.lastRunAdded || 0),
      noProgressStreak: Number(db?.collector?.noProgressStreak || 0),
      expectedBaccaratTables: Number(db?.collector?.expectedBaccaratTables || 0),
      detectedBaccaratTables: Number(db?.collector?.detectedBaccaratTables || 0),
      detailCapturedTables: Number(db?.collector?.detailCapturedTables || 0),
      missingBaccaratTables: Number(db?.collector?.missingBaccaratTables || 0),
      lastRunTableIds: Array.isArray(db?.collector?.lastRunTableIds) ? db.collector.lastRunTableIds : [],
      lastRunMissingTableIds: Array.isArray(db?.collector?.lastRunMissingTableIds)
        ? db.collector.lastRunMissingTableIds
        : [],
      runHistory: Array.isArray(db?.collector?.runHistory) ? db.collector.runHistory : []
    }
  };
  if (!next.tables.length) {
    const table = makeTable({ name: "手動輸入", roomId: "manual" });
    next.tables.push(table);
  }
  return next;
}

function normalizeRunHistoryEntry(entry = {}) {
  const at = entry.at && Number.isFinite(Date.parse(entry.at)) ? entry.at : new Date().toISOString();
  return {
    at,
    elapsedMs: Number(entry.elapsedMs || 0),
    ok: entry.ok === true,
    skipped: entry.skipped === true,
    scanned: Number(entry.scanned || 0),
    added: Number(entry.added || 0),
    expectedTables: Number(entry.expectedTables || 0),
    detectedTables: Number(entry.detectedTables || 0),
    detailCaptured: Number(entry.detailCaptured || 0),
    missingTables: Number(entry.missingTables || 0),
    skippedUnavailableTables: Number(entry.skippedUnavailableTables || 0),
    sourceView: String(entry.sourceView || ""),
    message: String(entry.message || "").slice(0, 250)
  };
}

function parseTimeMs(value) {
  if (value === undefined || value === null) return 0;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function isRetryableFileError(error) {
  return ["EBUSY", "EPERM", "EACCES", "ENFILE", "EMFILE"].includes(error?.code);
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, Math.max(1, Math.round(ms)));
}

function cleanupTempFiles(dir, prefix, suffix, maxAgeMs, keep) {
  try {
    const resolvedDir = path.resolve(dir);
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
      .map((entry) => {
        const fullPath = path.join(resolvedDir, entry.name);
        const stat = fs.statSync(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const nowMs = Date.now();
    entries.forEach((entry, index) => {
      const fullPath = path.resolve(entry.fullPath);
      if (!fullPath.startsWith(`${resolvedDir}${path.sep}`)) return;
      if (index < keep && nowMs - entry.mtimeMs <= maxAgeMs) return;
      fs.unlinkSync(fullPath);
    });
  } catch (_) {}
}

function appendCollectorRunHistory(entry = {}) {
  return mutateDb((db) => {
    const collector = db.collector || {};
    const history = Array.isArray(collector.runHistory) ? collector.runHistory : [];
    history.push(normalizeRunHistoryEntry(entry));
    collector.runHistory = history.slice(-RUN_HISTORY_LIMIT);
    db.collector = { ...collector };
    return db.collector;
  });
}

function readRunHistory(collector = {}, sinceMs) {
  const rawHistory = Array.isArray(collector.runHistory) ? collector.runHistory : [];
  const list = rawHistory
    .map((item) => ({
      ...item,
      atMs: parseTimeMs(item?.at)
    }))
    .filter((item) => item.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);
  if (!Number.isFinite(sinceMs)) return list;
  return list.filter((item) => item.atMs >= sinceMs);
}

function evaluateRunContinuity(history = [], maxGapMs = 120000, minimumRunCount = 0) {
  if (!Array.isArray(history) || history.length < 2) {
    return {
      continuous: false,
      runCount: history.length,
      maxGapMs,
      maxObservedGapMs: 0,
      minimumRunCount,
      reason: "Run history data is insufficient."
    };
  }
  let maxObservedGapMs = 0;
  for (let index = 1; index < history.length; index += 1) {
    const gap = history[index].atMs - history[index - 1].atMs;
    if (gap > maxObservedGapMs) {
      maxObservedGapMs = gap;
    }
    if (gap > maxGapMs) {
      return {
        continuous: false,
        runCount: history.length,
        maxGapMs,
        maxObservedGapMs,
        minimumRunCount,
        reason: `Gap ${Math.round(gap / 1000)}s exceeds ${Math.round(maxGapMs / 1000)}s threshold.`
      };
    }
  }
  if (history.length < minimumRunCount) {
    return {
      continuous: false,
      runCount: history.length,
      maxGapMs,
      maxObservedGapMs,
      minimumRunCount,
      reason: `Run count ${history.length} is below minimum required ${minimumRunCount}.`
    };
  }
  return {
    continuous: true,
    runCount: history.length,
    maxGapMs,
    maxObservedGapMs,
    minimumRunCount,
    reason: ""
  };
}

function getCollectorHealthSummary(hours = 24) {
  const db = readDb();
  const collector = db.collector || {};
  const nowMs = Date.now();
  const intervalMs = Number(collector.runIntervalMs || 300000);
  const configuredRunTimeoutMs = Number(process.env.COLLECT_RUN_TIMEOUT_MS || 0);
  const windowMs = hours * 60 * 60 * 1000;
  const windowSinceMs = nowMs - windowMs;
  const recentRuns = readRunHistory(collector, windowSinceMs);
  const maxRecentElapsedMs = recentRuns.reduce((max, item) => Math.max(max, Number(item.elapsedMs || 0)), 0);
  const configuredGapMs = Number(process.env.BAIJIA_HEALTH_MAX_GAP_MS || 0);
  const thresholdMs = Math.max(
    300000,
    Math.round(intervalMs * 5),
    Number.isFinite(configuredRunTimeoutMs) ? Math.round(configuredRunTimeoutMs + intervalMs + 60000) : 0,
    Math.round(maxRecentElapsedMs + intervalMs + 60000),
    Number.isFinite(configuredGapMs) ? configuredGapMs : 0
  );
  const expectedCadenceMs = thresholdMs;
  const expectedRunCount = expectedCadenceMs > 0 ? Math.max(1, Math.floor(windowMs / expectedCadenceMs)) : 0;
  const minimumRunCount = Math.max(2, Math.floor(expectedRunCount * 0.8));
  const continuity = evaluateRunContinuity(recentRuns, thresholdMs, minimumRunCount);
  const recentFailures = recentRuns.filter((item) => item.ok === false).length;

  const allbetTables = getTargetBaccaratTables(db);
  const allbetTableIds = new Set(allbetTables.map((table) => table.id));
  const allbetRounds24h = (db.rounds || []).filter((round) => {
    const observedMs = Date.parse(round.observedAt || round.createdAt || "");
    return Number.isFinite(observedMs) && observedMs >= windowSinceMs && allbetTableIds.has(round.tableId);
  });
  const allbetTableCoverage = new Map();
  for (const round of allbetRounds24h) {
    const key = round.tableId;
    const item = allbetTableCoverage.get(key) || { rounds: 0, lastSeenAt: "" };
    item.rounds += 1;
    const observedMs = Date.parse(round.observedAt || round.createdAt || "");
    if (Number.isFinite(observedMs)) {
      if (!item.lastSeenAt || observedMs > Date.parse(item.lastSeenAt)) {
        item.lastSeenAt = new Date(observedMs).toISOString();
      }
    }
    allbetTableCoverage.set(key, item);
  }
  const tableCoverage = allbetTables.map((table) => {
    const coverage = allbetTableCoverage.get(table.id) || { rounds: 0, lastSeenAt: "" };
    const roundSeenMs = parseTimeMs(coverage.lastSeenAt);
    const tableSeenMs = parseTimeMs(table.lastSeenAt);
    const lastSeenMs = Math.max(roundSeenMs, tableSeenMs);
    return {
      id: table.id,
      tableCode: getAllbetTableCode(table),
      roomId: table.roomId,
      name: table.name,
      rounds24h: coverage.rounds || 0,
      lastSeenAt: lastSeenMs > 0 ? new Date(lastSeenMs).toISOString() : "",
      observedInWindow: lastSeenMs >= windowSinceMs
    };
  });
  const activeAllbetTableIds = new Set(
    tableCoverage
      .filter((entry) => entry.rounds24h > 0 || entry.observedInWindow)
      .map((entry) => entry.id)
  );
  const inactiveAllbetTables = tableCoverage.filter((entry) => !activeAllbetTableIds.has(entry.id));
  const inactiveAllbetTableIds = inactiveAllbetTables.map((entry) => entry.id);
  const inactiveAllbetTableCodes = inactiveAllbetTables.map((entry) => entry.tableCode || entry.id);
  const coverageRate = allbetTables.length ? Math.round((activeAllbetTableIds.size / allbetTables.length) * 100) : 100;
  const latestSnapshot = db.snapshots.reduce((best, snapshot) => {
    if (!snapshot || !snapshot.createdAt) return best;
    return !best || Date.parse(snapshot.createdAt) > Date.parse(best.createdAt) ? snapshot : best;
  }, null);
  const heartbeatPath = path.join(STORAGE_DIR, "baijia-daemon.heartbeat");
  let heartbeatMs = 0;
  try {
    heartbeatMs = fs.statSync(heartbeatPath).mtimeMs;
  } catch (_) {
    heartbeatMs = 0;
  }
  return {
    now: new Date(nowMs).toISOString(),
    intervalMs,
    expectedCadenceMs,
    continuity,
    recentRuns: recentRuns.length,
    recentFailures,
    recentRunHistory: recentRuns.map((item) => ({
      at: item.at,
      elapsedMs: Number(item.elapsedMs || 0),
      ok: Boolean(item.ok),
      skipped: Boolean(item.skipped),
      scanned: Number(item.scanned || 0),
      added: Number(item.added || 0),
      expectedTables: Number(item.expectedTables || 0),
      detectedTables: Number(item.detectedTables || 0),
      detailCaptured: Number(item.detailCaptured || 0),
      missingTables: Number(item.missingTables || 0),
      skippedUnavailableTables: Number(item.skippedUnavailableTables || 0),
      sourceView: item.sourceView || "",
      message: item.message || ""
    })),
    allbet: {
      totalTables: allbetTables.length,
      roundsLast24h: allbetRounds24h.length,
      activeTablesLast24h: activeAllbetTableIds.size,
      observedTablesLast24h: activeAllbetTableIds.size,
      inactiveTablesLast24h: inactiveAllbetTableIds.length,
      coverageRate,
      tableCoverage: tableCoverage,
      inactiveTableIds: inactiveAllbetTableIds,
      inactiveTableCodes: inactiveAllbetTableCodes,
      latestCoverage: {
        at: latestSnapshot?.createdAt || "",
        expectedTables: Number(latestSnapshot?.coverage?.expectedTables || 0),
        detectedTables: Number(latestSnapshot?.coverage?.detectedTables || 0),
        detailCaptured: Number(latestSnapshot?.coverage?.detailCaptured || 0),
        missingTables: Number(latestSnapshot?.coverage?.missingTables || 0),
        missingTableIds: latestSnapshot?.coverage?.missingTableIds || [],
        skippedUnavailableTableIds: latestSnapshot?.coverage?.skippedUnavailableTableIds || []
      }
    },
    heartbeat: {
      exists: heartbeatMs > 0,
      updatedAt: heartbeatMs ? new Date(heartbeatMs).toISOString() : "",
      staleMinutes: heartbeatMs ? Math.max(0, Math.round((nowMs - heartbeatMs) / 60000)) : -1
    }
  };
}

function getCollectorCoverageSummary() {
  const db = readDb();
  const allbetBaccaratTables = getTargetBaccaratTables(db);
  const tableIds = new Set(allbetBaccaratTables.map((table) => table.id));
  const allbetRounds = (db.rounds || []).filter((round) => tableIds.has(round.tableId));
  const tableRoundCounts = new Map();
  for (const round of allbetRounds) {
    tableRoundCounts.set(round.tableId, (tableRoundCounts.get(round.tableId) || 0) + 1);
  }
  return {
    baccaratTableCount: allbetBaccaratTables.length,
    totalRounds: allbetRounds.length,
    tableCoverage: allbetBaccaratTables.map((table) => ({
      id: table.id,
      tableCode: getAllbetTableCode(table),
      roomId: table.roomId,
      name: table.name,
      rounds: tableRoundCounts.get(table.id) || 0,
      lastSeenAt: table.lastSeenAt || ""
    }))
  };
}

function listTables() {
  const db = readDb();
  const roundStats = buildRoundStats(db.rounds || []);
  return db.tables
    .filter((table) => isDisplayCandidateTable(table))
    .map((table) => ({
      ...table,
      rounds: roundStats.get(table.id)?.rounds || 0,
      lastSeenAt: roundStats.get(table.id)?.lastSeenAt || table.lastSeenAt || ""
    }));
}

function getTable(tableId) {
  const db = readDb();
  return db.tables.find((table) => table.id === tableId) || db.tables[0];
}

function upsertTable(input) {
  return mutateDb((db) => {
    const inputCode = getAllbetTableCode(input);
    const existing = db.tables.find((table) => (
      input.id && table.id === input.id
    ) || (
      inputCode && table.provider === (input.provider || table.provider) && getAllbetTableCode(table) === inputCode
    ) || (
      input.roomId && table.roomId === input.roomId && table.provider === (input.provider || table.provider)
    ));
    if (existing) {
      Object.assign(existing, cleanObject({
        name: input.name || existing.name,
        roomId: input.roomId || existing.roomId,
        tableCode: inputCode || input.tableCode || existing.tableCode,
        provider: input.provider || existing.provider,
        gameType: input.gameType || existing.gameType,
        shoe: input.shoe ?? existing.shoe,
        source: input.source || existing.source,
        enabled: input.enabled ?? existing.enabled,
        lastSeenAt: input.lastSeenAt || existing.lastSeenAt,
        summary: Object.prototype.hasOwnProperty.call(input, "summary") ? input.summary : existing.summary,
        parseWarning: input.parseWarning || existing.parseWarning || "",
        lastDetail: input.lastDetail || existing.lastDetail,
        lastRoadImages: input.lastRoadImages || existing.lastRoadImages,
        lastDetailText: input.lastDetailText || existing.lastDetailText
      }));
      return existing;
    }
    const table = makeTable(input);
    db.tables.push(table);
    return table;
  });
}

function removeSummaryOnlyTables(predicate) {
  return mutateDb((db) => {
    const roundTableIds = new Set(db.rounds.map((round) => round.tableId).filter(Boolean));
    const before = db.tables.length;
    db.tables = db.tables.filter((table) => {
      if (roundTableIds.has(table.id)) return true;
      return !predicate(table);
    });
    return before - db.tables.length;
  });
}

function cleanupEmptyManualDuplicateTables() {
  return mutateDb((db) => {
    const roundTableIds = new Set(db.rounds.map((round) => round.tableId).filter(Boolean));
    const allbetRoomIds = new Set(
      db.tables
        .filter((table) => table.provider === "allbet" && table.roomId)
        .map((table) => table.roomId)
    );
    const before = db.tables.length;
    db.tables = db.tables.filter((table) => !(
      table.provider === "manual"
      && table.roomId
      && table.roomId !== "manual"
      && !roundTableIds.has(table.id)
      && allbetRoomIds.has(table.roomId)
    ));
    return before - db.tables.length;
  });
}

function makeTable(input = {}) {
  const now = new Date().toISOString();
  const tableCode = getAllbetTableCode(input);
  return {
    id: input.id || createId("tbl"),
    name: input.name || input.roomId || "未命名桌台",
    roomId: input.roomId || "",
    tableCode,
    provider: input.provider || "manual",
    gameType: input.gameType || "baccarat",
    shoe: input.shoe || "",
    source: input.source || "manual",
    enabled: input.enabled ?? true,
    summary: input.summary || null,
    parseWarning: input.parseWarning || "",
    lastDetail: input.lastDetail || null,
    lastRoadImages: input.lastRoadImages || [],
    lastDetailText: input.lastDetailText || "",
    createdAt: input.createdAt || now,
    lastSeenAt: input.lastSeenAt || ""
  };
}

function addRound(tableId, roundInput) {
  return addRounds(tableId, [roundInput])[0] || null;
}

function addRounds(tableId, roundInputs, fallback = {}) {
  return mutateDb((db) => {
    let table = db.tables.find((item) => item.id === tableId);
    if (!table) {
      table = makeTable({ id: tableId, name: tableId || "新桌台" });
      db.tables.push(table);
    }

    const existingKeys = new Set(db.rounds.map((round) => round.externalKey).filter(Boolean));
    const added = [];
    roundInputs.forEach((roundInput, index) => {
      const round = normalizeRound(roundInput, {
        ...fallback,
        tableId: table.id,
        shoe: roundInput?.shoe || table.shoe || fallback.shoe || "",
        handNumber: roundInput?.handNumber || getNextHandNumber(db.rounds, table.id, table.shoe) + index
      });
      if (!round) return;
      round.id = round.id || createId("rnd");
      round.tableId = table.id;
      round.shoe = round.shoe || table.shoe || "";
      round.createdAt = round.createdAt || new Date().toISOString();
      round.observedAt = round.observedAt || round.createdAt;
      if (round.externalKey && existingKeys.has(round.externalKey)) {
        const existing = db.rounds.find((item) => item.externalKey === round.externalKey);
        if (existing) {
          existing.bankerPair = round.bankerPair;
          existing.playerPair = round.playerPair;
          existing.luckySix = round.luckySix;
          existing.bankerPoints = round.bankerPoints ?? existing.bankerPoints ?? null;
          existing.playerPoints = round.playerPoints ?? existing.playerPoints ?? null;
          existing.cardText = round.cardText || existing.cardText || "";
          existing.note = round.note || existing.note || "";
          existing.source = round.source || existing.source || "";
        }
        return;
      }
      if (round.externalKey) existingKeys.add(round.externalKey);
      db.rounds.push(round);
      table.lastSeenAt = round.observedAt;
      if (round.shoe) table.shoe = round.shoe;
      added.push(round);
    });
    return added;
  });
}

function importBulk(tableId, text) {
  const rounds = parseBulkRounds(text);
  return addRounds(tableId, rounds);
}

function clearTable(tableId) {
  return mutateDb((db) => {
    const before = db.rounds.length;
    db.rounds = db.rounds.filter((round) => round.tableId !== tableId);
    return before - db.rounds.length;
  });
}

function getRounds(tableId, limit = 1000) {
  const db = readDb();
  const rounds = db.rounds
    .filter((round) => !tableId || round.tableId === tableId)
    .sort(compareRounds);
  return limit ? rounds.slice(-limit) : rounds;
}

function getAllRounds() {
  return [...readDb().rounds].sort(compareRounds);
}

function getAnalysisTableOptions() {
  const snapshot = readAnalysisSnapshot();
  if (snapshot?.tables?.length) {
    return snapshot.tables
      .filter((table) => table.provider === "allbet")
      .map((table) => ({
        id: table.id,
        tableCode: table.tableCode,
        name: table.name || table.tableCode,
        rounds: Number(table.rounds || 0),
        lastSeenAt: table.lastSeenAt || ""
      }));
  }
  const db = readDb();
  if (analysisTableOptionsCache.key === dbCacheKey && analysisTableOptionsCache.value) {
    return analysisTableOptionsCache.value.map((table) => ({ ...table }));
  }
  const roundStats = buildRoundStats(db.rounds || []);
  const value = getTargetBaccaratTables(db).map((table) => ({
    id: table.id,
    tableCode: getAllbetTableCode(table),
    name: table.name || getAllbetTableCode(table),
    rounds: roundStats.get(table.id)?.rounds || 0,
    lastSeenAt: roundStats.get(table.id)?.lastSeenAt || table.lastSeenAt || ""
  }));
  analysisTableOptionsCache = { key: dbCacheKey, value };
  return value.map((table) => ({ ...table }));
}

function getAnalysisRounds(options = {}) {
  const snapshotRounds = getAnalysisRoundsFromSnapshot(options);
  if (snapshotRounds) return snapshotRounds;

  const db = readDb();
  const tableById = new Map((db.tables || []).map((table) => [table.id, table]));
  const targetTables = getTargetBaccaratTables(db);
  const targetTableIds = new Set(targetTables.map((table) => table.id));
  const manualTableIds = new Set(
    (db.tables || [])
      .filter((table) => table.provider === "manual")
      .map((table) => table.id)
  );
  const requestedTableId = String(options.tableId || "").trim();
  const requestedTableCode = normalizeTableCode(options.tableCode || "");
  const selectedTable = requestedTableId
    ? tableById.get(requestedTableId)
    : requestedTableCode
      ? targetTables.find((table) => getAllbetTableCode(table) === requestedTableCode)
      : null;
  const isTableScope = Boolean(selectedTable);
  const limit = clampLimit(
    Number(options.limit || 0),
    isTableScope ? ANALYSIS_TABLE_MAX_ROUNDS : ANALYSIS_MAX_ROUNDS
  );
  const cacheKey = [
    dbCacheKey,
    requestedTableId,
    requestedTableCode,
    selectedTable?.id || "",
    limit,
    isTableScope ? "table" : "all"
  ].join("|");
  const cached = getAnalysisRoundsCache(cacheKey);
  if (cached) return cached;
  const allowedTableIds = isTableScope
    ? new Set([selectedTable.id])
    : new Set([...targetTableIds, ...manualTableIds]);
  const perTableLimit = isTableScope
    ? limit
    : Math.max(120, Math.ceil(limit / Math.max(1, allowedTableIds.size)));
  const rounds = selectRecentAnalysisRounds(db.rounds || [], {
    allowedTableIds,
    tableById,
    perTableLimit
  });
  return setAnalysisRoundsCache(cacheKey, rounds.sort(compareRounds));
}

function getAnalysisRoundsFromSnapshot(options = {}) {
  const snapshot = readAnalysisSnapshot();
  if (!snapshot?.rounds?.length || !snapshot?.tables?.length) return null;
  const tableById = new Map(snapshot.tables.map((table) => [table.id, table]));
  const targetTables = snapshot.tables.filter((table) => table.provider === "allbet");
  const manualTables = snapshot.tables.filter((table) => table.provider === "manual");
  const requestedTableId = String(options.tableId || "").trim();
  const requestedTableCode = normalizeTableCode(options.tableCode || "");
  const selectedTable = requestedTableId
    ? tableById.get(requestedTableId)
    : requestedTableCode
      ? targetTables.find((table) => normalizeTableCode(table.tableCode) === requestedTableCode)
      : null;
  const isTableScope = Boolean(selectedTable);
  const limit = clampLimit(
    Number(options.limit || 0),
    isTableScope ? ANALYSIS_TABLE_MAX_ROUNDS : ANALYSIS_MAX_ROUNDS
  );
  if (isTableScope && limit > Number(snapshot.tableLimit || 0)) return null;
  if (!isTableScope && limit > Number(snapshot.allLimit || 0)) return null;

  const cacheKey = [
    `snapshot:${snapshot.analysisVersion || snapshot.createdAt || ""}`,
    requestedTableId,
    requestedTableCode,
    selectedTable?.id || "",
    limit,
    isTableScope ? "table" : "all"
  ].join("|");
  const cached = getAnalysisRoundsCache(cacheKey);
  if (cached) return cached;

  const allowedTableIds = isTableScope
    ? new Set([selectedTable.id])
    : new Set([...targetTables, ...manualTables].map((table) => table.id));
  const perTableLimit = isTableScope
    ? limit
    : Math.max(120, Math.ceil(limit / Math.max(1, allowedTableIds.size)));
  const rounds = selectRecentAnalysisRounds(snapshot.rounds, {
    allowedTableIds,
    tableById,
    perTableLimit
  });
  return setAnalysisRoundsCache(cacheKey, rounds.sort(compareRounds));
}

function selectRecentAnalysisRounds(sourceRounds, { allowedTableIds, tableById, perTableLimit }) {
  const rounds = [];
  const counts = new Map();
  let filledTables = 0;
  for (let index = sourceRounds.length - 1; index >= 0; index -= 1) {
    const round = sourceRounds[index];
    if (!allowedTableIds.has(round.tableId)) continue;
    const count = counts.get(round.tableId) || 0;
    if (count >= perTableLimit) continue;
    rounds.push(enrichAnalysisRound(round, tableById));
    counts.set(round.tableId, count + 1);
    if (count + 1 === perTableLimit) filledTables += 1;
    if (filledTables >= allowedTableIds.size) break;
  }
  return rounds;
}

function enrichAnalysisRound(round, tableById) {
  const table = tableById.get(round.tableId) || {};
  return {
    ...round,
    tableCode: getAllbetTableCode(table),
    tableName: table.name || "",
    provider: table.provider || ""
  };
}

function getAnalysisRoundsCache(key) {
  const cached = analysisRoundsCache.get(key);
  if (!cached) return null;
  analysisRoundsCache.delete(key);
  analysisRoundsCache.set(key, cached);
  return cached.slice();
}

function setAnalysisRoundsCache(key, rounds) {
  const value = Array.isArray(rounds) ? rounds.slice() : [];
  analysisRoundsCache.set(key, value);
  while (analysisRoundsCache.size > ANALYSIS_ROUNDS_CACHE_MAX) {
    const oldest = analysisRoundsCache.keys().next().value;
    analysisRoundsCache.delete(oldest);
  }
  return value.slice();
}

function getStatus() {
  const version = readDbVersionPayload();
  if (version && Number.isFinite(Number(version.tables)) && Number.isFinite(Number(version.rounds))) {
    const summaryTables = Number(version.summaryTables || 0);
    const verifiedSummaryTables = Number(version.verifiedSummaryTables || 0);
    return {
      ok: true,
      dbPath: DB_PATH,
      dataDir: DATA_DIR,
      tables: Number(version.tables || 0),
      allbetTables: Number(version.allbetTables || TARGET_TABLE_CODES.length),
      summaryTables,
      verifiedSummaryTables,
      unverifiedSummaryTables: Number(version.unverifiedSummaryTables ?? Math.max(0, summaryTables - verifiedSummaryTables)),
      rounds: Number(version.rounds || 0),
      snapshots: Number(version.snapshots || 0),
      updatedAt: version.updatedAt || "",
      latestRoundAt: version.latestRoundAt || "",
      analysisVersion: version.analysisVersion || "",
      dbMtimeMs: Number(version.dbMtimeMs || 0),
      dbSize: Number(version.dbSize || 0),
      statusSource: "version",
      collector: buildStatusCollector(version.collector || {})
    };
  }
  const db = readDb();
  const verifiedSummaryTables = db.tables.filter((table) => table.summary?.verified).length;
  const summaryTables = db.tables.filter((table) => table.summary).length;
  const allbetTables = getTargetBaccaratTables(db).length;
  return {
    ok: true,
    dbPath: DB_PATH,
    dataDir: DATA_DIR,
    tables: db.tables.length,
    allbetTables,
    summaryTables,
    verifiedSummaryTables,
    unverifiedSummaryTables: Math.max(0, summaryTables - verifiedSummaryTables),
    rounds: db.rounds.length,
    snapshots: db.snapshots.length,
    updatedAt: db.updatedAt,
    statusSource: "database",
    collector: buildStatusCollector(db.collector || {})
  };
}

function buildStatusCollector(collector = {}) {
  const runHistory = Array.isArray(collector.runHistory) ? collector.runHistory : [];
  return {
    ...collector,
    runHistoryCount: Number(collector.runHistoryCount ?? runHistory.length),
    runHistory: runHistory.slice(-20)
  };
}

function updateCollectorStatus(patch) {
  return mutateDb((db) => {
    db.collector = {
      ...db.collector,
      ...patch
    };
    return db.collector;
  });
}

function cleanupAllbetTablePollution() {
  return mutateDb((db) => {
    const beforeTables = db.tables.length;
    const beforeRounds = db.rounds.length;
    const tableRoundCounts = new Map();
    for (const round of db.rounds || []) {
      tableRoundCounts.set(round.tableId, (tableRoundCounts.get(round.tableId) || 0) + 1);
    }

    const keepByCode = new Map();
    const removedTableIds = new Set();
    for (const table of db.tables || []) {
      if (table.provider !== "allbet") continue;
      const code = getAllbetTableCode(table);
      if (!TARGET_TABLE_CODE_SET.has(code)) {
        removedTableIds.add(table.id);
        continue;
      }
      table.tableCode = code;
      table.enabled = true;
      table.gameType = "baccarat";
      const current = keepByCode.get(code);
      if (!current) {
        keepByCode.set(code, table);
        continue;
      }
      const currentRounds = tableRoundCounts.get(current.id) || 0;
      const nextRounds = tableRoundCounts.get(table.id) || 0;
      const primary = nextRounds > currentRounds ? table : current;
      const duplicate = primary === table ? current : table;
      for (const round of db.rounds || []) {
        if (round.tableId === duplicate.id) round.tableId = primary.id;
      }
      removedTableIds.add(duplicate.id);
      keepByCode.set(code, primary);
    }

    db.tables = (db.tables || []).filter((table) => !removedTableIds.has(table.id));
    db.rounds = (db.rounds || []).filter((round) => !removedTableIds.has(round.tableId));

    const activeIds = new Set(db.tables.map((table) => table.id));
    db.rounds = (db.rounds || []).filter((round) => activeIds.has(round.tableId));

    const createdMissingCodes = [];
    for (const code of TARGET_TABLE_CODES) {
      if (keepByCode.has(code)) continue;
      const table = makeTable({
        name: `Baccarat ${code}`,
        roomId: `allbet:${code}:${code}`,
        tableCode: code,
        provider: "allbet",
        gameType: "baccarat",
        source: "goodwin-allbet-target"
      });
      db.tables.push(table);
      keepByCode.set(code, table);
      createdMissingCodes.push(code);
    }

    dedupeTargetRounds(db);

    const missingCodes = TARGET_TABLE_CODES.filter((code) => !getTargetBaccaratTables(db).some((table) => getAllbetTableCode(table) === code));
    db.collector = {
      ...db.collector,
      expectedBaccaratTables: TARGET_TABLE_CODES.length,
      detectedBaccaratTables: getTargetBaccaratTables(db).length,
      missingBaccaratTables: missingCodes.length,
      lastRunMissingTableIds: missingCodes,
      lastMessage: `Cleaned ALLBET target tables. Removed ${beforeTables - db.tables.length + createdMissingCodes.length} polluted tables, created ${createdMissingCodes.length} missing targets, and removed ${beforeRounds - db.rounds.length} polluted rounds.`
    };

    return {
      beforeTables,
      afterTables: db.tables.length,
      beforeRounds,
      afterRounds: db.rounds.length,
      removedTables: beforeTables - db.tables.length + createdMissingCodes.length,
      createdMissingTables: createdMissingCodes.length,
      createdMissingCodes,
      removedRounds: beforeRounds - db.rounds.length,
      targetTables: getTargetBaccaratTables(db).length,
      missingCodes
    };
  });
}

function dedupeTargetRounds(db) {
  const tableMap = new Map((db.tables || []).map((table) => [table.id, table]));
  const seen = new Set();
  db.rounds = (db.rounds || []).filter((round) => {
    const table = tableMap.get(round.tableId);
    if (!table || !isTargetBaccaratTable(table)) return true;
    const key = round.externalKey || [
      round.tableId,
      round.shoe || "",
      round.handNumber || "",
      round.result || "",
      round.bankerPair === true ? "bp" : "",
      round.playerPair === true ? "pp" : "",
      round.luckySix === true ? "l6" : ""
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addSnapshot(snapshot) {
  return mutateDb((db) => {
    const item = {
      id: createId("snp"),
      createdAt: new Date().toISOString(),
      ...snapshot
    };
    db.snapshots.push(item);
    db.snapshots = db.snapshots.slice(-200);
    return item;
  });
}

function exportCsv() {
  const db = readDb();
  const header = [
    "tableName",
    "roomId",
    "shoe",
    "handNumber",
    "result",
    "bankerPair",
    "playerPair",
    "luckySix",
    "bankerPoints",
    "playerPoints",
    "cardText",
    "source",
    "observedAt",
    "note"
  ];
  const tableMap = new Map(db.tables.map((table) => [table.id, table]));
  const rows = [header];
  for (const round of [...db.rounds].sort(compareRounds)) {
    const table = tableMap.get(round.tableId) || {};
    rows.push([
      table.name || "",
      table.roomId || "",
      round.shoe || "",
      round.handNumber || "",
      round.result,
      round.bankerPair ? "1" : "0",
      round.playerPair ? "1" : "0",
      round.luckySix ? "1" : "0",
      round.bankerPoints ?? "",
      round.playerPoints ?? "",
      round.cardText || "",
      round.source || "",
      round.observedAt || "",
      round.note || ""
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function compareRounds(a, b) {
  const shoeCompare = String(a.shoe || "").localeCompare(String(b.shoe || ""));
  if (a.tableId === b.tableId && shoeCompare !== 0) return shoeCompare;
  const handA = Number(a.handNumber || 0);
  const handB = Number(b.handNumber || 0);
  if (a.tableId === b.tableId && handA !== handB) return handA - handB;
  return String(a.observedAt || a.createdAt || "").localeCompare(String(b.observedAt || b.createdAt || ""));
}

function latestRoundAt(rounds) {
  return rounds.reduce((latest, round) => {
    const value = round.observedAt || round.createdAt || "";
    return value > latest ? value : latest;
  }, "");
}

function buildRoundStats(rounds = []) {
  const stats = new Map();
  for (const round of rounds) {
    const key = round.tableId;
    if (!key) continue;
    const item = stats.get(key) || { rounds: 0, lastSeenAt: "" };
    item.rounds += 1;
    const value = round.observedAt || round.createdAt || "";
    if (value > item.lastSeenAt) item.lastSeenAt = value;
    stats.set(key, item);
  }
  return stats;
}

function clampLimit(value, fallback) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(ANALYSIS_LIMIT_CAP, Math.round(base)));
}

function getNextHandNumber(rounds, tableId, shoe) {
  return rounds
    .filter((round) => round.tableId === tableId && (!shoe || round.shoe === shoe))
    .reduce((max, round) => Math.max(max, Number(round.handNumber || 0)), 0) + 1;
}

function cleanObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  DB_PATH,
  DATA_DIR,
  ensureStore,
  readDb,
  writeDb,
  listTables,
  getTable,
  upsertTable,
  addRound,
  addRounds,
  removeSummaryOnlyTables,
  cleanupEmptyManualDuplicateTables,
  importBulk,
  clearTable,
  getRounds,
  getAllRounds,
  getAnalysisVersion,
  getAnalysisRounds,
  getAnalysisTableOptions,
  appendCollectorRunHistory,
  getCollectorHealthSummary,
  getCollectorCoverageSummary,
  getStatus,
  updateCollectorStatus,
  cleanupAllbetTablePollution,
  addSnapshot,
  exportCsv
};
