import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const required = ["index.html", "styles.css", "app.js", "manifest.webmanifest", "sw.js", "icon.svg"];
const missing = required.filter((file) => !existsSync(join(root, file)));

if (missing.length) {
  console.error(`Missing required files: ${missing.join(", ")}`);
  process.exit(1);
}

const index = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "app.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");

const checks = [
  [index.includes("百家樂監控數據"), "index title text"],
  [index.includes("app.js"), "index app script"],
  [app.includes("baijia-monitor-v2-empty-start"), "fresh storage key"],
  [app.includes("function addRound"), "round entry handler"],
  [styles.includes(".bead-road"), "road styling"]
];

const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);

if (failed.length) {
  console.error(`Validation failed: ${failed.join(", ")}`);
  process.exit(1);
}

console.log("Baijia fresh dashboard validation passed.");
