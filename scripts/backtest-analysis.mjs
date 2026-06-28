import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const store = require("../src/store");
const { runTableBacktest } = require("../src/backtest");

const args = parseArgs(process.argv.slice(2));
const tableCode = String(args.table || args.code || process.env.BAIJIA_BACKTEST_TABLE_CODE || "").trim().toUpperCase();
const maxChecks = Number(args.checks || process.env.BAIJIA_BACKTEST_CHECKS || 120);
const limit = Number(args.limit || process.env.BAIJIA_BACKTEST_LIMIT || 2400);
const detailLimit = Number(args.details || process.env.BAIJIA_BACKTEST_DETAILS || 40);

store.ensureStore();
const tables = store.getAnalysisTableOptions();
const table = selectTable(tables, tableCode);
if (!table) {
  console.error(`No analysis table found${tableCode ? ` for ${tableCode}` : ""}.`);
  process.exit(2);
}

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
  detailLimit
});

mkdirSync(join(process.cwd(), "reports"), { recursive: true });
writeFileSync(join(process.cwd(), "reports", "analysis-backtest-latest.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 2;

function selectTable(tables, code) {
  if (code) return tables.find((table) => table.tableCode === code) || null;
  return [...tables].sort((left, right) => Number(right.rounds || 0) - Number(left.rounds || 0))[0] || null;
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
