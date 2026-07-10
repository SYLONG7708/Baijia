import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const { exportCsv } = createRequire(import.meta.url)("../src/store");

const args = process.argv.slice(2);
const format = readArg("--format") || "csv";
const output = readArg("--output");

if (!output) {
  throw new Error("Missing --output path.");
}
if (format !== "csv") {
  throw new Error(`Unsupported export format: ${format}`);
}

const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, exportCsv(), "utf8");

function readArg(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return args[index + 1] || "";
}
