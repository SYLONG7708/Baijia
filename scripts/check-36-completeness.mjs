import { createRequire } from "node:module";

const store = createRequire(import.meta.url)("../src/store");

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
const FRESH_MINUTES = Number(process.argv[2] || 30);
const COVERAGE_SEEN_GRACE_MINUTES = Number(process.env.BAIJIA_COVERAGE_SEEN_GRACE_MINUTES || 10);

const db = store.readDb();
const health = store.getCollectorHealthSummary(24);
const nowMs = Date.now();
const latestCoverage = health.allbet?.latestCoverage || {};
const latestMissing = latestCoverage.missingTableIds || [];
const latestSkipped = latestCoverage.skippedUnavailableTableIds || [];
const skippedSet = new Set(latestSkipped);
const latestCoverageAtMs = Date.parse(latestCoverage.at || "");

const rows = (db.tables || [])
  .filter((table) => table.provider === "allbet")
  .map((table) => {
    const code = normalizeCode(table.tableCode || table.deskNo || table.name || table.roomId);
    const rounds = (db.rounds || []).filter((round) => round.tableId === table.id);
    const latestRoundAt = rounds
      .map((round) => round.observedAt || round.createdAt || "")
      .filter(Boolean)
      .sort()
      .at(-1) || "";
    const lastSeenAt = table.lastSeenAt || "";
    return {
      code,
      id: table.id,
      name: table.name,
      rounds: rounds.length,
      lastSeenAt,
      latestRoundAt,
      lastSeenAgeMinutes: ageMinutes(nowMs, lastSeenAt),
      latestRoundAgeMinutes: ageMinutes(nowMs, latestRoundAt)
    };
  })
  .filter((row) => TARGET_SET.has(row.code))
  .sort((left, right) => TARGET_CODES.indexOf(left.code) - TARGET_CODES.indexOf(right.code));

const codes = rows.map((row) => row.code);
const duplicateCodes = [...new Set(codes.filter((code, index) => codes.indexOf(code) !== index))];
const missingCodes = TARGET_CODES.filter((code) => !codes.includes(code));
const extraTables = (db.tables || [])
  .filter((table) => table.provider === "allbet")
  .map((table) => ({
    id: table.id,
    code: normalizeCode(table.tableCode || table.deskNo || table.name || table.roomId),
    name: table.name,
    roomId: table.roomId
  }))
  .filter((table) => !TARGET_SET.has(table.code));
const zeroRoundTables = rows.filter((row) => row.rounds === 0);
const staleSeenTables = rows.filter((row) => row.lastSeenAgeMinutes > FRESH_MINUTES);
const observedAfterLatestCoverageIds = latestMissing.filter((code) => {
  const row = rows.find((item) => item.code === code);
  if (!row || !Number.isFinite(latestCoverageAtMs)) return false;
  return Math.max(Date.parse(row.lastSeenAt || "") || 0, Date.parse(row.latestRoundAt || "") || 0) > latestCoverageAtMs;
});
const observedAfterCoverageSet = new Set(observedAfterLatestCoverageIds);
const observedNearLatestCoverageIds = latestMissing.filter((code) => {
  const row = rows.find((item) => item.code === code);
  if (!row || !Number.isFinite(latestCoverageAtMs)) return false;
  const observedMs = Math.max(Date.parse(row.lastSeenAt || "") || 0, Date.parse(row.latestRoundAt || "") || 0);
  if (!observedMs || observedMs > latestCoverageAtMs) return false;
  return latestCoverageAtMs - observedMs <= COVERAGE_SEEN_GRACE_MINUTES * 60 * 1000;
});
const observedNearCoverageSet = new Set(observedNearLatestCoverageIds);
const unaccountedMissingTableIds = latestMissing.filter((code) => (
  !skippedSet.has(code)
  && !observedAfterCoverageSet.has(code)
  && !observedNearCoverageSet.has(code)
));
const recentRuns = health.recentRunHistory || [];
const wrongDetectedRuns = recentRuns.filter((run) => (
  run.ok
  && !run.skipped
  && Number(run.detectedTables || 0) > 0
  && Number(run.detectedTables || 0) !== TARGET_CODES.length
));
const recentFailures = recentRuns.filter((run) => run.ok === false);
const gaps = [];
for (let index = 1; index < recentRuns.length; index += 1) {
  const gap = Date.parse(recentRuns[index].at || "") - Date.parse(recentRuns[index - 1].at || "");
  if (Number.isFinite(gap) && gap > Number(health.continuity?.maxGapMs || 300000)) {
    gaps.push({
      from: recentRuns[index - 1].at,
      to: recentRuns[index].at,
      gapSeconds: Math.round(gap / 1000)
    });
  }
}

const report = {
  timestamp: new Date().toISOString(),
  targetTablesExpected: TARGET_CODES.length,
  tableCount: rows.length,
  uniqueCodes: new Set(codes).size,
  allTargetTablesPresent: rows.length === TARGET_CODES.length && missingCodes.length === 0 && duplicateCodes.length === 0,
  allTargetTablesHaveRounds: zeroRoundTables.length === 0,
  allTargetTablesRecentlySeen: staleSeenTables.length === 0,
  latestRunDetectedAllTargets: Number(latestCoverage.detectedTables || 0) === TARGET_CODES.length,
  latestMissingAllAccounted: unaccountedMissingTableIds.length === 0,
  latestDetailCaptured: Number(latestCoverage.detailCaptured || 0),
  latestMissingTables: Number(latestCoverage.missingTables || 0),
  latestSkippedUnavailableTables: latestSkipped.length,
  minRounds: rows.length ? Math.min(...rows.map((row) => row.rounds)) : 0,
  maxRounds: rows.length ? Math.max(...rows.map((row) => row.rounds)) : 0,
  totalRounds: rows.reduce((sum, row) => sum + row.rounds, 0),
  missingCodes,
  duplicateCodes,
  extraTables,
  zeroRoundTables,
  staleSeenTables,
  latestCoverage: {
    at: latestCoverage.at || "",
    expectedTables: Number(latestCoverage.expectedTables || 0),
    detectedTables: Number(latestCoverage.detectedTables || 0),
    detailCaptured: Number(latestCoverage.detailCaptured || 0),
    missingTableIds: latestMissing,
    skippedUnavailableTableIds: latestSkipped,
    observedAfterLatestCoverageIds,
    observedNearLatestCoverageIds,
    unaccountedMissingTableIds
  },
  last24h: {
    observedTables: Number(health.allbet?.observedTablesLast24h || 0),
    inactiveTables: Number(health.allbet?.inactiveTablesLast24h || 0),
    coverageRate: Number(health.allbet?.coverageRate || 0),
    rounds: Number(health.allbet?.roundsLast24h || 0),
    recentFailures: recentFailures.length,
    wrongDetectedRunCount: wrongDetectedRuns.length,
    continuity: health.continuity,
    gapCount: gaps.length,
    lastGap: gaps.at(-1) || null,
    lastFailure: recentFailures.at(-1) || null,
    lastWrongDetectedRun: wrongDetectedRuns.at(-1) || null
  },
  tables: rows
};

console.log(JSON.stringify(report, null, 2));

const ok = (
  report.allTargetTablesPresent
  && report.allTargetTablesHaveRounds
  && report.latestRunDetectedAllTargets
  && report.latestMissingAllAccounted
);

if (!ok) process.exitCode = 2;

function normalizeCode(value) {
  return String(value || "").toUpperCase().match(/\b(?:IB\d{3}|[BQCV]\d{3})\b/)?.[0] || "";
}

function ageMinutes(now, value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 60000)) : 999999;
}
