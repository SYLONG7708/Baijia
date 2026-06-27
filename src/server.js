"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const store = require("./store");
const { buildRoads, parseBulkRounds, summarizeBasic } = require("./roads");
const { analyzePattern } = require("./analysis");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = Number(process.env.PORT || 4173);
const DEFAULT_HOST = process.env.BAIJIA_HOST || process.env.HOST || (isTruthy(process.env.BAIJIA_LAN) ? "0.0.0.0" : "127.0.0.1");
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/live", "live.html"],
  ["/live.html", "live.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/sw.js", "sw.js"],
  ["/icon.svg", "icon.svg"]
]);

function startServer(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  store.ensureStore();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const status = Number(error.statusCode || error.status || 500);
      sendJson(response, status, {
        ok: false,
        error: error.message || String(error),
        detail: error.detail || ""
      });
    });
  });
  server.listen(port, host, () => {
    console.log(`Baijia Monitor running at http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);
    if (host === "0.0.0.0" || host === "::") {
      for (const url of getLanUrls(port)) console.log(`Baijia iPhone/LAN URL: ${url}`);
    }
  });
  return server;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  serveStatic(request, response, url);
}

async function handleApi(request, response, url) {
  const method = request.method || "GET";
  const parts = url.pathname.split("/").filter(Boolean);
  const restrictPublic = isPublicViewMode() && isExternalRequest(request);

  if (method === "GET" && url.pathname === "/api/status") {
    const status = store.getStatus();
    sendJson(response, 200, restrictPublic ? sanitizePublicStatus(status) : status);
    return;
  }

  if (restrictPublic && !isPublicApiAllowed(method, url.pathname)) {
    sendJson(response, 403, { ok: false, error: "Public view mode: this API is not exposed." });
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    const hours = Number(url.searchParams.get("hours") || 24);
    sendJson(response, 200, store.getCollectorHealthSummary(hours));
    return;
  }

  if (method === "GET" && url.pathname === "/api/tables") {
    sendJson(response, 200, { ok: true, tables: store.listTables() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tables") {
    const body = await readJsonBody(request);
    const table = store.upsertTable(body);
    sendJson(response, 200, { ok: true, table });
    return;
  }

  if (method === "GET" && parts[1] === "tables" && parts[3] === "rounds") {
    const tableId = decodeURIComponent(parts[2]);
    const limit = Number(url.searchParams.get("limit") || 1000);
    const rounds = store.getRounds(tableId, limit);
    sendJson(response, 200, {
      ok: true,
      table: store.getTable(tableId),
      rounds,
      summary: summarizeBasic(rounds)
    });
    return;
  }

  if (method === "POST" && parts[1] === "tables" && parts[3] === "rounds") {
    const tableId = decodeURIComponent(parts[2]);
    const body = await readJsonBody(request);
    const round = store.addRound(tableId, body);
    sendJson(response, 200, { ok: true, round });
    return;
  }

  if (method === "POST" && parts[1] === "tables" && parts[3] === "bulk") {
    const tableId = decodeURIComponent(parts[2]);
    const body = await readJsonBody(request);
    const rounds = Array.isArray(body.rounds) ? body.rounds : parseBulkRounds(body.text || "");
    const added = store.addRounds(tableId, rounds);
    sendJson(response, 200, { ok: true, added });
    return;
  }

  if (method === "POST" && parts[1] === "tables" && parts[3] === "clear") {
    const tableId = decodeURIComponent(parts[2]);
    const deleted = store.clearTable(tableId);
    sendJson(response, 200, { ok: true, deleted });
    return;
  }

  if (method === "GET" && parts[1] === "roads") {
    const tableId = url.searchParams.get("tableId") || "";
    const rounds = store.getRounds(tableId, Number(url.searchParams.get("limit") || 1000));
    sendJson(response, 200, {
      ok: true,
      roads: buildRoads(rounds),
      summary: summarizeBasic(rounds)
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/analyze") {
    const body = await readJsonBody(request);
    const scope = body.scope === "table" ? "table" : "all";
    const localOnly = isTruthy(body.localOnly);
    const result = analyzePattern({
      sequence: body.sequence || body.text || [],
      manualSequence: body.manualSequence || body.fullSequence || body.sequence || body.text || [],
      tableId: scope === "table" ? body.tableId || "" : "",
      rounds: localOnly ? [] : store.getAnalysisRounds()
    });
    sendJson(response, 200, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/export/json") {
    sendJson(response, 200, store.readDb());
    return;
  }

  if (method === "GET" && url.pathname === "/api/export/csv") {
    const csv = store.exportCsv();
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"baijia-data.csv\""
    });
    response.end(csv);
    return;
  }

  sendJson(response, 404, { ok: false, error: "API not found" });
}

function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405);
    response.end("Method not allowed");
    return;
  }
  let relative = "";
  try {
    relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (_) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }
  const staticFile = STATIC_FILES.get(relative);
  if (!staticFile) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const target = path.resolve(ROOT, staticFile);
  const relativeToRoot = path.relative(ROOT, target);
  const outsideRoot = relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot);
  if (outsideRoot || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(target),
    "cache-control": target.endsWith("index.html") ? "no-store" : "no-cache"
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(target).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError(400, "Bad Request：JSON 格式錯誤，請確認前端送出的 body 是合法 JSON。", error.message);
  }
}

function sendJson(response, status, data) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function httpError(statusCode, message, detail = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.detail = detail;
  return error;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

function getLanUrls(port) {
  const urls = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return urls;
}

function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").trim().toLowerCase());
}

function isPublicViewMode() {
  return isTruthy(process.env.BAIJIA_PUBLIC_VIEW);
}

function isPublicApiAllowed(method, pathname) {
  if (method === "POST" && pathname === "/api/analyze") return true;
  return false;
}

function isExternalRequest(request) {
  const headers = request.headers || {};
  if (headers["cf-connecting-ip"] || headers["x-forwarded-for"] || headers["x-real-ip"]) return true;
  const address = request.socket?.remoteAddress || "";
  return !["127.0.0.1", "::1", "::ffff:127.0.0.1", ""].includes(address);
}

function sanitizePublicStatus(status) {
  const collector = status.collector || {};
  return {
    ok: true,
    publicView: true,
    tables: status.tables,
    allbetTables: status.allbetTables,
    summaryTables: status.summaryTables,
    verifiedSummaryTables: status.verifiedSummaryTables,
    unverifiedSummaryTables: status.unverifiedSummaryTables,
    rounds: status.rounds,
    snapshots: status.snapshots,
    updatedAt: status.updatedAt,
    collector: {
      lastRunAt: collector.lastRunAt || "",
      lastSuccessAt: collector.lastSuccessAt || "",
      lastMessage: collector.lastMessage || "",
      lastError: collector.lastError || "",
      streakFailures: collector.streakFailures || 0
    }
  };
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  handleRequest
};
