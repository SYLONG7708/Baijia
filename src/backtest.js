const { normalizeTableCode } = require("./tables");
const { outcomeShort } = require("./baccarat-codec");
const { predictFromSequence, predictionPool, sequenceOf } = require("./analytics");

function clampLimit(value, fallback = 500) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(50, Math.min(Math.floor(parsed), 5000));
}

function pct(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
}

function emptyStats() {
  return {
    tested: 0,
    correct: 0,
    testedNoTie: 0,
    correctNoTie: 0,
    logLoss: 0,
    brier: 0,
    actual: { BANKER: 0, PLAYER: 0, TIE: 0 },
    predicted: { BANKER: 0, PLAYER: 0, TIE: 0 },
    correctByActual: { BANKER: 0, PLAYER: 0, TIE: 0 }
  };
}

function addObservation(stats, prediction, actual) {
  const probabilities = prediction.probabilities || {};
  const pick = prediction.pick;
  const pActual = Math.max(0.0001, Number(probabilities[actual] || 0.0001));
  const labels = ["BANKER", "PLAYER", "TIE"];

  stats.tested += 1;
  stats.actual[actual] += 1;
  if (stats.predicted[pick] !== undefined) stats.predicted[pick] += 1;
  if (pick === actual) {
    stats.correct += 1;
    stats.correctByActual[actual] += 1;
  }
  if (actual !== "TIE" && pick !== "TIE") {
    stats.testedNoTie += 1;
    if (pick === actual) stats.correctNoTie += 1;
  }
  stats.logLoss += -Math.log(pActual);
  for (const label of labels) {
    const target = label === actual ? 1 : 0;
    const p = Number(probabilities[label] || 0);
    stats.brier += (p - target) ** 2;
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

function backtestTable(pool, tableCode, limit, warmup, stats, samples) {
  const rows = pool
    .filter((round) => round.tableCode === tableCode)
    .slice(-limit)
    .sort((a, b) => a.id - b.id);

  for (let index = warmup; index < rows.length; index += 1) {
    const priorTable = rows.slice(0, index);
    const actualRound = rows[index];
    const priorGlobal = pool.filter((round) => round.id < actualRound.id);
    const prediction = predictFromSequence(priorGlobal, {
      tableCode,
      sequence: sequenceOf(priorTable, 6)
    });
    addObservation(stats, prediction, actualRound.outcome);
    if (samples.length < 25) {
      samples.push({
        id: actualRound.id,
        tableCode: actualRound.tableCode,
        roundNo: actualRound.roundNo,
        sequence: prediction.sequenceText,
        pick: prediction.pick,
        actual: actualRound.outcome,
        percentages: prediction.percentages,
        cardModelAvailable: Boolean(prediction.cardModel?.available)
      });
    }
  }

  return rows.length;
}

function backtestPredictions(allRounds, options = {}) {
  const tableCode = normalizeTableCode(options.tableCode);
  const limit = clampLimit(options.limit);
  const warmup = Math.max(20, Math.min(Number(options.warmup || 40), 500));
  const pool = predictionPool(allRounds, tableCode);
  const stats = emptyStats();
  const samples = [];
  const perTable = [];

  if (tableCode) {
    const sourceRows = backtestTable(pool, tableCode, limit, warmup, stats, samples);
    perTable.push({ tableCode, sourceRows, tested: Math.max(0, sourceRows - warmup) });
  } else {
    const codes = [...new Set(pool.map((round) => round.tableCode))].sort();
    for (const code of codes) {
      const before = stats.tested;
      const sourceRows = backtestTable(pool, code, limit, warmup, stats, samples);
      if (sourceRows > 0) perTable.push({ tableCode: code, sourceRows, tested: stats.tested - before });
    }
  }

  return {
    tableCode,
    limit,
    warmup,
    sourceRows: tableCode
      ? perTable[0]?.sourceRows || 0
      : perTable.reduce((sum, table) => sum + table.sourceRows, 0),
    usablePoolRows: pool.length,
    metrics: finalize(stats),
    perTable: perTable.filter((table) => table.tested > 0),
    samples,
    note: "Backtest is walk-forward on stored reliable rounds. It measures prediction quality; it does not guarantee future results."
  };
}

module.exports = {
  backtestPredictions
};
