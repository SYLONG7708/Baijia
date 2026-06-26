"use strict";

const { normalizeRound } = require("./roads");

const DIRECTIONAL_RESULTS = new Set(["banker", "player"]);
const RESULT_LABELS = {
  banker: "莊",
  player: "閒",
  tie: "和",
  neutral: "中性"
};
const ELEMENT_LABELS = {
  wood: "木",
  fire: "火",
  earth: "土",
  metal: "金",
  water: "水"
};
const TRIGRAMS = {
  "111": "乾",
  "000": "坤",
  "010": "坎",
  "101": "離",
  "001": "震",
  "110": "巽",
  "100": "艮",
  "011": "兌"
};

function buildAdvancedAnalysis({ inputRounds = [], allRounds = [], source = {}, resultRates = [] } = {}) {
  const input = inputRounds.map((round) => normalizeRound(round)).filter(Boolean);
  const historical = allRounds.map(preserveMetadataRound).filter(Boolean);
  const directionalInput = input.filter(isDirectional);
  const frontBack = calcFrontBack(input);
  const leftRight = calcLeftRightBias(input);
  const crossTable = calcCrossTable(directionalInput, historical);
  const fiveElements = calcFiveElements(input, source, resultRates);
  const bagua = calcBagua(directionalInput);
  const synthesis = buildSynthesis({
    resultRates,
    leftRight,
    frontBack,
    crossTable,
    fiveElements,
    bagua,
    directionalInput,
    source
  });

  return {
    ok: true,
    inputLength: input.length,
    directionalHands: directionalInput.length,
    frontBack,
    leftRight,
    crossTable,
    fiveElements,
    bagua,
    synthesis,
    notes: [
      "五行八卦只作象徵權重，不能視為保證結果。",
      "若桌台洗牌中、暫停或資料不足，該桌應跳過，不納入強判斷。"
    ]
  };
}

function preserveMetadataRound(round) {
  const normalized = normalizeRound(round);
  if (!normalized) return null;
  return {
    ...normalized,
    tableCode: normalizeTableCode(round?.tableCode || round?.deskNo || round?.tableName || round?.name || ""),
    tableName: String(round?.tableName || round?.name || round?.roomId || ""),
    provider: String(round?.provider || "")
  };
}

function calcFrontBack(rounds) {
  const midpoint = Math.floor(rounds.length / 2);
  const front = countResults(rounds.slice(0, midpoint));
  const back = countResults(rounds.slice(midpoint));
  const frontBias = bias(front);
  const backBias = bias(back);
  const shift = round(backBias - frontBias, 4);
  const label = shift > 0.18 ? "後段轉莊" : shift < -0.18 ? "後段轉閒" : "前後接近";

  return {
    label,
    frontHands: front.total,
    backHands: back.total,
    frontBias,
    backBias,
    shift,
    read: `${label}，偏移值 ${formatSigned(shift)}。`
  };
}

function calcLeftRightBias(rounds) {
  const counts = countResults(rounds);
  const directionalTotal = counts.banker + counts.player;
  const bankerRate = rate(counts.banker, directionalTotal);
  const playerRate = rate(counts.player, directionalTotal);
  const tieRate = rate(counts.tie, rounds.length);
  const biasValue = round(bankerRate - playerRate, 4);
  const label = biasValue > 0.16 ? "莊側偏強" : biasValue < -0.16 ? "閒側偏強" : "莊閒接近";

  return {
    label,
    banker: counts.banker,
    player: counts.player,
    tie: counts.tie,
    bankerRate,
    playerRate,
    tieRate,
    bias: biasValue,
    read: `${label}，莊閒差 ${formatSigned(biasValue)}。`
  };
}

function calcCrossTable(input, rounds) {
  const inputSeq = input.map(resultChar);
  if (inputSeq.length < 4) {
    return {
      comparedTables: 0,
      sampleTables: 0,
      sameDirection: [],
      oppositeDirection: [],
      read: "有效莊閒手數少於 4，跨桌同向/反向暫不判斷。"
    };
  }

  const groups = groupRoundsByTable(rounds);
  const comparisons = [];
  for (const group of groups) {
    const sequence = group.rounds.filter(isDirectional).map(resultChar);
    const compared = Math.min(inputSeq.length, sequence.length);
    if (compared < 4) continue;
    const left = inputSeq.slice(-compared);
    const right = sequence.slice(-compared);
    let same = 0;
    for (let index = 0; index < compared; index += 1) {
      if (left[index] === right[index]) same += 1;
    }
    const sameRate = rate(same, compared);
    comparisons.push({
      tableId: group.tableId,
      tableCode: group.tableCode || group.tableId,
      tableName: group.tableName || "",
      compared,
      sameRate,
      oppositeRate: round(1 - sameRate, 4),
      latestAt: group.latestAt
    });
  }

  const sameDirection = [...comparisons]
    .sort((left, right) => right.sameRate - left.sameRate || right.compared - left.compared)
    .slice(0, 6);
  const oppositeDirection = [...comparisons]
    .sort((left, right) => right.oppositeRate - left.oppositeRate || right.compared - left.compared)
    .slice(0, 6);
  const bestSame = sameDirection[0];
  const bestOpposite = oppositeDirection[0];
  const read = bestSame || bestOpposite
    ? `同向最高 ${formatTableMatch(bestSame, "same")}；反向最高 ${formatTableMatch(bestOpposite, "opposite")}。`
    : "尚未找到可比對的跨桌樣本。";

  return {
    comparedTables: comparisons.length,
    sampleTables: groups.length,
    sameDirection,
    oppositeDirection,
    read
  };
}

function calcFiveElements(rounds, source = {}, resultRates = []) {
  const scores = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  let lastDirectional = "";
  for (const roundItem of rounds) {
    if (roundItem.result === "banker") scores.fire += 1;
    if (roundItem.result === "player") scores.water += 1;
    if (roundItem.result === "tie") scores.earth += 1.4;
    if (isDirectional(roundItem)) {
      if (lastDirectional && lastDirectional !== roundItem.result) scores.wood += 0.55;
      if (lastDirectional && lastDirectional === roundItem.result) scores.metal += 0.35;
      lastDirectional = roundItem.result;
    }
  }

  const rateMap = new Map((resultRates || []).map((item) => [item.result || item.key, Number(item.rate || 0)]));
  scores.fire += (rateMap.get("banker") || 0) * 1.2;
  scores.water += (rateMap.get("player") || 0) * 1.2;
  scores.earth += (rateMap.get("tie") || 0) * 1.5;
  const totalSamples = Math.max(Number(source.total || 0), 1);
  scores.wood += rate(Number(source.bankerPair || 0) + Number(source.playerPair || 0), totalSamples) * 1.1;
  scores.metal += rate(Number(source.luckySix || 0), totalSamples) * 1.2;

  const roundedScores = Object.fromEntries(
    Object.entries(scores).map(([key, value]) => [key, round(value, 2)])
  );
  const total = Object.values(roundedScores).reduce((sum, value) => sum + value, 0) || 1;
  const weights = Object.fromEntries(
    Object.entries(roundedScores).map(([key, value]) => [key, round(value / total, 4)])
  );
  const dominant = Object.entries(roundedScores).sort((left, right) => right[1] - left[1])[0]?.[0] || "earth";

  return {
    scores: roundedScores,
    weights,
    dominant,
    dominantLabel: ELEMENT_LABELS[dominant] || dominant,
    read: elementRead(dominant)
  };
}

function calcBagua(input) {
  const bits = input.slice(-6).map((roundItem) => (roundItem.result === "banker" ? "1" : "0"));
  while (bits.length < 6) bits.unshift("0");
  const lowerBits = bits.slice(0, 3).join("");
  const upperBits = bits.slice(3).join("");
  const yang = bits.filter((bit) => bit === "1").length;
  const yin = bits.length - yang;
  const lean = yang >= 4 ? "banker" : yang <= 2 ? "player" : "neutral";

  return {
    bits: bits.join(""),
    upper: { bits: upperBits, name: TRIGRAMS[upperBits] || "坤" },
    lower: { bits: lowerBits, name: TRIGRAMS[lowerBits] || "坤" },
    hexagram: `${TRIGRAMS[upperBits] || "坤"}上${TRIGRAMS[lowerBits] || "坤"}下`,
    yang,
    yin,
    lean,
    leanLabel: RESULT_LABELS[lean] || RESULT_LABELS.neutral,
    read: lean === "banker"
      ? "陽爻偏多，象徵莊側權重較高。"
      : lean === "player"
        ? "陰爻偏多，象徵閒側權重較高。"
        : "陰陽接近，象徵權重偏中性。"
  };
}

function buildSynthesis({ resultRates, leftRight, frontBack, crossTable, fiveElements, bagua, directionalInput, source }) {
  const rates = new Map((resultRates || []).map((item) => [item.result || item.key, Number(item.rate || 0)]));
  const lastSide = directionalInput.at(-1)?.result || "";
  const lastSign = lastSide === "banker" ? 1 : lastSide === "player" ? -1 : 0;
  const baseScore = (rates.get("banker") || 0) - (rates.get("player") || 0);
  const crossScore = calcCrossScore(crossTable, lastSign);
  const elementScore = fiveElements.dominant === "fire"
    ? 0.12
    : fiveElements.dominant === "water"
      ? -0.12
      : fiveElements.dominant === "metal"
        ? lastSign * 0.06
        : fiveElements.dominant === "wood"
          ? -lastSign * 0.05
          : 0;
  const baguaScore = bagua.lean === "banker" ? 0.09 : bagua.lean === "player" ? -0.09 : 0;
  const score = clamp(
    baseScore * 0.42
      + Number(leftRight.bias || 0) * 0.22
      + Number(frontBack.shift || 0) * 0.14
      + crossScore * 0.12
      + elementScore * 0.06
      + baguaScore * 0.04,
    -1,
    1
  );
  const direction = score > 0.07 ? "banker" : score < -0.07 ? "player" : "neutral";
  const sourceBonus = Math.min(0.18, Number(source?.total || 0) / 160);
  const crossBonus = Math.min(0.12, Number(crossTable?.comparedTables || 0) / 120);
  const confidence = round(clamp(0.26 + Math.abs(score) * 0.72 + sourceBonus + crossBonus, 0.05, 0.82), 4);

  return {
    direction,
    label: direction === "banker" ? "綜合偏莊" : direction === "player" ? "綜合偏閒" : "綜合中性",
    score: round(score, 4),
    confidence,
    components: {
      historicalRate: round(baseScore, 4),
      leftRight: Number(leftRight.bias || 0),
      frontBack: Number(frontBack.shift || 0),
      crossTable: round(crossScore, 4),
      fiveElements: round(elementScore, 4),
      bagua: round(baguaScore, 4)
    },
    read: direction === "neutral"
      ? "綜合權重未形成強方向，下一手先視為觀察點。"
      : `綜合權重偏向${RESULT_LABELS[direction]}，仍需以下一手實際結果校正。`
  };
}

function calcCrossScore(crossTable, lastSign) {
  if (!lastSign) return 0;
  const same = crossTable?.sameDirection?.[0];
  const opposite = crossTable?.oppositeDirection?.[0];
  const sameEdge = same ? Number(same.sameRate || 0) - 0.5 : 0;
  const oppositeEdge = opposite ? Number(opposite.oppositeRate || 0) - 0.5 : 0;
  if (sameEdge <= 0 && oppositeEdge <= 0) return 0;
  return sameEdge >= oppositeEdge ? sameEdge * lastSign : oppositeEdge * -lastSign;
}

function groupRoundsByTable(rounds) {
  const groups = new Map();
  for (const roundItem of rounds) {
    if (!isDirectional(roundItem)) continue;
    const code = normalizeTableCode(roundItem.tableCode);
    if (!code) continue;
    const key = code;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        tableId: roundItem.tableId || key,
        tableCode: code || key,
        tableName: roundItem.tableName || "",
        latestAt: "",
        rounds: []
      });
    }
    const group = groups.get(key);
    group.rounds.push(roundItem);
    const at = roundItem.observedAt || roundItem.createdAt || "";
    if (at && (!group.latestAt || Date.parse(at) > Date.parse(group.latestAt))) group.latestAt = at;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    rounds: group.rounds.sort(compareRounds)
  }));
}

function countResults(rounds) {
  const counts = { banker: 0, player: 0, tie: 0, total: 0 };
  for (const roundItem of rounds) {
    if (roundItem.result === "banker") counts.banker += 1;
    if (roundItem.result === "player") counts.player += 1;
    if (roundItem.result === "tie") counts.tie += 1;
    if (roundItem.result === "banker" || roundItem.result === "player" || roundItem.result === "tie") counts.total += 1;
  }
  return counts;
}

function bias(counts) {
  const total = counts.banker + counts.player;
  return total ? round((counts.banker - counts.player) / total, 4) : 0;
}

function rate(value, total) {
  return total ? round(Number(value || 0) / total, 4) : 0;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function isDirectional(roundItem) {
  return DIRECTIONAL_RESULTS.has(roundItem?.result);
}

function resultChar(roundItem) {
  return roundItem.result === "banker" ? "B" : "P";
}

function compareRounds(a, b) {
  const timeA = Date.parse(a.observedAt || a.createdAt || "");
  const timeB = Date.parse(b.observedAt || b.createdAt || "");
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
  const handA = Number(a.handNumber || 0);
  const handB = Number(b.handNumber || 0);
  if (a.tableId === b.tableId && handA !== handB) return handA - handB;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function normalizeTableCode(value) {
  return String(value || "").toUpperCase().match(/\b(?:IB\d{3}|[BQCV]\d{3})\b/)?.[0] || "";
}

function formatSigned(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(3)}`;
}

function formatTableMatch(item, mode) {
  if (!item) return "-";
  const rateValue = mode === "opposite" ? item.oppositeRate : item.sameRate;
  return `${item.tableCode} ${Math.round(rateValue * 100)}%`;
}

function elementRead(value) {
  return {
    wood: "木旺：轉折、分岔與反向訊號權重較高。",
    fire: "火旺：莊側延伸訊號權重較高。",
    earth: "土旺：和局、停頓與不明確訊號權重較高。",
    metal: "金旺：連續、特殊點與收斂訊號權重較高。",
    water: "水旺：閒側延伸訊號權重較高。"
  }[value] || "五行權重中性。";
}

module.exports = {
  buildAdvancedAnalysis
};
