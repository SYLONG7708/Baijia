const crypto = require("node:crypto");
const { TARGET_CODES, tableMeta, normalizeTableCode } = require("./tables");
const {
  looksLikeBaccaratResult,
  parseBaccaratResult,
  parseAllbetCardMatrix
} = require("./baccarat-codec");

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

function payloadBody(parsed) {
  return parsed?.p || parsed?.data || parsed;
}

function findTargetCodeInValue(value) {
  if (value === undefined || value === null) return "";
  const text = String(value).toUpperCase();
  const direct = normalizeTableCode(text.split("__")[0]);
  if (TARGET_CODES.has(direct)) return direct;
  for (const code of TARGET_CODES) {
    if (text === code) return code;
    const pattern = new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`);
    if (pattern.test(text)) return code;
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

function extractValidRawResults(value, results = []) {
  extractRawResults(value, results);
  return results.filter((raw) => raw !== "-1" && raw !== "-2");
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

function isNonTargetTableAlias(tableName, code) {
  const name = String(tableName || "").toUpperCase();
  return /^[A-Z]+[0-9]+$/.test(name) && name !== code;
}

function parseTableObject(obj, context) {
  const rounds = [];
  const tableCode = context.tableCode;
  const meta = tableMeta(tableCode);
  const status = obj.HH || obj.gameStatus || obj.status || {};
  const tableName = tableNameFromObject(obj, tableCode);
  if (isNonTargetTableAlias(tableName, tableCode)) return rounds;
  const shoeId = String(firstValue(
    obj.shoeId,
    obj.shoeNo,
    obj.inningsId,
    obj.inningsID,
    status.inningsID,
    context.shoeId,
    context.snapshotShoeId,
    "snapshot"
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
  for (const source of resultSources) extractValidRawResults(source, rawResults);

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

  const ownTableCode = detectTableCode(value);
  const nextContext = ownTableCode ? { ...context, tableCode: ownTableCode } : context;
  if (ownTableCode) rounds.push(...parseTableObject(value, nextContext));

  for (const item of Object.values(value)) {
    walk(item, nextContext, rounds, visited);
  }
}

function extractRoundsFromPayload(payload, context = {}) {
  const parsed = maybeJson(payload);
  if (!parsed || typeof parsed !== "object") return [];
  const sourceEvent = context.sourceEvent || parsed.c || parsed.cmd || parsed.eventType || "";
  const body = payloadBody(parsed);
  const rounds = [];
  walk(body, {
    ...context,
    sourceEvent,
    snapshotShoeId: context.snapshotShoeId || `snapshot:${new Date().toISOString().slice(0, 10)}`
  }, rounds, new WeakSet());

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

function extractTableReferencesFromPayload(payload) {
  const parsed = maybeJson(payload);
  if (!parsed || typeof parsed !== "object") return [];
  const body = payloadBody(parsed);
  const refs = [];
  const visited = new WeakSet();

  function visit(value) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const tableCode = detectTableCode(value);
    const tableId = value.AA ?? value.tableId ?? value.tableID;
    if (tableCode && tableId !== undefined && tableId !== null) {
      const status = value.HH || value.gameStatus || value.status || {};
      const tableName = tableNameFromObject(value, tableCode);
      if (isNonTargetTableAlias(tableName, tableCode)) return;
      refs.push({
        tableId: String(tableId),
        tableCode,
        tableName,
        category: tableMeta(tableCode).category,
        currentRoundNo: Number(status.BB || value.roundNo || 0) || 0,
        gameRoundId: String(status.CC || value.gameRoundId || value.game_round_id || ""),
        status: status.DD ?? value.status ?? "",
        updatedAt: new Date().toISOString()
      });
    }

    for (const item of Object.values(value)) visit(item);
  }

  visit(body);
  return refs;
}

function roundFromLiveRaw(raw, tableRef, details, context) {
  const roundNo = Number(details.roundNo || tableRef.currentRoundNo || 0) || 0;
  if (roundNo <= 0) return null;
  const parsed = parseBaccaratResult(raw, {
    tableCode: tableRef.tableCode,
    shoeId: details.shoeId || tableRef.shoeId || "live",
    gameRoundId: details.gameRoundId || tableRef.gameRoundId || "",
    roundNo
  });
  if (!parsed) return null;
  return {
    ...parsed,
    tableCode: tableRef.tableCode,
    tableName: tableRef.tableName || tableMeta(tableRef.tableCode).label,
    category: tableRef.category || tableMeta(tableRef.tableCode).category,
    shoeId: parsed.shoeId || "live",
    roundNo: parsed.roundNo || 0,
    gameRoundId: parsed.gameRoundId || `${tableRef.tableCode}:${parsed.roundNo}:${raw}`,
    providerTableId: tableRef.tableId || "",
    bankerCards: details.bankerCards || [],
    playerCards: details.playerCards || [],
    cardObservedAt: details.cardObservedAt || "",
    source: context.source || "allbet",
    sourceEvent: context.sourceEvent || ""
  };
}

function extractLiveRoundsFromPayload(payload, tableRefs = new Map(), context = {}) {
  const parsed = maybeJson(payload);
  if (!parsed || typeof parsed !== "object") return { rounds: [], unmatched: [] };

  const sourceEvent = context.sourceEvent || parsed.c || parsed.cmd || parsed.eventType || "";
  const body = payloadBody(parsed);
  const rounds = [];
  const unmatched = [];

  function tableRefFor(id) {
    if (id === undefined || id === null) return null;
    return tableRefs.get(String(id)) || null;
  }

  if (sourceEvent === "pushGameTableResults") {
    const tableId = body.A ?? body.AA ?? body.tableId;
    const ref = tableRefFor(tableId);
    if (!ref) unmatched.push(String(tableId));
    const raws = extractValidRawResults(body.G || body.results || body.result);
    raws.forEach((raw, index) => {
      if (!ref) return;
      const roundNo = Number(body.C || body.roundNo || 0) - Math.max(0, raws.length - 1 - index);
      const round = roundFromLiveRaw(raw, ref, {
        roundNo,
        gameRoundId: String(body.E || body.gameRoundId || `${ref.tableCode}:${roundNo}:${raw}`)
      }, { ...context, sourceEvent });
      if (round) rounds.push(round);
    });
  }

  if (sourceEvent === "pushGameStatus") {
    const items = Array.isArray(body.A) ? body.A : [body];
    for (const item of items) {
      const tableId = item.AA ?? item.A ?? item.tableId;
      const ref = tableRefFor(tableId);
      if (!ref) {
        if (tableId !== undefined && tableId !== null) unmatched.push(String(tableId));
        continue;
      }
      const raws = extractValidRawResults(item.NN || item.MM || item.FF || item.result);
      for (const raw of raws) {
        const round = roundFromLiveRaw(raw, ref, {
          roundNo: Number(item.BB || item.roundNo || ref.currentRoundNo || 0) || 0,
          gameRoundId: String(item.CC || item.gameRoundId || ref.gameRoundId || "")
        }, { ...context, sourceEvent });
        if (round) rounds.push(round);
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const round of rounds) {
    const key = sha1([
      round.tableCode,
      round.gameRoundId,
      round.roundNo,
      round.rawResult,
      round.outcome
    ].join("|"));
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(round);
  }

  return { rounds: deduped, unmatched: [...new Set(unmatched)] };
}

function extractCardSnapshotsFromPayload(payload) {
  const parsed = maybeJson(payload);
  if (!parsed || typeof parsed !== "object") return [];
  const sourceEvent = parsed.c || parsed.cmd || parsed.eventType || "";
  if (sourceEvent !== "pushRawCards") return [];
  const body = payloadBody(parsed);
  const tableId = body.A ?? body.AA ?? body.tableId;
  const matrix = parseAllbetCardMatrix(body.B || body.cards || body.rawCards);
  if (!matrix || tableId === undefined || tableId === null) return [];
  return [{
    providerTableId: String(tableId),
    gameRoundId: String(body.E || body.gameRoundId || ""),
    observedAt: new Date().toISOString(),
    ...matrix
  }];
}

module.exports = {
  extractRoundsFromPayload,
  extractLiveRoundsFromPayload,
  extractTableReferencesFromPayload,
  extractCardSnapshotsFromPayload,
  detectTableCode,
  extractRawResults,
  findTargetCodeInValue
};
