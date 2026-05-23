const OUTCOME_BY_CODE = {
  "0": "TIE",
  "1": "BANKER",
  "2": "PLAYER",
  "3": "TIE",
  "4": "TIE",
  "5": "BANKER",
  "6": "PLAYER"
};

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
  parseBaccaratResult
};
