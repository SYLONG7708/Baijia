const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { PUBLIC_DIR, PORT, API_TOKEN, PUBLIC_API_BASE } = require("./env");
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

openDatabase();

function reliableRounds(allRounds) {
  const reliable = allRounds.filter(isPredictionUsable);
  return reliable.length ? reliable : allRounds;
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

function snapshotLooksLikeNewerShoe(liveRounds, snapshotRounds) {
  if (!snapshotRounds.length || !liveRounds.length) return false;
  const snapshotFirst = Math.min(...snapshotRounds.map(roundNoOf).filter(Boolean));
  return snapshotFirst <= 3
    && maxRoundNo(snapshotRounds) + 8 < maxRoundNo(liveRounds)
    && maxId(snapshotRounds) > maxId(liveRounds);
}

function mergeSnapshotRoadRounds(liveRounds, snapshotRounds) {
  if (!snapshotRounds.length) return liveRounds;
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

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, {
      tableGroups: TABLE_GROUPS,
      tables: TARGET_TABLES,
      publicApiBase: PUBLIC_API_BASE
    });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const allRounds = rounds();
    const summaryRounds = reliableRounds(allRounds);
    return sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      summary: summarizeAll(summaryRounds),
      rawTotals: {
        allRounds: allRounds.length,
        reliableRounds: summaryRounds.length
      },
      scraper: getStatus()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/tables") {
    return sendJson(res, 200, summarizeAll(reliableRounds(rounds())));
  }

  if (req.method === "GET" && url.pathname === "/api/quality") {
    return sendJson(res, 200, buildDataQuality(rounds(), getStatus()));
  }

  if (req.method === "GET" && url.pathname === "/api/validation") {
    return sendJson(res, 200, buildValidation(rounds()));
  }

  if (req.method === "GET" && url.pathname === "/api/monitor") {
    const status = getStatus();
    return sendJson(res, 200, {
      monitor: status.monitor || {},
      monitorProcess: status.monitorProcess || {},
      scraper: status.scraper || {},
      ingest: getRoundIngestSummary()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/backtest") {
    return sendJson(res, 200, backtestPredictions(rounds(), {
      tableCode: url.searchParams.get("tableCode"),
      limit: url.searchParams.get("limit"),
      warmup: url.searchParams.get("warmup")
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    return sendJson(res, 200, buildModelSelection(rounds(), {
      limit: url.searchParams.get("limit"),
      warmup: url.searchParams.get("warmup")
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/rounds") {
    const includeSnapshots = url.searchParams.get("includeSnapshots") === "true";
    const tableCode = normalizeTableCode(url.searchParams.get("tableCode"));
    const sourceRounds = includeSnapshots
      ? getRounds({ tableCode, limit: url.searchParams.get("limit") || 2000 })
      : reliableRounds(getRounds({ tableCode, limit: url.searchParams.get("limit") || 2000 }));
    return sendJson(res, 200, {
      rounds: sourceRounds,
      source: includeSnapshots ? "all" : "reliable-live"
    });
  }

  if (req.method === "GET" && url.pathname === "/api/roads") {
    const tableCode = normalizeTableCode(url.searchParams.get("tableCode"));
    if (!tableCode) return sendJson(res, 400, { error: "tableCode is required" });
    const allTableRounds = getTableRounds(tableCode);
    const reliable = reliableRounds(allTableRounds);
    const liveRounds = currentShoeRounds(reliable);
    const snapshotRounds = currentShoeRounds(allTableRounds.filter((round) => round.sourceEvent === "roadSnapshot"));
    const tableRounds = mergeSnapshotRoadRounds(liveRounds, snapshotRounds);
    return sendJson(res, 200, {
      tableCode,
      source: snapshotRounds.length ? "snapshot-verified-current-shoe" : "reliable-live-current-shoe",
      roads: buildRoads(tableRounds),
      rounds: tableRounds.slice(-500)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/shoe") {
    const tableCode = normalizeTableCode(url.searchParams.get("tableCode"));
    if (!tableCode) return sendJson(res, 400, { error: "tableCode is required" });
    return sendJson(res, 200, {
      tableCode,
      cardModel: estimateCardModel(getTableRounds(tableCode))
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
      if (modelId) {
        return sendJson(res, 200, predictByModel(rounds(), body.tableCode, modelId));
      }
      return sendJson(res, 200, predictFromSequence(rounds(), body));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    return sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      tables: TARGET_TABLES,
      rounds: reliableRounds(rounds())
    });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    return sendJson(res, 200, { events: getEvents(url.searchParams.get("limit") || 100) });
  }

  return sendJson(res, 404, { error: "API route not found" });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return void handleApi(req, res);
  serveStatic(req, res);
});

server.listen(PORT, () => {
  logEvent("info", `server started on port ${PORT}`);
  console.log(`Baijia Pro running at http://localhost:${PORT}`);
});
