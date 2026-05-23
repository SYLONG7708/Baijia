const OUTCOME_BY_CODE = {
  "0": "TIE",
  "1": "BANKER",
  "2": "PLAYER",
  "3": "TIE",
  "4": "TIE",
  "5": "BANKER",
  "6": "PLAYER"
};

function cardPointFromRank(rank) {
  const value = Number(rank);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value === 1) return 1;
  if (value >= 10) return 0;
  return value;
}

function parseAllbetCard(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw || raw === "-1" || raw === "-2") return null;
  const match = raw.match(/^([1-4])([0-9]{2})$/);
  if (!match) return null;
  const rank = Number(match[2]);
  if (!Number.isInteger(rank) || rank < 1 || rank > 13) return null;
  return {
    raw,
    suit: match[1],
    rank,
    point: cardPointFromRank(rank)
  };
}

function normalizeCardList(cards) {
  if (!Array.isArray(cards)) return [];
  return cards
    .map((card) => {
      if (card && typeof card === "object" && card.raw && card.rank !== undefined) {
        return {
          raw: String(card.raw),
          suit: String(card.suit || String(card.raw)[0] || ""),
          rank: Number(card.rank),
          point: card.point === undefined ? cardPointFromRank(card.rank) : Number(card.point)
        };
      }
      return parseAllbetCard(card);
    })
    .filter(Boolean);
}

function parseAllbetCardMatrix(matrix) {
  if (!Array.isArray(matrix)) return null;
  const bankerCards = normalizeCardList(Array.isArray(matrix[0]) ? matrix[0] : []);
  const playerCards = normalizeCardList(Array.isArray(matrix[1]) ? matrix[1] : []);
  if (!bankerCards.length && !playerCards.length) return null;
  return {
    bankerCards,
    playerCards,
    bankerCardPoints: bankerCards.map((card) => card.point),
    playerCardPoints: playerCards.map((card) => card.point),
    bankerCardRanks: bankerCards.map((card) => card.rank),
    playerCardRanks: playerCards.map((card) => card.rank),
    bankerCardsRaw: bankerCards.map((card) => card.raw),
    playerCardsRaw: playerCards.map((card) => card.raw),
    cardCount: bankerCards.length + playerCards.length
  };
}

function normalizeOutcome(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (["B", "BANKER", "莊", "庄"].includes(raw)) return "BANKER";
  if (["P", "PLAYER", "閒", "闲"].includes(raw)) return "PLAYER";
  if (["T", "TIE", "和"].includes(raw)) return "TIE";
  return null;
}

function outcomeShort(outcome) {
  return { BANKER: "B", PLAYER: "P", TIE: "T" }[normalizeOutcome(outcome)] || "";
}

function looksLikeBaccaratResult(value) {
  if (typeof value !== "string") return false;
  const raw = value.trim().toUpperCase();
  if (raw.length < 5 || raw.length > 24) return false;
  return /^[0-6][0-9A-D][0-9A-D][0-6][0-9A-D]/.test(raw);
}

function parseBaccaratResult(value, context = {}) {
  if (!looksLikeBaccaratResult(value)) return null;
  const raw = value.trim().toUpperCase();
  const winnerCode = raw[0];
  const pairCode = raw[3] || "0";
  const sideBetCode = raw[4] || "0";
  const colorAnySixCode = raw[6] || "0";
  const outcome = OUTCOME_BY_CODE[winnerCode];
  if (!outcome) return null;

  const bankerPair = ["1", "3", "4", "6"].includes(pairCode);
  const playerPair = ["2", "3", "5", "6"].includes(pairCode);
  const luckySix = ["1", "2", "3", "4"].includes(sideBetCode);
  const allWinSide = [outcome.toLowerCase()];
  if (bankerPair) allWinSide.push("bankerpair");
  if (playerPair) allWinSide.push("playerpair");
  if (luckySix) allWinSide.push("lucky6");
  if (["9", "A", "B", "C", "D", "E", "F", "G", "H"].includes(colorAnySixCode)) {
    allWinSide.push("any_6");
  }

  return {
    rawResult: raw,
    outcome,
    outcomeShort: outcomeShort(outcome),
    bankerPoint: raw[1] || "",
    playerPoint: raw[2] || "",
    bankerPair,
    playerPair,
    luckySix,
    allWinSide,
    tableCode: context.tableCode || "",
    shoeId: context.shoeId || "",
    gameRoundId: context.gameRoundId || "",
    roundNo: context.roundNo || 0
  };
}

module.exports = {
  looksLikeBaccaratResult,
  normalizeOutcome,
  outcomeShort,
  parseBaccaratResult,
  parseAllbetCard,
  parseAllbetCardMatrix,
  normalizeCardList,
  cardPointFromRank
};
