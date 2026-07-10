"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { URL } = require("node:url");
const store = require("./store");
const { buildRoads, normalizeRound, parseBulkRounds, summarizeBasic } = require("./roads");
const { analyzePattern, buildAnalysisContext } = require("./analysis");
const { runTableBacktest } = require("./backtest");
const { buildDecisionProfile } = require("./decision-profile");
const { compareOutcomeStats } = require("./accuracy-metrics");
const { buildFiveStepRisk } = require("./five-step-risk");
const { buildAdaptiveBrain } = require("./adaptive-brain");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = Number(process.env.PORT || 4173);
const DEFAULT_HOST = process.env.BAIJIA_HOST || process.env.HOST || (isTruthy(process.env.BAIJIA_LAN) ? "0.0.0.0" : "127.0.0.1");
const MAX_JSON_BODY_BYTES = Number(process.env.BAIJIA_MAX_JSON_BODY_BYTES || 256 * 1024);
const ANALYZE_SEQUENCE_LIMIT = Number(process.env.BAIJIA_ANALYZE_SEQUENCE_LIMIT || 120);
const ANALYZE_MANUAL_SEQUENCE_LIMIT = Number(process.env.BAIJIA_ANALYZE_MANUAL_SEQUENCE_LIMIT || 240);
const ANALYZE_TEXT_LIMIT = Number(process.env.BAIJIA_ANALYZE_TEXT_LIMIT || 10_000);
const ANALYZE_ALL_LIMIT_CAP = Number(process.env.BAIJIA_ANALYZE_ALL_LIMIT_CAP || 7200);
const ANALYZE_TABLE_LIMIT_CAP = Number(process.env.BAIJIA_ANALYZE_TABLE_LIMIT_CAP || 2400);
const BACKTEST_LIMIT_CAP = Number(process.env.BAIJIA_BACKTEST_LIMIT_CAP || 3600);
const SERVER_REQUEST_TIMEOUT_MS = Number(process.env.BAIJIA_SERVER_REQUEST_TIMEOUT_MS || 30_000);
const SERVER_HEADERS_TIMEOUT_MS = Number(process.env.BAIJIA_SERVER_HEADERS_TIMEOUT_MS || 15_000);
const SERVER_KEEP_ALIVE_TIMEOUT_MS = Number(process.env.BAIJIA_SERVER_KEEP_ALIVE_TIMEOUT_MS || 5_000);
const ANALYSIS_CACHE_TTL_MS = Number(process.env.BAIJIA_ANALYSIS_CACHE_TTL_MS || 30_000);
const ANALYSIS_CACHE_MAX = Number(process.env.BAIJIA_ANALYSIS_CACHE_MAX || 80);
const ANALYSIS_CONTEXT_CACHE_MAX = Number(process.env.BAIJIA_ANALYSIS_CONTEXT_CACHE_MAX || 8);
const CALIBRATION_MIN_NON_TIE = Number(process.env.BAIJIA_CALIBRATION_MIN_NON_TIE || 30);
const CALIBRATION_MIN_DELTA = Number(process.env.BAIJIA_CALIBRATION_MIN_DELTA || 0.035);
const CALIBRATION_MIN_WILSON_LOWER = Number(process.env.BAIJIA_CALIBRATION_MIN_WILSON_LOWER || 0.49);
const CALIBRATION_MIN_SIGNAL_RATE = Number(process.env.BAIJIA_CALIBRATION_MIN_SIGNAL_RATE || 0.55);
const CALIBRATION_MIN_LOWER_EDGE = Number(process.env.BAIJIA_CALIBRATION_MIN_LOWER_EDGE || -0.025);
const CALIBRATION_MIN_ROI_LOWER = Number(process.env.BAIJIA_CALIBRATION_MIN_ROI_LOWER || 0);
const EXPORT_JOB_TIMEOUT_MS = Number(process.env.BAIJIA_EXPORT_JOB_TIMEOUT_MS || 180_000);
const EXPORT_TMP_DIR = path.join(ROOT, "storage", "exports");
const CALIBRATION_PATH = path.join(ROOT, "reports", "logic-hit-rate-latest.json");
const analysisCache = new Map();
const analysisContextCache = new Map();
let strategyCalibration = { mtimeMs: 0, report: null };
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/simulator", "simulator.html"],
  ["/simulator.html", "simulator.html"],
  ["/live", "live.html"],
  ["/live.html", "live.html"],
  ["/logic", "logic.html"],
  ["/logic.html", "logic.html"],
  ["/styles.css", "styles.css"],
  ["/simulator.css", "simulator.css"],
  ["/app.js", "app.js"],
  ["/simulator.js", "simulator.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/sw.js", "sw.js"],
  ["/icon.svg", "icon.svg"]
]);
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()"
};
const STATIC_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join("; ")
};

function startServer(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  store.ensureStore();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const status = Number(error.statusCode || error.status || 500);
      const publicError = status >= 500 && isPublicViewMode() && isExternalRequest(request);
      if (status >= 500) console.error(error);
      sendJson(response, status, {
        ok: false,
        error: publicError ? "Internal server error" : error.message || String(error),
        detail: publicError ? "" : error.detail || ""
      });
    });
  });
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
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

  if (method === "GET" && url.pathname === "/api/ping") {
    const memory = process.memoryUsage();
    sendJson(response, 200, {
      ok: true,
      service: "baijia-monitor",
      now: new Date().toISOString(),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external
      }
    });
    return;
  }

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

  if (method === "GET" && url.pathname === "/api/analysis/tables") {
    sendJson(response, 200, { ok: true, tables: store.getAnalysisTableOptions() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/analysis/backtest") {
    const body = normalizeBacktestBody(await readJsonBody(request));
    const selectedTable = resolveAnalysisTable(body.tableId, body.tableCode);
    if (!selectedTable) {
      sendJson(response, 400, { ok: false, error: "Analysis table not found." });
      return;
    }
    const limit = body.limit;
    const rounds = store.getAnalysisRounds({
      tableId: selectedTable.id,
      tableCode: selectedTable.tableCode,
      limit
    });
    const result = runTableBacktest({
      table: selectedTable,
      rounds,
      windowSize: body.windowSize,
      maxChecks: body.maxChecks,
      detailLimit: body.detailLimit,
      specialThreshold: body.specialThreshold,
      historyLimit: body.historyLimit,
      manualHistoryLimit: body.manualHistoryLimit
    });
    sendJson(response, 200, result);
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
    const body = normalizeAnalyzeBody(await readJsonBody(request));
    const startedAt = Date.now();
    const scope = body.scope === "table" ? "table" : "all";
    const localOnly = body.localOnly;
    const analysisVersion = localOnly ? "local" : store.getAnalysisVersion();
    const calibrationVersion = getStrategyCalibrationVersion();
    const preliminaryCacheKey = buildAnalysisCacheKey({
      body,
      scope,
      localOnly,
      tableId: scope === "table" ? body.tableId || "" : "",
      tableCode: scope === "table" ? body.tableCode || "" : "",
      dataVersion: analysisVersion,
      calibrationVersion
    });
    const preliminaryCached = getAnalysisCache(preliminaryCacheKey);
    if (preliminaryCached) {
      preliminaryCached.runtime = {
        ...preliminaryCached.runtime,
        analyzeMs: Date.now() - startedAt,
        cacheHit: true,
        earlyCacheHit: true
      };
      sendJson(response, 200, preliminaryCached);
      return;
    }
    const selectedTable = scope === "table" && !localOnly
      ? resolveAnalysisTable(body.tableId, body.tableCode)
      : null;
    const analysisRounds = localOnly ? [] : store.getAnalysisRounds({
      tableId: selectedTable?.id || (scope === "table" ? body.tableId || "" : ""),
      tableCode: selectedTable?.tableCode || (scope === "table" ? body.tableCode || "" : ""),
      limit: Number(body.limit || 0)
    });
    const runtimeBase = {
      roundsLoaded: analysisRounds.length,
      localOnly,
      scope: selectedTable ? "table" : scope,
      tableId: selectedTable?.id || (scope === "table" ? body.tableId || "" : ""),
      tableCode: selectedTable?.tableCode || (scope === "table" ? body.tableCode || "" : "")
    };
    const cacheKey = buildAnalysisCacheKey({
      body,
      scope: runtimeBase.scope,
      localOnly,
      tableId: runtimeBase.tableId,
      tableCode: runtimeBase.tableCode,
      rounds: analysisRounds,
      dataVersion: analysisVersion,
      calibrationVersion
    });
    const cached = getAnalysisCache(cacheKey);
    if (cached) {
      cached.runtime = {
        ...cached.runtime,
        ...runtimeBase,
        analyzeMs: Date.now() - startedAt,
        cacheHit: true
      };
      sendJson(response, 200, cached);
      return;
    }
    const contextKey = buildAnalysisContextKey({
      scope: runtimeBase.scope,
      localOnly,
      tableId: runtimeBase.tableId,
      tableCode: runtimeBase.tableCode,
      dataVersion: analysisVersion,
      rounds: analysisRounds
    });
    const contextState = localOnly
      ? { context: null, contextCacheHit: false, contextBuildMs: 0 }
      : getAnalysisContext(contextKey, analysisRounds, { tableId: runtimeBase.tableId });
    const result = analyzePattern({
      sequence: body.sequence || body.text || [],
      manualSequence: body.manualSequence || body.fullSequence || body.sequence || body.text || [],
      tableId: selectedTable?.id || (scope === "table" ? body.tableId || "" : ""),
      rounds: analysisRounds,
      context: contextState.context
    });
    result.runtime = {
      analyzeMs: Date.now() - startedAt,
      ...runtimeBase,
      cacheHit: false,
      contextCacheHit: contextState.contextCacheHit,
      contextBuildMs: contextState.contextBuildMs,
      indexed: Boolean(contextState.context?.predictionIndex)
    };
    const calibrationContext = buildStrategyCalibrationContext(loadStrategyCalibration(), runtimeBase);
    result.strategyCalibration = calibrationContext;
    applyStrategyCalibration(result, runtimeBase);
    result.adaptiveBrain = buildAdaptiveBrain({
      analysis: result,
      inputRounds: body.manualSequence || body.fullSequence || body.sequence || body.text || [],
      historyGroups: contextState.context?.historyGroups,
      allRounds: analysisRounds,
      calibration: calibrationContext
    });
    applyAdaptivePreferred(result);
    const adaptiveTarget = result.adaptiveBrain?.selected?.result || result.roadBreakdown?.overall?.preferred?.result || result.nextResult?.result;
    result.fiveStepRisk = result.adaptiveBrain?.riskByResult?.[adaptiveTarget] || buildFiveStepRisk({
      inputRounds: body.manualSequence || body.fullSequence || body.sequence || body.text || [],
      historyGroups: contextState.context?.historyGroups,
      allRounds: analysisRounds,
      targetResult: adaptiveTarget,
      maxBets: 5,
      windowSize: 8
    });
    result.decisionProfile = buildDecisionProfile(result);
    result.warnings = buildAnalysisWarnings(result);
    setAnalysisCache(cacheKey, result);
    if (cacheKey !== preliminaryCacheKey) setAnalysisCache(preliminaryCacheKey, result);
    sendJson(response, 200, result);
    return;
  }

  if (method === "GET" && url.pathname === "/api/export/json") {
    await streamJsonExport(response);
    return;
  }

  if (method === "GET" && url.pathname === "/api/export/csv") {
    await streamCsvExport(response);
    return;
  }

  sendJson(response, 404, { ok: false, error: "API not found" });
}

function buildAnalysisWarnings(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings.slice() : [];
  const qualityRead = result?.decisionProfile?.action === "observe" ? result.decisionProfile.read : "";
  if (qualityRead && !warnings.includes(qualityRead)) warnings.push(qualityRead);
  return warnings.slice(0, 8);
}

async function streamJsonExport(response) {
  const stat = fs.statSync(store.DB_PATH);
  await streamFile(response, store.DB_PATH, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": "attachment; filename=\"baijia-data.json\"",
    "content-length": String(stat.size)
  });
}

async function streamCsvExport(response) {
  const filePath = await createCsvExportFile();
  try {
    const stat = fs.statSync(filePath);
    await streamFile(response, filePath, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"baijia-data.csv\"",
      "content-length": String(stat.size)
    });
  } finally {
    fs.promises.unlink(filePath).catch(() => {});
  }
}

function createCsvExportFile() {
  fs.mkdirSync(EXPORT_TMP_DIR, { recursive: true });
  const filePath = path.join(EXPORT_TMP_DIR, `baijia-export-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  const script = path.join(ROOT, "scripts", "export-data.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--format", "csv", "--output", filePath], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(httpError(503, "CSV export timed out."));
    }, EXPORT_JOB_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(httpError(500, "CSV export failed to start.", error.message));
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(filePath);
        return;
      }
      fs.promises.unlink(filePath).catch(() => {});
      reject(httpError(500, "CSV export failed.", stderr || `exit=${code}, signal=${signal || ""}`));
    });
  });
}

async function streamFile(response, filePath, headers) {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    ...headers,
    "cache-control": "no-store"
  });
  await pipeline(fs.createReadStream(filePath), response);
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
    ...STATIC_SECURITY_HEADERS,
    "content-type": contentType(target),
    "cache-control": target.endsWith(".html") ? "no-store" : "no-cache"
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(target).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw httpError(413, `Request body too large. Max ${MAX_JSON_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError(400, "Bad Request：JSON 格式錯誤，請確認前端送出的 body 是合法 JSON。", error.message);
  }
}

function normalizeAnalyzeBody(body = {}) {
  const scope = body.scope === "table" ? "table" : "all";
  const limitCap = scope === "table" ? ANALYZE_TABLE_LIMIT_CAP : ANALYZE_ALL_LIMIT_CAP;
  const sequenceInput = body.sequence ?? body.text ?? [];
  const manualInput = body.manualSequence ?? body.fullSequence ?? sequenceInput;
  return {
    ...body,
    scope,
    localOnly: isTruthy(body.localOnly),
    tableId: safeText(body.tableId, 160),
    tableCode: safeTableCode(body.tableCode),
    limit: safeInteger(body.limit, 0, limitCap, scope === "table" ? 1200 : 7200),
    sequence: normalizeAnalyzeInput(sequenceInput, ANALYZE_SEQUENCE_LIMIT),
    manualSequence: normalizeAnalyzeInput(manualInput, ANALYZE_MANUAL_SEQUENCE_LIMIT),
    text: ""
  };
}

function normalizeBacktestBody(body = {}) {
  return {
    ...body,
    tableId: safeText(body.tableId, 160),
    tableCode: safeTableCode(body.tableCode),
    limit: safeInteger(body.limit, 1, BACKTEST_LIMIT_CAP, 2400),
    windowSize: safeInteger(body.windowSize, 4, 20, 8),
    maxChecks: safeInteger(body.maxChecks, 1, 500, 120),
    detailLimit: safeInteger(body.detailLimit, 0, 200, 40),
    specialThreshold: clampNumber(Number(body.specialThreshold || 0.12), 0, 1),
    historyLimit: safeInteger(body.historyLimit, 0, 5000, 0),
    manualHistoryLimit: safeInteger(body.manualHistoryLimit, 0, 1000, 0)
  };
}

function normalizeAnalyzeInput(value, limit) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRound(item)).filter(Boolean).slice(-limit);
  }
  if (typeof value === "string") {
    return parseBulkRounds(value.slice(-ANALYZE_TEXT_LIMIT)).slice(-limit);
  }
  const round = normalizeRound(value);
  return round ? [round] : [];
}

function safeText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

function safeTableCode(value) {
  const match = safeText(value, 40).toUpperCase().match(/\b(?:IB\d{3}|[BQCV]\d{3})\b/);
  return match ? match[0] : "";
}

function safeInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(clampNumber(number, min, max));
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sendJson(response, status, data) {
  if (response.headersSent) return;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function buildAnalysisContextKey({ scope, localOnly, tableId, tableCode, rounds = [], dataVersion = "" }) {
  if (localOnly) return "";
  return stableStringify({
    scope,
    tableId,
    tableCode,
    roundFingerprint: dataVersion || fingerprintRounds(rounds)
  });
}

function getAnalysisContext(key, rounds, options = {}) {
  if (!key) {
    return { context: null, contextCacheHit: false, contextBuildMs: 0 };
  }
  const cached = analysisContextCache.get(key);
  if (cached) {
    analysisContextCache.delete(key);
    analysisContextCache.set(key, cached);
    return {
      context: cached,
      contextCacheHit: true,
      contextBuildMs: 0
    };
  }
  const startedAt = Date.now();
  const context = buildAnalysisContext(rounds, options);
  const contextBuildMs = Date.now() - startedAt;
  analysisContextCache.set(key, context);
  while (analysisContextCache.size > ANALYSIS_CONTEXT_CACHE_MAX) {
    const oldest = analysisContextCache.keys().next().value;
    analysisContextCache.delete(oldest);
  }
  return {
    context,
    contextCacheHit: false,
    contextBuildMs
  };
}

function buildAnalysisCacheKey({ body, scope, localOnly, tableId, tableCode, rounds = [], dataVersion = "", calibrationVersion }) {
  return stableStringify({
    scope,
    localOnly,
    tableId,
    tableCode,
    limit: Number(body.limit || 0),
    sequence: body.sequence || body.text || [],
    manualSequence: body.manualSequence || body.fullSequence || body.sequence || body.text || [],
    roundFingerprint: dataVersion || fingerprintRounds(rounds),
    calibrationVersion
  });
}

function getStrategyCalibrationVersion() {
  try {
    return fs.statSync(CALIBRATION_PATH).mtimeMs;
  } catch (_) {
    return 0;
  }
}

function loadStrategyCalibration() {
  const mtimeMs = getStrategyCalibrationVersion();
  if (!mtimeMs) return null;
  if (strategyCalibration.report && strategyCalibration.mtimeMs === mtimeMs) return strategyCalibration.report;
  try {
    strategyCalibration = {
      mtimeMs,
      report: JSON.parse(fs.readFileSync(CALIBRATION_PATH, "utf8"))
    };
    return strategyCalibration.report;
  } catch (_) {
    return null;
  }
}

function applyStrategyCalibration(result, runtime) {
  const report = loadStrategyCalibration();
  const overall = result?.roadBreakdown?.overall;
  if (!report || !overall) return;
  const row = runtime?.scope === "table"
    ? (report.rows || []).find((item) => item.tableCode === runtime.tableCode)
    : null;
  const tableSelected = row ? selectTableCalibratedStrategy(row) : null;
  const aggregateSelected = selectAggregateCalibratedStrategy(report.aggregate);
  const selected = tableSelected || aggregateSelected;
  if (!selected?.key) return;
  const candidate = candidatePredictionForStrategy(result, selected.key);
  if (!["banker", "player"].includes(candidate?.result)) return;
  overall.preferred = {
    ...candidate,
    strategy: `calibrated-${selected.key}`,
    basis: "latest backtest calibration",
    backtest: {
      key: selected.key,
      nonTieChecked: selected.nonTieChecked,
      nonTieHitRate: selected.nonTieHitRate,
      nonTieWilsonLower: selected.nonTieWilsonLower || 0,
      baselineNonTieHitRate: selected.baselineNonTieHitRate || 0,
      lowerEdgeVsBaseline: selected.lowerEdgeVsBaseline || 0,
      signalRate: selected.signalRate || 0,
      selectionScore: selected.selectionScore || 0,
      roi: selected.roi || 0,
      roiLower95: selected.roiLower95 || 0,
      roiLiftVsBanker: selected.roiLiftVsBanker || 0,
      brierScore: selected.brierScore || 0,
      brierSkill: selected.brierSkill || 0,
      delta: selected.delta || 0,
      scope: tableSelected ? "table" : "aggregate"
    }
  };
  result.calibration = overall.preferred.backtest;
}

function buildStrategyCalibrationContext(report, runtime) {
  if (!report || typeof report !== "object") return null;
  const row = runtime?.scope === "table"
    ? (report.rows || []).find((item) => item.tableCode === runtime.tableCode)
    : null;
  const aggregateStrategies = report.aggregate?.strategies || {};
  const rowStrategies = row?.strategies || {};
  const keys = ["onlineEnsemble", "mainNextResult", "advancedHighestRoad", "instantVerifiedCurrent", "evidenceWeighted", "fiveRoadConsensus"];
  const strategies = Object.fromEntries(keys.map((key) => [
    key,
    normalizeCalibrationStat(rowStrategies[key] || aggregateStrategies[key] || null, rowStrategies[key] ? "table" : "aggregate")
  ]).filter(([, value]) => value));
  return {
    generatedAt: report.generatedAt || "",
    scope: row ? "table" : "aggregate",
    tableCode: row?.tableCode || runtime?.tableCode || "",
    strategies,
    bestStrategy: normalizeCalibrationStat(row?.bestStrategy || report.aggregate?.bestOverall || null, row?.bestStrategy ? "table" : "aggregate"),
    bestRoad: normalizeCalibrationStat(row?.bestRoad || null, "table"),
    bestManualCycle: normalizeCalibrationStat(row?.bestManualCycle || null, "table"),
    aggregateBest: normalizeCalibrationStat(report.aggregate?.bestOverall || null, "aggregate")
  };
}

function normalizeCalibrationStat(stat, scope = "") {
  if (!stat || typeof stat !== "object") return null;
  return {
    ...stat,
    scope,
    key: stat.key || "",
    nonTieChecked: Number(stat.nonTieChecked || 0),
    nonTieHitRate: Number(stat.nonTieHitRate || 0),
    nonTieWilsonLower: Number(stat.nonTieWilsonLower || 0),
    baselineNonTieHitRate: Number(stat.baselineNonTieHitRate || 0),
    lowerEdgeVsBaseline: Number(stat.lowerEdgeVsBaseline || 0),
    signalRate: Number(stat.signalRate || 0),
    selectionScore: Number(stat.selectionScore || 0),
    fiveStepWilsonLower: Number(stat.fiveStepWilsonLower || 0),
    fiveStepFailureRate: Number(stat.fiveStepFailureRate || 0),
    fiveStepBaselineCompletionRate: Number(stat.fiveStepBaselineCompletionRate || 0),
    fiveStepLiftVsNatural: Number(stat.fiveStepLiftVsNatural || 0),
    roi: Number(stat.roi || 0),
    roiLower95: Number(stat.roiLower95 || 0),
    roiLiftVsBanker: Number(stat.roiLiftVsBanker || 0),
    brierScore: Number(stat.brierScore || 0),
    brierSkill: Number(stat.brierSkill || 0),
    logLoss: Number(stat.logLoss || 0)
  };
}

function applyAdaptivePreferred(result) {
  const brain = result?.adaptiveBrain;
  const overall = result?.roadBreakdown?.overall;
  const selected = brain?.selected;
  if (!overall || brain?.action !== "advise" || !["banker", "player"].includes(selected?.result)) return;
  overall.preferred = {
    result: selected.result,
    label: selected.resultLabel || (selected.result === "banker" ? "莊" : "閒"),
    rate: selected.rate,
    basis: brain.read || "adaptive strategy brain",
    strategy: `adaptive-${selected.key}`,
    adaptiveScore: selected.score,
    backtest: selected.calibrationKey ? {
      key: selected.calibrationKey,
      nonTieWilsonLower: selected.calibrationLower || 0,
      lowerEdgeVsBaseline: selected.lowerEdgeVsBaseline || 0,
      roi: selected.roi || 0,
      roiLower95: selected.roiLower95 || 0,
      scope: result.strategyCalibration?.scope || ""
    } : null
  };
}

function selectTableCalibratedStrategy(row = {}) {
  const best = selectBestCalibratedEntry(row.strategies, CALIBRATION_MIN_NON_TIE) || row.bestStrategy || {};
  const current = row.strategies?.instantVerifiedCurrent || row.strategies?.fiveRoadConsensus || {};
  const delta = Number(best.nonTieHitRate || 0) - Number(current.nonTieHitRate || 0);
  const conservativeDelta = Number(best.nonTieWilsonLower || 0) - Number(current.nonTieWilsonLower || 0);
  if (
    passesCalibrationQuality(best, { minNonTie: CALIBRATION_MIN_NON_TIE })
    && (
      ["instantVerifiedCurrent", "fiveRoadConsensus"].includes(best.key)
      || conservativeDelta >= Math.max(0.008, CALIBRATION_MIN_DELTA * 0.35)
      || delta >= CALIBRATION_MIN_DELTA
    )
  ) {
    return { ...best, delta, conservativeDelta };
  }
  return null;
}

function selectAggregateCalibratedStrategy(aggregate = {}) {
  const best = selectBestCalibratedEntry(aggregate?.strategies, 800) || aggregate?.bestOverall || {};
  if (!passesCalibrationQuality(best, { minNonTie: 800, minWilsonLower: 0.495, minLowerEdge: -0.018 })) return null;
  if (!["onlineEnsemble", "mainNextResult", "advancedHighestRoad", "instantVerifiedCurrent", "evidenceWeighted", "fiveRoadConsensus"].includes(best.key)) return null;
  if (Number(best.nonTieHitRate || 0) < 0.505) return null;
  return best;
}

function selectBestCalibratedEntry(statsByKey = {}, minNonTie = 0) {
  return Object.entries(statsByKey || {})
    .map(([key, stat]) => ({ key, ...stat }))
    .filter((stat) => Number(stat.nonTieChecked || 0) >= minNonTie)
    .sort(compareOutcomeStats)[0] || null;
}

function passesCalibrationQuality(stat = {}, options = {}) {
  const minNonTie = Number(options.minNonTie || CALIBRATION_MIN_NON_TIE);
  const minWilsonLower = Number(options.minWilsonLower || CALIBRATION_MIN_WILSON_LOWER);
  const minSignalRate = Number(options.minSignalRate || CALIBRATION_MIN_SIGNAL_RATE);
  const minLowerEdge = Number(options.minLowerEdge || CALIBRATION_MIN_LOWER_EDGE);
  if (Number(stat.nonTieChecked || 0) < minNonTie) return false;
  if (Number(stat.signalRate || 0) < minSignalRate) return false;
  if (Number(stat.nonTieWilsonLower || 0) < minWilsonLower) return false;
  if (Number(stat.lowerEdgeVsBaseline || 0) < minLowerEdge) return false;
  if (Number(stat.roiLower95 || 0) <= CALIBRATION_MIN_ROI_LOWER) return false;
  return true;
}

function candidatePredictionForStrategy(result, key) {
  const overall = result?.roadBreakdown?.overall || {};
  if (key === "onlineEnsemble") return result?.ensembleBrain?.directional || null;
  if (key === "mainNextResult") return sideNormalizedPrediction(result?.nextResult, result?.resultRates);
  if (key === "advancedHighestRoad") return overall.highest || null;
  if (key === "evidenceWeighted") return overall.recommended || null;
  if (key === "fiveRoadConsensus") return overall.consensus || null;
  if (key === "instantVerifiedCurrent") return overall.preferred || overall.consensus || overall.highest || result?.nextResult || null;
  return null;
}

function sideNormalizedPrediction(item, resultRates = []) {
  if (!item) return null;
  const result = item.result || item.key;
  if (!["banker", "player"].includes(result)) return item;
  const rates = new Map((Array.isArray(resultRates) ? resultRates : []).map((rate) => [rate.result || rate.key, Number(rate.rate || 0)]));
  const banker = rates.get("banker") || 0;
  const player = rates.get("player") || 0;
  const total = banker + player;
  if (total <= 0 || !Number.isFinite(rates.get(result))) return item;
  return {
    ...item,
    rawRate: Number(item.rate || 0),
    rate: clampNumber(rates.get(result) / total, 0, 0.95),
    basis: `${item.basis || item.description || "歷史下一手"}；莊閒正規化`
  };
}

function fingerprintRounds(rounds = []) {
  const first = rounds[0] || {};
  const last = rounds.at(-1) || {};
  return [
    rounds.length,
    first.id || "",
    first.observedAt || first.createdAt || "",
    last.id || "",
    last.observedAt || last.createdAt || "",
    last.tableId || "",
    last.shoe || "",
    last.handNumber || ""
  ].join("|");
}

function getAnalysisCache(key) {
  if (!key || ANALYSIS_CACHE_TTL_MS <= 0) return null;
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ANALYSIS_CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }
  analysisCache.delete(key);
  analysisCache.set(key, entry);
  return cloneJson(entry.value);
}

function setAnalysisCache(key, value) {
  if (!key || ANALYSIS_CACHE_TTL_MS <= 0 || ANALYSIS_CACHE_MAX <= 0) return;
  analysisCache.set(key, { at: Date.now(), value: cloneJson(value) });
  while (analysisCache.size > ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next().value;
    analysisCache.delete(oldest);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
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
  if (method === "GET" && pathname === "/api/ping") return true;
  if (method === "POST" && pathname === "/api/analyze") return true;
  if (method === "GET" && pathname === "/api/analysis/tables") return true;
  return false;
}

function resolveAnalysisTable(tableId = "", tableCode = "") {
  const id = String(tableId || "").trim();
  const code = String(tableCode || "").trim().toUpperCase();
  if (!id && !code) return null;
  return store.getAnalysisTableOptions().find((table) => (
    (id && table.id === id) ||
    (code && table.tableCode === code)
  )) || null;
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
