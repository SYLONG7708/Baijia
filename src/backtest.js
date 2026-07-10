"use strict";

const { analyzePattern } = require("./analysis");
const { buildAdaptiveBrain } = require("./adaptive-brain");
const { buildDecisionProfile } = require("./decision-profile");
const { compareOutcomeStats, enrichOutcomeStat, THEORETICAL_BANKER_RATE } = require("./accuracy-metrics");
const { evaluateFiveStepOutcome, fiveStepNaturalBaseline } = require("./five-step-risk");
const { RESULT_LABELS, normalizeRound } = require("./roads");
const { compareChronologicalRounds, groupRoundSequences } = require("./round-sequences");

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
  specialThreshold = 0.12,
  historyLimit = 0,
  manualHistoryLimit = 0
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
    const manualPrefix = Number(manualHistoryLimit || 0) > 0
      ? shoePrefix.slice(-Number(manualHistoryLimit || 0))
      : shoePrefix;
    const historyBeforeActualRaw = normalized.slice(0, actual._globalIndex);
    const historyBeforeActual = (Number(historyLimit || 0) > 0
      ? historyBeforeActualRaw.slice(-Number(historyLimit || 0))
      : historyBeforeActualRaw
    ).map(stripInternalFields);
    if (sequence.length < windowSize || historyBeforeActual.length < windowSize) continue;

    const manualInput = manualPrefix.map(stripInternalFields);
    const analysis = analyzePattern({
      sequence,
      manualSequence: manualInput,
      rounds: historyBeforeActual,
      tableId
    });
    analysis.adaptiveBrain = buildAdaptiveBrain({
      analysis,
      inputRounds: manualInput,
      allRounds: historyBeforeActual,
      maxSamples: 240
    });
    const adaptiveTarget = analysis.adaptiveBrain?.selected?.result || analysis.roadBreakdown?.overall?.preferred?.result || analysis.nextResult?.result;
    if (analysis.adaptiveBrain?.riskByResult?.[adaptiveTarget]) {
      analysis.fiveStepRisk = analysis.adaptiveBrain.riskByResult[adaptiveTarget];
    }
    analysis.decisionProfile = buildDecisionProfile(analysis);
    const predictions = extractPredictions(analysis);
    updateBacktestStats(stats, predictions, actual, analysis, specialThreshold, candidate);
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
      specialThreshold,
      historyLimit: Number(historyLimit || 0),
      manualHistoryLimit: Number(manualHistoryLimit || 0)
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
      forcedEveryHand: stats.strategies.forcedEveryHand,
      forcedEveryHandReverse: stats.strategies.forcedEveryHandReverse,
      onlineEnsemble: stats.strategies.onlineEnsemble,
      evidenceWeighted: stats.strategies.evidenceWeighted,
      previousHighestRoad: stats.strategies.highestRoad,
      nextResult: stats.strategies.nextResult,
      consensus: stats.strategies.consensus,
      cardModel: stats.strategies.cardModel,
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
  const candidates = [];
  const groups = groupRoundSequences(rounds, { minimumLength: windowSize + 1 });
  for (const group of groups) {
    const shoe = group.shoe || group.key;
    const sorted = group.rounds;
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
    onlineEnsemble: predictionFrom({
      ...analysis?.ensembleBrain?.directional,
      pBanker: analysis?.ensembleBrain?.bankerRate,
      qualityApproved: analysis?.ensembleBrain?.validation?.approved,
      validation: analysis?.ensembleBrain?.validation || null
    }, "無洩漏線上集成"),
    currentUi: pickCurrentUiPrediction(analysis),
    forcedEveryHand: predictionFrom(analysis?.decisionProfile?.forced, "every-hand-balance"),
    forcedEveryHandReverse: reversePredictionFrom(analysis?.decisionProfile?.forced, "every-hand-reverse"),
    evidenceWeighted: predictionFrom(overall.recommended, "證據加權", overall.recommended?.roadLabel),
    highestRoad: predictionFrom(overall.highest, "最高百分比", overall.highest?.roadLabel),
    consensus: predictionFrom(overall.consensus, "五路統整"),
    cardModel: analysis?.cardModel?.usable ? predictionFrom(analysis?.cardModel?.top, "8副牌點數") : predictionFrom(null, "8副牌點數"),
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
  const profile = analysis?.decisionProfile;
  if (profile) {
    if (profile.action === "advise" && SIDE_KEYS.includes(profile.result)) {
      return predictionFrom(profile, "品質閘門", profile.levelLabel || profile.source || "");
    }
    return predictionFrom({
      result: "neutral",
      label: "觀察",
      rate: profile.score || 0.5
    }, "品質閘門", profile.levelLabel || "");
  }
  const overall = analysis?.roadBreakdown?.overall || {};
  if (SIDE_KEYS.includes(overall.preferred?.result)) {
    return predictionFrom(overall.preferred, "目前介面策略", overall.preferred.roadLabel || overall.preferred.strategy);
  }
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
    pBanker: item.pBanker !== null && item.pBanker !== undefined && Number.isFinite(Number(item.pBanker))
      ? Number(item.pBanker)
      : null,
    expectedValue: item.expectedValue !== null && item.expectedValue !== undefined && Number.isFinite(Number(item.expectedValue))
      ? Number(item.expectedValue)
      : null,
    qualityApproved: Boolean(item.qualityApproved),
    validation: item.validation || null,
    source,
    roadLabel: roadLabel || item.roadLabel || ""
  };
}

function reversePredictionFrom(item, source = "") {
  const result = item?.result || "neutral";
  const reversed = result === "banker" ? "player" : result === "player" ? "banker" : "neutral";
  return predictionFrom({
    ...item,
    result: reversed,
    label: RESULT_LABELS[reversed] || reversed,
    rate: item?.rate || 0.5
  }, source);
}

function createBacktestStats() {
  return {
    checkedWindows: 0,
    firstCheckedAt: "",
    lastCheckedAt: "",
    strategies: {
      forcedEveryHand: createOutcomeStat("every-hand-balance"),
      forcedEveryHandReverse: createOutcomeStat("every-hand-reverse"),
      onlineEnsemble: createOutcomeStat("leakage-safe-online-ensemble"),
      currentUi: createOutcomeStat("目前介面策略"),
      evidenceWeighted: createOutcomeStat("證據加權"),
      highestRoad: createOutcomeStat("最高百分比"),
      nextResult: createOutcomeStat("歷史樣本"),
      cardModel: createOutcomeStat("8副牌點數"),
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
    nonTieWilsonLower: 0,
    hitWilsonLower: 0,
    baselineNonTieHitRate: 0,
    edgeVsBaseline: 0,
    lowerEdgeVsBaseline: 0,
    selectionScore: 0,
    fiveStepChecked: 0,
    fiveStepWins: 0,
    fiveStepFailures: 0,
    fiveStepCompletionRate: 0,
    fiveStepFailureRate: 0,
    fiveStepWilsonLower: 0,
    fiveStepAverageStep: 0,
    fiveStepStepSum: 0,
    fiveStepBaselineSum: 0,
    averageRate: 0,
    rateSum: 0,
    netUnits: 0,
    unitSquareSum: 0,
    baselineNetUnits: 0,
    baselineUnitSquareSum: 0,
    equity: 0,
    peakEquity: 0,
    maxDrawdown: 0,
    currentLossStreak: 0,
    maxLossStreak: 0,
    probabilityChecks: 0,
    brierSum: 0,
    baselineBrierSum: 0,
    logLossSum: 0,
    baselineLogLossSum: 0,
    calibrationBins: Array.from({ length: 10 }, () => ({ count: 0, probabilitySum: 0, actualSum: 0 })),
    abstained: 0,
    signalRate: 0,
    actualByResult: Object.fromEntries(SIDE_KEYS.map((key) => [key, 0])),
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

function updateBacktestStats(stats, predictions, actual, analysis, specialThreshold, candidate) {
  stats.checkedWindows += 1;
  const observedAt = actual.observedAt || actual.createdAt || "";
  if (!stats.firstCheckedAt) stats.firstCheckedAt = observedAt;
  stats.lastCheckedAt = observedAt || stats.lastCheckedAt;

  updateOutcomeStat(stats.strategies.currentUi, predictions.currentUi, actual, candidate);
  updateOutcomeStat(stats.strategies.forcedEveryHand, predictions.forcedEveryHand, actual, candidate);
  updateOutcomeStat(stats.strategies.forcedEveryHandReverse, predictions.forcedEveryHandReverse, actual, candidate);
  updateOutcomeStat(stats.strategies.onlineEnsemble, predictions.onlineEnsemble, actual, candidate);
  updateOutcomeStat(stats.strategies.evidenceWeighted, predictions.evidenceWeighted, actual, candidate);
  updateOutcomeStat(stats.strategies.highestRoad, predictions.highestRoad, actual, candidate);
  updateOutcomeStat(stats.strategies.nextResult, predictions.nextResult, actual, candidate);
  updateOutcomeStat(stats.strategies.consensus, predictions.consensus, actual, candidate);
  updateOutcomeStat(stats.strategies.cardModel, predictions.cardModel, actual, candidate);
  updateSourceType(stats.sourceTypes, predictions.sourceType, predictions.currentUi, actual, candidate);
  updateRateBucket(stats.rateBuckets, predictions.currentUi, actual, candidate);

  for (const [key, road] of Object.entries(predictions.roads || {})) {
    updateOutcomeStat(stats.roads[key] || (stats.roads[key] = createOutcomeStat(road.roadLabel || key)), road.prediction, actual, candidate);
    updateOutcomeStat(stats.manualCycles[key] || (stats.manualCycles[key] = createOutcomeStat(`${road.roadLabel || key}輸入6欄`)), road.manualCycle, actual, candidate);
  }

  for (const key of SPECIAL_KEYS) {
    updateSpecialStat(stats.specials[key], key, actual, findRate(predictions.fullRates, key), specialThreshold);
  }
}

function updateOutcomeStat(stat, prediction, actual, candidate = null) {
  if (!stat || !prediction) return;
  if (!RESULT_KEYS.includes(prediction.result)) {
    stat.abstained += 1;
    return;
  }
  stat.checked += 1;
  stat.rateSum += Number(prediction.rate || 0);
  stat.byResult[prediction.result].predicted += 1;
  if (prediction.result === actual.result) {
    stat.hits += 1;
    stat.byResult[prediction.result].hits += 1;
  }
  if (SIDE_KEYS.includes(prediction.result) && SIDE_KEYS.includes(actual.result)) {
    stat.actualByResult[actual.result] += 1;
    stat.nonTieChecked += 1;
    if (prediction.result === actual.result) stat.nonTieHits += 1;
  }
  if (SIDE_KEYS.includes(prediction.result)) {
    const units = settleFlatUnit(prediction.result, actual.result);
    const baselineUnits = settleFlatUnit("banker", actual.result);
    stat.netUnits += units;
    stat.unitSquareSum += units * units;
    stat.baselineNetUnits += baselineUnits;
    stat.baselineUnitSquareSum += baselineUnits * baselineUnits;
    stat.equity += units;
    stat.peakEquity = Math.max(stat.peakEquity, stat.equity);
    stat.maxDrawdown = Math.max(stat.maxDrawdown, stat.peakEquity - stat.equity);
    if (units < 0) {
      stat.currentLossStreak += 1;
      stat.maxLossStreak = Math.max(stat.maxLossStreak, stat.currentLossStreak);
    } else if (units > 0) {
      stat.currentLossStreak = 0;
    }
  }
  if (SIDE_KEYS.includes(prediction.result) && SIDE_KEYS.includes(actual.result)) {
    const pBanker = predictionBankerRate(prediction);
    const observed = actual.result === "banker" ? 1 : 0;
    const baseline = THEORETICAL_BANKER_RATE;
    stat.probabilityChecks += 1;
    stat.brierSum += (pBanker - observed) ** 2;
    stat.baselineBrierSum += (baseline - observed) ** 2;
    stat.logLossSum += binaryLogLoss(pBanker, observed);
    stat.baselineLogLossSum += binaryLogLoss(baseline, observed);
    const bin = stat.calibrationBins[Math.min(9, Math.floor(pBanker * 10))];
    bin.count += 1;
    bin.probabilitySum += pBanker;
    bin.actualSum += observed;
  }
  updateFiveStepOutcomeStat(stat, prediction, candidate);
}

function updateFiveStepOutcomeStat(stat, prediction, candidate) {
  if (!candidate || !SIDE_KEYS.includes(prediction?.result)) return;
  const outcome = evaluateFiveStepOutcome(candidate.shoeRounds, candidate.indexInShoe, prediction.result, 5);
  if (!["win", "fail"].includes(outcome.status)) return;
  stat.fiveStepChecked += 1;
  stat.fiveStepBaselineSum += fiveStepNaturalBaseline(prediction.result, 5).completionRate;
  if (outcome.status === "win") {
    stat.fiveStepWins += 1;
    stat.fiveStepStepSum += Number(outcome.step || 0);
  } else {
    stat.fiveStepFailures += 1;
  }
}

function updateSourceType(sourceTypes, sourceType, prediction, actual, candidate) {
  const key = sourceType || "unknown";
  if (!sourceTypes[key]) sourceTypes[key] = createOutcomeStat(key);
  updateOutcomeStat(sourceTypes[key], prediction, actual, candidate);
}

function updateRateBucket(buckets, prediction, actual, candidate) {
  const rate = Number(prediction?.rate || 0.5);
  const key = rate >= 0.8 ? "80+" : rate >= 0.7 ? "70-80" : rate >= 0.6 ? "60-70" : "50-60";
  updateOutcomeStat(buckets[key], prediction, actual, candidate);
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
  stat.averageRate = stat.checked ? round(stat.rateSum / stat.checked) : 0;
  enrichOutcomeStat(stat);
  delete stat.rateSum;
  delete stat.fiveStepStepSum;
  delete stat.equity;
  delete stat.peakEquity;
  delete stat.currentLossStreak;
}

function settleFlatUnit(prediction, actual) {
  if (actual === "tie") return 0;
  if (prediction !== actual) return -1;
  return prediction === "banker" ? 0.95 : 1;
}

function predictionBankerRate(prediction = {}) {
  if (prediction.pBanker !== null && prediction.pBanker !== undefined && Number.isFinite(Number(prediction.pBanker))) {
    return clamp(Number(prediction.pBanker), 0.01, 0.99);
  }
  const rate = clamp(Number(prediction.rate || 0.5), 0.01, 0.99);
  return prediction.result === "banker" ? rate : 1 - rate;
}

function binaryLogLoss(probability, actual) {
  const p = clamp(Number(probability || 0.5), 0.01, 0.99);
  return -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
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
    .sort(compareOutcomeStats);
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
    .sort(compareOutcomeStats)[0] || null;
  const checked = Math.min(Number(current.nonTieChecked || 0), Number(weighted.nonTieChecked || 0));
  const previousChecked = Math.min(Number(previousHighest.nonTieChecked || 0), Number(weighted.nonTieChecked || 0));
  const diff = Number(weighted.nonTieHitRate || 0) - Number(current.nonTieHitRate || 0);
  const diffVsPreviousHighest = Number(weighted.nonTieHitRate || 0) - Number(previousHighest.nonTieHitRate || 0);
  const conservativeDiff = Number(weighted.nonTieWilsonLower || 0) - Number(current.nonTieWilsonLower || 0);
  const conservativeDiffVsPreviousHighest = Number(weighted.nonTieWilsonLower || 0) - Number(previousHighest.nonTieWilsonLower || 0);
  const bestDelta = Number(bestCandidate?.nonTieHitRate || 0) - Number(current.nonTieHitRate || 0);
  const bestConservativeDelta = Number(bestCandidate?.nonTieWilsonLower || 0) - Number(current.nonTieWilsonLower || 0);
  const bestCandidateReady = Number(bestCandidate?.nonTieChecked || 0) >= 60
    && bestConservativeDelta >= 0.012
    && Number(bestCandidate?.lowerEdgeVsBaseline || 0) >= -0.018;
  const canUse = checked >= 40
    && conservativeDiff >= 0.008
    && Number(weighted.lowerEdgeVsBaseline || 0) >= -0.02;
  const adoptedBetterThanPrevious = previousChecked >= 40
    && conservativeDiffVsPreviousHighest >= 0.008
    && Number(weighted.lowerEdgeVsBaseline || 0) >= -0.02;
  return {
    currentNonTieHitRate: current.nonTieHitRate,
    evidenceWeightedNonTieHitRate: weighted.nonTieHitRate,
    previousHighestRoadNonTieHitRate: previousHighest.nonTieHitRate,
    currentWilsonLower: current.nonTieWilsonLower,
    evidenceWeightedWilsonLower: weighted.nonTieWilsonLower,
    previousHighestRoadWilsonLower: previousHighest.nonTieWilsonLower,
    delta: round(diff),
    deltaPercent: `${(diff * 100).toFixed(1)}%`,
    conservativeDelta: round(conservativeDiff),
    conservativeDeltaPercent: `${(conservativeDiff * 100).toFixed(1)}%`,
    deltaVsPreviousHighest: round(diffVsPreviousHighest),
    deltaVsPreviousHighestPercent: `${(diffVsPreviousHighest * 100).toFixed(1)}%`,
    conservativeDeltaVsPreviousHighest: round(conservativeDiffVsPreviousHighest),
    conservativeDeltaVsPreviousHighestPercent: `${(conservativeDiffVsPreviousHighest * 100).toFixed(1)}%`,
    bestCandidate: bestCandidate ? {
      key: bestCandidate.key,
      type: bestCandidate.type,
      label: bestCandidate.label,
      nonTieChecked: bestCandidate.nonTieChecked,
      nonTieHitRate: bestCandidate.nonTieHitRate,
      nonTieWilsonLower: bestCandidate.nonTieWilsonLower,
      lowerEdgeVsBaseline: bestCandidate.lowerEdgeVsBaseline,
      selectionScore: bestCandidate.selectionScore,
      delta: round(bestDelta),
      deltaPercent: `${(bestDelta * 100).toFixed(1)}%`,
      conservativeDelta: round(bestConservativeDelta),
      conservativeDeltaPercent: `${(bestConservativeDelta * 100).toFixed(1)}%`
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
  if (Number(stats.strategies.currentUi.signalRate || 0) < 0.25) warnings.push("品質閘門出手率偏低，建議累積更多樣本後再調整門檻。");
  if (!["candidate-improvement", "candidate-best-observed", "adopted-improvement"].includes(improvement.action)) warnings.push("尚未達到自動調整主策略的保守證據門檻。");
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
      cardModel: predictions.cardModel,
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
  return compareChronologicalRounds(a, b);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

module.exports = {
  runTableBacktest
};
