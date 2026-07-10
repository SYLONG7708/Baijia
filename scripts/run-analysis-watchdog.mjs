import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.BAIJIA_WATCH_BASE_URL || `http://127.0.0.1:${PORT}`;
const INTERVAL_MS = Number(process.env.BAIJIA_ANALYSIS_WATCH_INTERVAL_MS || 300000);
const SLOW_MS = Number(process.env.BAIJIA_ANALYSIS_SLOW_MS || 1500);
const TABLE_CODE = String(process.env.BAIJIA_WATCH_TABLE_CODE || "").trim().toUpperCase();
const BACKTEST_CHECKS = Number(process.env.BAIJIA_WATCH_BACKTEST_CHECKS || 60);
const ANALYZE_ALL_LIMIT = Number(process.env.BAIJIA_WATCH_ANALYZE_ALL_LIMIT || 7200);
const ANALYZE_TABLE_LIMIT = Number(process.env.BAIJIA_WATCH_ANALYZE_TABLE_LIMIT || 1200);
const BACKTEST_HISTORY_LIMIT = Number(process.env.BAIJIA_WATCH_BACKTEST_HISTORY_LIMIT || 480);
const BACKTEST_MANUAL_HISTORY_LIMIT = Number(process.env.BAIJIA_WATCH_BACKTEST_MANUAL_HISTORY_LIMIT || 8);
const REQUEST_RETRIES = Number(process.env.BAIJIA_WATCH_RETRIES || 2);
const RETRY_DELAY_MS = Number(process.env.BAIJIA_WATCH_RETRY_DELAY_MS || 1500);
const ONCE = process.argv.includes("--once");
const REPORT_DIR = join(process.cwd(), "reports");
const LATEST_PATH = join(REPORT_DIR, "analysis-watchdog-latest.json");
const LOG_PATH = join(REPORT_DIR, "analysis-watchdog.ndjson");

const manualSequence = parseManualSequence(process.env.BAIJIA_WATCH_SEQUENCE) || [
  { result: "banker", bankerPair: true, bankerCards: ["8", "8"], playerCards: ["K", "5"], bankerPoints: 6, playerPoints: 5 },
  { result: "player", bankerCards: ["4", "Q"], playerCards: ["7", "2"], bankerPoints: 4, playerPoints: 9 },
  { result: "banker", luckySix: true, bankerCards: ["3", "3"], playerCards: ["10", "5"], bankerPoints: 6, playerPoints: 5 },
  { result: "banker", bankerCards: ["9", "1"], playerCards: ["2", "6"], bankerPoints: 0, playerPoints: 8 },
  { result: "player", playerPair: true, bankerCards: ["5", "K"], playerCards: ["6", "6"], bankerPoints: 5, playerPoints: 2 },
  { result: "tie", bankerCards: ["7", "2"], playerCards: ["4", "5"], bankerPoints: 9, playerPoints: 9 },
  { result: "banker", bankerCards: ["1", "5"], playerCards: ["2", "3"], bankerPoints: 6, playerPoints: 5 },
  { result: "player", bankerCards: ["J", "4"], playerCards: ["8", "1"], bankerPoints: 4, playerPoints: 9 },
  { result: "banker", bankerPair: true, bankerCards: ["2", "2"], playerCards: ["3", "K"], bankerPoints: 4, playerPoints: 3 },
  { result: "player", bankerCards: ["6", "Q"], playerCards: ["9", "K"], bankerPoints: 6, playerPoints: 9 }
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
    limit: ANALYZE_ALL_LIMIT,
    sequence,
    manualSequence
  }));

  if (selectedTable) {
    results.push(await postAnalyze(`table-${selectedTable.tableCode || selectedTable.id}`, {
      scope: "table",
      tableId: selectedTable.id,
      tableCode: selectedTable.tableCode,
      limit: ANALYZE_TABLE_LIMIT,
      sequence,
      manualSequence
    }));
    results.push(await postBacktest(`backtest-${selectedTable.tableCode || selectedTable.id}`, {
      tableId: selectedTable.id,
      tableCode: selectedTable.tableCode,
      limit: ANALYZE_TABLE_LIMIT,
      maxChecks: BACKTEST_CHECKS,
      detailLimit: 8,
      historyLimit: BACKTEST_HISTORY_LIMIT,
      manualHistoryLimit: BACKTEST_MANUAL_HISTORY_LIMIT
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
      hasLuckySix: manualSequence.some((round) => round.luckySix),
      hasCards: manualSequence.some((round) => (round.bankerCards || []).length || (round.playerCards || []).length)
    },
    summary: {
      tests: results.length,
      passed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      maxMs,
      slowThresholdMs: SLOW_MS,
      slow,
      backtestChecks: BACKTEST_CHECKS
    },
    results,
    recommendations: buildRecommendations(results, slow)
  };
}

async function postBacktest(name, body) {
  const startedAt = Date.now();
  let firstError = "";
  for (let attempt = 1; attempt <= REQUEST_RETRIES + 1; attempt += 1) {
    const result = await postBacktestOnce(name, body, startedAt, attempt, firstError);
    if (result.ok || attempt > REQUEST_RETRIES) return result;
    firstError = firstError || result.error || "";
    await sleep(RETRY_DELAY_MS);
  }
}

async function postBacktestOnce(name, body, startedAt, attempt, firstError = "") {
  try {
    const response = await fetch(`${BASE_URL}/api/analysis/backtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const json = JSON.parse(text);
    const ms = Date.now() - startedAt;
    const error = validateBacktest(json);
    return {
      name,
      ok: response.ok && json.ok === true && !error,
      ms,
      runtimeMs: Number(json.runtimeMs || 0),
      checkedWindows: Number(json.sample?.checkedWindows || 0),
      currentNonTieHitRate: Number(json.summary?.currentStrategy?.nonTieHitRate || 0),
      evidenceWeightedNonTieHitRate: Number(json.summary?.evidenceWeighted?.nonTieHitRate || 0),
      cardModelNonTieHitRate: Number(json.summary?.cardModel?.nonTieHitRate || 0),
      cardModelChecked: Number(json.summary?.cardModel?.checked || 0),
      improvement: json.improvement || null,
      bestRoad: json.summary?.bestRoad ? {
        key: json.summary.bestRoad.key,
        label: json.summary.bestRoad.label,
        nonTieHitRate: Number(json.summary.bestRoad.nonTieHitRate || 0),
        nonTieChecked: Number(json.summary.bestRoad.nonTieChecked || 0)
      } : null,
      attempts: attempt,
      firstError,
      error
    };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - startedAt,
      attempts: attempt,
      firstError,
      error: error.message || String(error)
    };
  }
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
  let firstError = "";
  for (let attempt = 1; attempt <= REQUEST_RETRIES + 1; attempt += 1) {
    const result = await postAnalyzeOnce(name, body, startedAt, attempt, firstError);
    if (result.ok || attempt > REQUEST_RETRIES) return result;
    firstError = firstError || result.error || "";
    await sleep(RETRY_DELAY_MS);
  }
}

async function postAnalyzeOnce(name, body, startedAt, attempt, firstError = "") {
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
      decision: json.decisionProfile ? {
        action: json.decisionProfile.action || "",
        result: json.decisionProfile.result || "",
        label: json.decisionProfile.label || "",
        rate: Number(json.decisionProfile.rate || 0),
        score: Number(json.decisionProfile.score || 0),
        level: json.decisionProfile.level || "",
        agreement: Number(json.decisionProfile.agreement || 0)
      } : null,
      ensemble: json.ensembleBrain ? {
        action: json.ensembleBrain.action || "",
        direction: json.ensembleBrain.directional?.result || "",
        rate: Number(json.ensembleBrain.directional?.rate || 0),
        validationChecks: Number(json.ensembleBrain.validation?.checks || 0),
        validationApproved: Boolean(json.ensembleBrain.validation?.approved),
        brierSkill: Number(json.ensembleBrain.validation?.brierSkill || 0),
        drift: Boolean(json.ensembleBrain.drift?.detected)
      } : null,
      highestRoad: json.roadBreakdown?.overall?.highest ? {
        road: json.roadBreakdown.overall.highest.roadLabel || "",
        result: json.roadBreakdown.overall.highest.result || "",
        label: json.roadBreakdown.overall.highest.label || "",
        rate: Number(json.roadBreakdown.overall.highest.rate || 0)
      } : null,
      cardModel: json.cardModel ? {
        usable: Boolean(json.cardModel.usable),
        seenCards: Number(json.cardModel.seenCards || 0),
        remainingCards: Number(json.cardModel.remainingCards || 0),
        top: json.cardModel.top ? {
          result: json.cardModel.top.result,
          label: json.cardModel.top.label,
          rate: Number(json.cardModel.top.rate || 0)
        } : null
      } : null,
      attempts: attempt,
      firstError,
      error
    };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - startedAt,
      attempts: attempt,
      firstError,
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
  if (!json.decisionProfile?.action) return "decision profile is missing";
  if (!["advise", "observe"].includes(json.decisionProfile.action)) return "decision profile action is invalid";
  if (!Number.isFinite(Number(json.decisionProfile.score))) return "decision profile score is missing";
  if (!json.decisionProfile?.sample || !json.decisionProfile?.evidence) return "decision profile sample/evidence blocks are missing";
  if (json.ensembleBrain?.source !== "leakage-safe-online-ensemble") return "online ensemble is missing";
  if (json.ensembleBrain?.validation?.leakageSafe !== true) return "ensemble leakage-safe validation is missing";
  if (!json.ensembleBrain?.directional?.result) return "ensemble every-hand direction is missing";
  if ((json.ensembleBrain?.experts || []).length !== 18) return "ensemble expert set is incomplete";
  if (!Number.isFinite(Number(json.fiveStepRisk?.baselineCompletionRate))) return "five-step natural baseline is missing";
  if (json.cardModel?.usable !== true) return "eight-deck card model is not active";
  if (Number(json.cardModel?.seenCards || 0) <= 0) return "card model did not count any input cards";
  if ((json.cardModel?.rates || []).length !== 6) return "card model six probability rates are missing";
  return "";
}

function validateBacktest(json = {}) {
  if (json.ok !== true) return json.error || "backtest ok is not true";
  if (Number(json.sample?.checkedWindows || 0) <= 0) return "backtest checked no windows";
  if (!json.summary?.currentStrategy) return "backtest current strategy summary missing";
  if (!json.summary?.evidenceWeighted) return "backtest evidence-weighted summary missing";
  if (!json.summary?.onlineEnsemble) return "backtest online ensemble summary missing";
  if (!Number.isFinite(Number(json.summary.onlineEnsemble.roiLower95))) return "backtest ROI lower bound missing";
  if (!Number.isFinite(Number(json.summary.onlineEnsemble.brierScore))) return "backtest Brier score missing";
  if (!json.roads || Object.keys(json.roads).length !== 5) return "backtest five-road stats missing";
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
  const backtest = results.find((item) => String(item.name || "").startsWith("backtest-"));
  if (backtest?.improvement?.action === "candidate-improvement") {
    items.push(backtest.improvement.read);
  }
  return items;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1000, ms)));
}
