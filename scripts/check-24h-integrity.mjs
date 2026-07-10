import { createRequire } from "module";

const require = createRequire(import.meta.url);
require("../src/env").loadLocalEnv();
const store = require("../src/store");

const HOURS = Number(process.argv[2] || 24);
const summary = store.getCollectorHealthSummary(HOURS);

const allbet = summary.allbet || {};
const heartbeat = summary.heartbeat || {};
const stale = heartbeat.staleMinutes >= 0 ? heartbeat.staleMinutes : -1;
const EXPECTED_TARGET_TABLES = 36;
const COVERAGE_SEEN_GRACE_MINUTES = Number(process.env.BAIJIA_COVERAGE_SEEN_GRACE_MINUTES || 10);
const RECOVERY_GAP_GRACE_MS = Number(process.env.BAIJIA_RECOVERY_GAP_GRACE_MS || 20 * 60 * 1000);
const latestCoverage = allbet.latestCoverage || {};
const latestMissingTableIds = latestCoverage.missingTableIds || [];
const latestSkippedUnavailableTableIds = latestCoverage.skippedUnavailableTableIds || [];
const latestSkippedSet = new Set(latestSkippedUnavailableTableIds);
const latestCoverageAtMs = Date.parse(latestCoverage.at || "");
const recentRuns = (summary.recentRunHistory || [])
  .slice()
  .sort((left, right) => Date.parse(left.at || "") - Date.parse(right.at || ""));
const targetRows = (allbet.tableCoverage || []).map((table) => ({
  code: table.tableCode || table.code || table.id || "",
  lastSeenAt: table.lastSeenAt || ""
}));
const observedAfterLatestCoverageIds = latestMissingTableIds.filter((code) => {
  const row = targetRows.find((item) => item.code === code);
  if (!row || !Number.isFinite(latestCoverageAtMs)) return false;
  return (Date.parse(row.lastSeenAt || "") || 0) > latestCoverageAtMs;
});
const observedAfterCoverageSet = new Set(observedAfterLatestCoverageIds);
const observedNearLatestCoverageIds = latestMissingTableIds.filter((code) => {
  const row = targetRows.find((item) => item.code === code);
  if (!row || !Number.isFinite(latestCoverageAtMs)) return false;
  const observedMs = Date.parse(row.lastSeenAt || "") || 0;
  if (!observedMs || observedMs > latestCoverageAtMs) return false;
  return latestCoverageAtMs - observedMs <= COVERAGE_SEEN_GRACE_MINUTES * 60 * 1000;
});
const observedNearCoverageSet = new Set(observedNearLatestCoverageIds);
const unaccountedMissingTableIds = latestMissingTableIds.filter((code) => (
  !latestSkippedSet.has(code) && !observedAfterCoverageSet.has(code) && !observedNearCoverageSet.has(code)
));
const wrongDetectedRuns = recentRuns
  .filter((item) => item.ok && !item.skipped)
  .filter((item) => Number(item.detectedTables || 0) > 0)
  .filter((item) => Number(item.detectedTables || 0) !== EXPECTED_TARGET_TABLES)
  .map((item) => ({
    at: item.at,
    expectedTables: Number(item.expectedTables || 0),
    detectedTables: Number(item.detectedTables || 0),
    detailCaptured: Number(item.detailCaptured || 0),
    message: item.message || ""
  }));
const recentFailureRuns = recentRuns
  .filter((item) => item.ok === false)
  .map((item) => ({
    at: item.at,
    message: item.message || ""
  }));
const continuityGaps = [];
const maxGapMs = Number(summary.continuity?.maxGapMs || summary.expectedCadenceMs || 300000);
for (let index = 1; index < recentRuns.length; index += 1) {
  const previousMs = Date.parse(recentRuns[index - 1].at || "");
  const currentMs = Date.parse(recentRuns[index].at || "");
  const gapMs = currentMs - previousMs;
  if (Number.isFinite(gapMs) && gapMs > maxGapMs) {
    continuityGaps.push({
      from: recentRuns[index - 1].at,
      to: recentRuns[index].at,
      gapMs,
      gapSeconds: Math.round(gapMs / 1000)
    });
  }
}
const targetTableCountOk = Number(allbet.totalTables || 0) === EXPECTED_TARGET_TABLES;
const latestRunDetectedAllTargets = (
  Number(latestCoverage.expectedTables || 0) === EXPECTED_TARGET_TABLES
  && Number(latestCoverage.detectedTables || 0) === EXPECTED_TARGET_TABLES
);
const latestMissingAllAccounted = unaccountedMissingTableIds.length === 0;
const latestCoverageHealthy = latestRunDetectedAllTargets || latestMissingAllAccounted;
const currentStateHealthy = (
  heartbeat.exists
  && stale >= 0
  && stale <= 5
  && Number(allbet.activeTablesLast24h || 0) === EXPECTED_TARGET_TABLES
  && Number(allbet.inactiveTablesLast24h || 0) === 0
  && Number(allbet.coverageRate || 0) === 100
  && latestCoverageHealthy
);
const unresolvedContinuityGaps = continuityGaps.filter((gap) => (
  !currentStateHealthy || Number(gap.gapMs || 0) > RECOVERY_GAP_GRACE_MS
));
const blockers = buildBlockers();
const earliestPossiblePassAt = blockers
  .map((item) => Date.parse(item.clearAfter || ""))
  .filter(Number.isFinite)
  .reduce((latest, value) => Math.max(latest, value), 0);

const report = {
  timestamp: summary.now,
  windowHours: HOURS,
  continuity: summary.continuity,
  recentFailures: Number(summary.recentFailures || 0),
  heartbeat: {
    exists: heartbeat.exists,
    staleMinutes: stale,
    updatedAt: heartbeat.updatedAt || ""
  },
  targetBaccaratTables: allbet.totalTables || 0,
  activeTablesLast24h: allbet.activeTablesLast24h || 0,
  observedTablesLast24h: allbet.observedTablesLast24h || allbet.activeTablesLast24h || 0,
  inactiveTablesLast24h: allbet.inactiveTablesLast24h || 0,
  coverageRate: allbet.coverageRate || 0,
  roundsLastWindow: allbet.roundsLast24h || 0,
  inactiveTableIds: allbet.inactiveTableIds || [],
  inactiveTableCodes: allbet.inactiveTableCodes || [],
  latestCoverage: {
    at: latestCoverage.at || "",
    expectedTables: Number(latestCoverage.expectedTables || 0),
    detectedTables: Number(latestCoverage.detectedTables || 0),
    detailCaptured: Number(latestCoverage.detailCaptured || 0),
    missingTables: Number(latestCoverage.missingTables || 0),
    missingTableIds: latestMissingTableIds,
    skippedUnavailableTableIds: latestSkippedUnavailableTableIds,
    observedAfterLatestCoverageIds,
    observedNearLatestCoverageIds,
    unaccountedMissingTableIds
  },
  latestRunDetectedAllTargets,
  latestMissingAllAccounted,
  latestCoverageHealthy,
  currentStateHealthy,
  continuityRecovered: !summary.continuity.continuous && continuityGaps.length > 0 && unresolvedContinuityGaps.length === 0,
  recoveryGapGraceMs: RECOVERY_GAP_GRACE_MS,
  unresolvedContinuityGaps,
  wrongDetectedRunCount: wrongDetectedRuns.length,
  recentWrongDetectedRuns: wrongDetectedRuns.slice(-10),
  blockers,
  earliestPossiblePassAt: earliestPossiblePassAt ? new Date(earliestPossiblePassAt).toISOString() : ""
};

console.log(JSON.stringify(report, null, 2));

if (
  unresolvedContinuityGaps.length > 0
  || report.recentFailures > 0
  || report.inactiveTablesLast24h > 0
  || !heartbeat.exists
  || !targetTableCountOk
  || !latestCoverageHealthy
  || report.latestCoverage.unaccountedMissingTableIds.length > 0
) {
  process.exitCode = 2;
}

function buildBlockers() {
  const items = [];
  const lastFailure = recentFailureRuns.at(-1);
  if (lastFailure) {
    items.push({
      type: "recent-failure",
      at: lastFailure.at || "",
      clearAfter: addHoursIso(lastFailure.at, HOURS),
      detail: lastFailure.message || "collector failure remains inside the health window"
    });
  }

  const lastGap = unresolvedContinuityGaps.at(-1);
  if (lastGap) {
    items.push({
      type: "continuity-gap",
      at: lastGap.to || "",
      clearAfter: addHoursIso(lastGap.to, HOURS),
      detail: `gap ${lastGap.gapSeconds}s exceeded ${Math.round(maxGapMs / 1000)}s`
    });
  }

  const lastWrongDetectedRun = wrongDetectedRuns.at(-1);
  if (lastWrongDetectedRun && !latestCoverageHealthy) {
    items.push({
      type: "wrong-detected-table-count",
      at: lastWrongDetectedRun.at || "",
      clearAfter: addHoursIso(lastWrongDetectedRun.at, HOURS),
      detail: `detected ${lastWrongDetectedRun.detectedTables}/${lastWrongDetectedRun.expectedTables} tables`
    });
  }

  if (reportWillHaveStaticBlockers()) {
    if (allbet.inactiveTablesLast24h > 0) {
      items.push({
        type: "inactive-tables",
        at: summary.now,
        clearAfter: "",
        detail: `${allbet.inactiveTablesLast24h} target tables inactive in the window`
      });
    }
    if (unaccountedMissingTableIds.length > 0) {
      items.push({
        type: "unaccounted-missing-tables",
        at: latestCoverage.at || summary.now,
        clearAfter: "",
        detail: unaccountedMissingTableIds.join(", ")
      });
    }
  }
  return items;
}

function reportWillHaveStaticBlockers() {
  return Number(allbet.inactiveTablesLast24h || 0) > 0 || unaccountedMissingTableIds.length > 0;
}

function addHoursIso(value, hours) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? new Date(ms + hours * 60 * 60 * 1000).toISOString() : "";
}
