const { normalizeOutcome } = require("./baccarat-codec");

const SNAPSHOT_EVENTS = new Set(["getGameHall", "getGameHall:snapshot", "roadSnapshot"]);
const LIVE_EVENTS = new Set(["pushGameStatus", "pushGameTableResults", "manual"]);

function roundNoOf(round) {
  return Number(round?.roundNo || 0) || 0;
}

function isValidRound(round) {
  return Boolean(round)
    && Boolean(normalizeOutcome(round.outcome))
    && Boolean(round.tableCode)
    && roundNoOf(round) > 0;
}

function isSnapshotRound(round) {
  return SNAPSHOT_EVENTS.has(round?.sourceEvent);
}

function isLiveRound(round) {
  return isValidRound(round) && !isSnapshotRound(round);
}

function isLikelyNewShoe(previousRoundNo, roundNo) {
  return previousRoundNo > 0
    && roundNo > 0
    && roundNo < previousRoundNo
    && (roundNo <= 5 || previousRoundNo - roundNo >= 20);
}

function sourceScore(round) {
  let score = 0;
  if (round.sourceEvent === "manual") score = 900;
  else if (round.sourceEvent === "pushGameStatus") score = 700;
  else if (round.sourceEvent === "pushGameTableResults") score = 620;
  else if (round.sourceEvent === "roadSnapshot") score = 280;
  else if (round.sourceEvent === "getGameHall:snapshot") score = 180;
  else if (round.sourceEvent === "getGameHall") score = 120;
  else score = 300;

  if (Number(round.cardCount || 0) > 0) score += 40;
  if (round.rawResult) score += 10;
  if (round.gameRoundId) score += 5;
  return score;
}

function resultKey(round) {
  return `${normalizeOutcome(round.outcome) || ""}|${round.rawResult || ""}`;
}

function betterRound(left, right) {
  if (!right) return left;
  const leftScore = sourceScore(left);
  const rightScore = sourceScore(right);
  if (leftScore !== rightScore) return leftScore > rightScore ? left : right;
  const leftId = Number(left.id || 0);
  const rightId = Number(right.id || 0);
  return leftId >= rightId ? left : right;
}

function withSegments(rows, sourceKind) {
  const byTable = new Map();
  for (const round of rows.filter(isValidRound)) {
    if (!byTable.has(round.tableCode)) byTable.set(round.tableCode, []);
    byTable.get(round.tableCode).push(round);
  }

  const segmented = [];
  for (const [tableCode, tableRows] of byTable.entries()) {
    const sorted = [...tableRows].sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
    let segment = 1;
    let previousRoundNo = 0;
    for (const round of sorted) {
      const roundNo = roundNoOf(round);
      if (isLikelyNewShoe(previousRoundNo, roundNo)) segment += 1;
      if (roundNo > 0) previousRoundNo = roundNo;
      segmented.push({
        ...round,
        canonicalSourceKind: sourceKind,
        canonicalSegment: segment,
        canonicalSlotKey: `${tableCode}|${sourceKind}|${segment}|${roundNo}`
      });
    }
  }
  return segmented.sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
}

function canonicalizeSegmented(rows) {
  const groups = new Map();
  for (const round of rows) {
    if (!groups.has(round.canonicalSlotKey)) groups.set(round.canonicalSlotKey, []);
    groups.get(round.canonicalSlotKey).push(round);
  }

  const canonicalRounds = [];
  const quarantinedRounds = [];
  const decisions = [];

  for (const [slotKey, group] of groups.entries()) {
    const winner = group.reduce((best, round) => betterRound(round, best), null);
    const distinctResults = new Set(group.map(resultKey));
    const hasConflict = distinctResults.size > 1;
    const reason = hasConflict ? "slot-conflict" : group.length > 1 ? "slot-duplicate" : "canonical";
    canonicalRounds.push({
      ...winner,
      qualityStatus: "canonical",
      qualityReason: reason,
      canonicalSlotKey: slotKey,
      canonicalSourceRank: sourceScore(winner)
    });

    for (const round of group) {
      if (Number(round.id || 0) === Number(winner.id || 0)) continue;
      quarantinedRounds.push({
        ...round,
        qualityStatus: "quarantined",
        qualityReason: hasConflict ? "lower-priority-conflict" : "duplicate-slot",
        canonicalSlotKey: slotKey,
        canonicalWinnerId: winner.id || 0,
        canonicalSourceRank: sourceScore(round)
      });
    }

    if (group.length > 1) {
      decisions.push({
        slotKey,
        tableCode: winner.tableCode,
        sourceKind: winner.canonicalSourceKind,
        segment: winner.canonicalSegment,
        roundNo: winner.roundNo,
        winnerId: winner.id || 0,
        winnerOutcome: winner.outcome,
        winnerRawResult: winner.rawResult,
        conflict: hasConflict,
        candidateCount: group.length,
        quarantinedCount: group.length - 1
      });
    }
  }

  return { canonicalRounds, quarantinedRounds, decisions };
}

function buildCanonicalView(rounds) {
  const valid = rounds.filter(isValidRound);
  const live = withSegments(valid.filter(isLiveRound), "live");
  const snapshots = withSegments(valid.filter(isSnapshotRound), "snapshot");
  const liveResult = canonicalizeSegmented(live);
  const snapshotResult = canonicalizeSegmented(snapshots);
  const canonicalRounds = [...liveResult.canonicalRounds, ...snapshotResult.canonicalRounds]
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  const quarantinedRounds = [...liveResult.quarantinedRounds, ...snapshotResult.quarantinedRounds]
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  const decisions = [...liveResult.decisions, ...snapshotResult.decisions]
    .sort((left, right) => (left.tableCode || "").localeCompare(right.tableCode || "") || left.roundNo - right.roundNo);
  const predictionRounds = liveResult.canonicalRounds
    .filter((round) => LIVE_EVENTS.has(round.sourceEvent) || !isSnapshotRound(round))
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  const conflictDecisions = decisions.filter((decision) => decision.conflict);

  return {
    canonicalRounds,
    predictionRounds,
    snapshotRounds: snapshotResult.canonicalRounds,
    quarantinedRounds,
    decisions,
    summary: {
      generatedAt: new Date().toISOString(),
      inputRounds: rounds.length,
      validRounds: valid.length,
      canonicalRounds: canonicalRounds.length,
      predictionRounds: predictionRounds.length,
      snapshotCanonicalRounds: snapshotResult.canonicalRounds.length,
      quarantinedRounds: quarantinedRounds.length,
      correctedSlots: decisions.length,
      conflictSlots: conflictDecisions.length,
      liveConflictSlots: liveResult.decisions.filter((decision) => decision.conflict).length,
      snapshotConflictSlots: snapshotResult.decisions.filter((decision) => decision.conflict).length
    }
  };
}

module.exports = {
  SNAPSHOT_EVENTS,
  LIVE_EVENTS,
  buildCanonicalView,
  isLiveRound,
  isSnapshotRound,
  isValidRound,
  sourceScore
};
