const { TARGET_TABLES, tableMeta, normalizeTableCode } = require("./tables");
const { outcomeShort, normalizeOutcome, cardPointFromRank } = require("./baccarat-codec");

const DEFAULT_BASELINE = {
  outcome: { BANKER: 0.4586, PLAYER: 0.4462, TIE: 0.0952 },
  bankerPair: 0.0747,
  playerPair: 0.0747,
  luckySix: 0.054
};
const DECKS_PER_SHOE = 8;
const CARDS_PER_DECK = 52;
const CARDS_PER_SHOE = DECKS_PER_SHOE * CARDS_PER_DECK;
const CARD_MODEL_TRIALS = 900;
const OLD_SNAPSHOT_EVENTS = new Set(["getGameHall", "getGameHall:snapshot"]);

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

function isPredictionUsable(round) {
  if (!round || !normalizeOutcome(round.outcome)) return false;
  if (!round.tableCode || Number(round.roundNo || 0) <= 0) return false;
  if (OLD_SNAPSHOT_EVENTS.has(round.sourceEvent)) return false;
  const tableName = String(round.tableName || "").toUpperCase();
  if (/^[A-Z]+[0-9]+$/.test(tableName) && tableName !== String(round.tableCode).toUpperCase()) {
    return false;
  }
  return true;
}

function validRound(round) {
  return round && normalizeOutcome(round.outcome) && round.tableCode && Number(round.roundNo || 0) > 0;
}

function predictionPool(allRounds, tableCode) {
  const valid = allRounds.filter(validRound);
  const reliable = valid.filter(isPredictionUsable);
  const reliableTableCount = tableCode
    ? reliable.filter((round) => round.tableCode === tableCode).length
    : reliable.length;
  if (reliableTableCount >= 20 || reliable.length >= 100) return reliable;
  return valid;
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

function chooseCommercialPick(probabilities, threshold = 0.07) {
  if ((probabilities.PLAYER || 0) > (probabilities.BANKER || 0) + threshold) return "PLAYER";
  return "BANKER";
}

function baseRankCounts() {
  const counts = {};
  for (let rank = 1; rank <= 13; rank += 1) counts[rank] = DECKS_PER_SHOE * 4;
  return counts;
}

function pointCountsFromRanks(rankCounts) {
  const points = {};
  for (let point = 0; point <= 9; point += 1) points[point] = 0;
  for (const [rank, count] of Object.entries(rankCounts)) {
    const point = cardPointFromRank(Number(rank));
    if (point !== null) points[point] += count;
  }
  return points;
}

function latestShoeRounds(tableRounds) {
  const sorted = [...tableRounds].sort((a, b) => a.id - b.id);
  if (!sorted.length) return [];
  const shoe = [sorted.at(-1)];
  let nextRoundNo = Number(sorted.at(-1).roundNo || 0);
  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    const round = sorted[index];
    const roundNo = Number(round.roundNo || 0);
    if (roundNo <= 0 || nextRoundNo <= 0) break;
    if (roundNo >= nextRoundNo) break;
    shoe.unshift(round);
    nextRoundNo = roundNo;
  }
  return shoe;
}

function usedRanksFromRounds(rounds) {
  const used = {};
  for (let rank = 1; rank <= 13; rank += 1) used[rank] = 0;
  for (const round of rounds) {
    const ranks = [
      ...(round.bankerCardRanks || []),
      ...(round.playerCardRanks || [])
    ];
    for (const rankValue of ranks) {
      const rank = Number(rankValue);
      if (Number.isInteger(rank) && rank >= 1 && rank <= 13) used[rank] += 1;
    }
  }
  return used;
}

function hashSeed(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seedText) {
  let state = hashSeed(seedText) || 1;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawRank(rankCounts, rng) {
  const total = Object.values(rankCounts).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 1;
  let target = rng() * total;
  for (let rank = 1; rank <= 13; rank += 1) {
    target -= rankCounts[rank] || 0;
    if (target < 0) {
      rankCounts[rank] -= 1;
      return rank;
    }
  }
  for (let rank = 13; rank >= 1; rank -= 1) {
    if ((rankCounts[rank] || 0) > 0) {
      rankCounts[rank] -= 1;
      return rank;
    }
  }
  return 1;
}

function handTotal(ranks) {
  return ranks.reduce((sum, rank) => sum + cardPointFromRank(rank), 0) % 10;
}

function simulateBaccaratRound(remainingRanks, rng) {
  const ranks = { ...remainingRanks };
  const player = [drawRank(ranks, rng)];
  const banker = [drawRank(ranks, rng)];
  player.push(drawRank(ranks, rng));
  banker.push(drawRank(ranks, rng));

  let playerTotal = handTotal(player);
  let bankerTotal = handTotal(banker);

  if (playerTotal < 8 && bankerTotal < 8) {
    let playerThirdPoint = null;
    if (playerTotal <= 5) {
      const rank = drawRank(ranks, rng);
      player.push(rank);
      playerThirdPoint = cardPointFromRank(rank);
      playerTotal = handTotal(player);
    }

    let bankerDraw = false;
    if (playerThirdPoint === null) {
      bankerDraw = bankerTotal <= 5;
    } else if (bankerTotal <= 2) {
      bankerDraw = true;
    } else if (bankerTotal === 3) {
      bankerDraw = playerThirdPoint !== 8;
    } else if (bankerTotal === 4) {
      bankerDraw = playerThirdPoint >= 2 && playerThirdPoint <= 7;
    } else if (bankerTotal === 5) {
      bankerDraw = playerThirdPoint >= 4 && playerThirdPoint <= 7;
    } else if (bankerTotal === 6) {
      bankerDraw = playerThirdPoint === 6 || playerThirdPoint === 7;
    }

    if (bankerDraw) {
      banker.push(drawRank(ranks, rng));
      bankerTotal = handTotal(banker);
    }
  }

  const outcome = bankerTotal > playerTotal ? "BANKER" : playerTotal > bankerTotal ? "PLAYER" : "TIE";
  return {
    outcome,
    bankerPair: banker[0] === banker[1],
    playerPair: player[0] === player[1],
    luckySix: outcome === "BANKER" && bankerTotal === 6
  };
}

function estimateCardModel(tableRounds) {
  const shoeRounds = latestShoeRounds(tableRounds).filter((round) => round.cardCount > 0);
  const usedRanks = usedRanksFromRounds(shoeRounds);
  const remainingRanks = baseRankCounts();
  let observedCards = 0;
  for (let rank = 1; rank <= 13; rank += 1) {
    const used = Math.min(remainingRanks[rank], usedRanks[rank] || 0);
    remainingRanks[rank] -= used;
    observedCards += used;
  }
  if (observedCards < 4) {
    return {
      available: false,
      decks: DECKS_PER_SHOE,
      cardsPerDeck: CARDS_PER_DECK,
      totalCards: CARDS_PER_SHOE,
      observedCards,
      remainingCards: CARDS_PER_SHOE - observedCards
    };
  }

  const counts = emptyCounts();
  const seed = shoeRounds.map((round) => `${round.tableCode}:${round.roundNo}:${round.rawResult}`).join("|");
  const rng = seededRandom(seed);
  for (let index = 0; index < CARD_MODEL_TRIALS; index += 1) {
    const result = simulateBaccaratRound(remainingRanks, rng);
    counts.total += 1;
    counts[result.outcome] += 1;
    if (result.bankerPair) counts.bankerPair += 1;
    if (result.playerPair) counts.playerPair += 1;
    if (result.luckySix) counts.luckySix += 1;
  }

  const probabilities = ratesFromCounts(counts);
  return {
    available: true,
    decks: DECKS_PER_SHOE,
    cardsPerDeck: CARDS_PER_DECK,
    totalCards: CARDS_PER_SHOE,
    observedCards,
    remainingCards: CARDS_PER_SHOE - observedCards,
    currentShoeRounds: shoeRounds.length,
    trials: CARD_MODEL_TRIALS,
    usedRankCounts: usedRanks,
    remainingRankCounts: remainingRanks,
    remainingPointCounts: pointCountsFromRanks(remainingRanks),
    probabilities,
    percentages: {
      BANKER: pct(probabilities.BANKER),
      PLAYER: pct(probabilities.PLAYER),
      TIE: pct(probabilities.TIE),
      bankerPair: pct(probabilities.bankerPair),
      playerPair: pct(probabilities.playerPair),
      luckySix: pct(probabilities.luckySix)
    }
  };
}

function blendValue(historical, card, weight) {
  return historical * (1 - weight) + card * weight;
}

function normalizeOutcomeProbabilities(probabilities) {
  const total = probabilities.BANKER + probabilities.PLAYER + probabilities.TIE || 1;
  return {
    BANKER: probabilities.BANKER / total,
    PLAYER: probabilities.PLAYER / total,
    TIE: probabilities.TIE / total
  };
}

function patternWeightFor(sampleSize) {
  if (sampleSize >= 150) return 0.12;
  if (sampleSize >= 60) return 0.08;
  if (sampleSize >= 20) return 0.05;
  if (sampleSize >= 8) return 0.03;
  return 0;
}

function predictFromSequence(allRounds, options = {}) {
  const tableCode = normalizeTableCode(options.tableCode);
  const sourceRounds = options.useAllSources ? allRounds.filter(validRound) : predictionPool(allRounds, tableCode);
  const tableRounds = tableCode
    ? sourceRounds.filter((round) => round.tableCode === tableCode)
    : sourceRounds;
  const sequence = normalizeSequence(options.sequence || sequenceOf(tableRounds, 6));
  const primaryMatches = collectMatches(tableRounds, sequence);
  const globalMatches = tableCode ? collectMatches(sourceRounds, sequence) : primaryMatches;
  const matchRounds = primaryMatches.length >= 8 ? primaryMatches : globalMatches;
  const counts = countRounds(matchRounds);
  const baseline = baselineFrom(tableRounds.length >= 20 ? tableRounds : sourceRounds);
  const baselineOutcome = normalizeOutcomeProbabilities(baseline.outcome);
  const patternOutcome = smoothOutcomeProbabilities(counts, baseline, counts.total);
  const patternFeatures = {
    bankerPair: smoothFeature(counts.bankerPair, counts.total, baseline.bankerPair),
    playerPair: smoothFeature(counts.playerPair, counts.total, baseline.playerPair),
    luckySix: smoothFeature(counts.luckySix, counts.total, baseline.luckySix)
  };
  const cardModel = tableCode ? estimateCardModel(tableRounds) : { available: false };
  const cardWeight = cardModel.available
    ? Math.min(0.18, 0.05 + (cardModel.observedCards / CARDS_PER_SHOE) * 0.35)
    : 0;
  const patternWeight = Math.min(patternWeightFor(counts.total), 1 - cardWeight);
  const baselineWeight = Math.max(0, 1 - cardWeight - patternWeight);
  const blendedOutcome = normalizeOutcomeProbabilities({
    BANKER:
      baselineOutcome.BANKER * baselineWeight +
      patternOutcome.BANKER * patternWeight +
      (cardModel.available ? cardModel.probabilities.BANKER * cardWeight : 0),
    PLAYER:
      baselineOutcome.PLAYER * baselineWeight +
      patternOutcome.PLAYER * patternWeight +
      (cardModel.available ? cardModel.probabilities.PLAYER * cardWeight : 0),
    TIE:
      baselineOutcome.TIE * baselineWeight +
      patternOutcome.TIE * patternWeight +
      (cardModel.available ? cardModel.probabilities.TIE * cardWeight : 0)
  });
  const blendedFeatures = {
    bankerPair:
      baseline.bankerPair * baselineWeight +
      patternFeatures.bankerPair * patternWeight +
      (cardModel.available ? cardModel.probabilities.bankerPair * cardWeight : 0),
    playerPair:
      baseline.playerPair * baselineWeight +
      patternFeatures.playerPair * patternWeight +
      (cardModel.available ? cardModel.probabilities.playerPair * cardWeight : 0),
    luckySix:
      baseline.luckySix * baselineWeight +
      patternFeatures.luckySix * patternWeight +
      (cardModel.available ? cardModel.probabilities.luckySix * cardWeight : 0)
  };

  return {
    tableCode,
    sequence,
    sequenceText: sequence.join(""),
    usableRounds: sourceRounds.length,
    usableTableRounds: tableRounds.length,
    sampleSize: counts.total,
    tableSampleSize: primaryMatches.length,
    globalSampleSize: globalMatches.length,
    rawPick: choosePick(blendedOutcome),
    pick: chooseCommercialPick(blendedOutcome),
    probabilities: {
      BANKER: blendedOutcome.BANKER,
      PLAYER: blendedOutcome.PLAYER,
      TIE: blendedOutcome.TIE,
      bankerPair: blendedFeatures.bankerPair,
      playerPair: blendedFeatures.playerPair,
      luckySix: blendedFeatures.luckySix
    },
    percentages: {
      BANKER: pct(blendedOutcome.BANKER),
      PLAYER: pct(blendedOutcome.PLAYER),
      TIE: pct(blendedOutcome.TIE),
      bankerPair: pct(blendedFeatures.bankerPair),
      playerPair: pct(blendedFeatures.playerPair),
      luckySix: pct(blendedFeatures.luckySix)
    },
    baselinePercentages: {
      BANKER: pct(baselineOutcome.BANKER),
      PLAYER: pct(baselineOutcome.PLAYER),
      TIE: pct(baselineOutcome.TIE),
      bankerPair: pct(baseline.bankerPair),
      playerPair: pct(baseline.playerPair),
      luckySix: pct(baseline.luckySix)
    },
    historicalPercentages: {
      BANKER: pct(patternOutcome.BANKER),
      PLAYER: pct(patternOutcome.PLAYER),
      TIE: pct(patternOutcome.TIE),
      bankerPair: pct(patternFeatures.bankerPair),
      playerPair: pct(patternFeatures.playerPair),
      luckySix: pct(patternFeatures.luckySix)
    },
    cardModel,
    modelWeights: {
      baseline: Math.round(baselineWeight * 1000) / 1000,
      pattern: Math.round(patternWeight * 1000) / 1000,
      cardShoe: Math.round(cardWeight * 1000) / 1000,
      playerPickThreshold: 0.07
    },
    counts,
    confidence: counts.total >= 100 ? "HIGH" : counts.total >= 30 ? "MEDIUM" : "LOW",
    note: "Percentages blend historical pattern statistics with recorded 8-deck shoe cards when available. Baccarat remains random and results are not guaranteed."
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
  isPredictionUsable,
  predictionPool,
  normalizeSequence,
  sequenceOf,
  predictFromSequence,
  estimateCardModel,
  summarizeTable,
  summarizeAll
};
