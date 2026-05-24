const { normalizeOutcome, outcomeShort } = require("./baccarat-codec");
const { buildRoads } = require("./roads");

const BASE_OUTCOME = { BANKER: 0.4586, PLAYER: 0.4462, TIE: 0.0952 };
const MAX_ROWS_PER_TABLE = Math.max(240, Number(process.env.ROAD_PATTERN_MAX_ROWS_PER_TABLE || 900));
const MIN_PREFIX_ROUNDS = 6;

let sampleCache = null;

function pct(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
}

function clamp(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function roundNoOf(round) {
  return Number(round?.roundNo || 0) || 0;
}

function validOutcome(round) {
  return normalizeOutcome(round?.outcome);
}

function isLikelyNewShoe(previousRoundNo, roundNo) {
  return previousRoundNo > 0
    && roundNo > 0
    && roundNo < previousRoundNo
    && (roundNo <= 5 || previousRoundNo - roundNo >= 20);
}

function sortRows(rows) {
  return [...rows]
    .filter((round) => validOutcome(round) && roundNoOf(round) > 0)
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
}

function groupByTable(rows) {
  const grouped = new Map();
  for (const round of sortRows(rows)) {
    if (!grouped.has(round.tableCode)) grouped.set(round.tableCode, []);
    grouped.get(round.tableCode).push(round);
  }
  return grouped;
}

function splitShoes(tableRows) {
  const shoes = [];
  let current = [];
  let previousRoundNo = 0;
  for (const round of sortRows(tableRows)) {
    const roundNo = roundNoOf(round);
    if (current.length && isLikelyNewShoe(previousRoundNo, roundNo)) {
      shoes.push(current);
      current = [];
    }
    current.push(round);
    if (roundNo > 0) previousRoundNo = roundNo;
  }
  if (current.length) shoes.push(current);
  return shoes;
}

function currentShoeRows(tableRows) {
  return splitShoes(tableRows).at(-1) || [];
}

function tailString(values, length) {
  return values.slice(-length).join("");
}

function bucketLength(length) {
  const number = Number(length || 0);
  if (number >= 6) return "6+";
  if (number >= 4) return "4+";
  return String(Math.max(0, number));
}

function sideRunKey(nonTie) {
  if (!nonTie.length) return "none";
  const side = nonTie.at(-1);
  let length = 1;
  for (let index = nonTie.length - 2; index >= 0; index -= 1) {
    if (nonTie[index] !== side) break;
    length += 1;
  }
  return `${side}${bucketLength(length)}`;
}

function colorRunKey(points) {
  const colors = points.map((point) => point.color).filter((color) => color === "R" || color === "B");
  if (!colors.length) return "none";
  const color = colors.at(-1);
  let length = 1;
  for (let index = colors.length - 2; index >= 0; index -= 1) {
    if (colors[index] !== color) break;
    length += 1;
  }
  return `${color}${bucketLength(length)}`;
}

function bigShapeKey(bigPoints) {
  const byColumn = new Map();
  for (const point of bigPoints) {
    byColumn.set(point.x, Math.max(byColumn.get(point.x) || 0, Number(point.y || 0) + 1));
  }
  const columns = [...byColumn.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => Math.min(6, entry[1]));
  return columns.slice(-4).join("") || "0";
}

function addedRoadPoint(beforePoints, afterPoints) {
  return afterPoints.length > beforePoints.length ? afterPoints.at(-1) : null;
}

function projectionFor(shoeRows) {
  const before = buildRoads(shoeRows);
  const project = (outcome) => {
    const nextRoundNo = Math.max(0, ...shoeRows.map(roundNoOf)) + 1;
    const after = buildRoads([
      ...shoeRows,
      {
        tableCode: shoeRows.at(-1)?.tableCode || "",
        roundNo: nextRoundNo,
        outcome,
        rawResult: `project:${outcome}:${nextRoundNo}`
      }
    ]);
    return {
      outcome,
      big: addedRoadPoint(before.big, after.big)?.outcome || "",
      bigEye: addedRoadPoint(before.bigEye, after.bigEye)?.color || "",
      small: addedRoadPoint(before.small, after.small)?.color || "",
      cockroach: addedRoadPoint(before.cockroach, after.cockroach)?.color || ""
    };
  };
  return {
    BANKER: project("BANKER"),
    PLAYER: project("PLAYER")
  };
}

function roadFeatures(shoeRows, options = {}) {
  const rows = sortRows(shoeRows);
  const roads = buildRoads(rows);
  const outcomes = rows.map((round) => outcomeShort(normalizeOutcome(round.outcome))).filter(Boolean);
  const nonTie = outcomes.filter((value) => value === "B" || value === "P");
  const big = roads.big.map((point) => point.outcome === "BANKER" ? "B" : point.outcome === "PLAYER" ? "P" : "T");
  const bigEye = roads.bigEye.map((point) => point.color).filter(Boolean);
  const small = roads.small.map((point) => point.color).filter(Boolean);
  const cockroach = roads.cockroach.map((point) => point.color).filter(Boolean);
  const projection = options.includeProjection === false ? null : projectionFor(rows);

  const parts = {
    bead6: tailString(outcomes, 6),
    bead4: tailString(outcomes, 4),
    main8: tailString(nonTie, 8),
    main6: tailString(nonTie, 6),
    main4: tailString(nonTie, 4),
    big8: tailString(big, 8),
    big6: tailString(big, 6),
    sideRun: sideRunKey(nonTie),
    bigShape: bigShapeKey(roads.big),
    bigEye6: tailString(bigEye, 6),
    bigEye4: tailString(bigEye, 4),
    small6: tailString(small, 6),
    small4: tailString(small, 4),
    cockroach6: tailString(cockroach, 6),
    cockroach4: tailString(cockroach, 4),
    bigEyeRun: colorRunKey(roads.bigEye),
    smallRun: colorRunKey(roads.small),
    cockroachRun: colorRunKey(roads.cockroach),
    projection
  };

  return {
    ...parts,
    keys: {
      full: `full|${parts.bead6}|${parts.main8}|${parts.bigShape}|${parts.bigEye6}|${parts.small6}|${parts.cockroach6}`,
      road: `road|${parts.main6}|${parts.sideRun}|${parts.bigEye4}|${parts.small4}|${parts.cockroach4}`,
      derived: `derived|${parts.bigEye6}|${parts.small6}|${parts.cockroach6}`,
      trend: `trend|${parts.sideRun}|${parts.bigEyeRun}|${parts.smallRun}|${parts.cockroachRun}`,
      big: `big|${parts.big6}|${parts.sideRun}|${parts.bigShape}`,
      bead: `bead|${parts.bead6}`,
      short: `short|${parts.main4}|${parts.bigEye4}|${parts.small4}|${parts.cockroach4}`
    }
  };
}

function emptyCounts() {
  return { total: 0, BANKER: 0, PLAYER: 0, TIE: 0 };
}

function addOutcome(counts, outcome, weight = 1) {
  counts.total += weight;
  if (counts[outcome] !== undefined) counts[outcome] += weight;
}

function addMapOutcome(map, key, outcome) {
  if (!key) return;
  let counts = map.get(key);
  if (!counts) {
    counts = emptyCounts();
    map.set(key, counts);
  }
  addOutcome(counts, outcome, 1);
}

function createIndexMaps() {
  return {
    full: new Map(),
    road: new Map(),
    derived: new Map(),
    trend: new Map(),
    big: new Map(),
    bead: new Map(),
    short: new Map()
  };
}

function addSample(maps, features, outcome) {
  for (const [key, value] of Object.entries(features.keys)) {
    addMapOutcome(maps[key], value, outcome);
  }
}

function buildSamplesForRows(rows) {
  const maps = createIndexMaps();
  const shoes = splitShoes(rows);
  let samples = 0;
  for (const shoe of shoes) {
    for (let index = MIN_PREFIX_ROUNDS; index < shoe.length; index += 1) {
      const outcome = normalizeOutcome(shoe[index].outcome);
      if (!outcome) continue;
      addSample(maps, roadFeatures(shoe.slice(0, index), { includeProjection: false }), outcome);
      samples += 1;
    }
  }
  return { maps, samples };
}

function latestRoundKey(rows) {
  const latest = sortRows(rows).at(-1);
  return `${rows.length}:${latest?.id || 0}:${latest?.tableCode || ""}:${latest?.roundNo || 0}:${latest?.rawResult || ""}`;
}

function buildSampleIndex(allRows) {
  const cacheKey = latestRoundKey(allRows);
  if (sampleCache?.cacheKey === cacheKey) return sampleCache;

  const byTable = groupByTable(allRows);
  const limitedRows = [];
  const tables = new Map();
  for (const [tableCode, rows] of byTable.entries()) {
    const limited = rows.slice(-MAX_ROWS_PER_TABLE);
    limitedRows.push(...limited);
    tables.set(tableCode, buildSamplesForRows(limited));
  }
  const global = buildSamplesForRows(limitedRows);
  sampleCache = {
    cacheKey,
    generatedAt: new Date().toISOString(),
    maxRowsPerTable: MAX_ROWS_PER_TABLE,
    global,
    tables
  };
  return sampleCache;
}

function weightedCountsFor(features, tableMaps, globalMaps) {
  const weights = {
    full: { table: 4.5, global: 1.4 },
    road: { table: 3.2, global: 1.1 },
    derived: { table: 2.2, global: 0.8 },
    trend: { table: 1.8, global: 0.7 },
    big: { table: 1.8, global: 0.7 },
    bead: { table: 1.2, global: 0.45 },
    short: { table: 1.0, global: 0.35 }
  };
  const counts = emptyCounts();
  const matches = [];

  for (const [key, value] of Object.entries(features.keys)) {
    const tableCounts = tableMaps?.[key]?.get(value);
    if (tableCounts?.total) {
      const weight = weights[key]?.table || 1;
      for (const outcome of ["BANKER", "PLAYER", "TIE"]) addOutcome(counts, outcome, tableCounts[outcome] * weight);
      matches.push({ key, source: "table", sample: tableCounts.total, weight });
    }
    const globalCounts = globalMaps?.[key]?.get(value);
    if (globalCounts?.total) {
      const weight = weights[key]?.global || 0.5;
      for (const outcome of ["BANKER", "PLAYER", "TIE"]) addOutcome(counts, outcome, globalCounts[outcome] * weight);
      matches.push({ key, source: "global", sample: globalCounts.total, weight });
    }
  }
  return { counts, matches };
}

function baselineFor(rows) {
  const counts = emptyCounts();
  for (const round of rows) {
    const outcome = normalizeOutcome(round.outcome);
    if (outcome) addOutcome(counts, outcome, 1);
  }
  if (counts.total < 20) return BASE_OUTCOME;
  const prior = 24;
  const raw = {
    BANKER: counts.BANKER + BASE_OUTCOME.BANKER * prior,
    PLAYER: counts.PLAYER + BASE_OUTCOME.PLAYER * prior,
    TIE: counts.TIE + BASE_OUTCOME.TIE * prior
  };
  const total = raw.BANKER + raw.PLAYER + raw.TIE || 1;
  return {
    BANKER: raw.BANKER / total,
    PLAYER: raw.PLAYER / total,
    TIE: raw.TIE / total
  };
}

function normalizeProbabilities(probabilities) {
  const raw = {
    BANKER: Math.max(0.0001, Number(probabilities.BANKER || 0)),
    PLAYER: Math.max(0.0001, Number(probabilities.PLAYER || 0)),
    TIE: Math.max(0.0001, Number(probabilities.TIE || 0))
  };
  const total = raw.BANKER + raw.PLAYER + raw.TIE || 1;
  return {
    BANKER: raw.BANKER / total,
    PLAYER: raw.PLAYER / total,
    TIE: raw.TIE / total
  };
}

function modelWeightFor(sample) {
  if (sample >= 180) return 0.18;
  if (sample >= 80) return 0.14;
  if (sample >= 35) return 0.1;
  if (sample >= 12) return 0.07;
  if (sample >= 5) return 0.04;
  return 0;
}

function estimateRoadPatternModel(allRows, tableCode) {
  const byTable = groupByTable(allRows);
  const tableRows = tableCode ? (byTable.get(tableCode) || []) : sortRows(allRows);
  const shoeRows = tableCode ? currentShoeRows(tableRows) : currentShoeRows(sortRows(allRows));
  if (shoeRows.length < MIN_PREFIX_ROUNDS) {
    return {
      available: false,
      reason: "not-enough-current-shoe-rounds",
      currentShoeRounds: shoeRows.length,
      modelWeight: 0
    };
  }

  const features = roadFeatures(shoeRows);
  const index = buildSampleIndex(allRows);
  const tableIndex = tableCode ? index.tables.get(tableCode) : null;
  const { counts, matches } = weightedCountsFor(features, tableIndex?.maps, index.global.maps);
  const effectiveSample = counts.total;
  const baseline = baselineFor(tableRows.length >= 20 ? tableRows : allRows);
  const noTie = counts.BANKER + counts.PLAYER;
  const prior = effectiveSample < 20 ? 60 : effectiveSample < 80 ? 36 : 18;
  const baselineNoTieBanker = baseline.BANKER / Math.max(0.0001, baseline.BANKER + baseline.PLAYER);
  const bankerNoTie = noTie
    ? (counts.BANKER + baselineNoTieBanker * prior) / (noTie + prior)
    : baselineNoTieBanker;
  const tie = clamp((counts.TIE + baseline.TIE * prior) / (effectiveSample + prior || 1), 0.035, 0.14);
  const nonTie = 1 - tie;
  const probabilities = normalizeProbabilities({
    BANKER: nonTie * bankerNoTie,
    PLAYER: nonTie * (1 - bankerNoTie),
    TIE: tie
  });
  const modelWeight = modelWeightFor(effectiveSample);

  return {
    available: modelWeight > 0,
    generatedAt: index.generatedAt,
    currentShoeRounds: shoeRows.length,
    maxRowsPerTable: index.maxRowsPerTable,
    effectiveSample: Math.round(effectiveSample * 10) / 10,
    rawCounts: {
      total: Math.round(counts.total * 10) / 10,
      BANKER: Math.round(counts.BANKER * 10) / 10,
      PLAYER: Math.round(counts.PLAYER * 10) / 10,
      TIE: Math.round(counts.TIE * 10) / 10
    },
    matches: matches
      .sort((left, right) => right.sample * right.weight - left.sample * left.weight)
      .slice(0, 10),
    modelWeight,
    pick: probabilities.BANKER >= probabilities.PLAYER ? "BANKER" : "PLAYER",
    probabilities,
    noTieProbabilities: {
      BANKER: bankerNoTie,
      PLAYER: 1 - bankerNoTie
    },
    percentages: {
      BANKER: pct(probabilities.BANKER),
      PLAYER: pct(probabilities.PLAYER),
      TIE: pct(probabilities.TIE)
    },
    noTiePercentages: {
      BANKER: pct(bankerNoTie),
      PLAYER: pct(1 - bankerNoTie)
    },
    features: {
      bead6: features.bead6,
      main8: features.main8,
      sideRun: features.sideRun,
      bigShape: features.bigShape,
      bigEye6: features.bigEye6,
      small6: features.small6,
      cockroach6: features.cockroach6,
      bigEyeRun: features.bigEyeRun,
      smallRun: features.smallRun,
      cockroachRun: features.cockroachRun,
      projection: features.projection
    }
  };
}

module.exports = {
  estimateRoadPatternModel,
  roadFeatures
};
