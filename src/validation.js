const { TARGET_TABLES } = require("./tables");
const { currentShoeRounds, isPredictionUsable } = require("./analytics");

const LIVE_EVENTS = new Set(["pushGameStatus", "pushGameTableResults", "manual"]);
const SNAPSHOT_EVENT = "roadSnapshot";

function roundNoOf(round) {
  return Number(round?.roundNo || 0) || 0;
}

function slotKey(round) {
  return `${roundNoOf(round)}|${round.outcome || ""}|${round.rawResult || ""}`;
}

function resultKey(round) {
  return `${round.outcome || ""}|${round.rawResult || ""}`;
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

function maxRoundNo(rounds) {
  return Math.max(0, ...rounds.map(roundNoOf));
}

function maxId(rounds) {
  return Math.max(0, ...rounds.map((round) => Number(round.id || 0) || 0));
}

function snapshotLooksLikeNewerShoe(snapshotRows, liveRows) {
  if (!snapshotRows.length || !liveRows.length) return false;
  const snapshotFirst = Math.min(...snapshotRows.map(roundNoOf).filter(Boolean));
  const snapshotMax = maxRoundNo(snapshotRows);
  const liveMax = maxRoundNo(liveRows);
  return snapshotFirst <= 3
    && snapshotMax + 8 < liveMax
    && maxId(snapshotRows) > maxId(liveRows);
}

function snapshotLooksLikeOlderShoe(snapshotRows, liveRows) {
  if (!snapshotRows.length || !liveRows.length) return false;
  const liveFirst = Math.min(...liveRows.map(roundNoOf).filter(Boolean));
  const snapshotMax = maxRoundNo(snapshotRows);
  const liveMax = maxRoundNo(liveRows);
  return liveFirst <= 3
    && liveMax <= 12
    && snapshotMax >= liveMax + 20
    && maxId(liveRows) > maxId(snapshotRows);
}

function snapshotComparison(snapshotRows, liveRows) {
  const liveByRoundNo = new Map();
  for (const round of liveRows) {
    const roundNo = roundNoOf(round);
    if (roundNo) liveByRoundNo.set(roundNo, round);
  }

  const snapshotOnly = [];
  const conflicts = [];
  const shifted = [];

  for (const snapshot of snapshotRows) {
    const roundNo = roundNoOf(snapshot);
    if (!roundNo) continue;
    const live = liveByRoundNo.get(roundNo);
    if (!live) {
      snapshotOnly.push(roundNo);
      continue;
    }
    if (resultKey(live) !== resultKey(snapshot)) {
      conflicts.push({
        roundNo,
        snapshot: {
          id: snapshot.id,
          outcome: snapshot.outcome,
          rawResult: snapshot.rawResult,
          insertedAt: snapshot.insertedAt
        },
        live: {
          id: live.id,
          outcome: live.outcome,
          rawResult: live.rawResult,
          sourceEvent: live.sourceEvent,
          insertedAt: live.insertedAt
        }
      });
    }
  }

  const liveRowsByResult = new Map();
  for (const live of liveRows) {
    const key = resultKey(live);
    if (!liveRowsByResult.has(key)) liveRowsByResult.set(key, []);
    liveRowsByResult.get(key).push(live);
  }

  for (const snapshot of snapshotRows) {
    const matches = liveRowsByResult.get(resultKey(snapshot)) || [];
    const sameSlot = matches.some((live) => roundNoOf(live) === roundNoOf(snapshot));
    if (sameSlot) continue;
    const nearest = matches
      .map((live) => ({
        live,
        distance: Math.abs(roundNoOf(live) - roundNoOf(snapshot))
      }))
      .filter((item) => item.distance > 0 && item.distance <= 5)
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearest) {
      shifted.push({
        snapshotRoundNo: roundNoOf(snapshot),
        liveRoundNo: roundNoOf(nearest.live),
        rawResult: snapshot.rawResult,
        outcome: snapshot.outcome,
        offset: roundNoOf(nearest.live) - roundNoOf(snapshot)
      });
    }
  }

  return {
    snapshotRounds: snapshotRows.length,
    snapshotCurrentRoundNo: snapshotRows.length ? Math.max(...snapshotRows.map(roundNoOf)) : 0,
    snapshotLatest: snapshotRows.at(-1)
      ? {
        id: snapshotRows.at(-1).id,
        roundNo: snapshotRows.at(-1).roundNo,
        outcome: snapshotRows.at(-1).outcome,
        rawResult: snapshotRows.at(-1).rawResult,
        insertedAt: snapshotRows.at(-1).insertedAt
      }
      : null,
    snapshotOnlyRoundNos: snapshotOnly.slice(0, 80),
    snapshotConflicts: conflicts.slice(0, 40),
    snapshotShiftedMatches: shifted.slice(0, 40)
  };
}

function tableValidation(rounds, table) {
  const tableRows = rounds.filter((round) => round.tableCode === table.code);
  const reliableRows = tableRows.filter(isPredictionUsable);
  const currentSnapshots = currentShoeRounds(tableRows.filter((round) => round.sourceEvent === SNAPSHOT_EVENT));
  const selectedCurrent = currentShoeRounds(reliableRows);
  const snapshotNewerShoe = snapshotLooksLikeNewerShoe(currentSnapshots, selectedCurrent);
  const snapshotOlderShoe = snapshotLooksLikeOlderShoe(currentSnapshots, selectedCurrent);
  const segmentRows = currentSegmentRows(reliableRows, selectedCurrent);
  const sourceCounts = {};
  for (const round of segmentRows) {
    sourceCounts[round.sourceEvent || "unknown"] = (sourceCounts[round.sourceEvent || "unknown"] || 0) + 1;
  }

  const missing = missingRoundNos(selectedCurrent);
  const comparableSnapshots = snapshotOlderShoe ? [] : currentSnapshots;
  const snapshotCheck = snapshotComparison(comparableSnapshots, snapshotNewerShoe ? [] : selectedCurrent);
  const nonLive = selectedCurrent
    .filter((round) => !LIVE_EVENTS.has(round.sourceEvent))
    .map((round) => ({
      roundNo: roundNoOf(round),
      sourceEvent: round.sourceEvent || "",
      rawResult: round.rawResult || ""
    }));
  const conflicts = conflictSlots(segmentRows);
  const latest = selectedCurrent.at(-1) || reliableRows.at(-1) || null;

  const severity = conflicts.length || snapshotCheck.snapshotConflicts.length ? "ERROR"
    : missing.length
      || snapshotCheck.snapshotOnlyRoundNos.length
      || snapshotCheck.snapshotShiftedMatches.length
      || nonLive.length ? "WARN"
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
    snapshotRounds: snapshotCheck.snapshotRounds,
    snapshotCurrentRoundNo: snapshotCheck.snapshotCurrentRoundNo,
    snapshotLatest: snapshotCheck.snapshotLatest,
    snapshotNewerShoe,
    snapshotOlderShoe,
    snapshotOnlyRoundNos: snapshotCheck.snapshotOnlyRoundNos,
    snapshotConflicts: snapshotCheck.snapshotConflicts,
    snapshotShiftedMatches: snapshotCheck.snapshotShiftedMatches,
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
