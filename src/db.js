const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { DATA_DIR, DB_PATH } = require("./env");
const { tableMeta, normalizeTableCode } = require("./tables");
const { normalizeOutcome } = require("./baccarat-codec");

fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

function openDatabase() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      table_code TEXT NOT NULL,
      table_name TEXT NOT NULL,
      category TEXT NOT NULL,
      shoe_id TEXT NOT NULL,
      round_no INTEGER NOT NULL DEFAULT 0,
      game_round_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      banker_pair INTEGER NOT NULL DEFAULT 0,
      player_pair INTEGER NOT NULL DEFAULT 0,
      lucky_six INTEGER NOT NULL DEFAULT 0,
      banker_point TEXT NOT NULL DEFAULT '',
      player_point TEXT NOT NULL DEFAULT '',
      raw_result TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      source_event TEXT NOT NULL DEFAULT '',
      observed_at TEXT NOT NULL,
      inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rounds_table_id ON rounds(table_code, id);
    CREATE INDEX IF NOT EXISTS idx_rounds_table_shoe_round ON rounds(table_code, shoe_id, round_no);
    CREATE INDEX IF NOT EXISTS idx_rounds_observed ON rounds(observed_at);

    CREATE TABLE IF NOT EXISTS scraper_status (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function makeDedupeKey(round) {
  const stable = [
    round.tableCode,
    round.shoeId,
    round.gameRoundId,
    round.roundNo,
    round.rawResult,
    round.outcome
  ].join("|");
  return crypto.createHash("sha1").update(stable).digest("hex");
}

function rowToRound(row) {
  if (!row) return null;
  return {
    id: row.id,
    tableCode: row.table_code,
    tableName: row.table_name,
    category: row.category,
    shoeId: row.shoe_id,
    roundNo: row.round_no,
    gameRoundId: row.game_round_id,
    outcome: row.outcome,
    bankerPair: Boolean(row.banker_pair),
    playerPair: Boolean(row.player_pair),
    luckySix: Boolean(row.lucky_six),
    bankerPoint: row.banker_point,
    playerPoint: row.player_point,
    rawResult: row.raw_result,
    source: row.source,
    sourceEvent: row.source_event,
    observedAt: row.observed_at,
    insertedAt: row.inserted_at
  };
}

function insertRound(input) {
  const database = openDatabase();
  const tableCode = normalizeTableCode(input.tableCode || input.table_code);
  const meta = tableMeta(tableCode);
  const outcome = normalizeOutcome(input.outcome);
  if (!tableCode || !outcome) return { inserted: false, reason: "invalid-round" };

  const round = {
    tableCode,
    tableName: String(input.tableName || input.table_name || meta.label || tableCode),
    category: String(input.category || meta.category || "其他"),
    shoeId: String(input.shoeId || input.shoe_id || ""),
    roundNo: Number(input.roundNo || input.round_no || 0) || 0,
    gameRoundId: String(input.gameRoundId || input.game_round_id || ""),
    outcome,
    bankerPair: Boolean(input.bankerPair ?? input.banker_pair),
    playerPair: Boolean(input.playerPair ?? input.player_pair),
    luckySix: Boolean(input.luckySix ?? input.lucky_six),
    bankerPoint: String(input.bankerPoint || input.banker_point || ""),
    playerPoint: String(input.playerPoint || input.player_point || ""),
    rawResult: String(input.rawResult || input.raw_result || ""),
    source: String(input.source || ""),
    sourceEvent: String(input.sourceEvent || input.source_event || ""),
    observedAt: input.observedAt ? new Date(input.observedAt).toISOString() : new Date().toISOString()
  };

  if (!round.shoeId) round.shoeId = round.observedAt.slice(0, 10);
  if (!round.gameRoundId) round.gameRoundId = `${round.shoeId}:${round.roundNo}:${round.rawResult}`;
  const dedupeKey = makeDedupeKey(round);

  const result = database.prepare(`
    INSERT OR IGNORE INTO rounds (
      dedupe_key, table_code, table_name, category, shoe_id, round_no, game_round_id,
      outcome, banker_pair, player_pair, lucky_six, banker_point, player_point,
      raw_result, source, source_event, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    dedupeKey,
    round.tableCode,
    round.tableName,
    round.category,
    round.shoeId,
    round.roundNo,
    round.gameRoundId,
    round.outcome,
    round.bankerPair ? 1 : 0,
    round.playerPair ? 1 : 0,
    round.luckySix ? 1 : 0,
    round.bankerPoint,
    round.playerPoint,
    round.rawResult,
    round.source,
    round.sourceEvent,
    round.observedAt
  );

  return {
    inserted: result.changes > 0,
    round: { ...round, dedupeKey }
  };
}

function getRounds(options = {}) {
  const database = openDatabase();
  const tableCode = normalizeTableCode(options.tableCode);
  const limit = Math.min(Number(options.limit || 5000), 100000);
  if (tableCode) {
    return database.prepare(`
      SELECT * FROM rounds
      WHERE table_code = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(tableCode, limit).reverse().map(rowToRound);
  }
  return database.prepare(`
    SELECT * FROM rounds
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).reverse().map(rowToRound);
}

function getAllRounds() {
  return openDatabase().prepare("SELECT * FROM rounds ORDER BY id ASC").all().map(rowToRound);
}

function getTableRounds(tableCode) {
  return getRounds({ tableCode, limit: 100000 });
}

function setStatus(key, value) {
  openDatabase().prepare(`
    INSERT INTO scraper_status(key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, typeof value === "string" ? value : JSON.stringify(value));
}

function getStatus() {
  const rows = openDatabase().prepare("SELECT key, value, updated_at FROM scraper_status").all();
  const status = {};
  for (const row of rows) {
    try {
      status[row.key] = JSON.parse(row.value);
    } catch {
      status[row.key] = row.value;
    }
    status[`${row.key}UpdatedAt`] = row.updated_at;
  }
  return status;
}

function logEvent(level, message, detail = "") {
  openDatabase().prepare(`
    INSERT INTO event_log(level, message, detail)
    VALUES (?, ?, ?)
  `).run(String(level), String(message), typeof detail === "string" ? detail : JSON.stringify(detail));
}

function getEvents(limit = 100) {
  return openDatabase().prepare(`
    SELECT * FROM event_log
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.min(Number(limit) || 100, 1000)).reverse();
}

module.exports = {
  openDatabase,
  insertRound,
  getRounds,
  getAllRounds,
  getTableRounds,
  setStatus,
  getStatus,
  logEvent,
  getEvents
};
