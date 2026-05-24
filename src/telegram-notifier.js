const {
  ALERT_MIN_RATE,
  ALERT_MIN_SAMPLE,
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
    thresholdPercent: Math.round(ALERT_MIN_RATE * 1000) / 10,
    minSample: ALERT_MIN_SAMPLE,
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
  if (value <= 65) return "";
  const count = Math.floor((value - 65) / 5) + 1;
  return "⭐".repeat(Math.max(1, count));
}

function latestRoundText(round) {
  if (!round) return "";
  const code = String(round.tableCode || "").trim();
  const meta = tableMeta(code);
  return `最新：${meta.category}${meta.code} 第${round.roundNo}局 ${outcomeLabels[round.outcome] || round.outcome}`;
}

function formatMessage(alerts, ingest) {
  const lines = [
    "結果群 即時勝率提醒",
    `時間：${new Date().toLocaleString("zh-TW", { hour12: false })}`,
    latestRoundText(ingest.latestRound),
    ""
  ].filter(Boolean);

  alerts.slice(0, 10).forEach((alert, index) => {
    const stars = accuracyStars(alert.continuationPercent);
    const starPrefix = stars ? `${stars} ` : "";
    lines.push(`${index + 1}. ${starPrefix}${tableDisplayName(alert)} ${alert.outcomeLabel}連${alert.length} 準確度${alert.continuationPercent}% 樣本${alert.continuations}/${alert.opportunities} 第${alert.lastRoundNo}局`);
  });
  if (alerts.length > 10) lines.push(`另外 ${alerts.length - 10} 桌符合條件`);
  return lines.join("\n").slice(0, 3900);
}

async function sendAlerts(alerts, ingest) {
  const text = formatMessage(alerts, ingest);
  await telegramApi("sendMessage", {
    chat_id: resolvedChatId,
    text,
    disable_web_page_preview: true
  });
  lastSentAt = new Date().toISOString();
}

function buildAlerts() {
  const allRounds = getAllRounds();
  const canonical = buildCanonicalView(allRounds);
  const reliable = canonical.predictionRounds.filter(isPredictionUsable);
  const validation = buildValidation(allRounds);
  const summary = summarizeAll(reliable);
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
    if (ingest.latestId && ingest.latestId === lastLatestId) {
      updateStatus({ configured: true, state: "WATCHING", lastCheckAt: new Date().toISOString() });
      return;
    }
    lastLatestId = ingest.latestId || lastLatestId;

    const { canonical, validation, alerts } = buildAlerts();
    const signature = alertSignature(alerts);
    if (alerts.length && signature && signature !== lastSignature) {
      await sendAlerts(alerts, ingest);
      lastSignature = signature;
      logEvent("info", "telegram alerts sent", { count: alerts.length });
    }

    updateStatus({
      configured: true,
      state: alerts.length ? "ALERT_READY" : "WATCHING",
      lastCheckAt: new Date().toISOString(),
      lastAlertCount: alerts.length,
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
