const { TARGET_TABLES } = require("./tables");
const { currentShoeRounds, isPredictionUsable } = require("./analytics");

const LIVE_EVENTS = new Set(["pushGameStatus", "pushGameTableResults", "manual"]);

function roundNoOf(round) {
  return Number(round?.roundNo || 0) || 0;
}

function slotKey(round) {
  return `${roundNoOf(round)}|${round.outcome || ""}|${round.rawResult || ""}`;
}

function missingRoundNos(rounds) {
  const slots = new Set(rounds.map(roundNoOf).filter(Boolean));
  if (!slots.size) return [];
  const first = Math.min(...slots);
  const last = Math.max(...slots);
  const missing = [];
  for (let roundNo = first; roundNo <= last; roundNo += 1) {
    if (!slots.has(roundNo)) missing.push(roundNo);
  }
  return missing;
}

function currentSegmentRows(tableRounds, selectedCurrent) {
  if (!selectedCurrent.length) return [];
  const firstId = Math.min(...selectedCurrent.map((round) => Number(round.id || 0)).filter(Boolean));
  return tableRounds.filter((round) => Number(round.id || 0) >= firstId);
}

function conflictSlots(rows) {
  const grouped = new Map();
  for (const round of rows) {
    const roundNo = roundNoOf(round);
    if (!roundNo) continue;
    if (!grouped.has(roundNo)) grouped.set(roundNo, []);
    grouped.get(roundNo).push(round);
  }

  return [...grouped.entries()]
    .map(([roundNo, group]) => {
      const signatures = new Set(group.map(slotKey));
      if (signatures.size <= 1) return null;
      return {
        roundNo,
        count: group.length,
        values: group.map((round) => ({
          id: round.id,
          outcome: round.outcome,
          rawResult: round.rawResult,
          sourceEvent: round.sourceEvent,
          insertedAt: round.insertedAt
        }))
      };
    })
    .filter(Boolean);
}

function tableValidation(rounds, table) {
  const tableRows = rounds.filter((round) => round.tableCode === table.code);
  const reliableRows = tableRows.filter(isPredictionUsable);
  const selectedCurrent = currentShoeRounds(reliableRows);
  const segmentRows = currentSegmentRows(reliableRows, selectedCurrent);
  const sourceCounts = {};
  for (const round of segmentRows) {
    sourceCounts[round.sourceEvent || "unknown"] = (sourceCounts[round.sourceEvent || "unknown"] || 0) + 1;
  }

  const missing = missingRoundNos(selectedCurrent);
  const snapshotOnly = selectedCurrent
    .filter((round) => round.sourceEvent === "roadSnapshot")
    .map((round) => roundNoOf(round));
  const nonLive = selectedCurrent
    .filter((round) => !LIVE_EVENTS.has(round.sourceEvent))
    .map((round) => ({
      roundNo: roundNoOf(round),
      sourceEvent: round.sourceEvent || "",
      rawResult: round.rawResult || ""
    }));
  const conflicts = conflictSlots(segmentRows);
  const latest = selectedCurrent.at(-1) || reliableRows.at(-1) || null;

  const severity = conflicts.length ? "ERROR"
    : missing.length || snapshotOnly.length || nonLive.length ? "WARN"
      : "OK";

  return {
    code: table.code,
    severity,
    totalReliable: reliableRows.length,
    currentShoeRounds: selectedCurrent.length,
    firstRoundNo: selectedCurrent.length ? roundNoOf(selectedCurrent[0]) : 0,
    currentRoundNo: selectedCurrent.length ? Math.max(...selectedCurrent.map(roundNoOf)) : 0,
    latestRound: latest
      ? {
        id: latest.id,
        roundNo: latest.roundNo,
        outcome: latest.outcome,
        sourceEvent: latest.sourceEvent,
        rawResult: latest.rawResult,
        insertedAt: latest.insertedAt
      }
      : null,
    missingRoundNos: missing,
    snapshotOnlyRoundNos: snapshotOnly,
    nonLiveRoundNos: nonLive,
    conflicts,
    sourceCounts
  };
}

function buildValidation(rounds) {
  const tables = TARGET_TABLES.map((table) => tableValidation(rounds, table));
  const warnTables = tables.filter((table) => table.severity === "WARN");
  const errorTables = tables.filter((table) => table.severity === "ERROR");
  return {
    generatedAt: new Date().toISOString(),
    ok: errorTables.length === 0 && warnTables.length === 0,
    summary: {
      tables: tables.length,
      ok: tables.filter((table) => table.severity === "OK").length,
      warn: warnTables.length,
      error: errorTables.length
    },
    issueTables: tables.filter((table) => table.severity !== "OK"),
    tables
  };
}

module.exports = {
  buildValidation
};
