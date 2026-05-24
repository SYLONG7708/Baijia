const { TARGET_TABLES } = require("./tables");
const { currentShoeRounds, isPredictionUsable } = require("./analytics");
const { buildCanonicalView } = require("./canonical");

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

function minRoundNo(rounds) {
  const values = rounds.map(roundNoOf).filter(Boolean);
  return values.length ? Math.min(...values) : 0;
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
    && snapshotMax >= liveMax + 10
    && maxId(liveRows) > maxId(snapshotRows);
}

function snapshotLooksStaleBehind(snapshotRows, liveRows) {
  if (!snapshotRows.length || !liveRows.length) return false;
  return maxId(snapshotRows) < maxId(liveRows)
    && maxRoundNo(snapshotRows) + 8 < maxRoundNo(liveRows);
}

function overlappingSnapshotConflictStats(snapshotRows, liveRows) {
  const liveByRoundNo = new Map();
  for (const live of liveRows) {
    const roundNo = roundNoOf(live);
    if (roundNo) liveByRoundNo.set(roundNo, live);
  }

  let overlap = 0;
  let conflicts = 0;
  for (const snapshot of snapshotRows) {
    const live = liveByRoundNo.get(roundNoOf(snapshot));
    if (!live) continue;
    overlap += 1;
    if (resultKey(snapshot) !== resultKey(live)) conflicts += 1;
  }
  return { overlap, conflicts };
}

function snapshotLooksLikeOlderConflictingShoe(snapshotRows, liveRows) {
  if (!snapshotRows.length || !liveRows.length) return false;
  if (maxId(snapshotRows) >= maxId(liveRows)) return false;
  if (minRoundNo(snapshotRows) > 3 || minRoundNo(liveRows) > 3) return false;
  const stats = overlappingSnapshotConflictStats(snapshotRows, liveRows);
  if (stats.overlap >= 1 && stats.conflicts === stats.overlap) {
    return true;
  }
  if (maxRoundNo(liveRows) < 5) return false;
  if (stats.overlap < 8) return false;
  return stats.conflicts >= Math.max(5, Math.floor(stats.overlap * 0.35));
}

function liveRowsAlignedToSnapshot(reliableRows, snapshotRows) {
  const current = currentShoeRounds(reliableRows);
  if (!snapshotRows.length) return current;
  const firstSnapshot = snapshotRows[0];
  if (roundNoOf(firstSnapshot) > 3) return current;
  const snapshotStartId = Number(firstSnapshot.id || 0);
  if (!snapshotStartId) return current;
  const aligned = currentShoeRounds(reliableRows.filter((round) => Number(round.id || 0) >= snapshotStartId));
  const currentLooksSameShoe = current.length
    && minRoundNo(current) <= 3
    && maxRoundNo(current) >= maxRoundNo(snapshotRows)
    && !snapshotLooksLikeNewerShoe(snapshotRows, current);
  if (currentLooksSameShoe && aligned.length < Math.max(3, Math.floor(snapshotRows.length / 2))) {
    return current;
  }
  return aligned.length ? aligned : current;
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

function actionableSnapshotOnlyRoundNos(snapshotOnlyRoundNos, liveRows) {
  if (!liveRows.length) return snapshotOnlyRoundNos;
  const liveFirst = minRoundNo(liveRows);
  const liveMax = maxRoundNo(liveRows);
  return snapshotOnlyRoundNos.filter((roundNo) => {
    const beforeLiveHistory = roundNo < liveFirst;
    const slightlyAhead = roundNo > liveMax && roundNo <= liveMax + 2;
    return !beforeLiveHistory && !slightlyAhead;
  });
}

function tableValidation(rounds, table, canonicalView) {
  const canonicalRows = canonicalView.canonicalRounds.filter((round) => round.tableCode === table.code);
  const quarantinedRows = canonicalView.quarantinedRounds.filter((round) => round.tableCode === table.code);
  const reliableRows = canonicalView.predictionRounds
    .filter((round) => round.tableCode === table.code)
    .filter(isPredictionUsable);
  const currentSnapshots = currentShoeRounds(canonicalRows.filter((round) => round.sourceEvent === SNAPSHOT_EVENT));
  const selectedCurrent = liveRowsAlignedToSnapshot(reliableRows, currentSnapshots);
  const snapshotNewerShoe = snapshotLooksLikeNewerShoe(currentSnapshots, selectedCurrent);
  const snapshotOlderConflictingShoe = snapshotLooksLikeOlderConflictingShoe(currentSnapshots, selectedCurrent);
  const snapshotOlderShoe = snapshotLooksLikeOlderShoe(currentSnapshots, selectedCurrent) || snapshotOlderConflictingShoe;
  const snapshotStaleBehind = snapshotLooksStaleBehind(currentSnapshots, selectedCurrent);
  const segmentRows = currentSegmentRows(reliableRows, selectedCurrent);
  const firstCurrentId = selectedCurrent.length
    ? Math.min(...selectedCurrent.map((round) => Number(round.id || 0)).filter(Boolean))
    : 0;
  const currentQuarantinedRows = firstCurrentId
    ? quarantinedRows.filter((round) => Number(round.id || 0) >= firstCurrentId)
    : [];
  const sourceCounts = {};
  for (const round of segmentRows) {
    sourceCounts[round.sourceEvent || "unknown"] = (sourceCounts[round.sourceEvent || "unknown"] || 0) + 1;
  }

  const missing = missingRoundNos(selectedCurrent);
  const comparableSnapshots = snapshotOlderShoe || snapshotStaleBehind ? [] : currentSnapshots;
  const snapshotCheck = snapshotComparison(comparableSnapshots, snapshotNewerShoe ? [] : selectedCurrent);
  const snapshotOnlySet = new Set(snapshotCheck.snapshotOnlyRoundNos);
  const snapshotFillRoundNos = missing.filter((roundNo) => snapshotOnlySet.has(roundNo));
  const unresolvedMissing = missing.filter((roundNo) => !snapshotOnlySet.has(roundNo));
  const actionableSnapshotOnly = actionableSnapshotOnlyRoundNos(snapshotCheck.snapshotOnlyRoundNos, selectedCurrent)
    .filter((roundNo) => !snapshotFillRoundNos.includes(roundNo));
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
    : unresolvedMissing.length
      || actionableSnapshotOnly.length
      || snapshotCheck.snapshotShiftedMatches.length
      || nonLive.length
      || currentQuarantinedRows.length ? "WARN"
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
    unresolvedMissingRoundNos: unresolvedMissing,
    snapshotFillRoundNos,
    snapshotRounds: snapshotCheck.snapshotRounds,
    snapshotCurrentRoundNo: snapshotCheck.snapshotCurrentRoundNo,
    snapshotLatest: snapshotCheck.snapshotLatest,
    snapshotNewerShoe,
    snapshotOlderShoe,
    snapshotOlderConflictingShoe,
    snapshotStaleBehind,
    snapshotOnlyRoundNos: snapshotCheck.snapshotOnlyRoundNos,
    actionableSnapshotOnlyRoundNos: actionableSnapshotOnly,
    ignoredSnapshotOnlyRoundNos: snapshotCheck.snapshotOnlyRoundNos.filter((roundNo) => !actionableSnapshotOnly.includes(roundNo)),
    snapshotConflicts: snapshotCheck.snapshotConflicts,
    snapshotShiftedMatches: snapshotCheck.snapshotShiftedMatches,
    nonLiveRoundNos: nonLive,
    quarantinedRows: currentQuarantinedRows.slice(0, 40).map((round) => ({
      id: round.id,
      roundNo: roundNoOf(round),
      outcome: round.outcome,
      rawResult: round.rawResult,
      sourceEvent: round.sourceEvent,
      qualityReason: round.qualityReason,
      canonicalWinnerId: round.canonicalWinnerId || 0
    })),
    quarantinedCount: quarantinedRows.length,
    currentQuarantinedCount: currentQuarantinedRows.length,
    conflicts,
    sourceCounts
  };
}

function buildValidation(rounds) {
  const canonicalView = buildCanonicalView(rounds);
  const tables = TARGET_TABLES.map((table) => tableValidation(rounds, table, canonicalView));
  const warnTables = tables.filter((table) => table.severity === "WARN");
  const errorTables = tables.filter((table) => table.severity === "ERROR");
  return {
    generatedAt: new Date().toISOString(),
    canonical: canonicalView.summary,
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
