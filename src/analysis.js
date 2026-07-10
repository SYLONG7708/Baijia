"use strict";

const { RESULT_LABELS, normalizeRound, parseBulkRounds, buildRoads, summarizeBasic } = require("./roads");
const { buildAdvancedAnalysis } = require("./advanced-analysis");
const { buildRoadBreakdownAnalysis } = require("./road-breakdown");
const { buildCardModelAnalysis } = require("./card-model");
const { buildPredictionIndex, queryPredictionIndex } = require("./prediction-index");
const { buildDecisionProfile } = require("./decision-profile");
const { buildFiveStepRisk } = require("./five-step-risk");
const { buildEnsembleBrain } = require("./ensemble-brain");

const BASE_REFERENCE = {
  banker: 0.5068,
  player: 0.4932,
  tie: 0.095
};

function analyzePattern({ sequence, manualSequence = [], rounds = [], tableId = "", context = null }) {
  const inputRounds = Array.isArray(sequence)
    ? sequence.map((round) => normalizeRound(round)).filter(Boolean)
    : parseBulkRounds(sequence);
  const manualRoundsRaw = Array.isArray(manualSequence) ? manualSequence : parseBulkRounds(manualSequence);
  const manualRounds = manualRoundsRaw
    .map((round) => normalizeRound(round))
    .filter(Boolean);
  const effectiveManualRounds = manualRounds.length >= inputRounds.length ? manualRounds : inputRounds;
  const pattern = inputRounds.map((round) => round.result);
  const activeContext = context?.ok ? context : null;
  const allRounds = activeContext?.allRounds || rounds.map(normalizeAnalysisRound).filter(Boolean);
  const scopedRounds = activeContext?.scopedRounds || (tableId ? allRounds.filter((round) => round.tableId === tableId) : allRounds);
  const historyGroups = activeContext?.historyGroups || groupHistoryObjects(scopedRounds);
  const histories = activeContext?.histories || historyGroups.map((group) => group.rounds);
  const exact = queryPredictionIndex(activeContext?.predictionIndex, pattern) || collectMatches(histories, pattern, pattern.length);
  const fuzzyLength = Math.max(3, Math.min(pattern.length - 1, 7));
  const fuzzy = fuzzyLength >= 3
    ? queryPredictionIndex(activeContext?.predictionIndex, pattern.slice(-fuzzyLength)) || collectMatches(histories, pattern.slice(-fuzzyLength), fuzzyLength)
    : emptyMatches(fuzzyLength);
  const global = activeContext?.global || collectGlobalNext(scopedRounds);
  const patterns = detectPatterns(inputRounds);
  const roadSignal = summarizeRoadSignals(inputRounds);
  const source = exact.total >= 3 ? exact : fuzzy.total >= 5 ? fuzzy : global;
  const cardModel = buildCardModelAnalysis(effectiveManualRounds);
  const resultRates = buildResultRates(source, pattern, patterns, cardModel);
  const sideRates = buildSideRates(source, global, effectiveManualRounds, cardModel);
  const fullRates = buildFullRates(resultRates, sideRates);
  const topResult = resultRates[0] || { result: "banker", label: "莊", rate: 0, count: 0 };
  const confidence = scoreConfidence({ source, exact, fuzzy, patternLength: pattern.length, roadSignal });
  const advanced = buildAdvancedAnalysis({
    inputRounds,
    allRounds,
    source,
    resultRates
  });
  const roadBreakdown = buildRoadBreakdownAnalysis({
    inputRounds,
    manualRounds: effectiveManualRounds,
    allRounds,
    historicalGroups: historyGroups,
    source,
    resultRates
  });
  const ensembleBrain = buildEnsembleBrain({
    inputRounds: effectiveManualRounds,
    historyGroups,
    allRounds,
    tableId
  });
  const fiveStepTarget = ensembleBrain?.directional?.result
    || roadBreakdown?.overall?.preferred?.result
    || roadBreakdown?.overall?.recommended?.result
    || topResult.result;
  const fiveStepRisk = buildFiveStepRisk({
    inputRounds: effectiveManualRounds,
    historyGroups,
    targetResult: fiveStepTarget,
    maxBets: 5,
    windowSize: 8
  });

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    input: {
      length: pattern.length,
      manualLength: effectiveManualRounds.length,
      sequence: pattern,
      manualSequence: effectiveManualRounds.map((round) => round.result),
      labels: pattern.map((result) => RESULT_LABELS[result] || result)
    },
    dataset: {
      scope: tableId ? "table" : "all",
      tableId,
      totalRounds: scopedRounds.length,
      allRounds: allRounds.length,
      histories: histories.length,
      indexed: Boolean(activeContext?.predictionIndex)
    },
    source: {
      type: exact.total >= 3 ? "exact" : fuzzy.total >= 5 ? "fuzzy" : "global",
      exactSamples: exact.total,
      fuzzySamples: fuzzy.total,
      globalSamples: global.total,
      fuzzyLength
    },
    nextResult: {
      result: topResult.result,
      label: topResult.label,
      rate: topResult.rate,
      confidence,
      description: describeTopResult(topResult, source)
    },
    resultRates,
    sideRates,
    fullRates,
    patterns,
    roadSignal,
    cardModel,
    advanced,
    roadBreakdown,
    ensembleBrain,
    fiveStepRisk,
    warnings: buildWarnings(pattern.length, source, confidence)
  };
  result.decisionProfile = buildDecisionProfile(result);
  result.warnings = buildWarnings(pattern.length, source, confidence, result.decisionProfile);
  return result;
}

function buildAnalysisContext(rounds = [], options = {}) {
  const startedAt = Date.now();
  const allRounds = rounds.map(normalizeAnalysisRound).filter(Boolean);
  const scopedRounds = options.tableId
    ? allRounds.filter((round) => round.tableId === options.tableId)
    : allRounds;
  const historyGroups = groupHistoryObjects(scopedRounds);
  const histories = historyGroups.map((group) => group.rounds);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - startedAt,
    allRounds,
    scopedRounds,
    historyGroups,
    histories,
    global: collectGlobalNext(scopedRounds),
    predictionIndex: buildPredictionIndex(scopedRounds)
  };
}

function normalizeAnalysisRound(round) {
  const normalized = normalizeRound(round);
  if (!normalized) return null;
  return {
    ...normalized,
    tableCode: round?.tableCode || "",
    tableName: round?.tableName || "",
    provider: round?.provider || ""
  };
}

function groupHistoryObjects(rounds) {
  const groups = new Map();
  for (const round of rounds) {
    const key = `${round.tableId || "unknown"}::${round.shoe || "shoe"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        tableId: round.tableId || "",
        tableCode: round.tableCode || "",
        tableName: round.tableName || "",
        rounds: []
      });
    }
    const group = groups.get(key);
    if (!group.tableCode && round.tableCode) group.tableCode = round.tableCode;
    if (!group.tableName && round.tableName) group.tableName = round.tableName;
    group.rounds.push(round);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      rounds: group.rounds.sort(compareRounds)
    }))
    .filter((group) => group.rounds.length >= 2);
}

function collectMatches(histories, pattern, length) {
  if (!pattern.length) return emptyMatches(length);
  const nextRounds = [];
  for (const history of histories) {
    for (let index = 0; index <= history.length - pattern.length - 1; index += 1) {
      let matched = true;
      for (let offset = 0; offset < pattern.length; offset += 1) {
        if (history[index + offset].result !== pattern[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) nextRounds.push(history[index + pattern.length]);
    }
  }
  return summarizeNextRounds(nextRounds, length);
}

function collectGlobalNext(rounds) {
  const nextRounds = rounds.filter((round) => ["banker", "player", "tie"].includes(round.result));
  return summarizeNextRounds(nextRounds, 0);
}

function summarizeNextRounds(nextRounds, length) {
  const counts = { banker: 0, player: 0, tie: 0 };
  let bankerPair = 0;
  let playerPair = 0;
  let luckySix = 0;
  for (const round of nextRounds) {
    if (counts[round.result] !== undefined) counts[round.result] += 1;
    if (round.bankerPair) bankerPair += 1;
    if (round.playerPair) playerPair += 1;
    if (round.luckySix) luckySix += 1;
  }
  return {
    length,
    total: nextRounds.length,
    counts,
    bankerPair,
    playerPair,
    luckySix,
    nextRounds: nextRounds.slice(-50)
  };
}

function emptyMatches(length) {
  return summarizeNextRounds([], length);
}

function buildResultRates(source, pattern, patterns, cardModel = null) {
  const total = Math.max(source.total, 0);
  const patternCounts = countPatternResults(pattern);
  const baseCounts = total ? source.counts : patternCounts;
  const effectiveTotal = total || pattern.length;
  const smoothing = effectiveTotal < 10 ? 2 : 0;
  const counts = {
    banker: baseCounts.banker + smoothing * BASE_REFERENCE.banker,
    player: baseCounts.player + smoothing * BASE_REFERENCE.player,
    tie: baseCounts.tie + (effectiveTotal < 20 ? 0.4 : 0)
  };
  const denominator = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;
  const rates = ["banker", "player", "tie"].map((result) => ({
    result,
    label: RESULT_LABELS[result],
    count: source.counts[result],
    rate: counts[result] / denominator
  }));

  const streak = patterns.find((item) => item.key === "long-streak");
  if (source.total < 5 && streak && ["banker", "player"].includes(pattern[pattern.length - 1])) {
    const target = pattern[pattern.length - 1];
    const item = rates.find((rate) => rate.result === target);
    item.rate = Math.min(0.64, item.rate + 0.08);
  }

  return applyCardModelToResultRates(normalizeRates(rates), cardModel).sort((a, b) => b.rate - a.rate);
}

function countPatternResults(pattern = []) {
  return {
    banker: pattern.filter((result) => result === "banker").length,
    player: pattern.filter((result) => result === "player").length,
    tie: pattern.filter((result) => result === "tie").length
  };
}

function buildSideRates(source, global, inputRounds = [], cardModel = null) {
  const manual = summarizeManualSpecials(inputRounds);
  const selected = source.total >= 5 ? source : global.total >= 5 ? global : manual;
  const denominator = Math.max(selected.total, 1);
  const rates = [
    {
      key: "bankerPair",
      label: "莊對",
      count: selected.bankerPair,
      rate: selected.bankerPair / denominator
    },
    {
      key: "playerPair",
      label: "閒對",
      count: selected.playerPair,
      rate: selected.playerPair / denominator
    },
    {
      key: "luckySix",
      label: "幸運6",
      count: selected.luckySix,
      rate: selected.luckySix / denominator
    }
  ];
  return applyCardModelToSideRates(rates, cardModel);
}

function applyCardModelToResultRates(rates, cardModel) {
  const weight = getCardModelWeight(cardModel);
  if (!weight) return rates;
  const modelRates = new Map((cardModel.resultRates || []).map((item) => [item.key || item.result, Number(item.rate || 0)]));
  return normalizeRates(rates.map((item) => {
    const modelRate = modelRates.get(item.result);
    if (!Number.isFinite(modelRate)) return item;
    return {
      ...item,
      rate: item.rate * (1 - weight) + modelRate * weight,
      cardRate: modelRate,
      cardWeight: weight
    };
  }));
}

function applyCardModelToSideRates(rates, cardModel) {
  const weight = getCardModelWeight(cardModel) * 0.85;
  if (!weight) return rates;
  const modelRates = new Map((cardModel.sideRates || []).map((item) => [item.key, Number(item.rate || 0)]));
  return rates.map((item) => {
    const modelRate = modelRates.get(item.key);
    if (!Number.isFinite(modelRate)) return item;
    return {
      ...item,
      rate: clamp(item.rate * (1 - weight) + modelRate * weight, 0, 1),
      cardRate: modelRate,
      cardWeight: weight
    };
  });
}

function getCardModelWeight(cardModel) {
  if (!cardModel?.usable) return 0;
  const seenCards = Number(cardModel.seenCards || 0);
  const pointsKnown = Number(cardModel.pointsKnown || 0);
  if (seenCards < 4) return 0;
  return clamp(0.08 + Math.min(seenCards, 120) / 120 * 0.16 + Math.min(pointsKnown, 24) / 24 * 0.06, 0.08, 0.3);
}

function summarizeManualSpecials(rounds = []) {
  const total = Math.max(rounds.length, 0);
  return {
    total,
    bankerPair: rounds.filter((round) => round.bankerPair).length,
    playerPair: rounds.filter((round) => round.playerPair).length,
    luckySix: rounds.filter((round) => round.luckySix).length
  };
}

function buildFullRates(resultRates, sideRates) {
  return [
    ...resultRates.map((item) => ({
      ...item,
      key: item.result,
      label: item.label,
      count: item.count,
      rate: item.rate,
      group: "result"
    })),
    ...sideRates.map((item) => ({
      ...item,
      group: "special"
    }))
  ];
}

function normalizeRates(rates) {
  const total = rates.reduce((sum, rate) => sum + rate.rate, 0) || 1;
  return rates.map((rate) => ({
    ...rate,
    rate: rate.rate / total
  }));
}

function detectPatterns(rounds) {
  const nonTie = rounds.filter((round) => round.result !== "tie");
  const recent = nonTie.slice(-12).map((round) => round.result);
  const patterns = [];
  if (!recent.length) return patterns;

  const current = recent[recent.length - 1];
  const streakCount = countTail(recent, current);
  if (streakCount >= 4) {
    patterns.push({
      key: "long-streak",
      label: current === "banker" ? "長莊" : "長閒",
      strength: Math.min(1, streakCount / 8),
      message: `${RESULT_LABELS[current]} 已連續 ${streakCount} 手`
    });
  }

  if (recent.length >= 5 && recent.slice(-5).every((value, index, arr) => index === 0 || value !== arr[index - 1])) {
    patterns.push({
      key: "single-jump",
      label: "單跳",
      strength: 0.72,
      message: "最近 5 手莊閒交替"
    });
  }

  if (recent.length >= 6 && isDoubleJump(recent.slice(-6))) {
    patterns.push({
      key: "double-jump",
      label: "雙跳",
      strength: 0.68,
      message: "最近呈現兩莊兩閒節奏"
    });
  }

  const columns = buildRoads(rounds).bigRoad.columnHeights;
  const heights = [...columns.entries()].sort((a, b) => a[0] - b[0]).map(([, height]) => height).slice(-5);
  if (heights.length >= 4 && isSlope(heights)) {
    patterns.push({
      key: "slope-road",
      label: "斜坡路",
      strength: 0.58,
      message: `大路欄高為 ${heights.join("-")}`
    });
  }

  if (heights.length >= 4 && isOneTwoPattern(heights)) {
    patterns.push({
      key: "one-room-two-room",
      label: "一房二房",
      strength: 0.55,
      message: "大路欄高接近 1、2 交替"
    });
  }

  const summary = summarizeBasic(rounds);
  if (summary.tie >= 2 && rounds.slice(-8).filter((round) => round.result === "tie").length >= 2) {
    patterns.push({
      key: "tie-active",
      label: "和局偏多",
      strength: 0.42,
      message: "近局多次出現和局"
    });
  }

  return patterns;
}

function summarizeRoadSignals(rounds) {
  const roads = buildRoads(rounds);
  const derived = [
    ["bigEyeRoad", "大眼路"],
    ["smallRoad", "小路"],
    ["cockroachRoad", "蟑螂路"]
  ].map(([key, label]) => {
    const points = roads[key].points.slice(-10);
    const red = points.filter((point) => point.color === "red").length;
    const blue = points.filter((point) => point.color === "blue").length;
    return {
      key,
      label,
      red,
      blue,
      signal: red > blue ? "整齊偏多" : blue > red ? "轉折偏多" : "中性"
    };
  });
  return {
    bigRoadColumns: roads.bigRoad.cols,
    derived
  };
}

function scoreConfidence({ source, exact, fuzzy, patternLength, roadSignal }) {
  let score = 0.18;
  if (patternLength >= 8) score += 0.12;
  if (exact.total >= 3) score += Math.min(0.35, exact.total / 40);
  if (fuzzy.total >= 5) score += Math.min(0.18, fuzzy.total / 80);
  const agreement = roadSignal.derived.filter((item) => item.signal === roadSignal.derived[0]?.signal).length;
  if (agreement >= 2) score += 0.08;
  if (source.total < 5) score -= 0.08;
  return Math.max(0.05, Math.min(0.82, score));
}

function describeTopResult(topResult, source) {
  if (!source.total) return "目前沒有足夠歷史樣本，只能顯示基準參考。";
  return `歷史樣本 ${source.total} 次中，下一手為「${topResult.label}」的比例約 ${formatPercent(topResult.rate)}。`;
}

function buildWarnings(patternLength, source, confidence, decisionProfile = null) {
  const warnings = [
    "百家樂每局仍是獨立事件，分析只代表歷史相似度與路型統計，不保證結果。"
  ];
  if (patternLength < 8) warnings.push("建議至少輸入 8 手。");
  if (source.total < 5) warnings.push("相同或相近路徑樣本偏少。");
  if (confidence < 0.35) warnings.push("目前不適合做強方向判斷。");
  if (decisionProfile?.action === "observe") warnings.push(decisionProfile.read);
  return warnings;
}

function countTail(values, target) {
  let count = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== target) break;
    count += 1;
  }
  return count;
}

function isDoubleJump(values) {
  if (values.length < 6) return false;
  const grouped = [];
  for (let index = 0; index < values.length; index += 2) {
    if (values[index] !== values[index + 1]) return false;
    grouped.push(values[index]);
  }
  return grouped.every((value, index) => index === 0 || value !== grouped[index - 1]);
}

function isSlope(values) {
  const up = values.every((value, index) => index === 0 || value >= values[index - 1]);
  const down = values.every((value, index) => index === 0 || value <= values[index - 1]);
  return up || down;
}

function isOneTwoPattern(values) {
  const tail = values.slice(-4);
  return tail.every((value) => value === 1 || value === 2) && new Set(tail).size === 2;
}

function compareRounds(a, b) {
  const handA = Number(a.handNumber || 0);
  const handB = Number(b.handNumber || 0);
  if (a.tableId === b.tableId && a.shoe === b.shoe && handA !== handB) return handA - handB;
  return String(a.observedAt || a.createdAt || "").localeCompare(String(b.observedAt || b.createdAt || ""));
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

module.exports = {
  analyzePattern,
  buildAnalysisContext,
  detectPatterns,
  summarizeRoadSignals,
  formatPercent
};
