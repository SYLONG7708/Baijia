const crypto = require("node:crypto");
const { TARGET_CODES, tableMeta, normalizeTableCode } = require("./tables");
const { looksLikeBaccaratResult, parseBaccaratResult } = require("./baccarat-codec");

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function maybeJson(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function findTargetCodeInValue(value) {
  if (value === undefined || value === null) return "";
  const text = String(value).toUpperCase();
  const direct = normalizeTableCode(text.split("__")[0]);
  if (TARGET_CODES.has(direct)) return direct;
  for (const code of TARGET_CODES) {
    if (text === code || text.includes(code)) return code;
  }
  return "";
}

function detectTableCode(obj) {
  if (!obj || typeof obj !== "object") return "";
  const priorityKeys = [
    "tableCode",
    "table_code",
    "tableId",
    "tableID",
    "tableName",
    "AA",
    "BB",
    "table"
  ];
  for (const key of priorityKeys) {
    const code = findTargetCodeInValue(obj[key]);
    if (code) return code;
  }
  for (const value of Object.values(obj)) {
    if (typeof value === "string") {
      const code = findTargetCodeInValue(value);
      if (code) return code;
    }
  }
  return "";
}

function extractRawResults(value, results = []) {
  if (typeof value === "string") {
    const raw = value.trim().toUpperCase();
    if (looksLikeBaccaratResult(raw)) results.push(raw);
    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractRawResults(item, results);
    return results;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) extractRawResults(item, results);
  }
  return results;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function tableNameFromObject(obj, code) {
  const fromKnown = tableMeta(code).label;
  const candidates = [obj?.tableName, obj?.table_name, obj?.BB, obj?.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fromKnown;
}

function parseTableObject(obj, context) {
  const rounds = [];
  const tableCode = context.tableCode;
  const meta = tableMeta(tableCode);
  const status = obj.HH || obj.gameStatus || obj.status || {};
  const tableName = tableNameFromObject(obj, tableCode);
  const shoeId = String(firstValue(
    obj.shoeId,
    obj.shoeNo,
    obj.inningsId,
    obj.inningsID,
    status.BB,
    status.inningsID,
    context.shoeId,
    new Date().toISOString().slice(0, 10)
  ));
  const currentGameRoundId = String(firstValue(
    obj.gameRoundId,
    obj.game_round_id,
    obj.roundId,
    status.CC,
    status.gameRoundId,
    status.game_round_id,
    ""
  ));

  const resultSources = [
    obj.WW3,
    obj.currentShoeGameResult,
    obj.roadmap,
    obj.roadData,
    obj.results,
    obj.result,
    status.NN,
    status.MM,
    status.FF,
    status.curGameRoundWinResult,
    status.stringlotteryResult,
    status.lotteryResult
  ];

  const rawResults = [];
  for (const source of resultSources) extractRawResults(source, rawResults);

  const uniqueRaw = [];
  for (const raw of rawResults) {
    if (!uniqueRaw.includes(raw)) uniqueRaw.push(raw);
  }

  uniqueRaw.forEach((raw, index) => {
    const parsed = parseBaccaratResult(raw, {
      tableCode,
      shoeId,
      gameRoundId: uniqueRaw.length === 1 ? currentGameRoundId : `${shoeId}:${index + 1}`,
      roundNo: index + 1
    });
    if (!parsed) return;
    rounds.push({
      ...parsed,
      tableCode,
      tableName,
      category: meta.category,
      shoeId,
      roundNo: parsed.roundNo || index + 1,
      gameRoundId: parsed.gameRoundId || `${shoeId}:${index + 1}`,
      source: context.source || "allbet",
      sourceEvent: context.sourceEvent || ""
    });
  });

  return rounds;
}

function walk(value, context, rounds, visited) {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, context, rounds, visited));
    return;
  }

  const tableCode = detectTableCode(value) || context.tableCode;
  const nextContext = tableCode ? { ...context, tableCode } : context;
  if (tableCode) rounds.push(...parseTableObject(value, nextContext));

  for (const item of Object.values(value)) {
    walk(item, nextContext, rounds, visited);
  }
}

function extractRoundsFromPayload(payload, context = {}) {
  const parsed = maybeJson(payload);
  if (!parsed || typeof parsed !== "object") return [];
  const sourceEvent = context.sourceEvent || parsed.c || parsed.cmd || parsed.eventType || "";
  const body = parsed.p || parsed.data || parsed;
  const rounds = [];
  walk(body, { ...context, sourceEvent }, rounds, new WeakSet());

  const deduped = [];
  const seen = new Set();
  for (const round of rounds) {
    const key = sha1([
      round.tableCode,
      round.shoeId,
      round.gameRoundId,
      round.roundNo,
      round.rawResult,
      round.outcome
    ].join("|"));
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(round);
  }
  return deduped;
}

module.exports = {
  extractRoundsFromPayload,
  detectTableCode,
  extractRawResults,
  findTargetCodeInValue
};
