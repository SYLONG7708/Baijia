"use strict";

const { analyzePattern } = require("./analysis");
const { RESULT_LABELS, normalizeRound } = require("./roads");

const RESULT_KEYS = ["banker", "player", "tie"];
const SIDE_KEYS = ["banker", "player"];
const SPECIAL_KEYS = ["bankerPair", "playerPair", "luckySix"];
const ROAD_LABELS = {
  bead: "珠盤路",
  bigRoad: "大路",
  bigEyeRoad: "大眼仔",
  smallRoad: "小路",
  cockroachRoad: "蟑螂路"
};
const SPECIAL_LABELS = {
  bankerPair: "莊對",
  playerPair: "閒對",
  luckySix: "幸運6"
};

function runTableBacktest({
  table = null,
  rounds = [],
  windowSize = 8,
  maxChecks = 120,
  detailLimit = 40,
  specialThreshold = 0.12
} = {}) {
  const startedAt = Date.now();
  const tableId = table?.id || rounds.find((round) => round?.tableId)?.tableId || "";
  const normalized = rounds
    .map(normalizeBacktestRound)
    .filter(Boolean)
    .sort(compareRounds)
    .map((round, index) => ({ ...round, _globalIndex: index }));
  const candidates = buildCandidates(normalized, Number(windowSize || 8));
  const selectedCandidates = Number(maxChecks || 0) > 0
    ? candidates.slice(-Number(maxChecks || 0))
    : candidates;

  const stats = createBacktestStats();
  const details = [];

  for (const candidate of selectedCandidates) {
    const actual = candidate.actual;
    const shoePrefix = candidate.shoeRounds.slice(0, candidate.indexInShoe);
    const sequence = shoePrefix.slice(-windowSize);
    const historyBeforeActual = normalized.slice(0, actual._globalIndex).map(stripInternalFields);
    if (sequence.length < windowSize || historyBeforeActual.length < windowSize) continue;

    const analysis = analyzePattern({
      sequence,
      manualSequence: shoePrefix.map(stripInternalFields),
      rounds: historyBeforeActual,
      tableId
    });
    const predictions = extractPredictions(analysis);
    updateBacktestStats(stats, predictions, actual, analysis, specialThreshold);
    if (detailLimit > 0) {
      details.push(buildDetailRow(candidate, sequence, actual, predictions, analysis));
      if (details.length > detailLimit) details.shift();
    }
  }

  finalizeBacktestStats(stats);
  const improvement = buildImprovementSummary(stats);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - startedAt,
    table: {
      id: tableId,
      tableCode: table?.tableCode || normalized[0]?.tableCode || "",
      name: table?.name || normalized[0]?.tableName || ""
    },
    config: {
      windowSize,
      maxChecks: Number(maxChecks || 0),
      detailLimit,
      specialThreshold
    },
    sample: {
      totalRounds: normalized.length,
      candidateWindows: candidates.length,
      checkedWindows: stats.checkedWindows,
      firstCheckedAt: stats.firstCheckedAt || "",
      lastCheckedAt: stats.lastCheckedAt || ""
    },
    summary: {
      currentStrategy: stats.strategies.currentUi,
      evidenceWeighted: stats.strategies.evidenceWeighted,
      previousHighestRoad: stats.strategies.highestRoad,
      nextResult: stats.strategies.nextResult,
      consensus: stats.strategies.consensus,
      bestRoad: bestStat(stats.roads),
      bestManualCycle: bestStat(stats.manualCycles),
      specials: stats.specials
    },
    roads: stats.roads,
    manualCycles: stats.manualCycles,
    sourceTypes: stats.sourceTypes,
    rateBuckets: stats.rateBuckets,
    improvement,
    details,
    warnings: buildWarnings(stats, improvement)
  };
}

function normalizeBacktestRound(round) {
  const normalized = normalizeRound(round);
  if (!normalized) return null;
  return {
    ...normalized,
    tableCode: round?.tableCode || "",
    tableName: round?.tableName || "",
    provider: round?.provider || ""
  };
}

function buildCandidates(rounds, windowSize) {
  const groups = new Map();
  for (const round of rounds) {
    const key = round.shoe || "shoe";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(round);
  }
  const candidates = [];
  for (const [shoe, shoeRounds] of groups.entries()) {
    const sorted = [...shoeRounds].sort(compareRounds);
    for (let index = windowSize; index < sorted.length; index += 1) {
      candidates.push({
        shoe,
        indexInShoe: index,
        handNumber: sorted[index].handNumber || index + 1,
        actual: sorted[index],
        shoeRounds: sorted
      });
    }
  }
  return candidates.sort((left, right) => left.actual._globalIndex - right.actual._globalIndex);
}

function extractPredictions(analysis) {
  const overall = analysis?.roadBreakdown?.overall || {};
  return {
    nextResult: predictionFrom(analysis?.nextResult, "歷史樣本"),
    currentUi: pickCurrentUiPrediction(analysis),
    evidenceWeighted: predictionFrom(overall.recommended, "證據加權", overall.recommended?.roadLabel),
    highestRoad: predictionFrom(overall.highest, "最高百分比", overall.highest?.roadLabel),
    consensus: predictionFrom(overall.consensus, "五路統整"),
    roads: Object.fromEntries((analysis?.roadBreakdown?.records || []).map((record) => [
      record.roadKey,
      {
        roadKey: record.roadKey,
        roadLabel: record.roadLabel,
        prediction: predictionFrom(record, "road", record.roadLabel),
        manualCycle: predictionFrom({
          result: record.manualCycleResult,
          label: record.manualCycleLabel,
          rate: record.manualCycleRate
        }, "manual-cycle", record.roadLabel),
        trendProfile: record.trendProfile || null,
        evidenceLabel: record.evidenceLabel || "低",
        evidenceScore: Number(record.evidenceScore || 0)
      }
    ])),
    fullRates: analysis?.fullRates || [],
    sourceType: analysis?.source?.type || "unknown"
  };
}

function pickCurrentUiPrediction(analysis) {
  const overall = analysis?.roadBreakdown?.overall || {};
  if (SIDE_KEYS.includes(overall.highest?.result)) {
    return predictionFrom(overall.highest, "目前介面策略", overall.highest.roadLabel);
  }
  if (SIDE_KEYS.includes(overall.consensus?.result)) {
    return predictionFrom(overall.consensus, "目前介面策略");
  }
  return predictionFrom(analysis?.nextResult, "目前介面策略");
}

function predictionFrom(item, source = "", roadLabel = "") {
  if (!item) return { result: "neutral", label: "觀察", rate: 0.5, source, roadLabel };
  const result = item.result || "neutral";
  return {
    result,
    label: item.label || RESULT_LABELS[result] || "觀察",
    rate: Number(item.rate || 0.5),
    source,
    roadLabel: roadLabel || item.roadLabel || ""
  };
}

function createBacktestStats() {
  return {
    checkedWindows: 0,
    firstCheckedAt: "",
    lastCheckedAt: "",
    strategies: {
      currentUi: createOutcomeStat("目前介面策略"),
      evidenceWeighted: createOutcomeStat("證據加權"),
      highestRoad: createOutcomeStat("最高百分比"),
      nextResult: createOutcomeStat("歷史樣本"),
      consensus: createOutcomeStat("五路統整")
    },
    roads: Object.fromEntries(Object.entries(ROAD_LABELS).map(([key, label]) => [key, createOutcomeStat(label)])),
    manualCycles: Object.fromEntries(Object.entries(ROAD_LABELS).map(([key, label]) => [key, createOutcomeStat(`${label}輸入6欄`)])),
    specials: Object.fromEntries(SPECIAL_KEYS.map((key) => [key, createSpecialStat(SPECIAL_LABELS[key])])),
    sourceTypes: {},
    rateBuckets: {
      "50-60": createOutcomeStat("50-60%"),
      "60-70": createOutcomeStat("60-70%"),
      "70-80": createOutcomeStat("70-80%"),
      "80+": createOutcomeStat("80%+")
    }
  };
}

function createOutcomeStat(label) {
  return {
    label,
    checked: 0,
    hits: 0,
    hitRate: 0,
    nonTieChecked: 0,
    nonTieHits: 0,
    nonTieHitRate: 0,
    averageRate: 0,
    rateSum: 0,
    byResult: Object.fromEntries(RESULT_KEYS.map((key) => [key, { predicted: 0, hits: 0 }]))
  };
}

function createSpecialStat(label) {
  return {
    label,
    checked: 0,
    actual: 0,
    actualRate: 0,
    signalThreshold: 0,
    signals: 0,
    signalHits: 0,
    signalHitRate: 0,
    averageRate: 0,
    rateSum: 0
  };
}

function updateBacktestStats(stats, predictions, actual, analysis, specialThreshold) {
  stats.checkedWindows += 1;
  const observedAt = actual.observedAt || actual.createdAt || "";
  if (!stats.firstCheckedAt) stats.firstCheckedAt = observedAt;
  stats.lastCheckedAt = observedAt || stats.lastCheckedAt;

  updateOutcomeStat(stats.strategies.currentUi, predictions.currentUi, actual);
  updateOutcomeStat(stats.strategies.evidenceWeighted, predictions.evidenceWeighted, actual);
  updateOutcomeStat(stats.strategies.highestRoad, predictions.highestRoad, actual);
  updateOutcomeStat(stats.strategies.nextResult, predictions.nextResult, actual);
  updateOutcomeStat(stats.strategies.consensus, predictions.consensus, actual);
  updateSourceType(stats.sourceTypes, predictions.sourceType, predictions.currentUi, actual);
  updateRateBucket(stats.rateBuckets, predictions.currentUi, actual);

  for (const [key, road] of Object.entries(predictions.roads || {})) {
    updateOutcomeStat(stats.roads[key] || (stats.roads[key] = createOutcomeStat(road.roadLabel || key)), road.prediction, actual);
    updateOutcomeStat(stats.manualCycles[key] || (stats.manualCycles[key] = createOutcomeStat(`${road.roadLabel || key}輸入6欄`)), road.manualCycle, actual);
  }

  for (const key of SPECIAL_KEYS) {
    updateSpecialStat(stats.specials[key], key, actual, findRate(predictions.fullRates, key), specialThreshold);
  }
}

function updateOutcomeStat(stat, prediction, actual) {
  if (!stat || !prediction || !RESULT_KEYS.includes(prediction.result)) return;
  stat.checked += 1;
  stat.rateSum += Number(prediction.rate || 0);
  stat.byResult[prediction.result].predicted += 1;
  if (prediction.result === actual.result) {
    stat.hits += 1;
    stat.byResult[prediction.result].hits += 1;
  }
  if (SIDE_KEYS.includes(prediction.result) && SIDE_KEYS.includes(actual.result)) {
    stat.nonTieChecked += 1;
    if (prediction.result === actual.result) stat.nonTieHits += 1;
  }
}

function updateSourceType(sourceTypes, sourceType, prediction, actual) {
  const key = sourceType || "unknown";
  if (!sourceTypes[key]) sourceTypes[key] = createOutcomeStat(key);
  updateOutcomeStat(sourceTypes[key], prediction, actual);
}

function updateRateBucket(buckets, prediction, actual) {
  const rate = Number(prediction?.rate || 0.5);
  const key = rate >= 0.8 ? "80+" : rate >= 0.7 ? "70-80" : rate >= 0.6 ? "60-70" : "50-60";
  updateOutcomeStat(buckets[key], prediction, actual);
}

function updateSpecialStat(stat, key, actual, predictedRate, threshold) {
  if (!stat) return;
  const rateValue = Number(predictedRate || 0);
  const hit = Boolean(actual[key]);
  stat.checked += 1;
  stat.rateSum += rateValue;
  stat.signalThreshold = threshold;
  if (hit) stat.actual += 1;
  if (rateValue >= threshold) {
    stat.signals += 1;
    if (hit) stat.signalHits += 1;
  }
}

function finalizeBacktestStats(stats) {
  for (const stat of [
    ...Object.values(stats.strategies),
    ...Object.values(stats.roads),
    ...Object.values(stats.manualCycles),
    ...Object.values(stats.sourceTypes),
    ...Object.values(stats.rateBuckets)
  ]) {
    finalizeOutcomeStat(stat);
  }
  for (const stat of Object.values(stats.specials)) finalizeSpecialStat(stat);
}

function finalizeOutcomeStat(stat) {
  stat.hitRate = stat.checked ? round(stat.hits / stat.checked) : 0;
  stat.nonTieHitRate = stat.nonTieChecked ? round(stat.nonTieHits / stat.nonTieChecked) : 0;
  stat.averageRate = stat.checked ? round(stat.rateSum / stat.checked) : 0;
  delete stat.rateSum;
}

function finalizeSpecialStat(stat) {
  stat.actualRate = stat.checked ? round(stat.actual / stat.checked) : 0;
  stat.signalHitRate = stat.signals ? round(stat.signalHits / stat.signals) : 0;
  stat.averageRate = stat.checked ? round(stat.rateSum / stat.checked) : 0;
  delete stat.rateSum;
}

function bestStat(statsByKey) {
  const rows = Object.entries(statsByKey || {})
    .map(([key, stat]) => ({ key, ...stat }))
    .filter((stat) => Number(stat.nonTieChecked || stat.checked || 0) > 0)
    .sort((left, right) => Number(right.nonTieHitRate || right.hitRate || 0) - Number(left.nonTieHitRate || left.hitRate || 0));
  return rows[0] || null;
}

function buildImprovementSummary(stats) {
  const current = stats.strategies.currentUi;
  const weighted = stats.strategies.evidenceWeighted;
  const previousHighest = stats.strategies.highestRoad;
  const observedCandidates = [
    { key: "evidenceWeighted", type: "strategy", ...weighted },
    ...Object.entries(stats.roads || {}).map(([key, stat]) => ({ key, type: "road", ...stat })),
    ...Object.entries(stats.manualCycles || {}).map(([key, stat]) => ({ key, type: "manual-cycle", ...stat }))
  ].filter((item) => Number(item.nonTieChecked || 0) > 0);
  const bestCandidate = observedCandidates
    .sort((left, right) => Number(right.nonTieHitRate || 0) - Number(left.nonTieHitRate || 0))[0] || null;
  const checked = Math.min(Number(current.nonTieChecked || 0), Number(weighted.nonTieChecked || 0));
  const previousChecked = Math.min(Number(previousHighest.nonTieChecked || 0), Number(weighted.nonTieChecked || 0));
  const diff = Number(weighted.nonTieHitRate || 0) - Number(current.nonTieHitRate || 0);
  const diffVsPreviousHighest = Number(weighted.nonTieHitRate || 0) - Number(previousHighest.nonTieHitRate || 0);
  const bestDelta = Number(bestCandidate?.nonTieHitRate || 0) - Number(current.nonTieHitRate || 0);
  const bestCandidateReady = Number(bestCandidate?.nonTieChecked || 0) >= 60 && bestDelta >= 0.04;
  const canUse = checked >= 40 && diff >= 0.03;
  const adoptedBetterThanPrevious = previousChecked >= 40 && diffVsPreviousHighest >= 0.03;
  return {
    currentNonTieHitRate: current.nonTieHitRate,
    evidenceWeightedNonTieHitRate: weighted.nonTieHitRate,
    previousHighestRoadNonTieHitRate: previousHighest.nonTieHitRate,
    delta: round(diff),
    deltaPercent: `${(diff * 100).toFixed(1)}%`,
    deltaVsPreviousHighest: round(diffVsPreviousHighest),
    deltaVsPreviousHighestPercent: `${(diffVsPreviousHighest * 100).toFixed(1)}%`,
    bestCandidate: bestCandidate ? {
      key: bestCandidate.key,
      type: bestCandidate.type,
      label: bestCandidate.label,
      nonTieChecked: bestCandidate.nonTieChecked,
      nonTieHitRate: bestCandidate.nonTieHitRate,
      delta: round(bestDelta),
      deltaPercent: `${(bestDelta * 100).toFixed(1)}%`
    } : null,
    checked,
    previousChecked,
    action: bestCandidateReady ? "candidate-best-observed" : adoptedBetterThanPrevious ? "adopted-improvement" : canUse ? "candidate-improvement" : "keep-current",
    read: adoptedBetterThanPrevious
      ? `目前證據加權策略比舊最高百分比高 ${(diffVsPreviousHighest * 100).toFixed(1)} 個百分點，先持續 24 小時驗證穩定性。`
      : bestCandidateReady
        ? `${bestCandidate.label} 比目前策略高 ${(bestDelta * 100).toFixed(1)} 個百分點，可列為下一輪主策略候選。`
      : canUse
      ? `證據加權策略比目前策略高 ${(diff * 100).toFixed(1)} 個百分點，可列為下一輪邏輯調整候選。`
      : "目前樣本未證明替代策略穩定優於現行策略，先持續 24 小時回測。"
  };
}

function buildWarnings(stats, improvement) {
  const warnings = [
    "回測只代表歷史相似度與路型統計，不保證下一局結果。"
  ];
  if (stats.checkedWindows < 40) warnings.push("回測窗數偏少，建議等待更多局數。");
  if (improvement.action !== "candidate-improvement") warnings.push("尚未達到自動調整主策略的證據門檻。");
  return warnings;
}

function buildDetailRow(candidate, sequence, actual, predictions, analysis) {
  return {
    shoe: candidate.shoe,
    handNumber: candidate.handNumber,
    observedAt: actual.observedAt || actual.createdAt || "",
    input: sequence.map((round) => ({
      result: round.result,
      label: RESULT_LABELS[round.result] || round.result,
      bankerPair: Boolean(round.bankerPair),
      playerPair: Boolean(round.playerPair),
      luckySix: Boolean(round.luckySix)
    })),
    actual: {
      result: actual.result,
      label: RESULT_LABELS[actual.result] || actual.result,
      bankerPair: Boolean(actual.bankerPair),
      playerPair: Boolean(actual.playerPair),
      luckySix: Boolean(actual.luckySix)
    },
    source: analysis?.source || {},
    predictions: {
      currentUi: predictions.currentUi,
      evidenceWeighted: predictions.evidenceWeighted,
      highestRoad: predictions.highestRoad,
      nextResult: predictions.nextResult,
      consensus: predictions.consensus,
      fullRates: (predictions.fullRates || []).map((item) => ({
        key: item.key || item.result,
        label: item.label || "",
        rate: Number(item.rate || 0),
        count: Number(item.count || 0)
      }))
    },
    roads: Object.values(predictions.roads || {}).map((road) => ({
      roadKey: road.roadKey,
      roadLabel: road.roadLabel,
      prediction: road.prediction,
      manualCycle: road.manualCycle,
      evidenceLabel: road.evidenceLabel,
      evidenceScore: road.evidenceScore,
      trendProfile: road.trendProfile
    }))
  };
}

function findRate(fullRates, key) {
  const item = (fullRates || []).find((rate) => (rate.key || rate.result) === key);
  return Number(item?.rate || 0);
}

function stripInternalFields(round) {
  const { _globalIndex, ...rest } = round;
  return rest;
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

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

module.exports = {
  runTableBacktest
};
