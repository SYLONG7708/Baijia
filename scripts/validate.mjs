import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const required = [
  "index.html",
  "live.html",
  "logic.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "sw.js",
  "icon.svg",
  "src/server.js",
  "src/store.js",
  "src/roads.js",
  "src/analysis.js",
  "src/advanced-analysis.js",
  "src/road-breakdown.js",
  "src/collector.js",
  "src/daemon.js",
  "src/backup.js",
  "scripts/run-daemon.ps1",
  "scripts/start-public-tunnel.ps1",
  "scripts/install-windows-task.ps1",
  "scripts/uninstall-windows-task.ps1",
  "scripts/backup-db.mjs",
  "scripts/analyze-road-patterns.mjs",
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
const app = readFileSync(join(root, "app.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const server = readFileSync(join(root, "src/server.js"), "utf8");
const roads = readFileSync(join(root, "src/roads.js"), "utf8");
const roadBreakdown = readFileSync(join(root, "src/road-breakdown.js"), "utf8");
const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const checks = [
  [index.includes("<main") && index.includes('id="statusRoundCount"'), "index main layout"],
  [index.includes("logic.html") && live.includes("logic.html"), "logic guide links"],
  [index.includes('id="patternInput"') && index.includes("analysis-band"), "analysis input section"],
  [index.includes('id="analysisTableSelect"'), "analysis table selector"],
  [index.includes("side-flag-btn") && index.includes('data-flag="luckySix"'), "main special buttons"],
  [live.includes('data-mode="live"') && live.includes("side-flag-btn"), "live iPhone page"],
  [logic.includes("Baijia Logic Guide") && logic.includes("6 欄循環") && logic.includes("時時刻刻復盤"), "zero-basic logic guide page"],
  [server.includes('["/logic.html", "logic.html"]'), "logic guide static route"],
  [server.includes("/api/analysis/tables") && server.includes("getAnalysisTableOptions"), "analysis table API"],
  [index.includes('id="advancedAnalysis"'), "advanced analysis section"],
  [index.includes("pattern-result-btn") && index.includes('data-result="banker"'), "pattern button board"],
  [index.includes('id="savedDataCount"') && index.includes('id="sidePrediction"'), "saved data and prediction blocks"],
  [app.includes("maybeAutoAnalyze"), "auto analysis trigger"],
  [app.includes("/api/analyze"), "analysis API client"],
  [app.includes("renderProbabilityList"), "probability renderer"],
  [app.includes("renderAdvancedAnalysis"), "advanced analysis renderer"],
  [app.includes("renderRoadBreakdown"), "road breakdown renderer"],
  [app.includes("renderPredictionChecks"), "prediction check renderer"],
  [app.includes("renderAnalysisRecordList"), "analysis record renderer"],
  [app.includes("manualSequence: state.pattern"), "full manual sequence submission"],
  [app.includes("localOnly: isLiveMode"), "live page local-only analysis"],
  [app.includes("analysisTableSelect") && app.includes('scope: tableId ? "table" : "all"'), "table-scoped analysis client"],
  [app.includes("makeManualRound"), "manual round special flags"],
  [app.includes("manual-cycle-cell"), "manual cycle renderer"],
  [app.includes("replayHitRate") && app.includes("復盤"), "manual replay renderer"],
  [app.includes("evidenceLabel") && app.includes("證據"), "evidence renderer"],
  [app.includes("renderResultIcon"), "result icon renderer"],
  [roadBreakdown.includes("buildManualReplayStats"), "manual replay analysis"],
  [roadBreakdown.includes("calibrateRoadWithReplay"), "replay calibrated prediction"],
  [roadBreakdown.includes("attachRoadEvidence"), "evidence calibrated prediction"],
  [roadBreakdown.includes("classifyDirectTrend") && roadBreakdown.includes("classifyDerivedTrend"), "trend profile analysis"],
  [readFileSync(join(root, "src/store.js"), "utf8").includes("ANALYSIS_TABLE_MAX_ROUNDS"), "bounded table analysis sampling"],
  [roads.includes("point.col - 1") && roads.includes("leftExists === aboveExists"), "formal derived-road color comparison"],
  [styles.includes(".side-flag-btn.active"), "special button active styling"],
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
  [packageJson.scripts["backup:db"] === "node scripts/backup-db.mjs", "database backup script"],
  [packageJson.scripts["analysis:roads"] === "node scripts/analyze-road-patterns.mjs", "road analysis script"],
  [packageJson.scripts["watch:analysis:once"] === "node scripts/run-analysis-watchdog.mjs --once", "analysis watchdog once script"],
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
  "src/roads.js",
  "src/store.js",
  "src/analysis.js",
  "src/advanced-analysis.js",
  "src/road-breakdown.js",
  "src/server.js",
  "src/collector.js",
  "src/daemon.js",
  "src/backup.js",
  "scripts/backup-db.mjs",
  "scripts/analyze-road-patterns.mjs",
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
    "scripts/install-windows-task.ps1",
    "scripts/uninstall-windows-task.ps1"
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
