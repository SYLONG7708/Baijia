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

function emptyOutcomeCounts() {
  return { total: 0, BANKER: 0, PLAYER: 0, TIE: 0 };
}

function addToCounts(counts, outcome) {
  counts.total += 1;
  if (counts[outcome] !== undefined) counts[outcome] += 1;
}

function smoothCounts(counts, prior = BASE_OUTCOME, priorWeight = 18) {
  const total = Number(counts.total || 0) + priorWeight;
  return normalize({
    BANKER: (Number(counts.BANKER || 0) + prior.BANKER * priorWeight) / total,
    PLAYER: (Number(counts.PLAYER || 0) + prior.PLAYER * priorWeight) / total,
    TIE: (Number(counts.TIE || 0) + prior.TIE * priorWeight) / total
  });
}

function sequenceKey(sequence, order) {
  if (!order || sequence.length < order) return "";
  return sequence.slice(-order).join("");
}

function mapCounts(map, key) {
  if (!key) return null;
  let counts = map.get(key);
  if (!counts) {
    counts = emptyOutcomeCounts();
    map.set(key, counts);
  }
  return counts;
}

function createFastState() {
  return {
    counts: emptyOutcomeCounts(),
    shoeCounts: emptyOutcomeCounts(),
    previousRoundNo: 0,
    sequence: [],
    markov: {
      1: new Map(),
      2: new Map(),
      3: new Map()
    },
    streak: {
      outcome: "",
      length: 0,
      exact: new Map()
    }
  };
}

function streakSampleKey(outcome, length) {
  return `${outcome}:${length}`;
}

function updateStreakSamples(state, outcome) {
  if (!["BANKER", "PLAYER"].includes(outcome)) return;
  const previous = state.streak;
  if (!previous.outcome || !previous.length) return;
  const key = streakSampleKey(previous.outcome, previous.length);
  let sample = previous.exact.get(key);
  if (!sample) {
    sample = { opportunities: 0, continuations: 0 };
    previous.exact.set(key, sample);
  }
  sample.opportunities += 1;
  if (outcome === previous.outcome) sample.continuations += 1;
}

function updateStreakState(state, outcome) {
  updateStreakSamples(state, outcome);
  if (outcome === "TIE") return;
  if (outcome === state.streak.outcome) {
    state.streak.length += 1;
  } else {
    state.streak.outcome = outcome;
    state.streak.length = 1;
  }
}

function updateFastState(state, round) {
  const outcome = normalizeOutcome(round.outcome);
  if (!outcome) return;
  const roundNo = Number(round.roundNo || 0);
  if (state.previousRoundNo > 0 && roundNo > 0 && roundNo < state.previousRoundNo) {
    state.shoeCounts = emptyOutcomeCounts();
  }
  state.previousRoundNo = roundNo || state.previousRoundNo;

  for (const order of [1, 2, 3]) {
    const key = sequenceKey(state.sequence, order);
    if (key) addToCounts(mapCounts(state.markov[order], key), outcome);
  }
  addToCounts(state.counts, outcome);
  addToCounts(state.shoeCounts, outcome);
  updateStreakState(state, outcome);
  state.sequence.push(outcomeShort(outcome));
  if (state.sequence.length > 8) state.sequence.shift();
}

function fastMarkovPrediction(state, order) {
  const base = smoothCounts(state.counts);
  const key = sequenceKey(state.sequence, order);
  const counts = key ? state.markov[order].get(key) : null;
  if (!counts || counts.total < 4) {
    return toPrediction(`markov_${order}`, base, { sampleSize: counts?.total || 0 });
  }
  return toPrediction(`markov_${order}`, smoothCounts(counts, base, counts.total < 10 ? 12 : 4), {
    sampleSize: counts.total
  });
}

function fastStreakPrediction(state) {
  const base = smoothCounts(state.counts);
  const current = state.streak;
  if (!current.outcome || !current.length) {
    return toPrediction("streak_continuation", base, { sampleSize: 0 });
  }
  const sample = current.exact.get(streakSampleKey(current.outcome, current.length)) || {};
  const same = sample.opportunities >= 5
    ? Math.max(0.35, Math.min(0.65, sample.continuations / sample.opportunities))
    : 0.5;
  const tie = Math.max(0.04, Math.min(0.14, base.TIE));
  const nonTie = 1 - tie;
  const other = current.outcome === "BANKER" ? "PLAYER" : "BANKER";
  return toPrediction("streak_continuation", {
    [current.outcome]: nonTie * same,
    [other]: nonTie * (1 - same),
    TIE: tie
  }, { sampleSize: sample.opportunities || 0 });
}

function blendProbabilities(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0) || 1;
  const raw = { BANKER: 0, PLAYER: 0, TIE: 0 };
  for (const item of items) {
    raw.BANKER += Number(item.probabilities.BANKER || 0) * item.weight;
    raw.PLAYER += Number(item.probabilities.PLAYER || 0) * item.weight;
    raw.TIE += Number(item.probabilities.TIE || 0) * item.weight;
  }
  return {
    BANKER: raw.BANKER / totalWeight,
    PLAYER: raw.PLAYER / totalWeight,
    TIE: raw.TIE / totalWeight
  };
}

function fastPredictionByModel(state, modelId) {
  if (modelId === "banker_baseline") return toPrediction(modelId, BASE_OUTCOME);
  if (modelId === "table_frequency") return toPrediction(modelId, smoothCounts(state.counts), { sampleSize: state.counts.total });
  if (modelId === "current_shoe_frequency") {
    const source = state.shoeCounts.total >= 8 ? state.shoeCounts : state.counts;
    return toPrediction(modelId, smoothCounts(source), { sampleSize: source.total });
  }
  if (modelId === "markov_1") return fastMarkovPrediction(state, 1);
  if (modelId === "markov_2") return fastMarkovPrediction(state, 2);
  if (modelId === "markov_3") return fastMarkovPrediction(state, 3);
  if (modelId === "streak_continuation") return fastStreakPrediction(state);
  if (modelId === "card_shoe") {
    const source = state.shoeCounts.total >= 8 ? state.shoeCounts : state.counts;
    return toPrediction(modelId, blendProbabilities([
      { probabilities: smoothCounts(state.counts), weight: 0.55 },
      { probabilities: smoothCounts(source), weight: 0.45 }
    ]), { sampleSize: source.total });
  }
  if (modelId === "commercial_blend") {
    const markov = fastMarkovPrediction(state, 3);
    const streak = fastStreakPrediction(state);
    return toPrediction(modelId, blendProbabilities([
      { probabilities: smoothCounts(state.counts), weight: 0.45 },
      { probabilities: markov.probabilities, weight: markov.sampleSize >= 8 ? 0.25 : 0.1 },
      { probabilities: streak.probabilities, weight: streak.sampleSize >= 5 ? 0.2 : 0.1 },
      { probabilities: BASE_OUTCOME, weight: 0.1 }
    ]), {
      sampleSize: Math.max(markov.sampleSize || 0, streak.sampleSize || 0, state.counts.total || 0)
    });
  }
  return fastPredictionByModel(state, "commercial_blend");
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
    const tableStats = emptyStats(modelId);
    const state = createFastState();
    for (let index = 0; index < Math.min(warmup, rows.length); index += 1) {
      updateFastState(state, rows[index]);
    }
    for (let index = warmup; index < rows.length; index += 1) {
      const actual = rows[index];
      const prediction = fastPredictionByModel(state, modelId);
      observe(stats, prediction, actual.outcome);
      observe(tableStats, prediction, actual.outcome);
      updateFastState(state, actual);
    }
    if (stats.tested > before) {
      perTable.push({
        tableCode: table.code,
        sourceRows: rows.length,
        ...finalize(tableStats)
      });
    }
  }

  return {
    ...finalize(stats),
    perTable
  };
}

function buildTableModels(candidates) {
  const byTable = new Map();
  for (const candidate of candidates) {
    for (const stats of candidate.perTable || []) {
      if (Number(stats.tested || 0) < 20) continue;
      const item = {
        tableCode: stats.tableCode,
        modelId: candidate.modelId,
        tested: stats.tested,
        sourceRows: stats.sourceRows,
        accuracy: stats.accuracy,
        accuracyNoTie: stats.accuracyNoTie,
        averageLogLoss: stats.averageLogLoss,
        averageBrier: stats.averageBrier
      };
      const current = byTable.get(stats.tableCode);
      if (!current
        || item.averageLogLoss < current.averageLogLoss
        || (item.averageLogLoss === current.averageLogLoss && item.accuracyNoTie > current.accuracyNoTie)
        || (item.averageLogLoss === current.averageLogLoss && item.accuracyNoTie === current.accuracyNoTie && item.tested > current.tested)) {
        byTable.set(stats.tableCode, item);
      }
    }
  }
  return [...byTable.values()].sort((left, right) => left.tableCode.localeCompare(right.tableCode));
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
  const tableModels = buildTableModels(candidates);
  return {
    generatedAt: new Date().toISOString(),
    activeModel: active?.modelId || "commercial_blend",
    active,
    baseline,
    tableModels,
    candidates,
    candidateIds: MODEL_IDS,
    note: "Local walk-forward model selection. Tables can use their own best recent model. It improves statistical calibration only; baccarat outcomes remain random and not guaranteed."
  };
}

module.exports = {
  MODEL_IDS,
  buildModelSelection,
  predictByModel,
  backtestModel
};
