const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function loadDotEnv(filePath = path.join(ROOT, ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function intEnv(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

module.exports = {
  ROOT,
  DATA_DIR: path.join(ROOT, "data"),
  LOG_DIR: path.join(ROOT, "logs"),
  PUBLIC_DIR: path.join(ROOT, "public"),
  DB_PATH: process.env.DB_PATH || path.join(ROOT, "data", "baijia.sqlite"),
  PORT: intEnv("PORT", 4173),
  API_TOKEN: process.env.API_TOKEN || "change-me",
  ALLBET_URL: process.env.ALLBET_URL || "",
  ALLBET_HEADLESS: boolEnv("ALLBET_HEADLESS", true),
  RAW_PAYLOAD_LOGGING: boolEnv("RAW_PAYLOAD_LOGGING", true),
  RAW_PAYLOAD_MAX_BYTES: intEnv("RAW_PAYLOAD_MAX_BYTES", 500_000),
  SCRAPER_ENABLED: boolEnv("SCRAPER_ENABLED", true),
  TRAINER_ENABLED: boolEnv("TRAINER_ENABLED", true),
  TRAINER_INTERVAL_MS: Math.max(60_000, intEnv("TRAINER_INTERVAL_MS", 5 * 60_000)),
  CLOUD_WEBHOOK_URL: process.env.CLOUD_WEBHOOK_URL || "",
  PUBLIC_API_BASE: process.env.PUBLIC_API_BASE || ""
};
