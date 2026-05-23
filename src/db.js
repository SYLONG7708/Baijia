const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { DATA_DIR, DB_PATH } = require("./env");
const { tableMeta, normalizeTableCode } = require("./tables");
const { normalizeOutcome, normalizeCardList } = require("./baccarat-codec");

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
  migrateDatabase(db);
  return db;
}

function columnNames(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(table, name, definition) {
  const columns = columnNames(table);
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function migrateDatabase(database) {
  db = database;
  addColumnIfMissing("rounds", "banker_cards_raw", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("rounds", "player_cards_raw", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("rounds", "banker_card_points", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("rounds", "player_card_points", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("rounds", "banker_card_ranks", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("rounds", "player_card_ranks", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("rounds", "card_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("rounds", "card_observed_at", "TEXT NOT NULL DEFAULT ''");
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
    bankerCardsRaw: parseJsonArray(row.banker_cards_raw),
    playerCardsRaw: parseJsonArray(row.player_cards_raw),
    bankerCardPoints: parseJsonArray(row.banker_card_points),
    playerCardPoints: parseJsonArray(row.player_card_points),
    bankerCardRanks: parseJsonArray(row.banker_card_ranks),
    playerCardRanks: parseJsonArray(row.player_card_ranks),
    cardCount: row.card_count || 0,
    cardObservedAt: row.card_observed_at,
    rawResult: row.raw_result,
    source: row.source,
    sourceEvent: row.source_event,
    observedAt: row.observed_at,
    insertedAt: row.inserted_at
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cardFields(input) {
  const bankerCards = normalizeCardList(input.bankerCards || input.banker_cards || input.bankerCardsRaw || input.banker_cards_raw || []);
  const playerCards = normalizeCardList(input.playerCards || input.player_cards || input.playerCardsRaw || input.player_cards_raw || []);
  const bankerCardPoints = input.bankerCardPoints || input.banker_card_points || bankerCards.map((card) => card.point);
  const playerCardPoints = input.playerCardPoints || input.player_card_points || playerCards.map((card) => card.point);
  const bankerCardRanks = input.bankerCardRanks || input.banker_card_ranks || bankerCards.map((card) => card.rank);
  const playerCardRanks = input.playerCardRanks || input.player_card_ranks || playerCards.map((card) => card.rank);
  const bankerCardsRaw = input.bankerCardsRaw || input.banker_cards_raw || bankerCards.map((card) => card.raw);
  const playerCardsRaw = input.playerCardsRaw || input.player_cards_raw || playerCards.map((card) => card.raw);
  const cardCount = bankerCardsRaw.length + playerCardsRaw.length;
  return {
    bankerCardsRaw,
    playerCardsRaw,
    bankerCardPoints,
    playerCardPoints,
    bankerCardRanks,
    playerCardRanks,
    cardCount,
    cardObservedAt: input.cardObservedAt || input.card_observed_at || ""
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
    ...cardFields(input),
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
      banker_cards_raw, player_cards_raw, banker_card_points, player_card_points,
      banker_card_ranks, player_card_ranks, card_count, card_observed_at,
      raw_result, source, source_event, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    JSON.stringify(round.bankerCardsRaw),
    JSON.stringify(round.playerCardsRaw),
    JSON.stringify(round.bankerCardPoints),
    JSON.stringify(round.playerCardPoints),
    JSON.stringify(round.bankerCardRanks),
    JSON.stringify(round.playerCardRanks),
    round.cardCount,
    round.cardObservedAt,
    round.rawResult,
    round.source,
    round.sourceEvent,
    round.observedAt
  );

  if (result.changes === 0 && round.cardCount > 0) {
    database.prepare(`
      UPDATE rounds
      SET banker_cards_raw = ?,
          player_cards_raw = ?,
          banker_card_points = ?,
          player_card_points = ?,
          banker_card_ranks = ?,
          player_card_ranks = ?,
          card_count = ?,
          card_observed_at = ?
      WHERE dedupe_key = ? AND card_count = 0
    `).run(
      JSON.stringify(round.bankerCardsRaw),
      JSON.stringify(round.playerCardsRaw),
      JSON.stringify(round.bankerCardPoints),
      JSON.stringify(round.playerCardPoints),
      JSON.stringify(round.bankerCardRanks),
      JSON.stringify(round.playerCardRanks),
      round.cardCount,
      round.cardObservedAt,
      dedupeKey
    );
  }

  return {
    inserted: result.changes > 0,
    round: { ...round, dedupeKey }
  };
}

function updateRoundCards(input) {
  const database = openDatabase();
  const tableCode = normalizeTableCode(input.tableCode || input.table_code);
  const roundNo = Number(input.roundNo || input.round_no || 0) || 0;
  const rawResult = String(input.rawResult || input.raw_result || "");
  const fields = cardFields(input);
  if (!tableCode || roundNo <= 0 || !rawResult || fields.cardCount <= 0) {
    return { updated: false, reason: "invalid-card-update" };
  }

  const result = database.prepare(`
    UPDATE rounds
    SET banker_cards_raw = ?,
        player_cards_raw = ?,
        banker_card_points = ?,
        player_card_points = ?,
        banker_card_ranks = ?,
        player_card_ranks = ?,
        card_count = ?,
        card_observed_at = ?
    WHERE id = (
      SELECT id FROM rounds
      WHERE table_code = ? AND round_no = ? AND raw_result = ? AND card_count = 0
      ORDER BY id DESC
      LIMIT 1
    )
  `).run(
    JSON.stringify(fields.bankerCardsRaw),
    JSON.stringify(fields.playerCardsRaw),
    JSON.stringify(fields.bankerCardPoints),
    JSON.stringify(fields.playerCardPoints),
    JSON.stringify(fields.bankerCardRanks),
    JSON.stringify(fields.playerCardRanks),
    fields.cardCount,
    fields.cardObservedAt,
    tableCode,
    roundNo,
    rawResult
  );
  return { updated: result.changes > 0 };
}

function rowRoundNo(row) {
  return Number(row.round_no || 0) || 0;
}

function isLikelyNewShoe(previousRoundNo, roundNo) {
  return previousRoundNo > 0
    && roundNo > 0
    && roundNo < previousRoundNo
    && (roundNo <= 5 || previousRoundNo - roundNo >= 20);
}

function isCurrentProgressAnchor(row) {
  return row.source_event !== "roadSnapshot" && row.source_event !== "getGameHall" && row.source_event !== "getGameHall:snapshot";
}

function currentShoeSlotRows(tableCode) {
  const rows = openDatabase().prepare(`
    SELECT id, round_no, source_event
    FROM rounds
    WHERE table_code = ? AND source_event NOT IN ('getGameHall', 'getGameHall:snapshot')
    ORDER BY id ASC
  `).all(tableCode);
  if (!rows.length) return rows;

  const anchors = rows.filter(isCurrentProgressAnchor);
  const progress = anchors.length ? anchors : rows;
  let currentStartId = Number(progress[0].id || 0);
  let previousRoundNo = rowRoundNo(progress[0]);
  for (let index = 1; index < progress.length; index += 1) {
    const roundNo = rowRoundNo(progress[index]);
    if (isLikelyNewShoe(previousRoundNo, roundNo)) currentStartId = Number(progress[index].id || 0);
    if (roundNo > 0) previousRoundNo = roundNo;
  }

  return rows.filter((row) => Number(row.id || 0) >= currentStartId);
}

function slotHasRound(input) {
  const tableCode = normalizeTableCode(input.tableCode || input.table_code);
  const roundNo = Number(input.roundNo || input.round_no || 0) || 0;
  if (!tableCode || roundNo <= 0) return true;
  return currentShoeSlotRows(tableCode).some((row) => rowRoundNo(row) === roundNo);
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

function getRoundIngestSummary() {
  const database = openDatabase();
  const reliableWhere = "source_event NOT IN ('getGameHall', 'getGameHall:snapshot')";
  const totals = database.prepare(`
    SELECT COUNT(*) AS total_rounds, MAX(id) AS latest_id
    FROM rounds
    WHERE ${reliableWhere}
  `).get();
  const latest = database.prepare(`
    SELECT * FROM rounds
    WHERE ${reliableWhere}
    ORDER BY id DESC
    LIMIT 1
  `).get();
  const recent = database.prepare(`
    SELECT
      SUM(CASE WHEN inserted_at >= datetime('now', '-5 minutes') THEN 1 ELSE 0 END) AS last_5m,
      SUM(CASE WHEN inserted_at >= datetime('now', '-15 minutes') THEN 1 ELSE 0 END) AS last_15m,
      SUM(CASE WHEN inserted_at >= datetime('now', '-60 minutes') THEN 1 ELSE 0 END) AS last_60m
    FROM rounds
    WHERE ${reliableWhere}
  `).get();

  return {
    totalRounds: Number(totals?.total_rounds || 0),
    latestId: Number(totals?.latest_id || 0),
    latestRound: rowToRound(latest),
    recent: {
      last5m: Number(recent?.last_5m || 0),
      last15m: Number(recent?.last_15m || 0),
      last60m: Number(recent?.last_60m || 0)
    }
  };
}

module.exports = {
  openDatabase,
  insertRound,
  updateRoundCards,
  slotHasRound,
  getRounds,
  getAllRounds,
  getTableRounds,
  setStatus,
  getStatus,
  logEvent,
  getEvents,
  getRoundIngestSummary
};
