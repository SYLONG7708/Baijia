"use strict";

const DEFAULT_SESSION_GAP_MS = Number(process.env.BAIJIA_SESSION_GAP_MS || 4 * 60 * 60 * 1000);
const SAME_HAND_NEW_SESSION_MS = Number(process.env.BAIJIA_SAME_HAND_NEW_SESSION_MS || 20 * 60 * 1000);

function groupRoundSequences(rounds = [], options = {}) {
  const minimumLength = Math.max(1, Number(options.minimumLength || 1));
  const sessionGapMs = Math.max(60_000, Number(options.sessionGapMs || DEFAULT_SESSION_GAP_MS));
  const byTable = new Map();

  for (const round of Array.isArray(rounds) ? rounds : []) {
    if (!round) continue;
    const tableId = String(round.tableId || "unknown");
    if (!byTable.has(tableId)) byTable.set(tableId, []);
    byTable.get(tableId).push(round);
  }

  const groups = [];
  for (const [tableId, tableRounds] of byTable) {
    const explicitShoes = new Map();
    const shoeless = [];

    for (const round of tableRounds) {
      const shoe = String(round.shoe || "").trim();
      if (!shoe) {
        shoeless.push(round);
        continue;
      }
      if (!explicitShoes.has(shoe)) explicitShoes.set(shoe, []);
      explicitShoes.get(shoe).push(round);
    }

    for (const [shoe, shoeRounds] of explicitShoes) {
      const sorted = orderExplicitShoe(shoeRounds);
      groups.push(buildGroup(tableId, sorted, {
        key: `${tableId}::shoe:${shoe}`,
        shoe,
        inferredSession: false
      }));
    }

    const sortedShoeless = [...shoeless].sort(compareChronologicalRounds);
    let session = [];
    let sessionIndex = 0;
    for (const round of sortedShoeless) {
      const previous = session.at(-1);
      if (previous && startsNewInferredSession(previous, round, sessionGapMs)) {
        groups.push(buildGroup(tableId, session, {
          key: `${tableId}::inferred:${sessionIndex}`,
          shoe: "",
          inferredSession: true
        }));
        sessionIndex += 1;
        session = [];
      }

      const currentLast = session.at(-1);
      if (currentLast && samePositiveHand(currentLast, round)) {
        session[session.length - 1] = round;
      } else {
        session.push(round);
      }
    }
    if (session.length) {
      groups.push(buildGroup(tableId, session, {
        key: `${tableId}::inferred:${sessionIndex}`,
        shoe: "",
        inferredSession: true
      }));
    }
  }

  return groups
    .filter((group) => group.rounds.length >= minimumLength)
    .sort((left, right) => {
      const time = Number(left.firstTimestamp || 0) - Number(right.firstTimestamp || 0);
      return time || left.key.localeCompare(right.key);
    });
}

function startsNewInferredSession(previous, current, sessionGapMs = DEFAULT_SESSION_GAP_MS) {
  const previousTime = roundTimestamp(previous);
  const currentTime = roundTimestamp(current);
  const gap = previousTime && currentTime ? Math.max(0, currentTime - previousTime) : 0;
  const previousHand = positiveHand(previous);
  const currentHand = positiveHand(current);

  if (gap >= sessionGapMs) return true;
  if (previousHand && currentHand && currentHand < previousHand) return true;
  if (previousHand && currentHand && currentHand === previousHand && gap >= SAME_HAND_NEW_SESSION_MS) return true;
  return false;
}

function compareChronologicalRounds(left, right) {
  const leftTime = roundTimestamp(left);
  const rightTime = roundTimestamp(right);
  if (leftTime && rightTime && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime && !rightTime) return -1;
  if (!leftTime && rightTime) return 1;

  const table = String(left?.tableId || "").localeCompare(String(right?.tableId || ""));
  if (table) return table;
  const hand = positiveHand(left) - positiveHand(right);
  if (hand) return hand;
  const globalIndex = Number(left?._globalIndex || 0) - Number(right?._globalIndex || 0);
  if (globalIndex) return globalIndex;
  return String(left?.id || left?.externalKey || "").localeCompare(String(right?.id || right?.externalKey || ""));
}

function buildGroup(tableId, rounds, metadata) {
  const first = rounds[0] || {};
  const last = rounds.at(-1) || first;
  return {
    key: metadata.key,
    tableId,
    tableCode: first.tableCode || "",
    tableName: first.tableName || "",
    shoe: metadata.shoe,
    inferredSession: metadata.inferredSession,
    firstTimestamp: roundTimestamp(first),
    lastTimestamp: roundTimestamp(last),
    rounds
  };
}

function orderExplicitShoe(rounds) {
  const byHand = new Map();
  const withoutHand = [];
  for (const round of [...rounds].sort(compareChronologicalRounds)) {
    const hand = positiveHand(round);
    if (hand) byHand.set(hand, round);
    else withoutHand.push(round);
  }
  return [
    ...[...byHand.entries()].sort((left, right) => left[0] - right[0]).map(([, round]) => round),
    ...withoutHand
  ];
}

function samePositiveHand(left, right) {
  const leftHand = positiveHand(left);
  return leftHand > 0 && leftHand === positiveHand(right);
}

function positiveHand(round) {
  const hand = Number(round?.handNumber || 0);
  return Number.isFinite(hand) && hand > 0 ? hand : 0;
}

function roundTimestamp(round) {
  const value = Date.parse(round?.observedAt || round?.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

module.exports = {
  DEFAULT_SESSION_GAP_MS,
  compareChronologicalRounds,
  groupRoundSequences,
  roundTimestamp,
  startsNewInferredSession
};
