const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_GROUP_NAME,
  TELEGRAM_POLL_INTERVAL_MS
} = require("./env");
const { getAllRounds, getRoundIngestSummary, getStatus, setStatus, logEvent, openDatabase } = require("./db");
const { summarizeAll, isPredictionUsable } = require("./analytics");
const { buildCanonicalView } = require("./canonical");
const { buildValidation } = require("./validation");
const { buildStreakAlerts, alertSignature } = require("./alerts");
const { tableMeta } = require("./tables");
const { predictByModel } = require("./model-selection");

let resolvedChatId = TELEGRAM_CHAT_ID;
let lastLatestId = 0;
let lastSignature = "";
let lastSentAt = "";
let running = false;

const outcomeLabels = {
  BANKER: "莊",
  PLAYER: "閒",
  TIE: "和"
};

function maskChatId(chatId) {
  const text = String(chatId || "");
  if (!text) return "";
  if (text.length <= 5) return "***";
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

async function telegramApi(method, body = {}) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return data.result;
}

function updateStatus(patch) {
  setStatus("telegram", {
    running: true,
    pid: process.pid,
    enabled: true,
    groupName: TELEGRAM_GROUP_NAME,
    chatIdConfigured: Boolean(resolvedChatId),
    chatId: maskChatId(resolvedChatId),
    thresholdPercent: 0,
    topLimit: 2,
    scoreLabel: "最高勝率",
    minSample: 0,
    intervalSeconds: Math.round(TELEGRAM_POLL_INTERVAL_MS / 1000),
    lastSentAt,
    ...patch
  });
}

async function discoverChatId() {
  const updates = await telegramApi("getUpdates", {
    allowed_updates: ["message", "my_chat_member"]
  });
  for (const update of updates.reverse()) {
    const chat = update.message?.chat || update.my_chat_member?.chat;
    if (!chat) continue;
    if (chat.title === TELEGRAM_GROUP_NAME) return String(chat.id);
  }
  return "";
}

function tableDisplayName(alert) {
  const code = String(alert.code || "").trim();
  const category = String(alert.category || tableMeta(code).category || "").trim();
  return `${category}${code}` || code || "-";
}

function accuracyStars(percent) {
  const value = Number(percent || 0);
  if (value <= 60) return "";
  const count = Math.floor((value - 60) / 5) + 1;
  return "⭐".repeat(Math.max(1, count));
}

function cleanPredictionState(input = {}) {
  return {
    pending: input.pending && typeof input.pending === "object" ? input.pending : {},
    streaks: input.streaks && typeof input.streaks === "object" ? input.streaks : {},
    sentSignatures: input.sentSignatures && typeof input.sentSignatures === "object" ? input.sentSignatures : {},
    alertSetSignature: typeof input.alertSetSignature === "string" ? input.alertSetSignature : ""
  };
}

function loadPredictionState() {
  return cleanPredictionState(getStatus().telegramPredictionState || {});
}

function savePredictionState(state) {
  setStatus("telegramPredictionState", cleanPredictionState(state));
}

function updatePredictionState(state, latestRound) {
  if (!latestRound?.tableCode || !latestRound?.roundNo) return false;
  const code = String(latestRound.tableCode);
  const pending = state.pending[code];
  if (!pending || Number(latestRound.roundNo || 0) <= Number(pending.lastRoundNo || 0)) return false;

  const previous = state.streaks[code] || {};
  const hit = latestRound.outcome === pending.outcome;
  const successStreak = hit ? Number(previous.successStreak || 0) + 1 : 0;
  state.streaks[code] = {
    successStreak,
    lastPrediction: pending.outcome,
    lastOutcome: latestRound.outcome,
    lastCheckedRoundNo: latestRound.roundNo,
    updatedAt: new Date().toISOString()
  };
  delete state.pending[code];
  return true;
}

function registerPendingPrediction(state, alert) {
  if (!alert?.code || !alert?.outcome) return;
  state.pending[alert.code] = {
    outcome: alert.outcome,
    lastRoundNo: alert.lastRoundNo || 0,
    sentAt: new Date().toISOString()
  };
}

function successStreakForAlert(state, alert) {
  return Number(state.streaks?.[alert.code]?.successStreak || 0);
}

function alertDisplayPercent(alert) {
  return Number(alert.scorePercent ?? alert.displayPercent ?? alert.continuationPercent ?? 0);
}

function formatMessage(alert, predictionState) {
  const displayPercent = alertDisplayPercent(alert);
  const stars = accuracyStars(displayPercent);
  const successStreak = successStreakForAlert(predictionState, alert);
  const lines = [
    `時間: ${new Date().toLocaleString("zh-TW", { hour12: false })}`,
    `${stars ? `${stars} ` : ""}${tableDisplayName(alert)}`,
    `預測: ${alert.outcomeLabel}`,
    `最高勝率: ${displayPercent}%`
  ];
  if (successStreak > 0) {
    lines.push(`🔥🔥🔥 連續命中 ${successStreak} 連勝 🔥🔥🔥`);
  }
  return lines.join("\n").slice(0, 3900);
}

async function sendAlert(alert, predictionState) {
  const text = formatMessage(alert, predictionState);
  await telegramApi("sendMessage", {
    chat_id: resolvedChatId,
    text,
    disable_web_page_preview: true
  });
  lastSentAt = new Date().toISOString();
}

function summaryWithActiveModel(summary, rounds, status = {}) {
  const modelSelection = status.modelSelection || {};
  const activeModel = modelSelection.activeModel || status.trainer?.activeModel || "";
  if (!activeModel) return summary;
  const tableModelByCode = new Map((modelSelection.tableModels || []).map((item) => [item.tableCode, item]));
  return {
    ...summary,
    activeModel,
    prediction: predictByModel(rounds, "", activeModel),
    tables: (summary.tables || []).map((table) => ({
      ...table,
      activeModel: tableModelByCode.get(table.code)?.modelId || activeModel,
      tableModel: tableModelByCode.get(table.code) || null,
      prediction: predictByModel(rounds, table.code, tableModelByCode.get(table.code)?.modelId || activeModel)
    }))
  };
}

function buildAlerts() {
  const allRounds = getAllRounds();
  const canonical = buildCanonicalView(allRounds);
  const reliable = canonical.predictionRounds.filter(isPredictionUsable);
  const validation = buildValidation(allRounds);
  const status = getStatus();
  const summary = summaryWithActiveModel(summarizeAll(reliable), reliable, status);
  return {
    canonical,
    validation,
    alerts: buildStreakAlerts(summary, validation).alerts
  };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      updateStatus({
        configured: false,
        state: "WAITING_BOT_TOKEN",
        reason: "Set TELEGRAM_BOT_TOKEN, create Telegram group named 結果群, add the bot, then set TELEGRAM_CHAT_ID or send one message in that group."
      });
      return;
    }

    if (!resolvedChatId) {
      resolvedChatId = await discoverChatId();
      if (!resolvedChatId) {
        updateStatus({
          configured: false,
          state: "WAITING_GROUP",
          reason: `Create Telegram group "${TELEGRAM_GROUP_NAME}", add the bot, and send one message so the bot can discover the group id.`
        });
        return;
      }
      logEvent("info", "telegram group discovered", { groupName: TELEGRAM_GROUP_NAME, chatId: maskChatId(resolvedChatId) });
    }

    const ingest = getRoundIngestSummary();
    const predictionState = loadPredictionState();
    const predictionStateChanged = updatePredictionState(predictionState, ingest.latestRound);
    if (ingest.latestId && ingest.latestId === lastLatestId) {
      if (predictionStateChanged) savePredictionState(predictionState);
      updateStatus({ configured: true, state: "WATCHING", lastCheckAt: new Date().toISOString() });
      return;
    }
    lastLatestId = ingest.latestId || lastLatestId;

    const { canonical, validation, alerts } = buildAlerts();
    const pushedAlerts = [];
    const alertSetSignature = alertSignature(alerts);
    if (alerts.length && alertSetSignature && predictionState.alertSetSignature !== alertSetSignature) {
      for (const alert of alerts) {
        const signature = alertSignature([alert]);
        await sendAlert(alert, predictionState);
        registerPendingPrediction(predictionState, alert);
        predictionState.sentSignatures[alert.code] = signature;
        pushedAlerts.push(alert);
        logEvent("info", "telegram alert sent", { code: alert.code, scorePercent: alertDisplayPercent(alert) });
      }
      predictionState.alertSetSignature = alertSetSignature;
      lastSignature = alertSetSignature;
    }

    if (pushedAlerts.length || predictionStateChanged) {
      savePredictionState(predictionState);
    }
    const lastPushedAlert = pushedAlerts.at(-1) || null;

    updateStatus({
      configured: true,
      state: alerts.length ? "ALERT_READY" : "WATCHING",
      lastCheckAt: new Date().toISOString(),
      lastAlertCount: alerts.length,
      lastPushedTable: lastPushedAlert?.code || "",
      lastPushedTables: pushedAlerts.map((alert) => alert.code),
      lastPushedCount: pushedAlerts.length,
      lastPushedPercent: lastPushedAlert ? alertDisplayPercent(lastPushedAlert) : 0,
      latestId: ingest.latestId,
      latestRound: ingest.latestRound
        ? {
          tableCode: ingest.latestRound.tableCode,
          roundNo: ingest.latestRound.roundNo,
          outcome: ingest.latestRound.outcome,
          insertedAt: ingest.latestRound.insertedAt
        }
        : null,
      canonicalSummary: canonical.summary,
      validationSummary: validation.summary || {}
    });
  } catch (error) {
    updateStatus({
      configured: Boolean(TELEGRAM_BOT_TOKEN && resolvedChatId),
      state: "ERROR",
      error: error.message,
      lastCheckAt: new Date().toISOString()
    });
    logEvent("warn", "telegram notifier failed", error.message);
  } finally {
    running = false;
  }
}

function run() {
  openDatabase();
  updateStatus({ state: "STARTING", startedAt: new Date().toISOString() });
  logEvent("info", "telegram notifier started", {
    pid: process.pid,
    enabled: true,
    groupName: TELEGRAM_GROUP_NAME,
    hasToken: Boolean(TELEGRAM_BOT_TOKEN),
    hasChatId: Boolean(TELEGRAM_CHAT_ID)
  });
  tick();
  setInterval(tick, TELEGRAM_POLL_INTERVAL_MS);
}

function shutdown() {
  setStatus("telegram", {
    running: false,
    pid: process.pid,
    stoppedAt: new Date().toISOString()
  });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run();
