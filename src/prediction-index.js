"use strict";

const { normalizeRound } = require("./roads");

const RESULT_KEYS = ["banker", "player", "tie"];
const MIN_NGRAM = Number(process.env.BAIJIA_NGRAM_MIN || 3);
const MAX_NGRAM = Number(process.env.BAIJIA_NGRAM_MAX || 12);
const SUMMARY_ROUND_LIMIT = Number(process.env.BAIJIA_NGRAM_ROUND_LIMIT || 50);
const RESULT_TOKENS = {
  banker: "B",
  player: "P",
  tie: "T"
};

function buildPredictionIndex(rounds = [], options = {}) {
  const minLength = clampInteger(options.minLength, MIN_NGRAM, 2, 20);
  const maxLength = clampInteger(options.maxLength, MAX_NGRAM, minLength, 24);
  const normalized = rounds
    .map(normalizeIndexRound)
    .filter(Boolean)
    .sort(compareRounds);
  const histories = groupHistories(normalized);
  const byLength = new Map();

  for (let length = minLength; length <= maxLength; length += 1) {
    byLength.set(length, new Map());
  }

  for (const history of histories) {
    const items = history.rounds;
    for (let index = 1; index < items.length; index += 1) {
      const next = items[index];
      for (let length = minLength; length <= maxLength; length += 1) {
        if (index < length) break;
        const key = encodeResults(items.slice(index - length, index));
        if (!key) continue;
        const bucket = byLength.get(length);
        const summary = bucket.get(key) || createSummary(length);
        addRoundToSummary(summary, next);
        bucket.set(key, summary);
      }
    }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    minLength,
    maxLength,
    rounds: normalized.length,
    histories: histories.length,
    byLength
  };
}

function queryPredictionIndex(index, pattern = []) {
  if (!index?.byLength || !pattern?.length) return null;
  const length = pattern.length;
  if (length < index.minLength || length > index.maxLength) return null;
  const key = encodeResults(pattern);
  const summary = index.byLength.get(length)?.get(key);
  return summary ? cloneSummary(summary) : null;
}

function normalizeIndexRound(round) {
  const normalized = normalizeRound(round);
  if (!normalized || !RESULT_KEYS.includes(normalized.result)) return null;
  return {
    ...normalized,
    tableCode: round?.tableCode || "",
    tableName: round?.tableName || "",
    provider: round?.provider || ""
  };
}

function groupHistories(rounds) {
  const groups = new Map();
  for (const round of rounds) {
    const key = `${round.tableId || "unknown"}::${round.shoe || "shoe"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        tableId: round.tableId || "",
        tableCode: round.tableCode || "",
        tableName: round.tableName || "",
        rounds: []
      });
    }
    groups.get(key).rounds.push(round);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      rounds: group.rounds.sort(compareRounds)
    }))
    .filter((group) => group.rounds.length >= 2);
}

function createSummary(length) {
  return {
    length,
    total: 0,
    counts: { banker: 0, player: 0, tie: 0 },
    bankerPair: 0,
    playerPair: 0,
    luckySix: 0,
    nextRounds: []
  };
}

function addRoundToSummary(summary, round) {
  summary.total += 1;
  if (summary.counts[round.result] !== undefined) summary.counts[round.result] += 1;
  if (round.bankerPair) summary.bankerPair += 1;
  if (round.playerPair) summary.playerPair += 1;
  if (round.luckySix) summary.luckySix += 1;
  summary.nextRounds.push(round);
  if (summary.nextRounds.length > SUMMARY_ROUND_LIMIT) summary.nextRounds.shift();
}

function cloneSummary(summary) {
  return {
    length: summary.length,
    total: summary.total,
    counts: { ...summary.counts },
    bankerPair: summary.bankerPair,
    playerPair: summary.playerPair,
    luckySix: summary.luckySix,
    nextRounds: summary.nextRounds.map((round) => ({ ...round }))
  };
}

function encodeResults(items = []) {
  const values = items.map((item) => {
    const result = typeof item === "string" ? item : item?.result;
    return RESULT_TOKENS[result] || "";
  });
  return values.every(Boolean) ? values.join("") : "";
}

function compareRounds(a, b) {
  if (a.tableId === b.tableId && a.shoe === b.shoe) {
    const handA = Number(a.handNumber || 0);
    const handB = Number(b.handNumber || 0);
    if (handA !== handB) return handA - handB;
  }
  const timeA = Date.parse(a.observedAt || a.createdAt || "");
  const timeB = Date.parse(b.observedAt || b.createdAt || "");
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

module.exports = {
  buildPredictionIndex,
  queryPredictionIndex,
  encodeResults
};
