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
  { key: "bead", label: "珠盤路", direct: true },
  { key: "bigRoad", label: "大路", direct: true },
  { key: "bigEyeRoad", label: "大眼仔", derived: true },
  { key: "smallRoad", label: "小路", derived: true },
  { key: "cockroachRoad", label: "蟑螂路", derived: true }
];
const DERIVED_ROADS = ROAD_DEFINITIONS.filter((road) => road.derived);

function buildRoadBreakdownAnalysis({ inputRounds = [], allRounds = [], source = {}, resultRates = [] } = {}) {
  const input = inputRounds.map((round) => normalizeRound(round)).filter(Boolean);
  const historical = groupHistories(allRounds.map(normalizeBreakdownRound).filter(Boolean));
  const roads = buildRoads(input);
  const askRoad = buildAskRoad(input);
  const cycleContext = { inputRounds: input, histories: historical, askRoad };
  const roadItems = [
    analyzeBead(input, source, resultRates, cycleContext),
    analyzeBigRoad(input, roads.bigRoad, cycleContext),
    ...DERIVED_ROADS.map((definition) => analyzeDerivedRoad(definition, roads[definition.key], askRoad, cycleContext))
  ];

  return {
    ok: true,
    inputLength: input.length,
    historicalGroups: historical.length,
    askRoad,
    roads: roadItems,
    overall: summarizeOverall(roadItems),
    records: buildRecords(roadItems)
  };
}

function analyzeBead(rounds, source, resultRates, cycleContext) {
  const counts = countResults(rounds);
  const total = Math.max(rounds.length, 1);
  const topRate = [...(resultRates || [])].sort((left, right) => Number(right.rate || 0) - Number(left.rate || 0))[0];
  const fallbackSide = counts.banker >= counts.player ? "banker" : "player";
  const basePrediction = normalizePrediction({
    result: topRate?.result || fallbackSide,
    rate: topRate?.rate || rate(Math.max(counts.banker, counts.player), Math.max(counts.banker + counts.player, 1)),
    basis: source?.total ? `歷史下一手樣本 ${source.total} 筆` : "輸入珠盤比例"
  });
  const cycle = buildSixColumnCyclePrediction(ROAD_DEFINITIONS[0], cycleContext);
  const prediction = mergePredictions(basePrediction, cycle);
  const nonTie = rounds.filter((round) => SIDE_RESULTS.has(round.result));
  const current = currentStreak(nonTie);

  return {
    key: "bead",
    label: "珠盤路",
    prediction,
    cycle,
    trends: [
      trend("莊比例", rate(counts.banker, total), `${counts.banker}/${rounds.length}`),
      trend("閒比例", rate(counts.player, total), `${counts.player}/${rounds.length}`),
      trend("和比例", rate(counts.tie, total), `${counts.tie}/${rounds.length}`),
      trend("目前連段", current.rate, current.side ? `${RESULT_LABELS[current.side]} ${current.length} 連` : "無"),
      trend("6欄循環", cycle.rate, cycle.read)
    ],
    read: `珠盤路以輸入順序看比例；目前預測偏${prediction.label}。`
  };
}

function analyzeBigRoad(rounds, bigRoad, cycleContext) {
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

  const cycle = buildSixColumnCyclePrediction(ROAD_DEFINITIONS[1], cycleContext);
  const prediction = mergePredictions(normalizePrediction({ result, rate: predictionRate, basis }), cycle);

  return {
    key: "bigRoad",
    label: "大路",
    prediction,
    cycle,
    trends: [
      trend("跳路比例", alternationRate, `${countAlternations(nonTie)} 次轉向`),
      trend("連段強度", current.rate, current.side ? `${RESULT_LABELS[current.side]} ${current.length} 連` : "無"),
      trend("大路欄高規律", scoreHeights(heights), heights.length ? heights.join("-") : "-"),
      trend("莊閒偏向", rate(Math.max(counts.banker, counts.player), Math.max(counts.banker + counts.player, 1)), `${counts.banker}/${counts.player}`),
      trend("6欄循環", cycle.rate, cycle.read)
    ],
    read: `大路以連段、跳路與欄高判斷；目前依 ${basis}。`
  };
}

function analyzeDerivedRoad(definition, road, askRoad, cycleContext) {
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
  const basePrediction = normalizePrediction({
    result,
    rate: predictionRate,
    basis: `莊問路 ${formatAsk(bankerAsk)} / 閒問路 ${formatAsk(playerAsk)}`
  });
  const cycle = buildSixColumnCyclePrediction(definition, cycleContext);
  const prediction = mergePredictions(basePrediction, cycle);

  return {
    key: definition.key,
    label: definition.label,
    prediction,
    cycle,
    ask: {
      banker: bankerAsk,
      player: playerAsk
    },
    trends: [
      trend("紅路比例", rate(red, Math.max(total, 1)), `${red}/${total}`),
      trend("藍路比例", rate(blue, Math.max(total, 1)), `${blue}/${total}`),
      trend("目前色連", total ? clamp(0.5 + colorStreak * 0.06, 0.5, 0.86) : 0.5, lastColor ? `${COLOR_LABELS[lastColor]} ${colorStreak} 連` : "未成路"),
      trend("問路吻合", predictionRate, `偏${RESULT_LABELS[result] || "觀察"}`),
      trend("6欄循環", cycle.rate, cycle.read)
    ],
    read: `${definition.label} 以問路顏色對照近期${COLOR_LABELS[dominantColor] || "-"}路；目前預測偏${RESULT_LABELS[result] || "觀察"}。`
  };
}

function buildSixColumnCyclePrediction(definition, { inputRounds = [], histories = [], askRoad = {} } = {}) {
  const inputRoads = buildRoads(inputRounds);
  const currentColumns = getRoadColumns(getRoadPoints(inputRoads, definition.key), definition);
  const activeColumn = currentColumns.at(-1);
  if (!activeColumn) {
    return emptyCyclePrediction("未成路");
  }

  const tokenScores = new Map();
  const sideScores = { banker: 0, player: 0 };
  const matches = [];
  for (const history of histories) {
    const historyRoads = buildRoads(history.rounds);
    const columns = getRoadColumns(getRoadPoints(historyRoads, definition.key), definition);
    if (columns.length < 7) continue;
    const byColumn = new Map(columns.map((column) => [column.col, column]));
    for (const source of columns) {
      if (source.col % 6 !== activeColumn.col % 6) continue;
      const target = byColumn.get(source.col + 6);
      if (!target) continue;
      const similarity = scoreColumnSimilarity(activeColumn, source);
      if (similarity < 0.58) continue;
      const token = getCycleToken(target, definition);
      if (!token || token === "tie") continue;
      const weight = round(similarity, 4);
      tokenScores.set(token, (tokenScores.get(token) || 0) + weight);
      const side = mapCycleTokenToSide(token, definition, askRoad);
      if (SIDE_RESULTS.has(side)) sideScores[side] += weight;
      matches.push({
        tableCode: history.tableCode || history.tableId || "",
        sourceCol: source.col + 1,
        targetCol: target.col + 1,
        token,
        height: target.height,
        weight
      });
    }
  }

  const tokenTotal = [...tokenScores.values()].reduce((sum, value) => sum + value, 0);
  if (!tokenTotal) {
    return fallbackCyclePrediction(definition, activeColumn, askRoad);
  }

  const tokenTop = [...tokenScores.entries()].sort((left, right) => right[1] - left[1])[0];
  let result = "neutral";
  let resultRate = 0.5;
  const sideTotal = sideScores.banker + sideScores.player;
  if (sideTotal > 0) {
    result = sideScores.banker >= sideScores.player ? "banker" : "player";
    resultRate = clamp(Math.max(sideScores.banker, sideScores.player) / sideTotal, 0.5, 0.89);
  } else {
    resultRate = clamp(tokenTop[1] / tokenTotal, 0.5, 0.82);
  }

  const sampleCount = matches.length;
  const sampleBonus = clamp(sampleCount / 80, 0, 0.08);
  const rateValue = result === "neutral" ? 0.5 : clamp(resultRate + sampleBonus, 0.5, 0.9);
  const tokenLabel = definition.derived
    ? `${COLOR_LABELS[tokenTop[0]] || tokenTop[0]}路`
    : RESULT_LABELS[tokenTop[0]] || tokenTop[0];

  return {
    ok: true,
    mode: "six-column-cycle",
    slot: activeColumn.col % 6 + 1,
    sourceColumn: activeColumn.col + 1,
    result,
    label: RESULT_LABELS[result] || "觀察",
    token: tokenTop[0],
    tokenLabel,
    rate: round(rateValue, 4),
    samples: sampleCount,
    matchedWeight: round(tokenTotal, 4),
    read: sampleCount
      ? `第 ${activeColumn.col % 6 + 1} 欄對照下個 6 欄，${tokenLabel} ${formatPercent(tokenTop[1] / tokenTotal)}`
      : "6欄樣本不足",
    matches: matches
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 5)
  };
}

function mergePredictions(basePrediction, cycle) {
  const base = basePrediction || normalizePrediction({ result: "neutral", rate: 0.5, basis: "" });
  if (!cycle || !SIDE_RESULTS.has(cycle.result) || Number(cycle.samples || 0) < 3) {
    return base;
  }
  if (!SIDE_RESULTS.has(base.result)) {
    return normalizePrediction({
      result: cycle.result,
      rate: cycle.rate,
      basis: cycle.read
    });
  }
  if (base.result === cycle.result) {
    const rateValue = clamp(0.5 + (Number(base.rate || 0) - 0.5) * 0.55 + (Number(cycle.rate || 0) - 0.5) * 0.75, 0.5, 0.92);
    return normalizePrediction({
      result: base.result,
      rate: rateValue,
      basis: `${base.basis}；${cycle.read}`
    });
  }
  const baseEdge = Math.abs(Number(base.rate || 0) - 0.5);
  const cycleEdge = Math.abs(Number(cycle.rate || 0) - 0.5);
  const winner = cycleEdge > baseEdge * 0.92 ? cycle : base;
  return normalizePrediction({
    result: winner.result,
    rate: clamp(0.5 + Math.max(baseEdge, cycleEdge) * 0.86, 0.5, 0.88),
    basis: winner === cycle ? cycle.read : `${base.basis}；6欄循環相反`
  });
}

function emptyCyclePrediction(read) {
  return {
    ok: false,
    mode: "six-column-cycle",
    slot: 0,
    sourceColumn: 0,
    result: "neutral",
    label: "觀察",
    token: "",
    tokenLabel: "-",
    rate: 0.5,
    samples: 0,
    matchedWeight: 0,
    read,
    matches: []
  };
}

function fallbackCyclePrediction(definition, activeColumn, askRoad) {
  const token = getCycleToken(activeColumn, definition);
  const side = mapCycleTokenToSide(token, definition, askRoad);
  return {
    ...emptyCyclePrediction("6欄歷史樣本不足，先看目前欄位"),
    slot: activeColumn.col % 6 + 1,
    sourceColumn: activeColumn.col + 1,
    result: SIDE_RESULTS.has(side) ? side : "neutral",
    label: RESULT_LABELS[side] || "觀察",
    token,
    tokenLabel: definition.derived ? (COLOR_LABELS[token] || "-") : (RESULT_LABELS[token] || "-"),
    rate: SIDE_RESULTS.has(side) ? clamp(0.5 + Math.min(activeColumn.height, 6) * 0.025, 0.5, 0.65) : 0.5
  };
}

function getRoadPoints(roads, key) {
  if (key === "bead") return roads.bead || [];
  return roads[key]?.points || [];
}

function getRoadColumns(points, definition) {
  const groups = new Map();
  for (const point of points || []) {
    const token = getPointToken(point, definition);
    if (!token) continue;
    if (!groups.has(point.col)) groups.set(point.col, []);
    groups.get(point.col).push({ ...point, token });
  }
  return [...groups.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([col, items]) => {
      const sorted = items.sort((left, right) => left.row - right.row || left.roundIndex - right.roundIndex);
      const rowSet = new Set(sorted.map((item) => item.row));
      const tokenCounts = new Map();
      for (const item of sorted) tokenCounts.set(item.token, (tokenCounts.get(item.token) || 0) + 1);
      const dominant = [...tokenCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || sorted[0]?.token || "";
      return {
        col,
        height: sorted.length,
        rows: rowSet,
        rowSignature: sorted.map((item) => item.row).join(","),
        leadToken: sorted[0]?.token || "",
        tailToken: sorted.at(-1)?.token || "",
        dominantToken: dominant,
        points: sorted
      };
    });
}

function getPointToken(point, definition) {
  if (definition.derived) return point.color || point.result || "";
  return point.result || "";
}

function getCycleToken(column, definition) {
  if (!column) return "";
  const token = column.dominantToken || column.leadToken || "";
  if (definition.direct && !SIDE_RESULTS.has(token)) return "";
  if (definition.derived && !["red", "blue"].includes(token)) return "";
  return token;
}

function mapCycleTokenToSide(token, definition, askRoad) {
  if (definition.direct) return SIDE_RESULTS.has(token) ? token : "neutral";
  if (!["red", "blue"].includes(token)) return "neutral";
  const bankerColor = askRoad?.banker?.[definition.key]?.color || "";
  const playerColor = askRoad?.player?.[definition.key]?.color || "";
  if (bankerColor === token && playerColor !== token) return "banker";
  if (playerColor === token && bankerColor !== token) return "player";
  return "neutral";
}

function scoreColumnSimilarity(active, source) {
  let score = 0.18;
  if (active.leadToken === source.leadToken) score += 0.28;
  if (active.dominantToken === source.dominantToken) score += 0.2;
  if (active.tailToken === source.tailToken) score += 0.1;
  score += (1 - Math.min(Math.abs(active.height - source.height), 6) / 6) * 0.18;
  score += rowSimilarity(active.rows, source.rows) * 0.16;
  return clamp(score, 0, 1);
}

function rowSimilarity(leftRows, rightRows) {
  const left = leftRows || new Set();
  const right = rightRows || new Set();
  const all = new Set([...left, ...right]);
  if (!all.size) return 0;
  let same = 0;
  for (const row of all) {
    if (left.has(row) && right.has(row)) same += 1;
  }
  return same / all.size;
}

function normalizeBreakdownRound(round) {
  const normalized = normalizeRound(round);
  if (!normalized) return null;
  return {
    ...normalized,
    tableId: round?.tableId || normalized.tableId || "",
    tableCode: normalizeTableCode(round?.tableCode || round?.deskNo || round?.tableName || round?.name || ""),
    tableName: String(round?.tableName || round?.name || ""),
    provider: String(round?.provider || "")
  };
}

function groupHistories(rounds) {
  const groups = new Map();
  for (const roundItem of rounds) {
    const key = `${roundItem.tableId || roundItem.tableCode || "unknown"}::${roundItem.shoe || "shoe"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        tableId: roundItem.tableId || "",
        tableCode: roundItem.tableCode || "",
        tableName: roundItem.tableName || "",
        rounds: []
      });
    }
    groups.get(key).rounds.push(roundItem);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      rounds: group.rounds.sort(compareRounds)
    }))
    .filter((group) => group.rounds.length >= 12);
}

function buildRecords(roads) {
  return (roads || []).map((road) => ({
    roadKey: road.key,
    roadLabel: road.label,
    result: road.prediction?.result || "neutral",
    label: road.prediction?.label || "觀察",
    rate: road.prediction?.rate || 0.5,
    basis: road.prediction?.basis || "",
    cycleRate: road.cycle?.rate || 0.5,
    cycleSamples: road.cycle?.samples || 0,
    cycleRead: road.cycle?.read || "",
    topTrend: [...(road.trends || [])].sort((left, right) => Number(right.rate || 0) - Number(left.rate || 0))[0] || null
  }));
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

function compareRounds(a, b) {
  const handA = Number(a.handNumber || 0);
  const handB = Number(b.handNumber || 0);
  if ((a.tableId || a.tableCode) === (b.tableId || b.tableCode) && a.shoe === b.shoe && handA !== handB) {
    return handA - handB;
  }
  const timeA = Date.parse(a.observedAt || a.createdAt || "");
  const timeB = Date.parse(b.observedAt || b.createdAt || "");
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function normalizeTableCode(value) {
  return String(value || "").toUpperCase().match(/\b(?:IB\d{3}|[BQCV]\d{3})\b/)?.[0] || "";
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
