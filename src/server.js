const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, PUBLIC_DIR, PORT, API_TOKEN, PUBLIC_API_BASE } = require("./env");
const { TABLE_GROUPS, TARGET_TABLES, tableMeta, normalizeTableCode } = require("./tables");
const { parseBaccaratResult, normalizeOutcome } = require("./baccarat-codec");
const {
  openDatabase,
  insertRound,
  getRounds,
  getAllRounds,
  getTableRounds,
  getStatus,
  getEvents,
  getRoundIngestSummary,
  logEvent
} = require("./db");
const {
  summarizeAll,
  predictFromSequence,
  estimateCardModel,
  isPredictionUsable,
  currentShoeRounds
} = require("./analytics");
const { buildRoads } = require("./roads");
const { backtestPredictions } = require("./backtest");
const { buildDataQuality } = require("./quality");
const { buildModelSelection, predictByModel } = require("./model-selection");
const { buildValidation } = require("./validation");
const { getTrainingSummary } = require("./training-store");
const { buildCanonicalView } = require("./canonical");
const { buildStreakAlerts } = require("./alerts");

openDatabase();
const MONITOR_REPORT_PATH = path.join(DATA_DIR, "monitor-reports.jsonl");
const streamClients = new Set();

function canonicalFor(allRounds) {
  const canonical = buildCanonicalView(allRounds);
  const reliable = canonical.predictionRounds.filter(isPredictionUsable);
  return {
    canonical,
    reliable: reliable.length ? reliable : allRounds.filter(isPredictionUsable)
  };
}

function sameRoadResult(left, right) {
  return (left?.outcome || "") === (right?.outcome || "")
    && (left?.rawResult || "") === (right?.rawResult || "");
}

function roundNoOf(round) {
  return Number(round?.roundNo || 0) || 0;
}

function maxRoundNo(rounds) {
  return Math.max(0, ...rounds.map(roundNoOf));
}

function maxId(rounds) {
  return Math.max(0, ...rounds.map((round) => Number(round.id || 0) || 0));
}

function minRoundNo(rounds) {
  const values = rounds.map(roundNoOf).filter(Boolean);
  return values.length ? Math.min(...values) : 0;
}

function overlappingSnapshotConflictStats(liveRounds, snapshotRounds) {
  const liveByRoundNo = new Map();
  for (const live of liveRounds) {
    const roundNo = roundNoOf(live);
    if (roundNo) liveByRoundNo.set(roundNo, live);
  }
  let overlap = 0;
  let conflicts = 0;
  for (const snapshot of snapshotRounds) {
    const live = liveByRoundNo.get(roundNoOf(snapshot));
    if (!live) continue;
    overlap += 1;
    if (!sameRoadResult(live, snapshot)) conflicts += 1;
  }
  return { overlap, conflicts };
}

function snapshotLooksLikeNewerShoe(liveRounds, snapshotRounds) {
  if (!snapshotRounds.length || !liveRounds.length) return false;
  const snapshotFirst = Math.min(...snapshotRounds.map(roundNoOf).filter(Boolean));
  return snapshotFirst <= 3
    && maxRoundNo(snapshotRounds) + 8 < maxRoundNo(liveRounds)
    && maxId(snapshotRounds) > maxId(liveRounds);
}

function snapshotLooksLikeOlderShoe(liveRounds, snapshotRounds) {
  if (!snapshotRounds.length || !liveRounds.length) return false;
  const liveFirst = Math.min(...liveRounds.map(roundNoOf).filter(Boolean));
  return liveFirst <= 3
    && maxRoundNo(liveRounds) <= 12
    && maxRoundNo(snapshotRounds) >= maxRoundNo(liveRounds) + 20
    && maxId(liveRounds) > maxId(snapshotRounds);
}

function snapshotLooksLikeOlderConflictingShoe(liveRounds, snapshotRounds) {
  if (!snapshotRounds.length || !liveRounds.length) return false;
  if (maxId(snapshotRounds) >= maxId(liveRounds)) return false;
  if (minRoundNo(liveRounds) > 3 || minRoundNo(snapshotRounds) > 3) return false;
  const stats = overlappingSnapshotConflictStats(liveRounds, snapshotRounds);
  if (stats.overlap >= 1 && stats.conflicts === stats.overlap) {
    return true;
  }
  if (maxRoundNo(liveRounds) < 5) return false;
  if (stats.overlap < 8) return false;
  return stats.conflicts >= Math.max(5, Math.floor(stats.overlap * 0.35));
}

function mergeSnapshotRoadRounds(liveRounds, snapshotRounds) {
  if (!snapshotRounds.length) return liveRounds;
  if (snapshotLooksLikeOlderShoe(liveRounds, snapshotRounds)) return liveRounds;
  if (snapshotLooksLikeOlderConflictingShoe(liveRounds, snapshotRounds)) return liveRounds;
  if (snapshotLooksLikeNewerShoe(liveRounds, snapshotRounds)) return snapshotRounds;
  const liveByRoundNo = new Map();
  for (const round of liveRounds) {
    const roundNo = Number(round.roundNo || 0) || 0;
    if (roundNo) liveByRoundNo.set(roundNo, round);
  }

  const usedLiveIds = new Set();
  const merged = snapshotRounds.map((snapshot) => {
    const live = liveByRoundNo.get(Number(snapshot.roundNo || 0) || 0);
    if (live && sameRoadResult(live, snapshot)) {
      usedLiveIds.add(Number(live.id || 0));
      return live;
    }
    return snapshot;
  });

  const snapshotSlots = new Set(snapshotRounds.map((round) => Number(round.roundNo || 0) || 0));
  for (const live of liveRounds) {
    const liveId = Number(live.id || 0);
    const roundNo = Number(live.roundNo || 0) || 0;
    if (usedLiveIds.has(liveId) || snapshotSlots.has(roundNo)) continue;
    merged.push(live);
  }

  return merged.sort((left, right) => {
    const roundDiff = (Number(left.roundNo || 0) || 0) - (Number(right.roundNo || 0) || 0);
    return roundDiff || (Number(left.id || 0) || 0) - (Number(right.id || 0) || 0);
  });
}

function summaryWithActiveModel(summary, rounds, status = {}) {
  const modelSelection = status.modelSelection || {};
  const activeModel = modelSelection.activeModel || status.trainer?.activeModel || "";
  if (!activeModel) return summary;
  const tableModelByCode = new Map((modelSelection.tableModels || []).map((item) => [item.tableCode, item]));
  return {
    ...summary,
    activeModel,
    prediction: predictByModel(rounds, "", activeModel),
    tables: (summary.tables || []).map((table) => ({
      ...table,
      activeModel: tableModelByCode.get(table.code)?.modelId || activeModel,
      tableModel: tableModelByCode.get(table.code) || null,
      prediction: predictByModel(rounds, table.code, tableModelByCode.get(table.code)?.modelId || activeModel)
    }))
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  });
  res.end(text);
}

function isAuthorized(req) {
  if (req.method === "GET" || req.method === "OPTIONS") return true;
  if (req.method === "POST" && req.url.startsWith("/api/predict")) return true;
  return (req.headers.authorization || "") === `Bearer ${API_TOKEN}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 2_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

function readJsonlTail(filePath, limit = 120) {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 120));
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .slice(-safeLimit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function streamPayload() {
  const status = getStatus();
  const ingest = getRoundIngestSummary();
  const monitor = status.monitor || {};
  return {
    now: new Date().toISOString(),
    latestId: ingest.latestId,
    totalRounds: ingest.totalRounds,
    recent: ingest.recent,
    latestRound: ingest.latestRound
      ? {
        tableCode: ingest.latestRound.tableCode,
        roundNo: ingest.latestRound.roundNo,
        outcome: ingest.latestRound.outcome,
        insertedAt: ingest.latestRound.insertedAt
      }
      : null,
    monitor: {
      state: monitor.state || "",
      canReadNewInfo: Boolean(monitor.canReadNewInfo),
      lastCheckAt: monitor.lastCheckAt || "",
      reportGeneratedAt: monitor.report?.generatedAt || "",
      errorTables: monitor.report?.errorTables || 0,
      warnTables: monitor.report?.warnTables || 0
    },
    scraper: {
      running: Boolean(status.scraper?.running),
      health: status.scraper?.health || "",
      heartbeatAt: status.scraper?.heartbeatAt || ""
    }
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "access-control-allow-origin": "*"
  });
  res.write(": connected\n\n");
  streamClients.add(res);
  sendSse(res, "status", streamPayload());
  req.on("close", () => {
    streamClients.delete(res);
  });
}

setInterval(() => {
  if (!streamClients.size) return;
  let payload;
  try {
    payload = streamPayload();
  } catch (error) {
    payload = { now: new Date().toISOString(), error: error.message };
  }
  for (const client of streamClients) sendSse(client, "status", payload);
}, 2000);

function roundFromInput(input) {
  const tableCode = normalizeTableCode(input.tableCode || input.table_code || input.tableId);
  const meta = tableMeta(tableCode);
  if (!tableCode) return { error: "tableCode is required" };
  if (input.rawResult) {
    const parsed = parseBaccaratResult(input.rawResult, {
      tableCode,
      shoeId: input.shoeId || input.shoe_id,
      gameRoundId: input.gameRoundId || input.game_round_id,
      roundNo: input.roundNo || input.round_no
    });
    if (!parsed) return { error: "rawResult is not a supported baccarat result string" };
    return {
      ...parsed,
      tableCode,
      tableName: input.tableName || meta.label,
      category: meta.category,
      bankerCards: input.bankerCards || input.banker_cards || input.bankerCardsRaw || input.banker_cards_raw || [],
      playerCards: input.playerCards || input.player_cards || input.playerCardsRaw || input.player_cards_raw || [],
      bankerCardPoints: input.bankerCardPoints || input.banker_card_points || [],
      playerCardPoints: input.playerCardPoints || input.player_card_points || [],
      bankerCardRanks: input.bankerCardRanks || input.banker_card_ranks || [],
      playerCardRanks: input.playerCardRanks || input.player_card_ranks || [],
      cardObservedAt: input.cardObservedAt || input.card_observed_at || "",
      source: input.source || "manual",
      sourceEvent: "manual"
    };
  }

  const outcome = normalizeOutcome(input.outcome || input.result || input.winner);
  if (!outcome) return { error: "outcome must be BANKER, PLAYER, or TIE" };
  return {
    tableCode,
    tableName: input.tableName || meta.label,
    category: meta.category,
    shoeId: input.shoeId || input.shoe_id || new Date().toISOString().slice(0, 10),
    roundNo: Number(input.roundNo || input.round_no || 0) || 0,
    gameRoundId: input.gameRoundId || input.game_round_id || "",
    outcome,
    bankerPair: Boolean(input.bankerPair || input.banker_pair),
    playerPair: Boolean(input.playerPair || input.player_pair),
    luckySix: Boolean(input.luckySix || input.lucky_six),
    bankerPoint: input.bankerPoint || "",
    playerPoint: input.playerPoint || "",
    bankerCards: input.bankerCards || input.banker_cards || input.bankerCardsRaw || input.banker_cards_raw || [],
    playerCards: input.playerCards || input.player_cards || input.playerCardsRaw || input.player_cards_raw || [],
    bankerCardPoints: input.bankerCardPoints || input.banker_card_points || [],
    playerCardPoints: input.playerCardPoints || input.player_card_points || [],
    bankerCardRanks: input.bankerCardRanks || input.banker_card_ranks || [],
    playerCardRanks: input.playerCardRanks || input.player_card_ranks || [],
    cardObservedAt: input.cardObservedAt || input.card_observed_at || "",
    rawResult: input.rawResult || "",
    source: input.source || "manual",
    sourceEvent: "manual"
  };
}

async function handleApi(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (!isAuthorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const rounds = () => getAllRounds();

  if (req.method === "GET" && url.pathname === "/api/stream") {
    return handleStream(req, res);
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, {
      tableGroups: TABLE_GROUPS,
      tables: TARGET_TABLES,
      publicApiBase: PUBLIC_API_BASE
    });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const allRounds = rounds();
    const { canonical, reliable: summaryRounds } = canonicalFor(allRounds);
    const status = getStatus();
    const validation = buildValidation(allRounds);
    const summary = summaryWithActiveModel(summarizeAll(summaryRounds), summaryRounds, status);
    return sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      summary,
      alerts: buildStreakAlerts(summary, validation),
      quality: canonical.summary,
      rawTotals: {
        allRounds: allRounds.length,
        reliableRounds: summaryRounds.length,
        canonicalRounds: canonical.canonicalRounds.length,
        quarantinedRounds: canonical.quarantinedRounds.length
      },
      scraper: { ...status, validation, canonical: canonical.summary }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/tables") {
    const status = getStatus();
    const summaryRounds = canonicalFor(rounds()).reliable;
    return sendJson(res, 200, summaryWithActiveModel(summarizeAll(summaryRounds), summaryRounds, status));
  }

  if (req.method === "GET" && url.pathname === "/api/quality") {
    return sendJson(res, 200, buildDataQuality(rounds(), getStatus()));
  }

  if (req.method === "GET" && url.pathname === "/api/validation") {
    return sendJson(res, 200, buildValidation(rounds()));
  }

  if (req.method === "GET" && url.pathname === "/api/alerts") {
    const allRounds = rounds();
    const { reliable } = canonicalFor(allRounds);
    const validation = buildValidation(allRounds);
    const status = getStatus();
    const summary = summaryWithActiveModel(summarizeAll(reliable), reliable, status);
    return sendJson(res, 200, buildStreakAlerts(summary, validation, {
      minRate: url.searchParams.get("minRate") || undefined,
      minSample: url.searchParams.get("minSample") || undefined,
      limit: url.searchParams.get("limit") || undefined
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/monitor") {
    const status = getStatus();
    const allRounds = rounds();
    const validation = buildValidation(allRounds);
    return sendJson(res, 200, {
      monitor: status.monitor || {},
      monitorProcess: status.monitorProcess || {},
      qualityWatchdog: status.qualityWatchdog || {},
      trainer: status.trainer || {},
      trainerProcess: status.trainerProcess || {},
      telegram: status.telegram || {},
      telegramProcess: status.telegramProcess || {},
      scraper: status.scraper || {},
      validation,
      ingest: getRoundIngestSummary()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/monitor/report") {
    const reports = readJsonlTail(MONITOR_REPORT_PATH, url.searchParams.get("limit") || 120);
    return sendJson(res, 200, {
      reportPath: MONITOR_REPORT_PATH,
      count: reports.length,
      latest: reports.at(-1) || null,
      reports
    });
  }

  if (req.method === "GET" && url.pathname === "/api/training") {
    return sendJson(res, 200, {
      trainer: getStatus().trainer || {},
      training: getTrainingSummary(url.searchParams.get("limit") || 20)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/backtest") {
    return sendJson(res, 200, backtestPredictions(canonicalFor(rounds()).reliable, {
      tableCode: url.searchParams.get("tableCode"),
      limit: url.searchParams.get("limit"),
      warmup: url.searchParams.get("warmup")
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    const status = getStatus();
    if (url.searchParams.get("recompute") !== "true" && status.modelSelection) {
      return sendJson(res, 200, {
        ...status.modelSelection,
        cached: true,
        note: `${status.modelSelection.note || ""} Use ?recompute=true to force a fresh walk-forward run.`
      });
    }
    return sendJson(res, 200, {
      ...buildModelSelection(canonicalFor(rounds()).reliable, {
        limit: url.searchParams.get("limit"),
        warmup: url.searchParams.get("warmup")
      }),
      cached: false
    });
  }

  if (req.method === "GET" && url.pathname === "/api/rounds") {
    const includeSnapshots = url.searchParams.get("includeSnapshots") === "true";
    const tableCode = normalizeTableCode(url.searchParams.get("tableCode"));
    const source = getRounds({ tableCode, limit: url.searchParams.get("limit") || 2000 });
    const canonical = canonicalFor(source);
    const sourceRounds = includeSnapshots
      ? source
      : canonical.reliable;
    return sendJson(res, 200, {
      rounds: sourceRounds,
      quality: canonical.canonical.summary,
      source: includeSnapshots ? "all" : "canonical-live"
    });
  }

  if (req.method === "GET" && url.pathname === "/api/roads") {
    const tableCode = normalizeTableCode(url.searchParams.get("tableCode"));
    if (!tableCode) return sendJson(res, 400, { error: "tableCode is required" });
    const allTableRounds = getTableRounds(tableCode);
    const canonical = canonicalFor(allTableRounds);
    const reliable = canonical.reliable;
    const liveRounds = currentShoeRounds(reliable);
    const snapshotRounds = currentShoeRounds(canonical.canonical.snapshotRounds.filter((round) => round.sourceEvent === "roadSnapshot"));
    const tableRounds = mergeSnapshotRoadRounds(liveRounds, snapshotRounds);
    const usesSnapshotFill = tableRounds.some((round) => round.sourceEvent === "roadSnapshot");
    return sendJson(res, 200, {
      tableCode,
      quality: canonical.canonical.summary,
      source: usesSnapshotFill ? "canonical-live-with-snapshot-fill" : "canonical-live-current-shoe",
      roads: buildRoads(tableRounds),
      rounds: tableRounds.slice(-500)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/shoe") {
    const tableCode = normalizeTableCode(url.searchParams.get("tableCode"));
    if (!tableCode) return sendJson(res, 400, { error: "tableCode is required" });
    return sendJson(res, 200, {
      tableCode,
      cardModel: estimateCardModel(canonicalFor(getTableRounds(tableCode)).reliable)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/rounds") {
    try {
      const body = await parseBody(req);
      const round = roundFromInput(body);
      if (round.error) return sendJson(res, 400, round);
      const result = insertRound(round);
      if (result.inserted) logEvent("info", "manual round inserted", result.round);
      return sendJson(res, result.inserted ? 201 : 200, result);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/predict") {
    try {
      const body = await parseBody(req);
      const modelId = body.modelId || body.model || "";
      const predictionRounds = canonicalFor(rounds()).reliable;
      if (modelId) {
        return sendJson(res, 200, predictByModel(predictionRounds, body.tableCode, modelId));
      }
      return sendJson(res, 200, predictFromSequence(predictionRounds, body));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    return sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      tables: TARGET_TABLES,
      rounds: canonicalFor(rounds()).reliable
    });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    return sendJson(res, 200, { events: getEvents(url.searchParams.get("limit") || 100) });
  }

  return sendJson(res, 404, { error: "API route not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/app-config.json") {
    return void sendJson(res, 200, {
      publicApiBase: PUBLIC_API_BASE,
      tableGroups: TABLE_GROUPS,
      tables: TARGET_TABLES
    });
  }
  if (req.url.startsWith("/api/")) return void handleApi(req, res);
  serveStatic(req, res);
});

server.listen(PORT, () => {
  logEvent("info", `server started on port ${PORT}`);
  console.log(`Baijia Pro running at http://localhost:${PORT}`);
});
