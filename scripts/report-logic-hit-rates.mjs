import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const store = require("../src/store");
const { runTableBacktest } = require("../src/backtest");
const { compareOutcomeStats, enrichOutcomeStat } = require("../src/accuracy-metrics");

const args = parseArgs(process.argv.slice(2));
const tableFilter = String(args.table || process.env.BAIJIA_LOGIC_REPORT_TABLE || "").trim().toUpperCase();
const maxChecks = Number(args.checks || process.env.BAIJIA_LOGIC_REPORT_CHECKS || 40);
const limit = Number(args.limit || process.env.BAIJIA_LOGIC_REPORT_LIMIT || 1800);
const minNonTie = Number(args.minNonTie || process.env.BAIJIA_LOGIC_REPORT_MIN_NON_TIE || 12);
const maxTables = Number(args.maxTables || process.env.BAIJIA_LOGIC_REPORT_MAX_TABLES || 0);
const skipTables = Number(args.skipTables || process.env.BAIJIA_LOGIC_REPORT_SKIP_TABLES || 0);
const historyLimit = Number(args.historyLimit || process.env.BAIJIA_LOGIC_REPORT_HISTORY_LIMIT || 360);
const manualHistoryLimit = Number(args.manualHistoryLimit || process.env.BAIJIA_LOGIC_REPORT_MANUAL_HISTORY_LIMIT || 40);
const REPORT_DIR = join(process.cwd(), "reports");
const JSON_PATH = join(REPORT_DIR, "logic-hit-rate-latest.json");
const MD_PATH = join(REPORT_DIR, "logic-hit-rate-latest.md");

store.ensureStore();
const startedAt = Date.now();
const allTables = store.getAnalysisTableOptions()
  .filter((table) => !tableFilter || table.tableCode === tableFilter)
  .sort((left, right) => String(left.tableCode || "").localeCompare(String(right.tableCode || "")));
const tables = allTables.slice(skipTables, maxTables > 0 ? skipTables + maxTables : undefined);

if (!tables.length) {
  console.error(tableFilter ? `No table found for ${tableFilter}.` : "No analysis tables found.");
  process.exit(2);
}

mkdirSync(REPORT_DIR, { recursive: true });
const rows = [];
const errors = [];
for (const table of tables) {
  try {
    const rounds = store.getAnalysisRounds({
      tableId: table.id,
      tableCode: table.tableCode,
      limit
    });
    const report = runTableBacktest({
      table,
      rounds,
      windowSize: 8,
      maxChecks,
      detailLimit: 0,
      historyLimit,
      manualHistoryLimit
    });
    rows.push(buildRow(table, report));
    console.error(`checked ${table.tableCode}: ${report.sample.checkedWindows} windows`);
  } catch (error) {
    errors.push({
      tableCode: table.tableCode,
      message: error?.message || String(error)
    });
    console.error(`failed ${table.tableCode}: ${error?.message || error}`);
  }
  writeReport(false);
}

const report = writeReport(true);
console.log(JSON.stringify(args.json ? report : {
  ok: report.ok,
  generatedAt: report.generatedAt,
  runtimeMs: report.runtimeMs,
  tables: report.tables,
  bestOverall: consoleStat(report.aggregate.bestOverall),
  onlineEnsemble: consoleStat(report.aggregate.strategies.onlineEnsemble),
  read: report.read,
  reportPaths: { json: JSON_PATH, markdown: MD_PATH }
}, null, 2));
if (!report.ok) process.exitCode = 1;

function writeReport(final) {
  const aggregate = buildAggregate(rows, minNonTie);
  const report = {
    ok: final ? errors.length === 0 : false,
    partial: !final,
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - startedAt,
    config: {
      tableFilter,
      maxChecks,
      limit,
      minNonTie,
      maxTables,
      skipTables,
      historyLimit,
      manualHistoryLimit
    },
    tables: {
      available: allTables.length,
      requested: tables.length,
      completed: rows.length,
      failed: errors.length
    },
    aggregate,
    rows,
    errors,
    read: buildRead(aggregate)
  };
  writeFileSync(JSON_PATH, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(MD_PATH, renderMarkdown(report), "utf8");
  return report;
}

function buildRow(table, report) {
  const summary = report.summary || {};
  const strategies = {
    mainNextResult: pickStat(summary.nextResult),
    advancedHighestRoad: pickStat(summary.previousHighestRoad),
    instantVerifiedCurrent: pickStat(summary.currentStrategy),
    onlineEnsemble: pickStat(summary.onlineEnsemble),
    forcedEveryHand: pickStat(summary.forcedEveryHand),
    forcedEveryHandReverse: pickStat(summary.forcedEveryHandReverse),
    evidenceWeighted: pickStat(summary.evidenceWeighted),
    fiveRoadConsensus: pickStat(summary.consensus)
  };
  const bestStrategy = bestEntry(strategies);
  return {
    tableCode: table.tableCode,
    tableName: table.name || "",
    totalRounds: Number(report.sample?.totalRounds || 0),
    checkedWindows: Number(report.sample?.checkedWindows || 0),
    firstCheckedAt: report.sample?.firstCheckedAt || "",
    lastCheckedAt: report.sample?.lastCheckedAt || "",
    strategies,
    bestStrategy,
    bestRoad: pickNamedStat(summary.bestRoad),
    bestManualCycle: pickNamedStat(summary.bestManualCycle),
    specials: {
      bankerPair: pickSpecial(summary.specials?.bankerPair),
      playerPair: pickSpecial(summary.specials?.playerPair),
      luckySix: pickSpecial(summary.specials?.luckySix)
    }
  };
}

function buildAggregate(rows, minNonTie) {
  const keys = [
    "mainNextResult",
    "advancedHighestRoad",
    "instantVerifiedCurrent",
    "onlineEnsemble",
    "forcedEveryHand",
    "forcedEveryHandReverse",
    "evidenceWeighted",
    "fiveRoadConsensus"
  ];
  const strategies = Object.fromEntries(keys.map((key) => [key, emptyAgg()]));
  const tableWins = Object.fromEntries(keys.map((key) => [key, 0]));
  const tableQualified = Object.fromEntries(keys.map((key) => [key, 0]));

  for (const row of rows) {
    for (const key of keys) {
      addStat(strategies[key], row.strategies[key]);
      if (Number(row.strategies[key]?.nonTieChecked || 0) >= minNonTie) tableQualified[key] += 1;
    }
    const best = bestEntry(row.strategies, minNonTie);
    if (best?.key) tableWins[best.key] = (tableWins[best.key] || 0) + 1;
  }
  for (const stat of Object.values(strategies)) finalizeAgg(stat);
  return {
    strategies,
    tableWins,
    tableQualified,
    bestOverall: bestEntry(strategies, minNonTie),
    bestByTableWins: Object.entries(tableWins)
      .map(([key, wins]) => ({ key, wins }))
      .sort((left, right) => right.wins - left.wins)[0] || null
  };
}

function buildRead(aggregate) {
  const bestOverall = aggregate.bestOverall;
  if (!bestOverall) return "No qualified hit-rate result was available.";
  if (Number(bestOverall.roiLower95 || 0) <= 0) {
    return `目前沒有任何策略證明平注報酬為正；保守分數最高為 ${bestOverall.key}，ROI ${formatSignedPct(bestOverall.roi)}，95% 下限 ${formatSignedPct(bestOverall.roiLower95)}。`;
  }
  return `${bestOverall.key} 的平注 ROI 95% 下限為 ${formatSignedPct(bestOverall.roiLower95)}，樣本 ${bestOverall.nonTieChecked} 局。`;
}

function consoleStat(stat = {}) {
  return {
    key: stat.key || "",
    nonTieChecked: Number(stat.nonTieChecked || 0),
    nonTieHitRate: Number(stat.nonTieHitRate || 0),
    nonTieWilsonLower: Number(stat.nonTieWilsonLower || 0),
    roi: Number(stat.roi || 0),
    roiLower95: Number(stat.roiLower95 || 0),
    brierScore: Number(stat.brierScore || 0),
    brierSkill: Number(stat.brierSkill || 0),
    fiveStepCompletionRate: Number(stat.fiveStepCompletionRate || 0),
    fiveStepBaselineCompletionRate: Number(stat.fiveStepBaselineCompletionRate || 0),
    fiveStepLiftVsNatural: Number(stat.fiveStepLiftVsNatural || 0)
  };
}

function pickStat(stat = {}) {
  return {
    checked: Number(stat.checked || 0),
    hits: Number(stat.hits || 0),
    hitRate: Number(stat.hitRate || 0),
    nonTieChecked: Number(stat.nonTieChecked || 0),
    nonTieHits: Number(stat.nonTieHits || 0),
    nonTieHitRate: Number(stat.nonTieHitRate || 0),
    nonTieWilsonLower: Number(stat.nonTieWilsonLower || 0),
    hitWilsonLower: Number(stat.hitWilsonLower || 0),
    baselineNonTieHitRate: Number(stat.baselineNonTieHitRate || 0),
    edgeVsBaseline: Number(stat.edgeVsBaseline || 0),
    lowerEdgeVsBaseline: Number(stat.lowerEdgeVsBaseline || 0),
    selectionScore: Number(stat.selectionScore || 0),
    fiveStepChecked: Number(stat.fiveStepChecked || 0),
    fiveStepWins: Number(stat.fiveStepWins || 0),
    fiveStepFailures: Number(stat.fiveStepFailures || 0),
    fiveStepCompletionRate: Number(stat.fiveStepCompletionRate || 0),
    fiveStepFailureRate: Number(stat.fiveStepFailureRate || 0),
    fiveStepWilsonLower: Number(stat.fiveStepWilsonLower || 0),
    fiveStepAverageStep: Number(stat.fiveStepAverageStep || 0),
    fiveStepBaselineSum: Number(stat.fiveStepBaselineSum || 0),
    fiveStepBaselineCompletionRate: Number(stat.fiveStepBaselineCompletionRate || 0),
    fiveStepLiftVsNatural: Number(stat.fiveStepLiftVsNatural || 0),
    averageRate: Number(stat.averageRate || 0),
    netUnits: Number(stat.netUnits || 0),
    unitSquareSum: Number(stat.unitSquareSum || 0),
    baselineNetUnits: Number(stat.baselineNetUnits || 0),
    baselineUnitSquareSum: Number(stat.baselineUnitSquareSum || 0),
    roi: Number(stat.roi || 0),
    roiLower95: Number(stat.roiLower95 || 0),
    baselineBankerRoi: Number(stat.baselineBankerRoi || 0),
    roiLiftVsBanker: Number(stat.roiLiftVsBanker || 0),
    maxDrawdown: Number(stat.maxDrawdown || 0),
    maxLossStreak: Number(stat.maxLossStreak || 0),
    probabilityChecks: Number(stat.probabilityChecks || 0),
    brierSum: Number(stat.brierSum || 0),
    baselineBrierSum: Number(stat.baselineBrierSum || 0),
    logLossSum: Number(stat.logLossSum || 0),
    baselineLogLossSum: Number(stat.baselineLogLossSum || 0),
    brierScore: Number(stat.brierScore || 0),
    brierSkill: Number(stat.brierSkill || 0),
    logLoss: Number(stat.logLoss || 0),
    calibrationBins: Array.isArray(stat.calibrationBins) ? stat.calibrationBins : [],
    abstained: Number(stat.abstained || 0),
    signalRate: Number(stat.signalRate || 0),
    actualByResult: {
      banker: Number(stat.actualByResult?.banker || stat.sideActualByResult?.banker || 0),
      player: Number(stat.actualByResult?.player || stat.sideActualByResult?.player || 0)
    }
  };
}

function pickNamedStat(stat = {}) {
  if (!stat) return null;
  return {
    key: stat.key || "",
    label: stat.label || "",
    ...pickStat(stat)
  };
}

function pickSpecial(stat = {}) {
  return {
    checked: Number(stat?.checked || 0),
    actual: Number(stat?.actual || 0),
    actualRate: Number(stat?.actualRate || 0),
    signals: Number(stat?.signals || 0),
    signalHits: Number(stat?.signalHits || 0),
    signalHitRate: Number(stat?.signalHitRate || 0),
    averageRate: Number(stat?.averageRate || 0)
  };
}

function emptyAgg() {
  return {
    checked: 0,
    hits: 0,
    hitRate: 0,
    nonTieChecked: 0,
    nonTieHits: 0,
    nonTieHitRate: 0,
    nonTieWilsonLower: 0,
    hitWilsonLower: 0,
    baselineNonTieHitRate: 0,
    edgeVsBaseline: 0,
    lowerEdgeVsBaseline: 0,
    selectionScore: 0,
    fiveStepChecked: 0,
    fiveStepWins: 0,
    fiveStepFailures: 0,
    fiveStepCompletionRate: 0,
    fiveStepFailureRate: 0,
    fiveStepWilsonLower: 0,
    fiveStepAverageStep: 0,
    fiveStepStepSum: 0,
    fiveStepBaselineSum: 0,
    netUnits: 0,
    unitSquareSum: 0,
    baselineNetUnits: 0,
    baselineUnitSquareSum: 0,
    maxDrawdown: 0,
    maxLossStreak: 0,
    probabilityChecks: 0,
    brierSum: 0,
    baselineBrierSum: 0,
    logLossSum: 0,
    baselineLogLossSum: 0,
    calibrationBins: Array.from({ length: 10 }, () => ({ count: 0, probabilitySum: 0, actualSum: 0 })),
    abstained: 0,
    signalRate: 0,
    actualByResult: { banker: 0, player: 0 }
  };
}

function addStat(target, stat = {}) {
  target.checked += Number(stat.checked || 0);
  target.hits += Number(stat.hits || 0);
  target.nonTieChecked += Number(stat.nonTieChecked || 0);
  target.nonTieHits += Number(stat.nonTieHits || 0);
  target.abstained += Number(stat.abstained || 0);
  target.fiveStepChecked += Number(stat.fiveStepChecked || 0);
  target.fiveStepWins += Number(stat.fiveStepWins || 0);
  target.fiveStepFailures += Number(stat.fiveStepFailures || 0);
  target.fiveStepStepSum += Number(stat.fiveStepAverageStep || 0) * Number(stat.fiveStepWins || 0);
  target.fiveStepBaselineSum += Number(stat.fiveStepBaselineSum || 0);
  target.netUnits += Number(stat.netUnits || 0);
  target.unitSquareSum += Number(stat.unitSquareSum || 0);
  target.baselineNetUnits += Number(stat.baselineNetUnits || 0);
  target.baselineUnitSquareSum += Number(stat.baselineUnitSquareSum || 0);
  target.maxDrawdown = Math.max(target.maxDrawdown, Number(stat.maxDrawdown || 0));
  target.maxLossStreak = Math.max(target.maxLossStreak, Number(stat.maxLossStreak || 0));
  target.probabilityChecks += Number(stat.probabilityChecks || 0);
  target.brierSum += Number(stat.brierSum || 0);
  target.baselineBrierSum += Number(stat.baselineBrierSum || 0);
  target.logLossSum += Number(stat.logLossSum || 0);
  target.baselineLogLossSum += Number(stat.baselineLogLossSum || 0);
  for (let index = 0; index < target.calibrationBins.length; index += 1) {
    const source = stat.calibrationBins?.[index] || {};
    target.calibrationBins[index].count += Number(source.count || 0);
    target.calibrationBins[index].probabilitySum += Number(source.probabilitySum || 0);
    target.calibrationBins[index].actualSum += Number(source.actualSum || 0);
  }
  target.actualByResult.banker += Number(stat.actualByResult?.banker || stat.sideActualByResult?.banker || 0);
  target.actualByResult.player += Number(stat.actualByResult?.player || stat.sideActualByResult?.player || 0);
}

function finalizeAgg(stat) {
  enrichOutcomeStat(stat);
  delete stat.fiveStepStepSum;
}

function bestEntry(statsByKey = {}, minNonTie = 0) {
  return Object.entries(statsByKey)
    .map(([key, stat]) => ({ key, ...stat }))
    .filter((stat) => Number(stat.nonTieChecked || 0) >= minNonTie)
    .sort(compareOutcomeStats)[0] || null;
}

function renderMarkdown(report) {
  const lines = [
    "# 百家樂邏輯無洩漏回測報告",
    "",
    `Generated: ${report.generatedAt}`,
    `Tables: ${report.tables.completed}/${report.tables.requested}`,
    `Checks per table: ${report.config.maxChecks}`,
    "",
    `結論：${report.read}`,
    "",
    "> 5 注完成率必須和自然基準比較；重疊視窗僅供描述，不是獨立樣本，也不是必過保證。",
    "",
    "## 整體統計",
    "",
    "| 邏輯 | 非和命中 | Wilson 下限 | 平注 ROI | ROI 95% 下限 | Brier | Brier skill | 5注完成 | 自然基準 | 5注超額 | 出手率 | 非和樣本 | 桌勝 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const [key, stat] of Object.entries(report.aggregate.strategies)) {
    lines.push(`| ${key} | ${formatPct(stat.nonTieHitRate)} | ${formatPct(stat.nonTieWilsonLower)} | ${formatSignedPct(stat.roi)} | ${formatSignedPct(stat.roiLower95)} | ${Number(stat.brierScore || 0).toFixed(4)} | ${formatSignedPct(stat.brierSkill)} | ${formatPct(stat.fiveStepCompletionRate)} | ${formatPct(stat.fiveStepBaselineCompletionRate)} | ${formatSignedPct(stat.fiveStepLiftVsNatural)} | ${formatPct(stat.signalRate)} | ${stat.nonTieChecked} | ${report.aggregate.tableWins[key] || 0} |`);
  }
  lines.push("", "## 各桌摘要", "");
  lines.push("| 桌台 | 最佳邏輯 | 命中 | ROI | ROI 下限 | 5注超額 | 樣本 | 線上集成 | 每局方向 | 反向 | 主樣本 | 五路統整 |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of report.rows) {
    lines.push([
      row.tableCode,
      row.bestStrategy?.key || "-",
      formatPct(row.bestStrategy?.nonTieHitRate || 0),
      formatSignedPct(row.bestStrategy?.roi || 0),
      formatSignedPct(row.bestStrategy?.roiLower95 || 0),
      formatSignedPct(row.bestStrategy?.fiveStepLiftVsNatural || 0),
      row.bestStrategy?.nonTieChecked || 0,
      formatPct(row.strategies.onlineEnsemble.nonTieHitRate),
      formatPct(row.strategies.forcedEveryHand.nonTieHitRate),
      formatPct(row.strategies.forcedEveryHandReverse.nonTieHitRate),
      formatPct(row.strategies.mainNextResult.nonTieHitRate),
      formatPct(row.strategies.fiveRoadConsensus.nonTieHitRate)
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      output[key] = next;
      index += 1;
    } else {
      output[key] = true;
    }
  }
  return output;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function formatPct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function formatSignedPct(value) {
  const number = Number(value || 0) * 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
}
