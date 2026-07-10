"use strict";

const { wilsonLowerBound } = require("./accuracy-metrics");
const { normalizeRound } = require("./roads");

const SIDE_RESULTS = new Set(["banker", "player"]);
const BASE_BANKER_RATE = 0.5068;
const DEFAULT_MAX_TRAINING_ROUNDS = Number(process.env.BAIJIA_ENSEMBLE_MAX_TRAINING_ROUNDS || 7200);
const MIN_VALIDATION_CHECKS = Number(process.env.BAIJIA_ENSEMBLE_MIN_VALIDATION_CHECKS || 400);
const MIN_CURRENT_EV = Number(process.env.BAIJIA_ENSEMBLE_MIN_CURRENT_EV || 0.003);
const LEARNING_RATE = Number(process.env.BAIJIA_ENSEMBLE_LEARNING_RATE || 0.35);
const FIXED_SHARE = Number(process.env.BAIJIA_ENSEMBLE_FIXED_SHARE || 0.025);
const RECENT_WINDOW = Number(process.env.BAIJIA_ENSEMBLE_RECENT_WINDOW || 160);

const BASE_EXPERTS = [
  { key: "house-prior", label: "莊方理論基準" },
  { key: "global-bayes", label: "全庫貝葉斯" },
  { key: "recent-ewma", label: "近期衰減" },
  { key: "table-bayes", label: "桌台偏差" },
  { key: "markov-1", label: "一階轉移" },
  { key: "markov-2", label: "二階轉移" },
  { key: "markov-3", label: "三階轉移" },
  { key: "run-length", label: "連續長度" },
  { key: "alternation", label: "跳路節奏" },
  { key: "shoe-position", label: "牌靴局位" }
];
const EXPERTS = [
  ...BASE_EXPERTS,
  ...BASE_EXPERTS
    .filter((expert) => !["house-prior", "global-bayes"].includes(expert.key))
    .map((expert) => ({
      key: `anti-${expert.key}`,
      label: `反向${expert.label}`,
      reverseOf: expert.key
    }))
];

function buildEnsembleBrain({
  inputRounds = [],
  historyGroups = null,
  allRounds = [],
  tableId = "",
  maxTrainingRounds = DEFAULT_MAX_TRAINING_ROUNDS
} = {}) {
  const events = buildTrainingEvents(historyGroups, allRounds, maxTrainingRounds);
  const model = createModel();
  const groupHistories = new Map();

  for (const event of events) {
    const history = groupHistories.get(event.groupKey) || [];
    const predictions = predictExperts(model, history, event);
    const mixture = mixPredictions(predictions, model.weights);
    const actual = event.result === "banker" ? 1 : 0;

    if (model.seen >= 24) {
      updatePerformance(model, predictions, mixture, actual);
    }
    updateWeights(model.weights, predictions, actual);
    updateModel(model, history, event, actual);
    history.push(event.result);
    if (history.length > 24) history.shift();
    groupHistories.set(event.groupKey, history);
  }

  const currentHistory = normalizeSides(inputRounds).slice(-24);
  const currentEvent = {
    groupKey: `current::${tableId || "all"}`,
    tableId: tableId || "",
    handNumber: Number(inputRounds.at?.(-1)?.handNumber || currentHistory.length) + 1
  };
  const predictions = predictExperts(model, currentHistory, currentEvent);
  const rawBankerRate = mixPredictions(predictions, model.weights);
  const validation = summarizeValidation(model.performance.mixture, model.performance.baseline);
  const drift = summarizeDrift(model.recentScores, validation);
  const shrinkage = validation.approved && !drift.detected
    ? 0.82
    : validation.pairedBrierLift > 0 && validation.checks >= 160
      ? 0.32
      : 0.12;
  const bankerRate = clamp(BASE_BANKER_RATE + (rawBankerRate - BASE_BANKER_RATE) * shrinkage, 0.35, 0.65);
  const spread = weightedSpread(predictions, model.weights, rawBankerRate);
  const uncertainty = clamp(spread + 0.5 / Math.sqrt(Math.max(25, validation.checks)), 0.015, 0.18);
  const economics = buildEconomics(bankerRate, uncertainty);
  const directional = economics.banker.expectedValue >= economics.player.expectedValue
    ? buildDirection("banker", bankerRate, economics.banker)
    : buildDirection("player", 1 - bankerRate, economics.player);
  const action = validation.approved
    && !drift.detected
    && directional.conservativeExpectedValue >= MIN_CURRENT_EV
    ? "advise"
    : "observe";
  const regime = detectRegime(currentHistory);
  const experts = summarizeExperts(predictions, model);
  const dominant = experts[0] || null;

  return {
    ok: true,
    source: "leakage-safe-online-ensemble",
    modelVersion: "ensemble-v1",
    action,
    result: action === "advise" ? directional.result : "neutral",
    label: action === "advise" ? directional.label : "觀察",
    trainingRounds: events.length,
    inputLength: currentHistory.length,
    rawBankerRate: round(rawBankerRate),
    bankerRate: round(bankerRate),
    playerRate: round(1 - bankerRate),
    shrinkage: round(shrinkage),
    uncertainty: round(uncertainty),
    directional,
    economics,
    validation,
    drift,
    regime,
    dominantExpert: dominant,
    experts,
    read: buildRead({ action, directional, validation, drift, dominant, shrinkage })
  };
}

function buildTrainingEvents(historyGroups, allRounds, maxTrainingRounds) {
  const sourceGroups = Array.isArray(historyGroups) && historyGroups.length
    ? historyGroups
    : groupRounds(allRounds);
  const events = [];
  let fallbackOrder = 0;

  for (const [groupIndex, group] of sourceGroups.entries()) {
    const groupKey = group.key
      || `${group.tableId || "table"}::${group.shoe || groupIndex}`;
    const rounds = (Array.isArray(group.rounds) ? group.rounds : [])
      .map((round) => normalizeTrainingRound(round, groupKey, groupIndex, fallbackOrder++))
      .filter(Boolean)
      .sort(compareWithinGroup);
    for (const round of rounds) events.push(round);
  }

  events.sort(compareChronological);
  const limit = clampInteger(maxTrainingRounds, DEFAULT_MAX_TRAINING_ROUNDS, 200, 50_000);
  return events.slice(-limit);
}

function groupRounds(rounds) {
  const groups = new Map();
  for (const round of Array.isArray(rounds) ? rounds : []) {
    const key = `${round?.tableId || "table"}::${round?.shoe || "shoe"}`;
    if (!groups.has(key)) groups.set(key, { key, tableId: round?.tableId || "", rounds: [] });
    groups.get(key).rounds.push(round);
  }
  return [...groups.values()];
}

function normalizeTrainingRound(round, groupKey, groupIndex, fallbackOrder) {
  const normalized = normalizeRound(round);
  if (!normalized || !SIDE_RESULTS.has(normalized.result)) return null;
  const observedAt = normalized.observedAt || normalized.createdAt || round?.observedAt || round?.createdAt || "";
  return {
    ...normalized,
    result: normalized.result,
    groupKey,
    groupIndex,
    tableId: normalized.tableId || round?.tableId || "",
    handNumber: Number(normalized.handNumber || round?.handNumber || 0),
    observedAt,
    timestamp: parseTimestamp(observedAt),
    fallbackOrder
  };
}

function createModel() {
  return {
    seen: 0,
    counts: { banker: 0, player: 0 },
    recent: [],
    tables: new Map(),
    markov: [null, new Map(), new Map(), new Map()],
    runs: new Map(),
    alternations: new Map(),
    positions: new Map(),
    weights: Object.fromEntries(EXPERTS.map((expert) => [expert.key, 1 / EXPERTS.length])),
    performance: {
      mixture: createPerformance(),
      baseline: createPerformance(),
      experts: Object.fromEntries(EXPERTS.map((expert) => [expert.key, createPerformance()]))
    },
    recentScores: []
  };
}

function createPerformance() {
  return {
    checks: 0,
    hits: 0,
    brierSum: 0,
    logLossSum: 0,
    liftSum: 0,
    liftSquareSum: 0
  };
}

function predictExperts(model, history, event) {
  const fallbackGlobal = bayesRate(model.counts, BASE_BANKER_RATE, 96);
  const basePredictions = {
    "house-prior": BASE_BANKER_RATE,
    "global-bayes": fallbackGlobal,
    "recent-ewma": recentRate(model.recent, fallbackGlobal),
    "table-bayes": bayesRate(model.tables.get(event.tableId || "") || null, fallbackGlobal, 56),
    "markov-1": contextualRate(model.markov[1], contextKey(history, 1), fallbackGlobal, 22),
    "markov-2": contextualRate(model.markov[2], contextKey(history, 2), fallbackGlobal, 34),
    "markov-3": contextualRate(model.markov[3], contextKey(history, 3), fallbackGlobal, 52),
    "run-length": contextualRate(model.runs, runKey(history), fallbackGlobal, 32),
    alternation: contextualRate(model.alternations, alternationKey(history), fallbackGlobal, 40),
    "shoe-position": contextualRate(model.positions, positionKey(event.handNumber), fallbackGlobal, 72)
  };
  return Object.fromEntries(EXPERTS.map((expert) => {
    const value = expert.reverseOf
      ? 1 - Number(basePredictions[expert.reverseOf] || BASE_BANKER_RATE)
      : Number(basePredictions[expert.key] || BASE_BANKER_RATE);
    return [expert.key, clamp(value, 0.32, 0.68)];
  }));
}

function updateModel(model, history, event, actual) {
  incrementCount(model.counts, actual);
  incrementMap(model.tables, event.tableId || "", actual);
  for (let order = 1; order <= 3; order += 1) {
    incrementMap(model.markov[order], contextKey(history, order), actual);
  }
  incrementMap(model.runs, runKey(history), actual);
  incrementMap(model.alternations, alternationKey(history), actual);
  incrementMap(model.positions, positionKey(event.handNumber), actual);
  model.recent.push(actual);
  if (model.recent.length > 96) model.recent.shift();
  model.seen += 1;
}

function updatePerformance(model, predictions, mixture, actual) {
  const baseline = BASE_BANKER_RATE;
  const baselineBrier = square(baseline - actual);
  scorePerformance(model.performance.baseline, baseline, actual, 0);
  const mixtureBrier = square(mixture - actual);
  const lift = baselineBrier - mixtureBrier;
  scorePerformance(model.performance.mixture, mixture, actual, lift);
  for (const [key, probability] of Object.entries(predictions)) {
    scorePerformance(model.performance.experts[key], probability, actual, baselineBrier - square(probability - actual));
  }
  model.recentScores.push({ mixtureBrier, baselineBrier, lift });
  if (model.recentScores.length > Math.max(40, RECENT_WINDOW)) model.recentScores.shift();
}

function scorePerformance(stat, probability, actual, lift) {
  const p = clamp(probability, 0.01, 0.99);
  const brier = square(p - actual);
  const logLoss = -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
  stat.checks += 1;
  stat.hits += (p >= 0.5 ? 1 : 0) === actual ? 1 : 0;
  stat.brierSum += brier;
  stat.logLossSum += logLoss;
  stat.liftSum += lift;
  stat.liftSquareSum += square(lift);
}

function updateWeights(weights, predictions, actual) {
  const keys = Object.keys(weights);
  let total = 0;
  for (const key of keys) {
    const probability = clamp(predictions[key], 0.02, 0.98);
    const actualProbability = actual ? probability : 1 - probability;
    weights[key] *= Math.pow(actualProbability, clamp(LEARNING_RATE, 0.05, 1));
    total += weights[key];
  }
  if (!total || !Number.isFinite(total)) {
    for (const key of keys) weights[key] = 1 / keys.length;
    return;
  }
  const share = clamp(FIXED_SHARE, 0, 0.2);
  for (const key of keys) {
    const normalized = weights[key] / total;
    weights[key] = normalized * (1 - share) + share / keys.length;
  }
}

function mixPredictions(predictions, weights) {
  let weighted = 0;
  let total = 0;
  for (const [key, probability] of Object.entries(predictions)) {
    const weight = Number(weights[key] || 0);
    weighted += probability * weight;
    total += weight;
  }
  return total ? clamp(weighted / total, 0.01, 0.99) : BASE_BANKER_RATE;
}

function summarizeValidation(mixture, baseline) {
  const checks = Number(mixture.checks || 0);
  const brier = checks ? mixture.brierSum / checks : 0;
  const baselineBrier = checks ? baseline.brierSum / checks : 0;
  const logLoss = checks ? mixture.logLossSum / checks : 0;
  const baselineLogLoss = checks ? baseline.logLossSum / checks : 0;
  const meanLift = checks ? mixture.liftSum / checks : 0;
  const variance = checks > 1
    ? Math.max(0, (mixture.liftSquareSum - square(mixture.liftSum) / checks) / (checks - 1))
    : 0;
  const standardError = checks ? Math.sqrt(variance / checks) : 0;
  const liftLower = meanLift - 1.96 * standardError;
  const brierSkill = baselineBrier > 0 ? 1 - brier / baselineBrier : 0;
  const approved = checks >= MIN_VALIDATION_CHECKS
    && liftLower > 0
    && logLoss < baselineLogLoss;
  return {
    method: "prequential-walk-forward",
    leakageSafe: true,
    checks,
    hits: Number(mixture.hits || 0),
    hitRate: round(checks ? mixture.hits / checks : 0),
    hitWilsonLower: round(wilsonLowerBound(mixture.hits, checks)),
    brier: round(brier, 6),
    baselineBrier: round(baselineBrier, 6),
    brierSkill: round(brierSkill, 6),
    pairedBrierLift: round(meanLift, 6),
    pairedBrierLiftLower: round(liftLower, 6),
    logLoss: round(logLoss, 6),
    baselineLogLoss: round(baselineLogLoss, 6),
    approved,
    read: approved
      ? "逐局樣本外 Brier 與 log-loss 均優於莊方基準。"
      : "尚未證明逐局樣本外表現優於莊方基準。"
  };
}

function summarizeDrift(scores, validation) {
  const recent = scores.slice(-Math.min(RECENT_WINDOW, scores.length));
  const recentLift = recent.length ? average(recent.map((item) => item.lift)) : 0;
  const recentBrier = recent.length ? average(recent.map((item) => item.mixtureBrier)) : 0;
  const recentBaselineBrier = recent.length ? average(recent.map((item) => item.baselineBrier)) : 0;
  const detected = recent.length >= 60
    && (recentLift < -0.0025 || recentLift < Number(validation.pairedBrierLift || 0) - 0.012);
  return {
    detected,
    recentChecks: recent.length,
    recentBrier: round(recentBrier, 6),
    recentBaselineBrier: round(recentBaselineBrier, 6),
    recentPairedLift: round(recentLift, 6),
    read: detected ? "近期機率損失惡化，已降權並停止高品質提醒。" : "近期未偵測到顯著惡化。"
  };
}

function buildEconomics(bankerRate, uncertainty) {
  const bankerLower = clamp(bankerRate - 1.96 * uncertainty, 0, 1);
  const bankerUpper = clamp(bankerRate + 1.96 * uncertainty, 0, 1);
  const playerRate = 1 - bankerRate;
  const playerLower = 1 - bankerUpper;
  return {
    basis: "flat-unit-resolved-hand",
    bankerPayout: 0.95,
    banker: {
      probability: round(bankerRate),
      conservativeProbability: round(bankerLower),
      expectedValue: round(0.95 * bankerRate - (1 - bankerRate)),
      conservativeExpectedValue: round(0.95 * bankerLower - (1 - bankerLower))
    },
    player: {
      probability: round(playerRate),
      conservativeProbability: round(playerLower),
      expectedValue: round(playerRate - bankerRate),
      conservativeExpectedValue: round(playerLower - (1 - playerLower))
    }
  };
}

function buildDirection(result, probability, economics) {
  return {
    action: "direction",
    result,
    label: result === "banker" ? "莊" : "閒",
    rate: round(probability),
    expectedValue: round(economics.expectedValue),
    conservativeExpectedValue: round(economics.conservativeExpectedValue)
  };
}

function summarizeExperts(predictions, model) {
  return EXPERTS.map((expert) => {
    const stat = model.performance.experts[expert.key];
    const checks = Number(stat.checks || 0);
    const probability = Number(predictions[expert.key] || BASE_BANKER_RATE);
    return {
      key: expert.key,
      label: expert.label,
      weight: round(model.weights[expert.key] || 0),
      bankerRate: round(probability),
      result: probability >= 0.5 ? "banker" : "player",
      resultLabel: probability >= 0.5 ? "莊" : "閒",
      checks,
      brier: round(checks ? stat.brierSum / checks : 0, 6),
      logLoss: round(checks ? stat.logLossSum / checks : 0, 6),
      pairedBrierLift: round(checks ? stat.liftSum / checks : 0, 6)
    };
  }).sort((left, right) => right.weight - left.weight);
}

function detectRegime(history) {
  const values = history.filter((result) => SIDE_RESULTS.has(result));
  const streak = currentStreak(values);
  const alternation = alternationRate(values.slice(-12));
  const label = streak >= 4
    ? "長連段"
    : alternation >= 0.72
      ? "高跳動"
      : alternation <= 0.28
        ? "低跳動"
        : "混合噪聲";
  return {
    key: label === "長連段" ? "long-run" : label === "高跳動" ? "alternating" : label === "低跳動" ? "clustered" : "mixed",
    label,
    streak,
    alternationRate: round(alternation),
    read: `目前型態 ${label}；型態只供權重調整，不代表可預知下一局。`
  };
}

function buildRead({ action, directional, validation, drift, dominant, shrinkage }) {
  const quality = action === "advise" ? "通過" : "未通過";
  const expert = dominant?.label ? `，主導專家 ${dominant.label}` : "";
  const driftText = drift.detected ? "，近期漂移已觸發降權" : "";
  return `多專家集成：每局方向 ${directional.label}，品質${quality}${expert}${driftText}；樣本外 Brier lift ${formatSigned(validation.pairedBrierLift)}，收縮 ${formatPercent(shrinkage)}。`;
}

function recentRate(values, prior) {
  if (!values.length) return prior;
  let weight = 1;
  let weighted = 0;
  let total = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    weighted += values[index] * weight;
    total += weight;
    weight *= 0.94;
  }
  const effective = Math.min(32, total);
  return (weighted + prior * 18) / (effective + 18);
}

function contextualRate(map, key, prior, strength) {
  if (!key) return prior;
  return bayesRate(map.get(key), prior, strength);
}

function bayesRate(counts, prior, strength) {
  const banker = Number(counts?.banker || 0);
  const player = Number(counts?.player || 0);
  const total = banker + player;
  return (banker + prior * strength) / (total + strength);
}

function incrementMap(map, key, actual) {
  if (!key) return;
  if (!map.has(key)) map.set(key, { banker: 0, player: 0 });
  incrementCount(map.get(key), actual);
}

function incrementCount(counts, actual) {
  if (actual) counts.banker += 1;
  else counts.player += 1;
}

function contextKey(history, order) {
  if (!Array.isArray(history) || history.length < order) return "";
  return history.slice(-order).join(">");
}

function runKey(history) {
  if (!history.length) return "";
  const last = history.at(-1);
  return `${last}:${Math.min(6, currentStreak(history))}`;
}

function alternationKey(history) {
  if (history.length < 4) return "";
  const tail = history.slice(-5);
  const transitions = [];
  for (let index = 1; index < tail.length; index += 1) {
    transitions.push(tail[index] === tail[index - 1] ? "S" : "A");
  }
  return transitions.join("");
}

function positionKey(handNumber) {
  const hand = Number(handNumber || 0);
  if (!hand) return "unknown";
  return `h${Math.min(8, Math.floor((hand - 1) / 10))}`;
}

function normalizeSides(rounds) {
  return (Array.isArray(rounds) ? rounds : [])
    .map((round) => normalizeRound(round))
    .filter((round) => round && SIDE_RESULTS.has(round.result))
    .map((round) => round.result);
}

function currentStreak(values) {
  const last = values.at(-1);
  if (!last) return 0;
  let count = 0;
  for (let index = values.length - 1; index >= 0 && values[index] === last; index -= 1) count += 1;
  return count;
}

function alternationRate(values) {
  if (values.length < 2) return 0.5;
  let changes = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1]) changes += 1;
  }
  return changes / (values.length - 1);
}

function weightedSpread(predictions, weights, center) {
  let sum = 0;
  let total = 0;
  for (const [key, probability] of Object.entries(predictions)) {
    const weight = Number(weights[key] || 0);
    sum += weight * square(probability - center);
    total += weight;
  }
  return total ? Math.sqrt(sum / total) : 0;
}

function compareWithinGroup(left, right) {
  const hand = Number(left.handNumber || 0) - Number(right.handNumber || 0);
  if (hand) return hand;
  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return left.fallbackOrder - right.fallbackOrder;
}

function compareChronological(left, right) {
  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  if (left.timestamp && !right.timestamp) return -1;
  if (!left.timestamp && right.timestamp) return 1;
  const group = Number(left.groupIndex || 0) - Number(right.groupIndex || 0);
  return group || compareWithinGroup(left, right);
}

function parseTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSigned(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(5)}`;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(0)}%`;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
}

function square(value) {
  return Number(value || 0) ** 2;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
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
  BASE_BANKER_RATE,
  buildEnsembleBrain
};
