import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const store = require("../src/store");

const ROOT = process.cwd();
const TARGET_CODES = [
  "B201", "B202", "B203", "B219", "B220",
  "B501", "B502", "B503", "B504", "B505", "B506", "B507",
  "B601", "B602", "B603", "B604", "B605", "B618",
  "C201", "C202", "C501", "C701",
  "IB201", "IB202",
  "Q201", "Q202", "Q204", "Q501", "Q502", "Q601", "Q701", "Q702",
  "V911", "V912", "V971", "V972"
];
const TARGET_SET = new Set(TARGET_CODES);
const VALID_RESULTS = new Set(["banker", "player", "tie"]);

const db = store.readDb();
const tableById = new Map((db.tables || []).map((table) => [table.id, table]));
const allbetTables = (db.tables || [])
  .filter((table) => table.provider === "allbet")
  .map((table) => ({
    id: table.id,
    code: normalizeCode(table.tableCode || table.deskNo || table.name || table.roomId),
    name: table.name || "",
    roomId: table.roomId || ""
  }));
const targetTables = allbetTables.filter((table) => TARGET_SET.has(table.code));
const targetCodes = targetTables.map((table) => table.code);
const missingCodes = TARGET_CODES.filter((code) => !targetCodes.includes(code));
const duplicateCodes = duplicates(targetCodes);
const extraAllbetTables = allbetTables.filter((table) => !TARGET_SET.has(table.code));
const orphanRounds = (db.rounds || []).filter((round) => !tableById.has(round.tableId));
const invalidRounds = (db.rounds || []).filter((round) => !VALID_RESULTS.has(round.result));
const duplicateRoundIds = duplicates((db.rounds || []).map((round) => round.id).filter(Boolean));
const duplicateExternalKeys = duplicates((db.rounds || []).map((round) => round.externalKey).filter(Boolean));
const targetRoundCounts = countTargetRounds(db.rounds || [], tableById);
const zeroRoundTargetCodes = TARGET_CODES.filter((code) => !targetRoundCounts.get(code));
const latestSnapshot = latestByDate(db.snapshots || [], "createdAt");
const backupLatestFiles = [
  path.join(ROOT, "backups", "backup-latest.json"),
  path.join(
    os.homedir(),
    "Desktop",
    "CODEX \u5c08\u6848\u8cc7\u6599\u593e",
    "\u88fd\u4f5c\u904e\u7684 APP \u4ee5\u53ca\u8cc7\u6599",
    "Baijia_\u81ea\u52d5\u5099\u4efd",
    "backup-latest.json"
  )
];
const backupManifests = backupLatestFiles.map((file) => ({
  file,
  exists: fs.existsSync(file),
  validJson: canReadJson(file)
}));

const errors = [];
if (targetTables.length !== TARGET_CODES.length) errors.push(`Expected ${TARGET_CODES.length} target tables, found ${targetTables.length}.`);
if (missingCodes.length) errors.push(`Missing target table codes: ${missingCodes.join(", ")}.`);
if (duplicateCodes.length) errors.push(`Duplicate target table codes: ${duplicateCodes.join(", ")}.`);
if (extraAllbetTables.length) errors.push(`Extra ALLBET tables outside target list: ${extraAllbetTables.map((table) => table.code || table.id).join(", ")}.`);
if (zeroRoundTargetCodes.length) errors.push(`Target tables with zero rounds: ${zeroRoundTargetCodes.join(", ")}.`);
if (orphanRounds.length) errors.push(`Orphan rounds without table: ${orphanRounds.length}.`);
if (invalidRounds.length) errors.push(`Rounds with invalid result: ${invalidRounds.length}.`);
if (duplicateRoundIds.length) errors.push(`Duplicate round ids: ${duplicateRoundIds.length}.`);
if (duplicateExternalKeys.length) errors.push(`Duplicate external keys: ${duplicateExternalKeys.length}.`);
if (!backupManifests.every((item) => item.exists && item.validJson)) errors.push("One or more backup-latest.json manifests are missing or invalid.");

const report = {
  generatedAt: new Date().toISOString(),
  ok: errors.length === 0,
  errors,
  tables: {
    total: (db.tables || []).length,
    allbet: allbetTables.length,
    target: targetTables.length,
    uniqueTargetCodes: new Set(targetCodes).size,
    missingCodes,
    duplicateCodes,
    extraAllbetTables
  },
  rounds: {
    total: (db.rounds || []).length,
    targetTotal: [...targetRoundCounts.values()].reduce((sum, value) => sum + value, 0),
    zeroRoundTargetCodes,
    orphanRounds: orphanRounds.length,
    invalidRounds: invalidRounds.length,
    duplicateRoundIds: duplicateRoundIds.length,
    duplicateExternalKeys: duplicateExternalKeys.length,
    minTargetRounds: TARGET_CODES.length ? Math.min(...TARGET_CODES.map((code) => targetRoundCounts.get(code) || 0)) : 0,
    maxTargetRounds: TARGET_CODES.length ? Math.max(...TARGET_CODES.map((code) => targetRoundCounts.get(code) || 0)) : 0
  },
  snapshots: {
    count: (db.snapshots || []).length,
    latestAt: latestSnapshot?.createdAt || "",
    latestCoverage: latestSnapshot?.coverage || null
  },
  backups: backupManifests
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 2;

function countTargetRounds(rounds, tables) {
  const counts = new Map();
  for (const round of rounds) {
    const table = tables.get(round.tableId);
    const code = normalizeCode(table?.tableCode || table?.deskNo || table?.name || table?.roomId);
    if (!TARGET_SET.has(code)) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return counts;
}

function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

function latestByDate(items, key) {
  return items.reduce((best, item) => {
    const value = Date.parse(item?.[key] || "");
    if (!Number.isFinite(value)) return best;
    if (!best || value > Date.parse(best[key] || "")) return item;
    return best;
  }, null);
}

function canReadJson(file) {
  if (!fs.existsSync(file)) return false;
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeCode(value) {
  return String(value || "").toUpperCase().match(/\b(?:IB\d{3}|[BQCV]\d{3})\b/)?.[0] || "";
}
