"use strict";

const CARD_RANKS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]);
const RANK_VALUES = Object.freeze({
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 0,
  J: 0,
  Q: 0,
  K: 0
});
const RESULT_LABELS = Object.freeze({
  banker: "莊",
  player: "閒",
  tie: "和",
  bankerPair: "莊對",
  playerPair: "閒對",
  luckySix: "幸運6"
});
const DEFAULT_DECKS = 8;
const CARDS_PER_DECK = 52;
const DEFAULT_TRIALS = clampInteger(process.env.BAIJIA_CARD_MODEL_TRIALS, 3000, 500, 20000);

function buildCardModelAnalysis(rounds = [], options = {}) {
  const decks = clampInteger(options.decks, DEFAULT_DECKS, 1, 12);
  const trials = clampInteger(options.trials, DEFAULT_TRIALS, 500, 20000);
  const shoe = buildShoe(decks);
  const normalizedRounds = rounds.map(normalizeRoundCards);
  const removal = removeObservedCards(shoe.counts, normalizedRounds);
  const remainingCards = countRemaining(shoe.counts);
  const pointsKnown = normalizedRounds.filter((round) => round.bankerCards.length || round.playerCards.length).length;
  const seed = hashSeed(JSON.stringify(normalizedRounds.map((round) => [
    round.result,
    round.bankerCards,
    round.playerCards,
    round.bankerPair,
    round.playerPair,
    round.luckySix
  ])));
  const simulation = simulateBaccarat(shoe.counts, remainingCards, trials, seed);
  const rates = buildRates(simulation, trials);
  const resultRates = rates.filter((item) => item.group === "result");
  const sideRates = rates.filter((item) => item.group === "special");
  const top = resultRates.slice().sort((a, b) => b.rate - a.rate)[0] || null;

  return {
    ok: true,
    source: "eight-deck-card-model",
    decks,
    cardsPerDeck: CARDS_PER_DECK,
    totalCards: decks * CARDS_PER_DECK,
    seenCards: removal.seenCards,
    remainingCards,
    pointsKnown,
    usable: removal.seenCards > 0,
    trials,
    rates,
    resultRates,
    sideRates,
    top,
    lastRound: summarizeLastRound(normalizedRounds),
    overdrawn: removal.overdrawn,
    remainingRanks: CARD_RANKS.map((rank, index) => ({
      rank,
      value: RANK_VALUES[rank],
      count: shoe.counts[index]
    })),
    read: removal.seenCards
      ? `已用 8 副牌扣除 ${removal.seenCards} 張已輸入牌面，估算下一手自然發牌分布。`
      : "尚未輸入牌面，點數模型暫不介入主預測。"
  };
}

function buildShoe(decks) {
  return {
    decks,
    counts: CARD_RANKS.map(() => decks * 4)
  };
}

function removeObservedCards(counts, rounds) {
  const overdrawn = [];
  let seenCards = 0;
  for (const round of rounds) {
    for (const side of ["bankerCards", "playerCards"]) {
      for (const rank of round[side]) {
        const index = CARD_RANKS.indexOf(rank);
        if (index < 0) continue;
        seenCards += 1;
        if (counts[index] > 0) {
          counts[index] -= 1;
        } else {
          overdrawn.push({ rank, side });
        }
      }
    }
  }
  return { seenCards, overdrawn };
}

function simulateBaccarat(baseCounts, remainingCards, trials, seed) {
  const counts = {
    banker: 0,
    player: 0,
    tie: 0,
    bankerPair: 0,
    playerPair: 0,
    luckySix: 0
  };
  if (remainingCards < 6) return counts;

  const random = makeRandom(seed);
  for (let trial = 0; trial < trials; trial += 1) {
    const pool = baseCounts.slice();
    let total = remainingCards;
    const bankerCards = [];
    const playerCards = [];

    bankerCards.push(drawRank(pool, total, random));
    total -= 1;
    playerCards.push(drawRank(pool, total, random));
    total -= 1;
    bankerCards.push(drawRank(pool, total, random));
    total -= 1;
    playerCards.push(drawRank(pool, total, random));
    total -= 1;

    let bankerPoint = baccaratPoints(bankerCards);
    let playerPoint = baccaratPoints(playerCards);
    let playerThirdValue = null;

    if (bankerPoint < 8 && playerPoint < 8) {
      if (playerPoint <= 5) {
        const card = drawRank(pool, total, random);
        total -= 1;
        playerCards.push(card);
        playerThirdValue = baccaratCardValue(card);
        playerPoint = baccaratPoints(playerCards);
      }

      if (shouldBankerDraw(bankerPoint, playerThirdValue)) {
        const card = drawRank(pool, total, random);
        bankerCards.push(card);
        bankerPoint = baccaratPoints(bankerCards);
      }
    }

    const result = bankerPoint > playerPoint ? "banker" : playerPoint > bankerPoint ? "player" : "tie";
    counts[result] += 1;
    if (bankerCards[0] && bankerCards[0] === bankerCards[1]) counts.bankerPair += 1;
    if (playerCards[0] && playerCards[0] === playerCards[1]) counts.playerPair += 1;
    if (result === "banker" && bankerPoint === 6) counts.luckySix += 1;
  }

  return counts;
}

function shouldBankerDraw(bankerPoint, playerThirdValue) {
  if (playerThirdValue === null) return bankerPoint <= 5;
  if (bankerPoint <= 2) return true;
  if (bankerPoint === 3) return playerThirdValue !== 8;
  if (bankerPoint === 4) return playerThirdValue >= 2 && playerThirdValue <= 7;
  if (bankerPoint === 5) return playerThirdValue >= 4 && playerThirdValue <= 7;
  if (bankerPoint === 6) return playerThirdValue === 6 || playerThirdValue === 7;
  return false;
}

function buildRates(counts, trials) {
  const denominator = Math.max(trials, 1);
  return [
    { key: "banker", result: "banker", label: RESULT_LABELS.banker, group: "result", rate: counts.banker / denominator, count: counts.banker },
    { key: "player", result: "player", label: RESULT_LABELS.player, group: "result", rate: counts.player / denominator, count: counts.player },
    { key: "tie", result: "tie", label: RESULT_LABELS.tie, group: "result", rate: counts.tie / denominator, count: counts.tie },
    { key: "bankerPair", label: RESULT_LABELS.bankerPair, group: "special", rate: counts.bankerPair / denominator, count: counts.bankerPair },
    { key: "playerPair", label: RESULT_LABELS.playerPair, group: "special", rate: counts.playerPair / denominator, count: counts.playerPair },
    { key: "luckySix", label: RESULT_LABELS.luckySix, group: "special", rate: counts.luckySix / denominator, count: counts.luckySix }
  ];
}

function normalizeRoundCards(round = {}) {
  const bankerCards = normalizeCardList(round.bankerCards);
  const playerCards = normalizeCardList(round.playerCards);
  const bankerPoints = bankerCards.length ? baccaratPoints(bankerCards) : normalizePoint(round.bankerPoints);
  const playerPoints = playerCards.length ? baccaratPoints(playerCards) : normalizePoint(round.playerPoints);
  return {
    result: round.result || "",
    bankerCards,
    playerCards,
    bankerPoints,
    playerPoints,
    bankerPair: Boolean(round.bankerPair) || isPair(bankerCards),
    playerPair: Boolean(round.playerPair) || isPair(playerCards),
    luckySix: Boolean(round.luckySix) || (round.result === "banker" && bankerPoints === 6)
  };
}

function normalizeCardList(cards) {
  const values = Array.isArray(cards)
    ? cards
    : String(cards || "")
      .split(/[\s,，、/|+-]+/)
      .filter(Boolean);
  return values.map(normalizeCardRank).filter(Boolean).slice(0, 3);
}

function normalizeCardRank(value) {
  const key = String(value || "").trim().toUpperCase();
  if (!key) return "";
  if (key === "A" || key === "ACE" || key === "01") return "1";
  if (key === "T") return "10";
  if (CARD_RANKS.includes(key)) return key;
  const number = Number(key);
  if (Number.isInteger(number) && number >= 1 && number <= 10) return String(number);
  return "";
}

function baccaratCardValue(rank) {
  return RANK_VALUES[normalizeCardRank(rank)] ?? 0;
}

function baccaratPoints(cards = []) {
  const normalized = normalizeCardList(cards);
  if (!normalized.length) return null;
  return normalized.reduce((sum, rank) => sum + baccaratCardValue(rank), 0) % 10;
}

function normalizePoint(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return ((Math.trunc(number) % 10) + 10) % 10;
}

function isPair(cards = []) {
  return cards.length >= 2 && cards[0] === cards[1];
}

function summarizeLastRound(rounds) {
  const last = rounds.slice().reverse().find((round) => round.bankerCards.length || round.playerCards.length);
  if (!last) return null;
  return {
    bankerCards: last.bankerCards,
    playerCards: last.playerCards,
    bankerPoints: last.bankerPoints,
    playerPoints: last.playerPoints,
    bankerPair: last.bankerPair,
    playerPair: last.playerPair,
    luckySix: last.luckySix
  };
}

function drawRank(pool, total, random) {
  let target = random() * total;
  for (let index = 0; index < pool.length; index += 1) {
    target -= pool[index];
    if (target < 0 && pool[index] > 0) {
      pool[index] -= 1;
      return CARD_RANKS[index];
    }
  }
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    if (pool[index] > 0) {
      pool[index] -= 1;
      return CARD_RANKS[index];
    }
  }
  return "10";
}

function makeRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function countRemaining(counts) {
  return counts.reduce((sum, count) => sum + count, 0);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

module.exports = {
  CARD_RANKS,
  normalizeCardRank,
  normalizeCardList,
  baccaratCardValue,
  baccaratPoints,
  buildCardModelAnalysis,
  normalizeRoundCards
};
