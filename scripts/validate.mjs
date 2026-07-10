import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const required = [
  "index.html",
  "live.html",
  "logic.html",
  "simulator.html",
  "styles.css",
  "simulator.css",
  "app.js",
  "simulator.js",
  "manifest.webmanifest",
  "sw.js",
  "icon.svg",
  "src/server.js",
  "src/store.js",
  "src/roads.js",
  "src/analysis.js",
  "src/decision-profile.js",
  "src/adaptive-brain.js",
  "src/accuracy-metrics.js",
  "src/five-step-risk.js",
  "src/prediction-index.js",
  "src/card-model.js",
  "src/backtest.js",
  "src/advanced-analysis.js",
  "src/road-breakdown.js",
  "src/collector.js",
  "src/daemon.js",
  "src/backup.js",
  "scripts/run-daemon.ps1",
  "scripts/start-public-tunnel.ps1",
  "scripts/check-public-tunnel.ps1",
  "scripts/install-windows-task.ps1",
  "scripts/uninstall-windows-task.ps1",
  "scripts/install-public-tunnel-watchdog-task.ps1",
  "scripts/uninstall-public-tunnel-watchdog-task.ps1",
  "scripts/backup-db.mjs",
  "scripts/export-data.mjs",
  "scripts/analyze-road-patterns.mjs",
  "scripts/backtest-analysis.mjs",
  "scripts/cleanup-target-tables.mjs",
  "scripts/compact-data.mjs",
  "scripts/check-36-completeness.mjs",
  "scripts/check-24h-integrity.mjs",
  "scripts/check-data-integrity.mjs",
  "scripts/check-runtime-smoke.mjs",
  "scripts/check-ui-compact.mjs",
  "scripts/run-analysis-watchdog.mjs",
  "scripts/start-analysis-watchdog.ps1",
  "scripts/install-analysis-watchdog-task.ps1",
  "scripts/uninstall-analysis-watchdog-task.ps1",
  "scripts/inspect-goodwin-network.mjs"
];

const missing = required.filter((file) => !existsSync(join(root, file)));
if (missing.length) {
  console.error(`Missing required files: ${missing.join(", ")}`);
  process.exit(1);
}

const index = readFileSync(join(root, "index.html"), "utf8");
const live = readFileSync(join(root, "live.html"), "utf8");
const logic = readFileSync(join(root, "logic.html"), "utf8");
const simulator = readFileSync(join(root, "simulator.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const simulatorJs = readFileSync(join(root, "simulator.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const simulatorStyles = readFileSync(join(root, "simulator.css"), "utf8");
const server = readFileSync(join(root, "src/server.js"), "utf8");
const roads = readFileSync(join(root, "src/roads.js"), "utf8");
const predictionIndex = readFileSync(join(root, "src/prediction-index.js"), "utf8");
const decisionProfile = readFileSync(join(root, "src/decision-profile.js"), "utf8");
const adaptiveBrain = readFileSync(join(root, "src/adaptive-brain.js"), "utf8");
const accuracyMetrics = readFileSync(join(root, "src/accuracy-metrics.js"), "utf8");
const fiveStepRisk = readFileSync(join(root, "src/five-step-risk.js"), "utf8");
const ensembleBrain = readFileSync(join(root, "src/ensemble-brain.js"), "utf8");
const roundSequences = readFileSync(join(root, "src/round-sequences.js"), "utf8");
const cardModel = readFileSync(join(root, "src/card-model.js"), "utf8");
const roadBreakdown = readFileSync(join(root, "src/road-breakdown.js"), "utf8");
const backtest = readFileSync(join(root, "src/backtest.js"), "utf8");
const publicWatchdogInstall = readFileSync(join(root, "scripts/install-public-tunnel-watchdog-task.ps1"), "utf8");
const monitorTaskInstall = readFileSync(join(root, "scripts/install-windows-task.ps1"), "utf8");
const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const checks = [
  [index.includes("<main") && index.includes('id="statusRoundCount"'), "index main layout"],
  [index.includes("simulator.html"), "simulator navigation link"],
  [index.includes("logic.html") && live.includes("logic.html"), "logic guide links"],
  [simulator.includes("百家樂下注提醒工具") && simulator.includes('id="manualTableSelect"'), "advisor reminder page"],
  [!simulator.includes("本機虛擬自動下注") && !simulator.includes("Virtual Auto Bet"), "virtual auto betting removed from page"],
  [index.includes('id="patternInput"') && index.includes("analysis-band"), "analysis input section"],
  [index.includes('id="analysisTableSelect"'), "analysis table selector"],
  [index.includes("side-flag-btn") && index.includes('data-flag="luckySix"'), "main special buttons"],
  [index.includes("data-card-rank") && index.includes("data-card-summary"), "main card rank buttons"],
  [live.includes('data-mode="live"') && live.includes("side-flag-btn"), "live iPhone page"],
  [live.includes("data-card-rank") && live.includes("data-card-summary"), "live card rank buttons"],
  [logic.includes("Baijia Logic Guide") && logic.includes("6 欄循環") && logic.includes("時時刻刻復盤"), "zero-basic logic guide page"],
  [server.includes('["/logic.html", "logic.html"]'), "logic guide static route"],
  [server.includes('["/simulator.html", "simulator.html"]') && server.includes('["/simulator.js", "simulator.js"]'), "simulator static route"],
  [server.includes("/api/analysis/tables") && server.includes("getAnalysisTableOptions"), "analysis table API"],
  [server.includes("/api/analysis/backtest") && server.includes("runTableBacktest"), "analysis backtest API"],
  [server.includes("buildAnalysisContext") && server.includes("analysisContextCache"), "indexed analysis context cache"],
  [index.includes('id="advancedAnalysis"'), "advanced analysis section"],
  [index.includes("pattern-result-btn") && index.includes('data-result="banker"'), "pattern button board"],
  [index.includes('id="savedDataCount"') && index.includes('id="sidePrediction"'), "saved data and prediction blocks"],
  [app.includes("maybeAutoAnalyze"), "auto analysis trigger"],
  [app.includes("renderDecisionProfile") && app.includes("API 請求逾時"), "decision profile renderer and API timeout"],
  [simulatorJs.includes("/api/analyze") && !simulatorJs.includes("runAutoStep"), "advisor analysis without virtual auto runner"],
  [simulatorJs.includes("settleManualAdvice") && simulatorJs.includes("exportSession"), "manual reminder settlement and export"],
  [simulatorJs.includes("decisionProfile") && simulatorJs.includes("analysisNote") && !simulatorJs.includes("fallbackDecision"), "advisor quality gate without fallback betting"],
  [simulatorJs.includes("buildAdvisorConservativeNote") && simulatorJs.includes("conservativeNote"), "advisor conservative calibration note"],
  [simulatorJs.includes("manualAnalyzeQueued") && simulatorJs.includes("API 請求逾時"), "advisor queued analysis and API timeout guard"],
  [simulatorJs.includes("sanitizeManualState") && simulatorJs.includes("sanitizeEvents"), "advisor storage sanitization"],
  [app.includes("/api/analyze"), "analysis API client"],
  [app.includes("renderProbabilityList"), "probability renderer"],
  [app.includes("renderAdvancedAnalysis"), "advanced analysis renderer"],
  [app.includes("renderRoadBreakdown"), "road breakdown renderer"],
  [app.includes("renderPredictionChecks"), "prediction check renderer"],
  [app.includes("renderAnalysisRecordList"), "analysis record renderer"],
  [app.includes("manualSequence: state.pattern"), "full manual sequence submission"],
  [app.includes("localOnly: false"), "live page global calibrated analysis"],
  [app.includes("analysisTableSelect") && app.includes('scope: tableId ? "table" : "all"'), "table-scoped analysis client"],
  [app.includes("makeManualRound"), "manual round special flags"],
  [app.includes("pendingCards") && app.includes("renderCardModel"), "manual card input and card model renderer"],
  [app.includes("manual-cycle-cell"), "manual cycle renderer"],
  [app.includes("replayHitRate") && app.includes("復盤"), "manual replay renderer"],
  [app.includes("evidenceLabel") && app.includes("證據"), "evidence renderer"],
  [app.includes("renderResultIcon"), "result icon renderer"],
  [roadBreakdown.includes("buildManualReplayStats"), "manual replay analysis"],
  [roadBreakdown.includes("calibrateRoadWithReplay"), "replay calibrated prediction"],
  [roadBreakdown.includes("attachRoadEvidence"), "evidence calibrated prediction"],
  [roadBreakdown.includes("classifyDirectTrend") && roadBreakdown.includes("classifyDerivedTrend"), "trend profile analysis"],
  [roadBreakdown.includes("scoreRecommendedRoad") && roadBreakdown.includes("recommended"), "evidence-weighted recommended road"],
  [predictionIndex.includes("buildPredictionIndex") && predictionIndex.includes("queryPredictionIndex") && predictionIndex.includes("BAIJIA_NGRAM_MAX"), "ngram prediction index"],
  [accuracyMetrics.includes("wilsonLowerBound") && accuracyMetrics.includes("selectionScore") && accuracyMetrics.includes("lowerEdgeVsBaseline"), "conservative accuracy metrics"],
  [fiveStepRisk.includes("buildFiveStepRisk") && fiveStepRisk.includes("evaluateFiveStepOutcome") && fiveStepRisk.includes("completionWilsonLower"), "five-step risk gate"],
  [ensembleBrain.includes("buildEnsembleBrain") && ensembleBrain.includes("prequential-walk-forward") && ensembleBrain.includes("pairedBrierLiftLower"), "leakage-safe online ensemble"],
  [ensembleBrain.includes("probabilityDirection") && ensembleBrain.includes("economicPreference"), "separate probability and commission directions"],
  [roundSequences.includes("groupRoundSequences") && roundSequences.includes("startsNewInferredSession"), "chronological inferred shoe sessions"],
  [decisionProfile.includes("trend-composite") && decisionProfile.includes("trendResult") && decisionProfile.includes("probabilityResult"), "trend-first unvalidated direction"],
  [fiveStepRisk.includes("fiveStepNaturalBaseline") && fiveStepRisk.includes("completionLowerLift"), "five-step natural baseline comparison"],
  [decisionProfile.includes("buildDecisionProfile") && decisionProfile.includes("decision-quality-gate") && decisionProfile.includes("observe"), "decision quality gate"],
  [adaptiveBrain.includes("buildAdaptiveBrain") && adaptiveBrain.includes("adaptive-strategy-brain") && adaptiveBrain.includes("recentMaxConsecutiveFailures"), "adaptive strategy brain and consecutive five-step guard"],
  [decisionProfile.includes("adaptive-brain") && decisionProfile.includes("自適應策略腦") && decisionProfile.includes("adaptive.action !== \"advise\""), "decision profile adaptive brain veto"],
  [decisionProfile.includes("nonTieWilsonLower") && decisionProfile.includes("保守回測下限偏低"), "decision conservative calibration gate"],
  [decisionProfile.includes("fiveStep") && decisionProfile.includes("completionWilsonLower") && decisionProfile.includes("ADVISE_MIN_FIVE_STEP_WILSON_LOWER") && decisionProfile.includes("ADVISE_MAX_FIVE_STEP_FAILURE_RATE"), "decision five-step quality gate"],
  [simulatorJs.includes("activeSet") && simulatorJs.includes("buildLockedSetAdvice") && simulatorJs.includes("buildFiveStepNote"), "advisor five-step locked set"],
  [backtest.includes("runTableBacktest") && backtest.includes("checkedWindows") && backtest.includes("SPECIAL_KEYS"), "rolling table backtest engine"],
  [backtest.includes("abstained") && backtest.includes("signalRate") && backtest.includes("nonTieWilsonLower") && backtest.includes("selectionScore"), "quality-gated conservative backtest signal accounting"],
  [backtest.includes("fiveStepChecked") && backtest.includes("evaluateFiveStepOutcome"), "five-step outcome backtest"],
  [cardModel.includes("buildCardModelAnalysis") && cardModel.includes("simulateBaccarat") && cardModel.includes("DEFAULT_DECKS = 8"), "eight-deck card probability model"],
  [readFileSync(join(root, "src/store.js"), "utf8").includes("ANALYSIS_TABLE_MAX_ROUNDS"), "bounded table analysis sampling"],
  [readFileSync(join(root, "src/collector.js"), "utf8").includes("openGoodwinAllbetWithRecovery") && readFileSync(join(root, "src/collector.js"), "utf8").includes("GOODWIN_ALLBET_ENTRY_RETRIES"), "allbet entry recovery retries"],
  [roads.includes("point.col - 1") && roads.includes("leftExists === aboveExists"), "formal derived-road color comparison"],
  [styles.includes(".side-flag-btn.active"), "special button active styling"],
  [simulatorStyles.includes(".advisor-layout") && simulatorStyles.includes(".sequence-strip"), "advisor layout styling"],
  [styles.includes(".card-input-panel") && styles.includes(".card-model-grid"), "card input and card model styling"],
  [styles.includes(".logic-road-grid") && styles.includes(".cycle-board"), "logic guide styling"],
  [styles.includes(".analysis-record-row"), "analysis record styling"],
  [styles.includes(".manual-cycle-cell"), "manual cycle styling"],
  [styles.includes(".probability-chip.strong"), "high probability styling"],
  [styles.includes(".advanced-panel"), "advanced analysis styling"],
  [styles.includes(".road-breakdown-grid"), "road breakdown styling"],
  [styles.includes(".compact-road-card"), "compact road card styling"],
  [styles.includes(".result-icon.banker"), "result icon styling"],
  [gitignore.includes(".env.*") && gitignore.includes("data/") && gitignore.includes("reports/"), "secret data and report gitignore"],
  [packageJson.scripts.daemon === "node src/daemon.js", "daemon script"],
  [packageJson.scripts["public:tunnel"] === "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-public-tunnel.ps1", "public tunnel script"],
  [packageJson.scripts["public:check"] === "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-public-tunnel.ps1", "public tunnel health check script"],
  [packageJson.scripts["public:watchdog:install"] === "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-public-tunnel-watchdog-task.ps1", "public tunnel watchdog install script"],
  [packageJson.scripts["public:watchdog:uninstall"] === "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall-public-tunnel-watchdog-task.ps1", "public tunnel watchdog uninstall script"],
  [publicWatchdogInstall.includes("New-TimeSpan -Minutes 5") && publicWatchdogInstall.includes("every 5 minutes"), "public tunnel watchdog 5-minute interval"],
  [monitorTaskInstall.includes("New-ScheduledTaskTrigger -AtLogOn") && monitorTaskInstall.includes("New-ScheduledTaskTrigger -AtStartup") && monitorTaskInstall.includes("BaijiaPublicTunnelWatchdog provides the 5-minute self-start guard"), "monitor task startup/logon with watchdog guard"],
  [readFileSync(join(root, "scripts/check-public-tunnel.ps1"), "utf8").includes("Test-DaemonHeartbeat") && readFileSync(join(root, "scripts/check-public-tunnel.ps1"), "utf8").includes("transient-local-timeout") && readFileSync(join(root, "scripts/check-public-tunnel.ps1"), "utf8").includes("scheduled-task->direct-runner"), "public tunnel watchdog heartbeat retry and direct fallback"],
  [readFileSync(join(root, "scripts/check-public-tunnel.ps1"), "utf8").includes("local-status-unresponsive") && readFileSync(join(root, "scripts/check-public-tunnel.ps1"), "utf8").includes("collector-worker.js") && readFileSync(join(root, "scripts/check-public-tunnel.ps1"), "utf8").includes("Test-ReportFresh"), "public tunnel watchdog local HTTP and stale report recovery"],
  [readFileSync(join(root, "scripts/run-daemon.ps1"), "utf8").includes("$MinimumRunTimeoutMs = 600000") && readFileSync(join(root, "src/collector.js"), "utf8").includes("600_000"), "collector 10-minute timeout guard"],
  [readFileSync(join(root, "src/daemon.js"), "utf8").includes("collector-worker.js") && readFileSync(join(root, "src/daemon.js"), "utf8").includes("startCollectorWorker") && readFileSync(join(root, "scripts/run-daemon.ps1"), "utf8").includes("collector-worker.js"), "collector worker process isolation"],
  [readFileSync(join(root, "src/daemon.js"), "utf8").includes("markHeartbeatReady") && readFileSync(join(root, "src/daemon.js"), "utf8").includes("backup-db.mjs") && readFileSync(join(root, "scripts/run-daemon.ps1"), "utf8").includes("run-daemon-wrapper.log"), "daemon ready heartbeat and wrapper diagnostics"],
  [packageJson.scripts["backup:db"] === "node scripts/backup-db.mjs", "database backup script"],
  [packageJson.scripts["analysis:roads"] === "node scripts/analyze-road-patterns.mjs", "road analysis script"],
  [packageJson.scripts["analysis:backtest"] === "node scripts/backtest-analysis.mjs", "backtest analysis script"],
  [packageJson.scripts["logic:update"] === "node scripts/report-logic-hit-rates.mjs --checks 60 --limit 1800", "hourly logic update script"],
  [packageJson.scripts["watch:analysis:once"] === "node scripts/run-analysis-watchdog.mjs --once", "analysis watchdog once script"],
  [readFileSync(join(root, "scripts/run-analysis-watchdog.mjs"), "utf8").includes("BAIJIA_WATCH_ANALYZE_ALL_LIMIT || 7200") && readFileSync(join(root, "app.js"), "utf8").includes("tableId ? 1200 : 7200"), "fast recent analysis limits"],
  [readFileSync(join(root, "src/server.js"), "utf8").includes("analysisCache") && readFileSync(join(root, "src/server.js"), "utf8").includes("applyStrategyCalibration") && readFileSync(join(root, "src/store.js"), "utf8").includes("analysisRoundsCache"), "analysis cache and calibrated preferred strategy"],
  [readFileSync(join(root, "src/server.js"), "utf8").includes("MAX_JSON_BODY_BYTES") && readFileSync(join(root, "src/server.js"), "utf8").includes("STATIC_SECURITY_HEADERS") && readFileSync(join(root, "src/server.js"), "utf8").includes("normalizeAnalyzeBody"), "API body limit and security headers"],
  [readFileSync(join(root, "src/server.js"), "utf8").includes("SERVER_REQUEST_TIMEOUT_MS") && readFileSync(join(root, "src/server.js"), "utf8").includes("buildDecisionProfile"), "server timeout guard and calibrated decision profile"],
  [readFileSync(join(root, "src/server.js"), "utf8").includes("buildAdaptiveBrain") && readFileSync(join(root, "src/server.js"), "utf8").includes("applyAdaptivePreferred"), "server adaptive strategy brain"],
  [readFileSync(join(root, "src/server.js"), "utf8").includes("streamCsvExport") && readFileSync(join(root, "src/server.js"), "utf8").includes("export-data.mjs") && readFileSync(join(root, "scripts/export-data.mjs"), "utf8").includes("exportCsv"), "nonblocking export worker"],
  [readFileSync(join(root, "src/server.js"), "utf8").includes("/api/ping") && readFileSync(join(root, "src/store.js"), "utf8").includes("statusSource: \"version\"") && readFileSync(join(root, "src/store.js"), "utf8").includes("cleanupTempFiles"), "fast status and lightweight ping health check"],
  [readFileSync(join(root, "src/daemon.js"), "utf8").includes("startLogicUpdate") && readFileSync(join(root, "src/daemon.js"), "utf8").includes("BAIJIA_LOGIC_UPDATE_INTERVAL_MS"), "hourly logic calibration daemon"],
  [readFileSync(join(root, "src/store.js"), "utf8").includes("baijia-analysis-snapshot.json") && readFileSync(join(root, "src/store.js"), "utf8").includes("getAnalysisRoundsFromSnapshot"), "fast analysis snapshot"],
  [readFileSync(join(root, "scripts/start-analysis-watchdog.ps1"), "utf8").includes("$isStale") && readFileSync(join(root, "scripts/start-analysis-watchdog.ps1"), "utf8").includes("BAIJIA_WATCH_ANALYZE_ALL_LIMIT"), "stale analysis watchdog restart"],
  [readFileSync(join(root, "scripts/start-analysis-watchdog.ps1"), "utf8").includes("Test-ReportFresh") && readFileSync(join(root, "scripts/start-analysis-watchdog.ps1"), "utf8").includes("MaxReportAgeSeconds"), "analysis watchdog stale report restart"],
  [packageJson.scripts["watch:analysis:bg"] === "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-analysis-watchdog.ps1", "analysis watchdog background script"],
  [packageJson.scripts["watch:analysis:install"] === "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-analysis-watchdog-task.ps1", "analysis watchdog task install script"],
  [packageJson.scripts["health:36"] === "node scripts/check-36-completeness.mjs", "36 table health script"],
  [packageJson.scripts["health:data"] === "node scripts/check-data-integrity.mjs", "data integrity script"],
  [packageJson.scripts["health:runtime"] === "node scripts/check-runtime-smoke.mjs", "runtime smoke script"],
  [packageJson.scripts["health:ui"] === "node scripts/check-ui-compact.mjs", "compact UI health script"],
  [packageJson.scripts["data:cleanup"] === "node scripts/cleanup-target-tables.mjs", "target table cleanup script"],
  [packageJson.scripts["data:compact"] === "node scripts/compact-data.mjs", "data compaction script"],
  [packageJson.scripts["network:inspect"] === "node scripts/inspect-goodwin-network.mjs", "network inspect script"],
  [packageJson.scripts["health:24h"] === "node scripts/check-24h-integrity.mjs", "24h health script"],
  [readFileSync(join(root, "src/collector.js"), "utf8").includes("runInProgress"), "collector in-progress status"]
];

const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);
if (failed.length) {
  console.error(`Validation failed: ${failed.join(", ")}`);
  process.exit(1);
}

const syntaxFiles = [
  "app.js",
  "simulator.js",
  "src/roads.js",
  "src/store.js",
  "src/analysis.js",
  "src/decision-profile.js",
  "src/adaptive-brain.js",
  "src/ensemble-brain.js",
  "src/accuracy-metrics.js",
  "src/five-step-risk.js",
  "src/prediction-index.js",
  "src/card-model.js",
  "src/backtest.js",
  "src/advanced-analysis.js",
  "src/road-breakdown.js",
  "src/server.js",
  "src/collector-worker.js",
  "src/collector.js",
  "src/daemon.js",
  "src/backup.js",
  "scripts/backup-db.mjs",
  "scripts/export-data.mjs",
  "scripts/analyze-road-patterns.mjs",
  "scripts/backtest-analysis.mjs",
  "scripts/cleanup-target-tables.mjs",
  "scripts/compact-data.mjs",
  "scripts/check-36-completeness.mjs",
  "scripts/inspect-goodwin-network.mjs",
  "scripts/check-data-integrity.mjs",
  "scripts/check-runtime-smoke.mjs",
  "scripts/check-ui-compact.mjs",
  "scripts/run-analysis-watchdog.mjs",
  "scripts/check-24h-integrity.mjs"
];

for (const file of syntaxFiles) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const roadRuleCheck = spawnSync(process.execPath, ["-e", `
const { buildDerivedRoad } = require("./src/roads");
const base = [
  { result: "banker", col: 0, row: 0, roundIndex: 0 },
  { result: "banker", col: 0, row: 1, roundIndex: 1 },
  { result: "player", col: 1, row: 0, roundIndex: 2 },
  { result: "banker", col: 2, row: 0, roundIndex: 3 },
  { result: "player", col: 3, row: 0, roundIndex: 4 },
  { result: "banker", col: 4, row: 0, roundIndex: 5 },
  { result: "banker", col: 4, row: 2, roundIndex: 6 }
];
const small = buildDerivedRoad(base, 2, "small").points;
const cockroach = buildDerivedRoad(base, 3, "cockroach").points;
const smallNewColumn = small.find((point) => point.sourceCol === 3 && point.sourceRow === 0);
const smallSameColumn = small.find((point) => point.sourceCol === 4 && point.sourceRow === 2);
const cockroachNewColumn = cockroach.find((point) => point.sourceCol === 4 && point.sourceRow === 0);
if (smallNewColumn?.color !== "blue") throw new Error("small-road new-column comparison should be blue");
if (smallSameColumn?.color !== "red") throw new Error("small-road same-column comparison should be red when both comparison cells match empty");
if (cockroachNewColumn?.color !== "blue") throw new Error("cockroach-road new-column comparison should be blue");
`], { encoding: "utf8", cwd: root });
if (roadRuleCheck.status !== 0) {
  console.error(roadRuleCheck.stderr || roadRuleCheck.stdout);
  process.exit(roadRuleCheck.status || 1);
}

if (process.platform === "win32") {
  const powerShellFiles = [
    "scripts/run-daemon.ps1",
    "scripts/start-public-tunnel.ps1",
    "scripts/check-public-tunnel.ps1",
    "scripts/install-windows-task.ps1",
    "scripts/uninstall-windows-task.ps1",
    "scripts/install-public-tunnel-watchdog-task.ps1",
    "scripts/uninstall-public-tunnel-watchdog-task.ps1",
    "scripts/start-analysis-watchdog.ps1",
    "scripts/install-analysis-watchdog-task.ps1",
    "scripts/uninstall-analysis-watchdog-task.ps1"
  ];
  for (const file of powerShellFiles) {
    const target = join(root, file).replace(/'/g, "''");
    const command = [
      "$errors = $null",
      "$tokens = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${target}', [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      process.exit(result.status || 1);
    }
  }
}

console.log("Baijia local monitor validation passed.");
