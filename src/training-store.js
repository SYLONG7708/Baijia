const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { DATA_DIR } = require("./env");

const TRAINING_DB_PATH = process.env.TRAINING_DB_PATH || path.join(DATA_DIR, "training.sqlite");

let db;

function openTrainingDatabase() {
  if (db) return db;
  fs.mkdirSync(path.dirname(TRAINING_DB_PATH), { recursive: true });
  db = new DatabaseSync(TRAINING_DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 10000;

    CREATE TABLE IF NOT EXISTS training_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      round_count INTEGER NOT NULL DEFAULT 0,
      reliable_round_count INTEGER NOT NULL DEFAULT 0,
      active_model TEXT NOT NULL DEFAULT '',
      active_accuracy_no_tie REAL NOT NULL DEFAULT 0,
      active_log_loss REAL NOT NULL DEFAULT 0,
      validation_warn INTEGER NOT NULL DEFAULT 0,
      validation_error INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_candidate_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      tested INTEGER NOT NULL DEFAULT 0,
      accuracy REAL NOT NULL DEFAULT 0,
      accuracy_no_tie REAL NOT NULL DEFAULT 0,
      average_log_loss REAL NOT NULL DEFAULT 0,
      average_brier REAL NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES training_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_training_runs_created ON training_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_candidate_scores_run ON model_candidate_scores(run_id);
    CREATE INDEX IF NOT EXISTS idx_candidate_scores_model ON model_candidate_scores(model_id, id);

    CREATE TABLE IF NOT EXISTS data_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      validation_summary_json TEXT NOT NULL,
      issue_tables_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES training_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS knowledge_items (
      key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isLockedError(error) {
  return String(error?.message || "").includes("database is locked")
    || error?.errcode === 5
    || (error?.code === "ERR_SQLITE_ERROR" && error?.errstr === "database is locked");
}

function runWithRetry(statement, args = [], attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return statement.run(...args);
    } catch (error) {
      if (!isLockedError(error)) throw error;
      lastError = error;
      sleepMs(75 * (attempt + 1));
    }
  }
  throw lastError;
}

function insertTrainingRun(input) {
  const database = openTrainingDatabase();
  const modelSelection = input.modelSelection || {};
  const validation = input.validation || {};
  const summary = validation.summary || {};
  const active = modelSelection.active || {};
  const result = runWithRetry(database.prepare(`
    INSERT INTO training_runs (
      round_count, reliable_round_count, active_model, active_accuracy_no_tie,
      active_log_loss, validation_warn, validation_error, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `), [
    Number(input.roundCount || 0),
    Number(input.reliableRoundCount || 0),
    String(modelSelection.activeModel || ""),
    Number(active.accuracyNoTie || 0),
    Number(active.averageLogLoss || 0),
    Number(summary.warn || 0),
    Number(summary.error || 0),
    JSON.stringify(input)
  ]);

  const runId = Number(result.lastInsertRowid);
  const insertCandidate = database.prepare(`
    INSERT INTO model_candidate_scores (
      run_id, model_id, tested, accuracy, accuracy_no_tie,
      average_log_loss, average_brier, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const candidate of modelSelection.candidates || []) {
    runWithRetry(insertCandidate, [
      runId,
      String(candidate.modelId || ""),
      Number(candidate.tested || 0),
      Number(candidate.accuracy || 0),
      Number(candidate.accuracyNoTie || 0),
      Number(candidate.averageLogLoss || 0),
      Number(candidate.averageBrier || 0),
      JSON.stringify(candidate)
    ]);
  }

  runWithRetry(database.prepare(`
    INSERT INTO data_audits(run_id, validation_summary_json, issue_tables_json, actions_json)
    VALUES (?, ?, ?, ?)
  `), [
    runId,
    JSON.stringify(summary),
    JSON.stringify((validation.issueTables || []).slice(0, 80)),
    JSON.stringify(input.actions || [])
  ]);

  pruneTrainingRuns(database);
  return runId;
}

function pruneTrainingRuns(database = openTrainingDatabase()) {
  const keep = Math.max(200, Number(process.env.TRAINING_KEEP_RUNS || 2000));
  runWithRetry(database.prepare(`
    DELETE FROM training_runs
    WHERE id NOT IN (
      SELECT id FROM training_runs ORDER BY id DESC LIMIT ?
    )
  `), [keep]);
}

function upsertKnowledgeItem(item) {
  runWithRetry(openTrainingDatabase().prepare(`
    INSERT INTO knowledge_items(key, title, source_url, summary, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      title = excluded.title,
      source_url = excluded.source_url,
      summary = excluded.summary,
      updated_at = excluded.updated_at
  `), [
    String(item.key || ""),
    String(item.title || ""),
    String(item.sourceUrl || ""),
    String(item.summary || "")
  ]);
}

function getTrainingSummary(limit = 20) {
  const database = openTrainingDatabase();
  const runs = database.prepare(`
    SELECT id, created_at, round_count, reliable_round_count, active_model,
           active_accuracy_no_tie, active_log_loss, validation_warn, validation_error
    FROM training_runs
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit || 20), 200)));
  const latestRun = runs[0] || null;
  const candidates = latestRun
    ? database.prepare(`
      SELECT model_id, tested, accuracy, accuracy_no_tie, average_log_loss, average_brier
      FROM model_candidate_scores
      WHERE run_id = ?
      ORDER BY average_log_loss ASC, accuracy_no_tie DESC
    `).all(latestRun.id)
    : [];
  const knowledge = database.prepare(`
    SELECT key, title, source_url, summary, updated_at
    FROM knowledge_items
    ORDER BY key ASC
  `).all();
  return {
    path: TRAINING_DB_PATH,
    latestRun,
    candidates,
    recentRuns: runs,
    knowledge
  };
}

module.exports = {
  TRAINING_DB_PATH,
  openTrainingDatabase,
  insertTrainingRun,
  upsertKnowledgeItem,
  getTrainingSummary
};
