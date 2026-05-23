const { TARGET_TABLES, normalizeTableCode } = require("./tables");
const { normalizeOutcome, outcomeShort } = require("./baccarat-codec");
const {
  countRounds,
  currentShoeRounds,
  estimateCardModel,
  predictFromSequence,
  predictionPool,
  ratesFromCounts,
  sequenceOf,
  tableStreakStats
} = require("./analytics");

const BASE_OUTCOME = { BANKER: 0.4586, PLAYER: 0.4462, TIE: 0.0952 };
const MODEL_IDS = [
  "commercial_blend",
  "banker_baseline",
  "table_frequency",
  "current_shoe_frequency",
  "markov_1",
  "markov_2",
  "markov_3",
  "streak_continuation",
  "card_shoe"
];

function pct(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
}

function normalize(probabilities) {
  const raw = {
    BANKER: Math.max(0.0001, Number(probabilities.BANKER || 0)),
    PLAYER: Math.max(0.0001, Number(probabilities.PLAYER || 0)),
    TIE: Math.max(0.0001, Number(probabilities.TIE || 0))
  };
  const total = raw.BANKER + raw.PLAYER + raw.TIE || 1;
  return {
    BANKER: raw.BANKER / total,
    PLAYER: raw.PLAYER / total,
    TIE: raw.TIE / total
  };
}

function choosePick(probabilities) {
  if ((probabilities.PLAYER || 0) > (probabilities.BANKER || 0) + 0.07) return "PLAYER";
  return "BANKER";
}

function toPrediction(modelId, probabilities, meta = {}) {
  const normalized = normalize(probabilities);
  const rawPick = Object.entries(normalized).sort((left, right) => right[1] - left[1])[0][0];
  return {
    modelId,
    rawPick,
    pick: choosePick(normalized),
    probabilities: normalized,
    percentages: {
      BANKER: pct(normalized.BANKER),
      PLAYER: pct(normalized.PLAYER),
      TIE: pct(normalized.TIE)
    },
    ...meta
  };
}

function smoothRates(rounds, prior = BASE_OUTCOME, priorWeight = 18) {
  const counts = countRounds(rounds);
  const total = counts.total + priorWeight;
  return normalize({
    BANKER: (counts.BANKER + prior.BANKER * priorWeight) / total,
    PLAYER: (counts.PLAYER + prior.PLAYER * priorWeight) / total,
    TIE: (counts.TIE + prior.TIE * priorWeight) / total
  });
}

function tableRows(allRounds, tableCode) {
  return allRounds
    .filter((round) => round.tableCode === tableCode && normalizeOutcome(round.outcome))
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
}

function markovPrediction(sourceRows, tableCode, order) {
  const table = tableRows(sourceRows, tableCode);
  const global = [...sourceRows].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  const sequence = sequenceOf(table, order);
  const collect = (rows) => {
    const matches = [];
    for (let index = order; index < rows.length; index += 1) {
      const window = rows.slice(index - order, index).map((round) => outcomeShort(round.outcome));
      if (window.join("") === sequence.join("")) matches.push(rows[index]);
    }
    return matches;
  };
  const tableMatches = sequence.length === order ? collect(table) : [];
  const globalMatches = sequence.length === order ? collect(global) : [];
  const selected = tableMatches.length >= 8 ? tableMatches : globalMatches;
  const base = smoothRates(table.length >= 20 ? table : sourceRows);
  return toPrediction(`markov_${order}`, smoothRates(selected, base, selected.length < 10 ? 12 : 4), {
    sampleSize: selected.length,
    tableSampleSize: tableMatches.length,
    globalSampleSize: globalMatches.length
  });
}

function streakPrediction(sourceRows, tableCode) {
  const table = tableRows(sourceRows, tableCode);
  const streak = tableStreakStats(table);
  const base = smoothRates(table.length >= 20 ? table : sourceRows);
  if (!streak.outcome || streak.opportunities < 5) {
    return toPrediction("streak_continuation", base, { streak, sampleSize: streak.opportunities || 0 });
  }
  const same = Math.max(0.35, Math.min(0.65, streak.continuationRate));
  const tie = Math.max(0.04, Math.min(0.14, base.TIE));
  const nonTie = 1 - tie;
  const other = streak.outcome === "BANKER" ? "PLAYER" : "BANKER";
  return toPrediction("streak_continuation", {
    [streak.outcome]: nonTie * same,
    [other]: nonTie * (1 - same),
    TIE: tie
  }, { streak, sampleSize: streak.opportunities });
}

function cardShoePrediction(sourceRows, tableCode) {
  const table = tableRows(sourceRows, tableCode);
  const base = smoothRates(table.length >= 20 ? table : sourceRows);
  const cardModel = estimateCardModel(table);
  if (!cardModel.available) {
    return toPrediction("card_shoe", base, { cardModel, sampleSize: 0 });
  }
  const weight = Math.min(0.28, 0.08 + (cardModel.observedCards / 416) * 0.35);
  return toPrediction("card_shoe", {
    BANKER: base.BANKER * (1 - weight) + cardModel.probabilities.BANKER * weight,
    PLAYER: base.PLAYER * (1 - weight) + cardModel.probabilities.PLAYER * weight,
    TIE: base.TIE * (1 - weight) + cardModel.probabilities.TIE * weight
  }, { cardModel, sampleSize: cardModel.currentShoeRounds || 0, cardWeight: Math.round(weight * 1000) / 1000 });
}

function predictByModel(allRounds, tableCode, modelId) {
  const code = normalizeTableCode(tableCode);
  const sourceRows = predictionPool(allRounds, code);
  const table = tableRows(sourceRows, code);
  if (modelId === "commercial_blend") {
    const prediction = predictFromSequence(sourceRows, { tableCode: code });
    return { ...prediction, modelId };
  }
  if (modelId === "banker_baseline") return toPrediction(modelId, BASE_OUTCOME);
  if (modelId === "table_frequency") {
    return toPrediction(modelId, smoothRates(table.length >= 20 ? table : sourceRows), { sampleSize: table.length });
  }
  if (modelId === "current_shoe_frequency") {
    const shoe = currentShoeRounds(table);
    return toPrediction(modelId, smoothRates(shoe.length >= 8 ? shoe : table), { sampleSize: shoe.length });
  }
  if (modelId === "markov_1") return markovPrediction(sourceRows, code, 1);
  if (modelId === "markov_2") return markovPrediction(sourceRows, code, 2);
  if (modelId === "markov_3") return markovPrediction(sourceRows, code, 3);
  if (modelId === "streak_continuation") return streakPrediction(sourceRows, code);
  if (modelId === "card_shoe") return cardShoePrediction(sourceRows, code);
  return predictByModel(allRounds, code, "commercial_blend");
}

function emptyStats(modelId) {
  return {
    modelId,
    tested: 0,
    correct: 0,
    testedNoTie: 0,
    correctNoTie: 0,
    logLoss: 0,
    brier: 0,
    predicted: { BANKER: 0, PLAYER: 0, TIE: 0 },
    actual: { BANKER: 0, PLAYER: 0, TIE: 0 }
  };
}

function observe(stats, prediction, actual) {
  const probabilities = prediction.probabilities || BASE_OUTCOME;
  const pick = prediction.pick || "BANKER";
  const pActual = Math.max(0.0001, Number(probabilities[actual] || 0.0001));
  stats.tested += 1;
  stats.actual[actual] += 1;
  if (stats.predicted[pick] !== undefined) stats.predicted[pick] += 1;
  if (pick === actual) stats.correct += 1;
  if (actual !== "TIE" && pick !== "TIE") {
    stats.testedNoTie += 1;
    if (pick === actual) stats.correctNoTie += 1;
  }
  stats.logLoss += -Math.log(pActual);
  for (const label of ["BANKER", "PLAYER", "TIE"]) {
    const target = label === actual ? 1 : 0;
    stats.brier += (Number(probabilities[label] || 0) - target) ** 2;
  }
}

function finalize(stats) {
  return {
    ...stats,
    accuracy: pct(stats.correct / Math.max(1, stats.tested)),
    accuracyNoTie: pct(stats.correctNoTie / Math.max(1, stats.testedNoTie)),
    averageLogLoss: Math.round((stats.logLoss / Math.max(1, stats.tested)) * 10000) / 10000,
    averageBrier: Math.round((stats.brier / Math.max(1, stats.tested)) * 10000) / 10000
  };
}

function backtestModel(allRounds, modelId, options = {}) {
  const limit = Math.max(80, Math.min(Number(options.limit || 1200), 5000));
  const warmup = Math.max(20, Math.min(Number(options.warmup || 45), 500));
  const pool = predictionPool(allRounds);
  const stats = emptyStats(modelId);
  const perTable = [];

  for (const table of TARGET_TABLES) {
    const rows = tableRows(pool, table.code).slice(-limit);
    const before = stats.tested;
    for (let index = warmup; index < rows.length; index += 1) {
      const actual = rows[index];
      const prior = pool.filter((round) => Number(round.id || 0) < Number(actual.id || 0));
      const prediction = predictByModel(prior, table.code, modelId);
      observe(stats, prediction, actual.outcome);
    }
    if (stats.tested > before) {
      perTable.push({ tableCode: table.code, tested: stats.tested - before, sourceRows: rows.length });
    }
  }

  return {
    ...finalize(stats),
    perTable
  };
}

function buildModelSelection(allRounds, options = {}) {
  const candidates = MODEL_IDS.map((modelId) => backtestModel(allRounds, modelId, options))
    .filter((candidate) => candidate.tested >= 50)
    .sort((left, right) => {
      if (left.averageLogLoss !== right.averageLogLoss) return left.averageLogLoss - right.averageLogLoss;
      if (right.accuracyNoTie !== left.accuracyNoTie) return right.accuracyNoTie - left.accuracyNoTie;
      return right.tested - left.tested;
    });
  const active = candidates[0] || null;
  const baseline = candidates.find((candidate) => candidate.modelId === "commercial_blend") || null;
  return {
    generatedAt: new Date().toISOString(),
    activeModel: active?.modelId || "commercial_blend",
    active,
    baseline,
    candidates,
    candidateIds: MODEL_IDS,
    note: "Local walk-forward model selection. It improves statistical calibration only; baccarat outcomes remain random and not guaranteed."
  };
}

module.exports = {
  MODEL_IDS,
  buildModelSelection,
  predictByModel,
  backtestModel
};
