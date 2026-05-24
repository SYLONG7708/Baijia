const { openDatabase, getAllRounds, getStatus, setStatus, logEvent } = require("./db");
const { isPredictionUsable } = require("./analytics");
const { buildModelSelection } = require("./model-selection");
const { buildValidation } = require("./validation");
const { buildCanonicalView } = require("./canonical");
const {
  TRAINING_DB_PATH,
  insertTrainingRun,
  openTrainingDatabase,
  upsertKnowledgeItem
} = require("./training-store");
const { TRAINER_INTERVAL_MS } = require("./env");

const RESEARCH_ITEMS = [
  {
    key: "baseline_odds",
    title: "Standard baccarat baseline probabilities",
    sourceUrl: "https://wizardofodds.com/games/baccarat/basics/",
    summary: "Use Banker, Player, and Tie base rates as priors. Candidate models must beat baseline log loss before promotion."
  },
  {
    key: "effect_of_removal",
    title: "Effect-of-removal and shoe composition",
    sourceUrl: "https://wizardofodds.com/games/baccarat/appendix/2/",
    summary: "Recorded card ranks can slightly change next-hand probabilities. Use only as a low-weight calibration layer."
  },
  {
    key: "card_counting_limits",
    title: "Baccarat card counting is limited",
    sourceUrl: "https://wizardofodds.com/games/baccarat/card-counting/",
    summary: "Card counting signals in baccarat are small and high variance; require walk-forward proof before increasing model weight."
  },
  {
    key: "side_bet_history",
    title: "Historic side-bet research",
    sourceUrl: "https://www.tandfonline.com/doi/abs/10.1080/01621459.1966.10480867",
    summary: "Side-bet opportunities are rule-specific. Pair and lucky-six models must be trained separately from main outcome models."
  }
];

let lastActiveModel = "";
let running = false;

function seedKnowledge() {
  for (const item of RESEARCH_ITEMS) upsertKnowledgeItem(item);
}

function trainingActions(validation, modelSelection) {
  const actions = [];
  const issueTables = validation.issueTables || [];
  const summary = validation.summary || {};
  if (summary.error > 0) {
    actions.push({
      type: "BLOCK_PROMOTION",
      severity: "ERROR",
      reason: "Snapshot/live conflicts exist. Keep current active model until data conflicts are resolved."
    });
  }

  const missingTables = issueTables.filter((table) => table.missingRoundNos?.length);
  if (missingTables.length) {
    actions.push({
      type: "USE_SNAPSHOT_ROAD_FILL",
      severity: "WARN",
      tables: missingTables.slice(0, 20).map((table) => ({
        code: table.code,
        missingRoundNos: table.missingRoundNos.slice(0, 20)
      })),
      reason: "Live stream skipped slots; road display should use snapshot-verified fill rows for missing round numbers."
    });
  }

  const snapshotOnlyTables = issueTables.filter((table) => table.snapshotOnlyRoundNos?.length);
  if (snapshotOnlyTables.length) {
    actions.push({
      type: "TRACK_LIVE_LAG",
      severity: "WARN",
      tables: snapshotOnlyTables.slice(0, 20).map((table) => ({
        code: table.code,
        snapshotOnlyRoundNos: table.snapshotOnlyRoundNos.slice(0, 20)
      })),
      reason: "Page road snapshot is ahead of reliable live inserts. Keep monitoring until live catches up."
    });
  }

  const active = modelSelection.active || {};
  if (modelSelection.activeModel && modelSelection.activeModel !== lastActiveModel) {
    actions.push({
      type: "MODEL_PROMOTION",
      severity: "INFO",
      modelId: modelSelection.activeModel,
      accuracyNoTie: active.accuracyNoTie || 0,
      averageLogLoss: active.averageLogLoss || 0,
      reason: "Walk-forward training selected the best calibrated candidate by log loss."
    });
  }
  return actions;
}

function checkOnce() {
  const allRounds = getAllRounds();
  const canonical = buildCanonicalView(allRounds);
  const reliableRounds = canonical.predictionRounds.filter(isPredictionUsable);
  const validation = buildValidation(allRounds);
  const modelSelection = buildModelSelection(reliableRounds, { limit: 1800, warmup: 45 });
  const actions = trainingActions(validation, modelSelection);
  const blocked = Number(validation.summary?.error || 0) > 0;
  const runId = insertTrainingRun({
    generatedAt: new Date().toISOString(),
    roundCount: allRounds.length,
    reliableRoundCount: reliableRounds.length,
    validation,
    modelSelection,
    actions
  });

  const active = modelSelection.active || {};
  const trainer = {
    running: true,
    pid: process.pid,
    trainingDbPath: TRAINING_DB_PATH,
    intervalSeconds: Math.round(TRAINER_INTERVAL_MS / 1000),
    lastRunAt: new Date().toISOString(),
    lastRunId: runId,
    roundCount: allRounds.length,
    reliableRoundCount: reliableRounds.length,
    activeModel: modelSelection.activeModel || "",
    activeAccuracyNoTie: active.accuracyNoTie || 0,
    activeLogLoss: active.averageLogLoss || 0,
    candidateCount: modelSelection.candidates?.length || 0,
    validationSummary: validation.summary || {},
    canonicalSummary: canonical.summary,
    promotionBlocked: blocked,
    actions: actions.slice(0, 12),
    autoCodeChanges: false,
    note: "Trainer stores walk-forward results and data audits locally. It does not auto-download or auto-execute unknown code."
  };

  setStatus("trainer", trainer);
  setStatus("modelSelection", modelSelection);
  if (modelSelection.activeModel && modelSelection.activeModel !== lastActiveModel) {
    logEvent("info", "trainer active model updated", {
      previous: lastActiveModel,
      activeModel: modelSelection.activeModel,
      runId
    });
    lastActiveModel = modelSelection.activeModel;
  }
  return trainer;
}

function run() {
  openDatabase();
  openTrainingDatabase();
  seedKnowledge();
  setStatus("trainer", {
    running: true,
    pid: process.pid,
    trainingDbPath: TRAINING_DB_PATH,
    startedAt: new Date().toISOString(),
    intervalSeconds: Math.round(TRAINER_INTERVAL_MS / 1000)
  });
  logEvent("info", "trainer started", { pid: process.pid, trainingDbPath: TRAINING_DB_PATH });

  const tick = () => {
    if (running) return;
    running = true;
    try {
      checkOnce();
    } catch (error) {
      setStatus("trainer", {
        running: true,
        pid: process.pid,
        trainingDbPath: TRAINING_DB_PATH,
        error: error.message,
        lastRunAt: new Date().toISOString()
      });
      logEvent("error", "trainer check failed", error.stack || error.message);
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, TRAINER_INTERVAL_MS);
}

function shutdown() {
  setStatus("trainer", {
    running: false,
    pid: process.pid,
    stoppedAt: new Date().toISOString()
  });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run();
