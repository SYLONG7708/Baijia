import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.BAIJIA_WATCH_BASE_URL || `http://127.0.0.1:${PORT}`;
const INTERVAL_MS = Number(process.env.BAIJIA_ANALYSIS_WATCH_INTERVAL_MS || 300000);
const SLOW_MS = Number(process.env.BAIJIA_ANALYSIS_SLOW_MS || 1500);
const TABLE_CODE = String(process.env.BAIJIA_WATCH_TABLE_CODE || "").trim().toUpperCase();
const ONCE = process.argv.includes("--once");
const REPORT_DIR = join(process.cwd(), "reports");
const LATEST_PATH = join(REPORT_DIR, "analysis-watchdog-latest.json");
const LOG_PATH = join(REPORT_DIR, "analysis-watchdog.ndjson");

const manualSequence = parseManualSequence(process.env.BAIJIA_WATCH_SEQUENCE) || [
  { result: "banker", bankerPair: true },
  { result: "player" },
  { result: "banker", luckySix: true },
  { result: "banker" },
  { result: "player", playerPair: true },
  { result: "tie" },
  { result: "banker" },
  { result: "player" },
  { result: "banker", bankerPair: true },
  { result: "player", luckySix: true }
];
const sequence = manualSequence.slice(-8);

mkdirSync(REPORT_DIR, { recursive: true });

do {
  const report = await runWatchdog();
  writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2), "utf8");
  appendFileSync(LOG_PATH, `${JSON.stringify(report)}\n`, "utf8");
  console.log(`${report.generatedAt} ok=${report.ok} max=${report.summary.maxMs}ms table=${report.selectedTable?.tableCode || "-"}`);
  if (ONCE) break;
  await sleep(INTERVAL_MS);
} while (true);

async function runWatchdog() {
  const generatedAt = new Date().toISOString();
  const results = [];
  const tables = await getAnalysisTables().catch((error) => {
    results.push({
      name: "analysis-tables",
      ok: false,
      ms: 0,
      error: error.message || String(error)
    });
    return [];
  });
  const selectedTable = selectTable(tables);

  results.push(await postAnalyze("all-36-recent", {
    scope: "all",
    limit: 24000,
    sequence,
    manualSequence
  }));

  if (selectedTable) {
    results.push(await postAnalyze(`table-${selectedTable.tableCode || selectedTable.id}`, {
      scope: "table",
      tableId: selectedTable.id,
      tableCode: selectedTable.tableCode,
      limit: 1800,
      sequence,
      manualSequence
    }));
  } else {
    results.push({
      name: "table-selected",
      ok: false,
      ms: 0,
      error: "No ALLBET analysis table is available."
    });
  }

  results.push(await postAnalyze("live-local-input", {
    scope: "all",
    localOnly: true,
    sequence,
    manualSequence
  }));

  const ok = results.every((item) => item.ok);
  const maxMs = Math.max(0, ...results.map((item) => Number(item.ms || 0)));
  const slow = results.filter((item) => Number(item.ms || 0) > SLOW_MS).map((item) => item.name);
  return {
    generatedAt,
    baseUrl: BASE_URL,
    ok,
    selectedTable,
    input: {
      sequence: sequence.map((round) => round.result),
      manualLength: manualSequence.length,
      hasBankerPair: manualSequence.some((round) => round.bankerPair),
      hasPlayerPair: manualSequence.some((round) => round.playerPair),
      hasLuckySix: manualSequence.some((round) => round.luckySix)
    },
    summary: {
      tests: results.length,
      passed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      maxMs,
      slowThresholdMs: SLOW_MS,
      slow
    },
    results,
    recommendations: buildRecommendations(results, slow)
  };
}

async function getAnalysisTables() {
  const response = await fetch(`${BASE_URL}/api/analysis/tables`);
  const text = await response.text();
  const json = JSON.parse(text);
  if (!response.ok || json.ok !== true) throw new Error(json.error || `HTTP ${response.status}`);
  return Array.isArray(json.tables) ? json.tables : [];
}

async function postAnalyze(name, body) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const json = JSON.parse(text);
    const ms = Date.now() - startedAt;
    const error = validateAnalysis(json);
    return {
      name,
      ok: response.ok && json.ok === true && !error,
      ms,
      runtimeMs: Number(json.runtime?.analyzeMs || 0),
      roundsLoaded: Number(json.runtime?.roundsLoaded || 0),
      datasetScope: json.dataset?.scope || "",
      datasetRounds: Number(json.dataset?.totalRounds || 0),
      next: json.nextResult ? {
        result: json.nextResult.result,
        label: json.nextResult.label,
        rate: Number(json.nextResult.rate || 0)
      } : null,
      highestRoad: json.roadBreakdown?.overall?.highest ? {
        road: json.roadBreakdown.overall.highest.roadLabel || "",
        result: json.roadBreakdown.overall.highest.result || "",
        label: json.roadBreakdown.overall.highest.label || "",
        rate: Number(json.roadBreakdown.overall.highest.rate || 0)
      } : null,
      error
    };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - startedAt,
      error: error.message || String(error)
    };
  }
}

function validateAnalysis(json = {}) {
  if (json.ok !== true) return json.error || "analysis ok is not true";
  if (json.input?.length !== 8) return "input length is not 8";
  if (!json.roadBreakdown || (json.roadBreakdown.roads || []).length !== 5) return "five-road analysis is missing";
  if (!(json.roadBreakdown.records || []).every((item) => item.manualCycleResult)) return "manual six-column cycle is missing";
  if (!(json.roadBreakdown.records || []).every((item) => Number.isFinite(Number(item.replayHitRate)))) return "replay hit rate is missing";
  if (!json.nextResult?.result) return "next result is missing";
  return "";
}

function selectTable(tables = []) {
  if (!tables.length) return null;
  if (TABLE_CODE) {
    const matched = tables.find((table) => table.tableCode === TABLE_CODE);
    if (matched) return matched;
  }
  return [...tables].sort((a, b) => Number(b.rounds || 0) - Number(a.rounds || 0))[0];
}

function parseManualSequence(value = "") {
  const text = String(value || "").trim();
  if (!text) return null;
  const tokens = text.split(/[\s,，、|]+/).filter(Boolean);
  const rounds = tokens.map((token) => {
    const result = token.includes("閒") || /^p/i.test(token)
      ? "player"
      : token.includes("和") || /^t/i.test(token)
        ? "tie"
        : token.includes("莊") || /^b/i.test(token)
          ? "banker"
          : "";
    if (!result) return null;
    return {
      result,
      bankerPair: /莊對|bp/i.test(token),
      playerPair: /閒對|pp/i.test(token),
      luckySix: /幸運6|l6/i.test(token)
    };
  }).filter(Boolean);
  return rounds.length >= 8 ? rounds : null;
}

function buildRecommendations(results, slow) {
  const items = [];
  if (slow.length) {
    items.push(`Slow analysis path detected: ${slow.join(", ")}.`);
  }
  for (const result of results) {
    if (!result.ok) items.push(`${result.name}: ${result.error || "failed"}`);
  }
  if (!items.length) {
    items.push("Current analysis paths are responding within the configured watchdog threshold.");
  }
  return items;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1000, ms)));
}
