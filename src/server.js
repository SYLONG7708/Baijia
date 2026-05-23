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
  logEvent
} = require("./db");
const { summarizeAll, predictFromSequence } = require("./analytics");
const { buildRoads } = require("./roads");

openDatabase();

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
    return sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      summary: summarizeAll(allRounds),
      scraper: getStatus()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/tables") {
    return sendJson(res, 200, summarizeAll(rounds()));
  }

  if (req.method === "GET" && url.pathname === "/api/rounds") {
    return sendJson(res, 200, {
      rounds: getRounds({
        tableCode: url.searchParams.get("tableCode"),
        limit: url.searchParams.get("limit") || 2000
      })
    });
  }

  if (req.method === "GET" && url.pathname === "/api/roads") {
    const tableCode = normalizeTableCode(url.searchParams.get("tableCode"));
    if (!tableCode) return sendJson(res, 400, { error: "tableCode is required" });
    const tableRounds = getTableRounds(tableCode);
    return sendJson(res, 200, {
      tableCode,
      roads: buildRoads(tableRounds),
      rounds: tableRounds.slice(-500)
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
      return sendJson(res, 200, predictFromSequence(rounds(), body));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    return sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      tables: TARGET_TABLES,
      rounds: rounds()
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
