const { TARGET_TABLES, tableMeta, normalizeTableCode } = require("./tables");
const { outcomeShort, normalizeOutcome } = require("./baccarat-codec");

const DEFAULT_BASELINE = {
  outcome: { BANKER: 0.4586, PLAYER: 0.4462, TIE: 0.0952 },
  bankerPair: 0.0747,
  playerPair: 0.0747,
  luckySix: 0.054
};

function pct(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
}

function emptyCounts() {
  return {
    total: 0,
    BANKER: 0,
    PLAYER: 0,
    TIE: 0,
    bankerPair: 0,
    playerPair: 0,
    luckySix: 0
  };
}

function countRounds(rounds) {
  const counts = emptyCounts();
  for (const round of rounds) {
    counts.total += 1;
    if (counts[round.outcome] !== undefined) counts[round.outcome] += 1;
    if (round.bankerPair) counts.bankerPair += 1;
    if (round.playerPair) counts.playerPair += 1;
    if (round.luckySix) counts.luckySix += 1;
  }
  return counts;
}

function ratesFromCounts(counts) {
  const total = Math.max(1, counts.total);
  return {
    BANKER: counts.BANKER / total,
    PLAYER: counts.PLAYER / total,
    TIE: counts.TIE / total,
    bankerPair: counts.bankerPair / total,
    playerPair: counts.playerPair / total,
    luckySix: counts.luckySix / total
  };
}

function normalizeSequence(sequence) {
  if (Array.isArray(sequence)) {
    return sequence.map(normalizeOutcome).filter(Boolean).map(outcomeShort).slice(-6);
  }
  return String(sequence || "")
    .toUpperCase()
    .replace(/[莊庄]/g, "B")
    .replace(/[閒闲]/g, "P")
    .replace(/和/g, "T")
    .split(/[\s,，、|/-]+/)
    .flatMap((part) => part.split(""))
    .filter((value) => ["B", "P", "T"].includes(value))
    .slice(-6);
}

function sequenceOf(rounds, len = 6) {
  return rounds.slice(-len).map((round) => outcomeShort(round.outcome)).filter(Boolean);
}

function baselineFrom(rounds) {
  const counts = countRounds(rounds);
  if (counts.total < 20) return DEFAULT_BASELINE;
  const rates = ratesFromCounts(counts);
  return {
    outcome: {
      BANKER: Math.max(0.01, rates.BANKER),
      PLAYER: Math.max(0.01, rates.PLAYER),
      TIE: Math.max(0.01, rates.TIE)
    },
    bankerPair: Math.max(0.005, rates.bankerPair),
    playerPair: Math.max(0.005, rates.playerPair),
    luckySix: Math.max(0.005, rates.luckySix)
  };
}

function matchesAt(rounds, index, sequence) {
  if (index < sequence.length) return false;
  for (let offset = 0; offset < sequence.length; offset += 1) {
    if (outcomeShort(rounds[index - sequence.length + offset].outcome) !== sequence[offset]) {
      return false;
    }
  }
  return true;
}

function collectMatches(rounds, sequence) {
  const nextRounds = [];
  if (!sequence.length) return nextRounds;
  for (let index = sequence.length; index < rounds.length; index += 1) {
    if (matchesAt(rounds, index, sequence)) nextRounds.push(rounds[index]);
  }
  return nextRounds;
}

function smoothOutcomeProbabilities(counts, baseline, sample) {
  const prior = sample < 10 ? 18 : sample < 30 ? 10 : 4;
  const raw = {
    BANKER: counts.BANKER + baseline.outcome.BANKER * prior,
    PLAYER: counts.PLAYER + baseline.outcome.PLAYER * prior,
    TIE: counts.TIE + baseline.outcome.TIE * prior
  };
  const total = raw.BANKER + raw.PLAYER + raw.TIE || 1;
  return {
    BANKER: raw.BANKER / total,
    PLAYER: raw.PLAYER / total,
    TIE: raw.TIE / total
  };
}

function smoothFeature(count, sample, baselineRate) {
  const prior = sample < 10 ? 30 : sample < 30 ? 16 : 6;
  return (count + baselineRate * prior) / (sample + prior || 1);
}

function choosePick(probabilities) {
  return Object.entries(probabilities)
    .sort((left, right) => right[1] - left[1])[0][0];
}

function predictFromSequence(allRounds, options = {}) {
  const tableCode = normalizeTableCode(options.tableCode);
  const tableRounds = tableCode
    ? allRounds.filter((round) => round.tableCode === tableCode)
    : allRounds;
  const sequence = normalizeSequence(options.sequence || sequenceOf(tableRounds, 6));
  const primaryMatches = collectMatches(tableRounds, sequence);
  const globalMatches = tableCode ? collectMatches(allRounds, sequence) : primaryMatches;
  const matchRounds = primaryMatches.length >= 8 ? primaryMatches : globalMatches;
  const counts = countRounds(matchRounds);
  const baseline = baselineFrom(tableRounds.length >= 20 ? tableRounds : allRounds);
  const outcome = smoothOutcomeProbabilities(counts, baseline, counts.total);

  return {
    tableCode,
    sequence,
    sequenceText: sequence.join(""),
    sampleSize: counts.total,
    tableSampleSize: primaryMatches.length,
    globalSampleSize: globalMatches.length,
    pick: choosePick(outcome),
    probabilities: {
      BANKER: outcome.BANKER,
      PLAYER: outcome.PLAYER,
      TIE: outcome.TIE,
      bankerPair: smoothFeature(counts.bankerPair, counts.total, baseline.bankerPair),
      playerPair: smoothFeature(counts.playerPair, counts.total, baseline.playerPair),
      luckySix: smoothFeature(counts.luckySix, counts.total, baseline.luckySix)
    },
    percentages: {
      BANKER: pct(outcome.BANKER),
      PLAYER: pct(outcome.PLAYER),
      TIE: pct(outcome.TIE),
      bankerPair: pct(smoothFeature(counts.bankerPair, counts.total, baseline.bankerPair)),
      playerPair: pct(smoothFeature(counts.playerPair, counts.total, baseline.playerPair)),
      luckySix: pct(smoothFeature(counts.luckySix, counts.total, baseline.luckySix))
    },
    counts,
    confidence: counts.total >= 100 ? "HIGH" : counts.total >= 30 ? "MEDIUM" : "LOW",
    note: "Percentages are historical pattern statistics with smoothing. Baccarat remains random and results are not guaranteed."
  };
}

function summarizeTable(rounds, table) {
  const tableRounds = rounds.filter((round) => round.tableCode === table.code);
  const counts = countRounds(tableRounds);
  const latest = tableRounds.at(-1) || null;
  const rates = ratesFromCounts(counts);
  const prediction = predictFromSequence(rounds, {
    tableCode: table.code,
    sequence: sequenceOf(tableRounds, 6)
  });
  return {
    ...table,
    total: counts.total,
    counts,
    rates,
    latest,
    latestSix: sequenceOf(tableRounds, 6),
    lastShoeId: latest?.shoeId || "",
    lastRoundNo: latest?.roundNo || 0,
    lastOutcome: latest?.outcome || "",
    prediction
  };
}

function summarizeAll(rounds) {
  const counts = countRounds(rounds);
  const tables = TARGET_TABLES.map((table) => summarizeTable(rounds, table));
  const activeTables = tables.filter((table) => table.total > 0).length;
  return {
    totalRounds: counts.total,
    activeTables,
    counts,
    rates: ratesFromCounts(counts),
    prediction: predictFromSequence(rounds),
    tables
  };
}

module.exports = {
  countRounds,
  ratesFromCounts,
  normalizeSequence,
  sequenceOf,
  predictFromSequence,
  summarizeTable,
  summarizeAll
};
