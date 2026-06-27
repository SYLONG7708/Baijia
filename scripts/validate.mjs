import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const required = [
  "index.html",
  "live.html",
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
  "scripts/inspect-goodwin-network.mjs"
];

const missing = required.filter((file) => !existsSync(join(root, file)));
if (missing.length) {
  console.error(`Missing required files: ${missing.join(", ")}`);
  process.exit(1);
}

const index = readFileSync(join(root, "index.html"), "utf8");
const live = readFileSync(join(root, "live.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const checks = [
  [index.includes("<main") && index.includes('id="statusRoundCount"'), "index main layout"],
  [index.includes('id="patternInput"') && index.includes("analysis-band"), "analysis input section"],
  [index.includes("side-flag-btn") && index.includes('data-flag="luckySix"'), "main special buttons"],
  [live.includes('data-mode="live"') && live.includes("side-flag-btn"), "live iPhone page"],
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
  [app.includes("makeManualRound"), "manual round special flags"],
  [app.includes("manual-cycle-cell"), "manual cycle renderer"],
  [app.includes("renderResultIcon"), "result icon renderer"],
  [styles.includes(".side-flag-btn.active"), "special button active styling"],
  [styles.includes(".analysis-record-row"), "analysis record styling"],
  [styles.includes(".manual-cycle-cell"), "manual cycle styling"],
  [styles.includes(".probability-chip.strong"), "high probability styling"],
  [styles.includes(".advanced-panel"), "advanced analysis styling"],
  [styles.includes(".road-breakdown-grid"), "road breakdown styling"],
  [styles.includes(".compact-road-card"), "compact road card styling"],
  [styles.includes(".result-icon.banker"), "result icon styling"],
  [gitignore.includes(".env.*") && gitignore.includes("data/"), "secret and data gitignore"],
  [packageJson.scripts.daemon === "node src/daemon.js", "daemon script"],
  [packageJson.scripts["public:tunnel"] === "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-public-tunnel.ps1", "public tunnel script"],
  [packageJson.scripts["backup:db"] === "node scripts/backup-db.mjs", "database backup script"],
  [packageJson.scripts["analysis:roads"] === "node scripts/analyze-road-patterns.mjs", "road analysis script"],
  [packageJson.scripts["health:36"] === "node scripts/check-36-completeness.mjs", "36 table health script"],
  [packageJson.scripts["health:data"] === "node scripts/check-data-integrity.mjs", "data integrity script"],
  [packageJson.scripts["health:runtime"] === "node scripts/check-runtime-smoke.mjs", "runtime smoke script"],
  [packageJson.scripts["health:ui"] === "node scripts/check-ui-compact.mjs", "compact UI health script"],
  [packageJson.scripts["data:cleanup"] === "node scripts/cleanup-target-tables.mjs", "target table cleanup script"],
  [packageJson.scripts["data:compact"] === "node scripts/compact-data.mjs", "data compaction script"],
  [packageJson.scripts["network:inspect"] === "node scripts/inspect-goodwin-network.mjs", "network inspect script"],
  [packageJson.scripts["health:24h"] === "node scripts/check-24h-integrity.mjs", "24h health script"]
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
  "scripts/check-24h-integrity.mjs"
];

for (const file of syntaxFiles) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
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
