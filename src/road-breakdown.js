"use strict";

const { normalizeRound, buildRoads } = require("./roads");

const SIDE_RESULTS = new Set(["banker", "player"]);
const RESULT_LABELS = {
  banker: "莊",
  player: "閒",
  tie: "和",
  neutral: "觀察"
};
const COLOR_LABELS = {
  red: "紅",
  blue: "藍",
  none: "-"
};
const COLOR_MEANING = {
  red: "整齊",
  blue: "轉折",
  none: "未出"
};
const ROAD_DEFINITIONS = [
  { key: "bead", label: "珠盤路" },
  { key: "bigRoad", label: "大路" },
  { key: "bigEyeRoad", label: "大眼仔", derived: true },
  { key: "smallRoad", label: "小路", derived: true },
  { key: "cockroachRoad", label: "蟑螂路", derived: true }
];
const DERIVED_ROADS = ROAD_DEFINITIONS.filter((road) => road.derived);

function buildRoadBreakdownAnalysis({ inputRounds = [], source = {}, resultRates = [] } = {}) {
  const input = inputRounds.map((round) => normalizeRound(round)).filter(Boolean);
  const roads = buildRoads(input);
  const askRoad = buildAskRoad(input);
  const roadItems = [
    analyzeBead(input, source, resultRates),
    analyzeBigRoad(input, roads.bigRoad),
    ...DERIVED_ROADS.map((definition) => analyzeDerivedRoad(definition, roads[definition.key], askRoad))
  ];

  return {
    ok: true,
    inputLength: input.length,
    askRoad,
    roads: roadItems,
    overall: summarizeOverall(roadItems)
  };
}

function analyzeBead(rounds, source, resultRates) {
  const counts = countResults(rounds);
  const total = Math.max(rounds.length, 1);
  const topRate = [...(resultRates || [])].sort((left, right) => Number(right.rate || 0) - Number(left.rate || 0))[0];
  const fallbackSide = counts.banker >= counts.player ? "banker" : "player";
  const prediction = normalizePrediction({
    result: topRate?.result || fallbackSide,
    rate: topRate?.rate || rate(Math.max(counts.banker, counts.player), Math.max(counts.banker + counts.player, 1)),
    basis: source?.total ? `歷史下一手樣本 ${source.total} 筆` : "輸入珠盤比例"
  });
  const nonTie = rounds.filter((round) => SIDE_RESULTS.has(round.result));
  const current = currentStreak(nonTie);

  return {
    key: "bead",
    label: "珠盤路",
    prediction,
    trends: [
      trend("莊比例", rate(counts.banker, total), `${counts.banker}/${rounds.length}`),
      trend("閒比例", rate(counts.player, total), `${counts.player}/${rounds.length}`),
      trend("和比例", rate(counts.tie, total), `${counts.tie}/${rounds.length}`),
      trend("目前連段", current.rate, current.side ? `${RESULT_LABELS[current.side]} ${current.length} 連` : "無")
    ],
    read: `珠盤路以輸入順序看比例；目前預測偏${prediction.label}。`
  };
}

function analyzeBigRoad(rounds, bigRoad) {
  const nonTie = rounds.filter((round) => SIDE_RESULTS.has(round.result));
  const counts = countResults(nonTie);
  const current = currentStreak(nonTie);
  const alternationRate = calcAlternationRate(nonTie);
  const heights = [...(bigRoad?.columnHeights || new Map()).entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, height]) => height)
    .slice(-6);

  let result = "neutral";
  let predictionRate = 0.5;
  let basis = "大路暫無強方向";
  if (nonTie.length) {
    const last = nonTie.at(-1).result;
    if (alternationRate >= 0.62) {
      result = oppositeSide(last);
      predictionRate = clamp(0.52 + (alternationRate - 0.5) * 0.72, 0.52, 0.84);
      basis = `跳路比例 ${formatPercent(alternationRate)}`;
    } else if (current.length >= 2) {
      result = current.side;
      predictionRate = clamp(0.54 + current.length * 0.055, 0.54, 0.84);
      basis = `${RESULT_LABELS[current.side]} ${current.length} 連`;
    } else if (counts.banker !== counts.player) {
      result = counts.banker > counts.player ? "banker" : "player";
      predictionRate = clamp(rate(Math.max(counts.banker, counts.player), counts.banker + counts.player), 0.5, 0.78);
      basis = "大路莊閒比例";
    }
  }

  return {
    key: "bigRoad",
    label: "大路",
    prediction: normalizePrediction({ result, rate: predictionRate, basis }),
    trends: [
      trend("跳路比例", alternationRate, `${countAlternations(nonTie)} 次轉向`),
      trend("連段強度", current.rate, current.side ? `${RESULT_LABELS[current.side]} ${current.length} 連` : "無"),
      trend("大路欄高規律", scoreHeights(heights), heights.length ? heights.join("-") : "-"),
      trend("莊閒偏向", rate(Math.max(counts.banker, counts.player), Math.max(counts.banker + counts.player, 1)), `${counts.banker}/${counts.player}`)
    ],
    read: `大路以連段、跳路與欄高判斷；目前依 ${basis}。`
  };
}

function analyzeDerivedRoad(definition, road, askRoad) {
  const points = Array.isArray(road?.points) ? road.points : [];
  const recent = points.slice(-18);
  const red = recent.filter((point) => point.color === "red").length;
  const blue = recent.filter((point) => point.color === "blue").length;
  const total = red + blue;
  const lastColor = recent.at(-1)?.color || "";
  const colorStreak = lastColor ? countTail(recent.map((point) => point.color), lastColor) : 0;
  const dominantColor = total
    ? red === blue
      ? lastColor || "red"
      : red > blue ? "red" : "blue"
    : "";
  const dominantRate = total ? rate(Math.max(red, blue), total) : 0.5;
  const bankerAsk = askRoad.banker[definition.key];
  const playerAsk = askRoad.player[definition.key];
  const bankerScore = scoreAskColor(bankerAsk?.color, dominantColor, dominantRate, lastColor, colorStreak);
  const playerScore = scoreAskColor(playerAsk?.color, dominantColor, dominantRate, lastColor, colorStreak);
  const result = bankerScore === playerScore
    ? "neutral"
    : bankerScore > playerScore ? "banker" : "player";
  const predictionRate = result === "neutral" ? 0.5 : Math.max(bankerScore, playerScore);

  return {
    key: definition.key,
    label: definition.label,
    prediction: normalizePrediction({
      result,
      rate: predictionRate,
      basis: `莊問路 ${formatAsk(bankerAsk)} / 閒問路 ${formatAsk(playerAsk)}`
    }),
    ask: {
      banker: bankerAsk,
      player: playerAsk
    },
    trends: [
      trend("紅路比例", rate(red, Math.max(total, 1)), `${red}/${total}`),
      trend("藍路比例", rate(blue, Math.max(total, 1)), `${blue}/${total}`),
      trend("目前色連", total ? clamp(0.5 + colorStreak * 0.06, 0.5, 0.86) : 0.5, lastColor ? `${COLOR_LABELS[lastColor]} ${colorStreak} 連` : "未成路"),
      trend("問路吻合", predictionRate, `偏${RESULT_LABELS[result] || "觀察"}`)
    ],
    read: `${definition.label} 以問路顏色對照近期${COLOR_LABELS[dominantColor] || "-"}路；目前預測偏${RESULT_LABELS[result] || "觀察"}。`
  };
}

function buildAskRoad(inputRounds) {
  return {
    banker: buildAskForSide(inputRounds, "banker"),
    player: buildAskForSide(inputRounds, "player")
  };
}

function buildAskForSide(inputRounds, side) {
  const appendedIndex = inputRounds.length;
  const simulated = buildRoads([...inputRounds, { result: side }]);
  return Object.fromEntries(DERIVED_ROADS.map((definition) => {
    const point = lastPointForRound(simulated[definition.key]?.points || [], appendedIndex);
    const color = point?.color || "none";
    return [definition.key, {
      roadKey: definition.key,
      roadLabel: definition.label,
      side,
      sideLabel: RESULT_LABELS[side],
      color,
      colorLabel: COLOR_LABELS[color] || "-",
      meaning: COLOR_MEANING[color] || "未出"
    }];
  }));
}

function summarizeOverall(roads) {
  const eligible = roads.filter((road) => ["banker", "player"].includes(road.prediction?.result));
  const highest = [...eligible].sort((left, right) => Number(right.prediction.rate || 0) - Number(left.prediction.rate || 0))[0] || null;
  const votes = { banker: 0, player: 0 };
  for (const road of eligible) {
    const weight = clamp(Number(road.prediction.rate || 0) - 0.5, 0, 0.5) + 0.01;
    votes[road.prediction.result] += weight;
  }
  const totalVotes = votes.banker + votes.player;
  const consensusResult = !totalVotes
    ? "neutral"
    : votes.banker >= votes.player ? "banker" : "player";
  const consensusRate = totalVotes
    ? clamp(Math.max(votes.banker, votes.player) / totalVotes, 0.5, 0.92)
    : 0.5;

  return {
    highest: highest ? {
      roadKey: highest.key,
      roadLabel: highest.label,
      result: highest.prediction.result,
      label: highest.prediction.label,
      rate: highest.prediction.rate,
      basis: highest.prediction.basis
    } : null,
    consensus: {
      result: consensusResult,
      label: RESULT_LABELS[consensusResult] || "觀察",
      rate: round(consensusRate, 4),
      votes: {
        banker: round(votes.banker, 4),
        player: round(votes.player, 4)
      },
      read: highest
        ? `最高百分比：${highest.label} ${highest.prediction.label} ${formatPercent(highest.prediction.rate)}。`
        : "目前各路未形成可用方向。"
    }
  };
}

function normalizePrediction({ result, rate: value, basis }) {
  const safeResult = ["banker", "player", "tie", "neutral"].includes(result) ? result : "neutral";
  return {
    result: safeResult,
    label: RESULT_LABELS[safeResult] || "觀察",
    rate: round(clamp(Number(value || 0), 0, 0.95), 4),
    percent: formatPercent(value),
    basis: basis || ""
  };
}

function trend(label, value, detail) {
  return {
    label,
    rate: round(clamp(Number(value || 0), 0, 1), 4),
    percent: formatPercent(value),
    detail: detail || ""
  };
}

function countResults(rounds) {
  const counts = { banker: 0, player: 0, tie: 0 };
  for (const round of rounds) {
    if (counts[round.result] !== undefined) counts[round.result] += 1;
  }
  return counts;
}

function currentStreak(rounds) {
  const last = rounds.at(-1);
  if (!last) return { side: "", length: 0, rate: 0 };
  let length = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (rounds[index].result !== last.result) break;
    length += 1;
  }
  return {
    side: last.result,
    length,
    rate: clamp(length / Math.max(rounds.length, 1), 0, 1)
  };
}

function calcAlternationRate(rounds) {
  if (rounds.length < 2) return 0;
  return rate(countAlternations(rounds), rounds.length - 1);
}

function countAlternations(rounds) {
  let changes = 0;
  for (let index = 1; index < rounds.length; index += 1) {
    if (rounds[index].result !== rounds[index - 1].result) changes += 1;
  }
  return changes;
}

function scoreHeights(heights) {
  if (!heights.length) return 0;
  if (heights.length < 3) return 0.5;
  const stable = heights.filter((height, index) => index === 0 || Math.abs(height - heights[index - 1]) <= 1).length;
  return rate(stable, heights.length);
}

function scoreAskColor(color, dominantColor, dominantRate, lastColor, streak) {
  if (!color || color === "none" || !dominantColor) return 0.5;
  let score = 0.5;
  if (color === dominantColor) score += (dominantRate - 0.5) * 0.78 + 0.08;
  if (lastColor && color === lastColor) score += Math.min(0.14, streak * 0.025);
  if (color !== dominantColor) score -= 0.04;
  return round(clamp(score, 0.42, 0.86), 4);
}

function lastPointForRound(points, roundIndex) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].roundIndex === roundIndex) return points[index];
  }
  return null;
}

function oppositeSide(side) {
  return side === "banker" ? "player" : "banker";
}

function countTail(values, target) {
  let count = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== target) break;
    count += 1;
  }
  return count;
}

function formatAsk(item) {
  if (!item || item.color === "none") return "-";
  return `${item.colorLabel}/${item.meaning}`;
}

function rate(value, total) {
  return total ? Number(value || 0) / total : 0;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

module.exports = {
  buildRoadBreakdownAnalysis
};
