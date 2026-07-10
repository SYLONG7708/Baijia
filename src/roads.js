"use strict";

const RESULT_LABELS = {
  banker: "莊",
  player: "閒",
  tie: "和",
  red: "紅",
  blue: "藍"
};

const RESULT_ALIASES = new Map([
  ["b", "banker"],
  ["banker", "banker"],
  ["bankerwin", "banker"],
  ["bankerwins", "banker"],
  ["z", "banker"],
  ["莊", "banker"],
  ["庄", "banker"],
  ["莊家", "banker"],
  ["庄家", "banker"],
  ["p", "player"],
  ["player", "player"],
  ["playerwin", "player"],
  ["playerwins", "player"],
  ["x", "player"],
  ["閒", "player"],
  ["闲", "player"],
  ["閒家", "player"],
  ["闲家", "player"],
  ["t", "tie"],
  ["tie", "tie"],
  ["draw", "tie"],
  ["h", "tie"],
  ["和", "tie"],
  ["和局", "tie"]
]);

function normalizeResult(value) {
  const raw = String(value || "").trim();
  const key = raw.toLowerCase().replace(/\s|_|-|\.|\/|:|：/g, "");
  return RESULT_ALIASES.get(key) || "";
}

function normalizeBool(value) {
  if (typeof value === "boolean") return value;
  const key = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "有", "是", "莊對", "庄对", "閒對", "闲对", "幸運6", "幸运6", "lucky6"].includes(key);
}

function normalizeRound(round, fallback = {}) {
  const result = normalizeResult(round?.result ?? round);
  if (!result) return null;
  return {
    id: round?.id || fallback.id || "",
    tableId: round?.tableId || fallback.tableId || "",
    shoe: round?.shoe || fallback.shoe || "",
    handNumber: Number.isFinite(Number(round?.handNumber)) ? Number(round.handNumber) : fallback.handNumber || null,
    result,
    bankerPair: Boolean(round?.bankerPair),
    playerPair: Boolean(round?.playerPair),
    luckySix: Boolean(round?.luckySix),
    bankerCards: Array.isArray(round?.bankerCards) ? round.bankerCards : [],
    playerCards: Array.isArray(round?.playerCards) ? round.playerCards : [],
    bankerPoints: Number.isFinite(Number(round?.bankerPoints)) ? Number(round.bankerPoints) : null,
    playerPoints: Number.isFinite(Number(round?.playerPoints)) ? Number(round.playerPoints) : null,
    cardText: round?.cardText || "",
    note: round?.note || "",
    source: round?.source || fallback.source || "manual",
    observedAt: round?.observedAt || round?.createdAt || fallback.observedAt || new Date().toISOString(),
    createdAt: round?.createdAt || fallback.createdAt || new Date().toISOString(),
    externalKey: round?.externalKey || ""
  };
}

function parseBulkRounds(text, fallback = {}) {
  const rounds = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.includes(",")) {
      const parts = line.split(",").map((part) => part.trim());
      if (parts[0].toLowerCase() === "result") continue;
      const result = normalizeResult(parts[0]);
      if (!result) continue;
      rounds.push(normalizeRound({
        result,
        bankerPair: normalizeBool(parts[1]),
        playerPair: normalizeBool(parts[2]),
        luckySix: normalizeBool(parts[3]),
        note: parts[4] || "",
        bankerPoints: parts[5],
        playerPoints: parts[6],
        cardText: parts[7] || ""
      }, fallback));
      continue;
    }

    const tokens = line
      .replace(/[，、,]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .flatMap(expandCompactResultToken);

    for (const token of tokens) {
      const flags = {
        bankerPair: /莊對|庄对|\+bp/i.test(token),
        playerPair: /閒對|闲对|\+pp/i.test(token),
        luckySix: /幸運6|幸运6|lucky6|\+l6/i.test(token)
      };
      const plain = token
        .replace(/莊對|庄对|閒對|闲对|幸運6|幸运6|\+bp|\+pp|\+l6/gi, "")
        .trim();
      const result = normalizeResult(plain || token);
      if (!result) continue;
      rounds.push(normalizeRound({ result, ...flags }, fallback));
    }
  }

  return rounds.filter(Boolean);
}

function expandCompactResultToken(token) {
  const text = String(token || "").trim();
  if (text.length <= 1) return [text];
  if (/^[莊庄閒闲和]+$/u.test(text)) return [...text];
  if (/^[bptzxth]+$/i.test(text)) return [...text];
  return [text];
}

function buildRoads(rounds) {
  const normalized = rounds.map((round, index) => normalizeRound(round, { handNumber: index + 1 })).filter(Boolean);
  const bead = normalized.map((round, index) => ({
    ...round,
    col: Math.floor(index / 6),
    row: index % 6,
    roundIndex: index
  }));
  const bigRoad = buildBigRoad(normalized);
  const bigEyeRoad = buildDerivedRoad(bigRoad.points, 1, "bigEye");
  const smallRoad = buildDerivedRoad(bigRoad.points, 2, "small");
  const cockroachRoad = buildDerivedRoad(bigRoad.points, 3, "cockroach");

  return {
    bead,
    bigRoad,
    bigEyeRoad,
    smallRoad,
    cockroachRoad
  };
}

function buildBigRoad(rounds) {
  const points = [];
  const grid = new Map();
  let lastMain = "";
  let lastPoint = null;
  let maxCol = -1;

  rounds.forEach((round, index) => {
    const result = normalizeResult(round.result);
    if (!result) return;

    if (result === "tie") {
      if (lastPoint) {
        lastPoint.tieCount = (lastPoint.tieCount || 0) + 1;
        lastPoint.tieRounds = [...(lastPoint.tieRounds || []), { ...round, roundIndex: index }];
      } else {
        const point = makeRoadPoint(round, index, 0, 0, "tie");
        point.tieCount = 1;
        points.push(point);
        grid.set(cellKey(0, 0), point);
        maxCol = 0;
        lastPoint = point;
      }
      return;
    }

    let col = 0;
    let row = 0;
    if (!lastMain || result !== lastMain || !lastPoint || lastPoint.result === "tie") {
      col = maxCol + 1;
      row = 0;
    } else {
      const belowRow = lastPoint.row + 1;
      const belowKey = cellKey(lastPoint.col, belowRow);
      if (belowRow < 6 && !grid.has(belowKey)) {
        col = lastPoint.col;
        row = belowRow;
      } else {
        col = lastPoint.col + 1;
        row = lastPoint.row;
        while (grid.has(cellKey(col, row))) col += 1;
      }
    }

    const point = makeRoadPoint(round, index, col, row, result);
    points.push(point);
    grid.set(cellKey(col, row), point);
    maxCol = Math.max(maxCol, col);
    lastMain = result;
    lastPoint = point;
  });

  return {
    points,
    rows: 6,
    cols: Math.max(maxCol + 1, 1),
    columnHeights: getColumnHeights(points)
  };
}

function buildDerivedRoad(bigRoadPoints, offset, name) {
  const sourceGrid = new Map();
  for (const point of bigRoadPoints) {
    if (point.result !== "tie") sourceGrid.set(cellKey(point.col, point.row), point);
  }
  const heights = getColumnHeights(bigRoadPoints.filter((point) => point.result !== "tie"));
  const events = [];

  for (const point of bigRoadPoints) {
    if (point.result === "tie") continue;
    if (!canStartDerived(point, offset)) continue;
    const color = deriveColor(point, offset, sourceGrid, heights);
    events.push({
      result: color,
      sourceCol: point.col,
      sourceRow: point.row,
      roundIndex: point.roundIndex,
      observedAt: point.observedAt,
      createdAt: point.createdAt
    });
  }

  const road = buildDragonRoad(events);
  return { ...road, name, offset };
}

function canStartDerived(point, offset) {
  return point.col > offset || (point.col === offset && point.row > 0);
}

function deriveColor(point, offset, grid, heights) {
  if (point.row === 0) {
    const left = heights.get(point.col - 1) || 0;
    const compare = heights.get(point.col - offset - 1) || 0;
    return left === compare ? "red" : "blue";
  }
  const leftExists = grid.has(cellKey(point.col - offset, point.row));
  const aboveExists = grid.has(cellKey(point.col - offset, point.row - 1));
  return leftExists === aboveExists ? "red" : "blue";
}

function buildDragonRoad(events) {
  const points = [];
  const grid = new Map();
  let lastColor = "";
  let lastPoint = null;
  let maxCol = -1;

  events.forEach((event, index) => {
    const color = event.result;
    let col = 0;
    let row = 0;
    if (!lastColor || color !== lastColor) {
      col = maxCol + 1;
      row = 0;
    } else {
      const belowRow = lastPoint.row + 1;
      if (belowRow < 6 && !grid.has(cellKey(lastPoint.col, belowRow))) {
        col = lastPoint.col;
        row = belowRow;
      } else {
        col = lastPoint.col + 1;
        row = lastPoint.row;
        while (grid.has(cellKey(col, row))) col += 1;
      }
    }
    const point = {
      ...event,
      id: `${event.roundIndex}-${index}-${color}`,
      col,
      row,
      color,
      label: RESULT_LABELS[color],
      roundIndex: event.roundIndex
    };
    points.push(point);
    grid.set(cellKey(col, row), point);
    maxCol = Math.max(maxCol, col);
    lastColor = color;
    lastPoint = point;
  });

  return {
    points,
    rows: 6,
    cols: Math.max(maxCol + 1, 1),
    columnHeights: getColumnHeights(points)
  };
}

function makeRoadPoint(round, roundIndex, col, row, result) {
  return {
    ...round,
    roundIndex,
    col,
    row,
    result,
    label: RESULT_LABELS[result] || "",
    tieCount: 0
  };
}

function getColumnHeights(points) {
  const heights = new Map();
  for (const point of points) {
    if (point.result === "tie") continue;
    heights.set(point.col, Math.max(heights.get(point.col) || 0, point.row + 1));
  }
  return heights;
}

function cellKey(col, row) {
  return `${col}:${row}`;
}

function summarizeBasic(rounds) {
  const normalized = rounds.map((round) => normalizeRound(round)).filter(Boolean);
  const banker = normalized.filter((round) => round.result === "banker").length;
  const player = normalized.filter((round) => round.result === "player").length;
  const tie = normalized.filter((round) => round.result === "tie").length;
  const bankerPair = normalized.filter((round) => round.bankerPair).length;
  const playerPair = normalized.filter((round) => round.playerPair).length;
  const luckySix = normalized.filter((round) => round.luckySix).length;
  const nonTie = normalized.filter((round) => round.result !== "tie");
  return {
    total: normalized.length,
    banker,
    player,
    tie,
    bankerPair,
    playerPair,
    luckySix,
    currentStreak: getCurrentStreak(nonTie),
    maxStreak: getMaxStreak(nonTie)
  };
}

function getCurrentStreak(rounds) {
  if (!rounds.length) return null;
  const result = rounds[rounds.length - 1].result;
  let count = 0;
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    if (rounds[i].result !== result) break;
    count += 1;
  }
  return { result, count, label: RESULT_LABELS[result] || result };
}

function getMaxStreak(rounds) {
  let best = null;
  let current = null;
  for (const round of rounds) {
    if (!current || current.result !== round.result) {
      current = { result: round.result, count: 1 };
    } else {
      current.count += 1;
    }
    if (!best || current.count > best.count) best = { ...current };
  }
  return best ? { ...best, label: RESULT_LABELS[best.result] || best.result } : null;
}

module.exports = {
  RESULT_LABELS,
  normalizeResult,
  normalizeBool,
  normalizeRound,
  parseBulkRounds,
  buildRoads,
  buildBigRoad,
  buildDerivedRoad,
  summarizeBasic
};
