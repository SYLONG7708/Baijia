const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { ALLBET_URL, ALLBET_HEADLESS, DATA_DIR, RAW_PAYLOAD_LOGGING, RAW_PAYLOAD_MAX_BYTES, ROOT } = require("./env");
const { insertRound, updateRoundCards, setStatus, logEvent } = require("./db");
const {
  extractRoundsFromPayload,
  extractLiveRoundsFromPayload,
  extractTableReferencesFromPayload,
  extractCardSnapshotsFromPayload
} = require("./extractor");

const urlArg = process.argv.find((arg) => arg.startsWith("http"));
const TARGET_URL = urlArg || ALLBET_URL;
const userDataDir = `${ROOT}/data/playwright-profile`;

let insertedTotal = 0;
let browserContext;
const tableRefs = new Map();
const pendingPayloads = [];
const recentRoundKeys = new Map();
const scraperStatus = {};
const cardSnapshotsByTable = new Map();
const cardSnapshotsByGame = new Map();
const shoeStateByTable = new Map();
let lastWebsocketAtMs = 0;
let lastRecoveryAtMs = 0;

function archivePayload(text, source, counts = {}) {
  try {
    if (!RAW_PAYLOAD_LOGGING) return;
    const hasUsefulData = Object.values(counts).some((value) => Number(value || 0) > 0);
    if (!hasUsefulData) return;
    const dir = path.join(DATA_DIR, "raw-payloads");
    fs.mkdirSync(dir, { recursive: true });
    const maxBytes = Math.max(10_000, Number(RAW_PAYLOAD_MAX_BYTES || 500_000));
    const buffer = Buffer.from(text, "utf8");
    const truncated = buffer.length > maxBytes;
    const payload = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : text;
    const row = {
      at: new Date().toISOString(),
      source,
      sha1: crypto.createHash("sha1").update(text).digest("hex"),
      bytes: buffer.length,
      truncated,
      counts,
      payload
    };
    fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
  } catch (error) {
    logEvent("warn", "raw payload archive failed", error.message);
  }
}

function isLikelyNewShoe(previousRoundNo, roundNo) {
  return previousRoundNo > 0
    && roundNo > 0
    && roundNo < previousRoundNo
    && (roundNo <= 5 || previousRoundNo - roundNo >= 20);
}

function seenRecently(round) {
  const now = Date.now();
  for (const [key, at] of recentRoundKeys.entries()) {
    if (now - at > 10 * 60 * 1000) recentRoundKeys.delete(key);
  }
  const sourceGroup = round.sourceEvent === "roadSnapshot" ? "snapshot" : "live";
  const key = `${sourceGroup}|${round.tableCode}|${round.roundNo}|${round.rawResult}`;
  if (recentRoundKeys.has(key)) return true;
  recentRoundKeys.set(key, now);
  return false;
}

function storeCardSnapshot(snapshot) {
  if (!snapshot.providerTableId || snapshot.cardCount < 4) return;
  const tableKey = snapshot.providerTableId;
  const gameKey = `${snapshot.providerTableId}|${snapshot.gameRoundId || ""}`;
  const existingTable = cardSnapshotsByTable.get(tableKey);
  if (!existingTable || snapshot.cardCount >= existingTable.cardCount) {
    cardSnapshotsByTable.set(tableKey, snapshot);
  }
  if (snapshot.gameRoundId) {
    const existingGame = cardSnapshotsByGame.get(gameKey);
    if (!existingGame || snapshot.cardCount >= existingGame.cardCount) {
      cardSnapshotsByGame.set(gameKey, snapshot);
    }
  }
}

function pruneCardSnapshots() {
  const now = Date.now();
  for (const [key, snapshot] of cardSnapshotsByTable.entries()) {
    if (now - Date.parse(snapshot.observedAt || 0) > 10 * 60 * 1000) cardSnapshotsByTable.delete(key);
  }
  for (const [key, snapshot] of cardSnapshotsByGame.entries()) {
    if (now - Date.parse(snapshot.observedAt || 0) > 10 * 60 * 1000) cardSnapshotsByGame.delete(key);
  }
}

function attachCards(round) {
  const tableId = round.providerTableId;
  if (!tableId) return round;
  const exact = cardSnapshotsByGame.get(`${tableId}|${round.gameRoundId || ""}`);
  const latest = cardSnapshotsByTable.get(String(tableId));
  const snapshot = exact || latest;
  if (!snapshot) return round;
  if (!exact && Date.now() - Date.parse(snapshot.observedAt || 0) > 2 * 60 * 1000) return round;
  return {
    ...round,
    bankerCards: snapshot.bankerCards,
    playerCards: snapshot.playerCards,
    bankerCardsRaw: snapshot.bankerCardsRaw,
    playerCardsRaw: snapshot.playerCardsRaw,
    bankerCardPoints: snapshot.bankerCardPoints,
    playerCardPoints: snapshot.playerCardPoints,
    bankerCardRanks: snapshot.bankerCardRanks,
    playerCardRanks: snapshot.playerCardRanks,
    cardObservedAt: snapshot.observedAt
  };
}

function attachShoe(round) {
  if (!round.providerTableId || round.sourceEvent === "getGameHall:snapshot") return round;
  const key = `${round.tableCode}:${round.providerTableId}`;
  const today = new Date().toISOString().slice(0, 10);
  const roundNo = Number(round.roundNo || 0) || 0;
  const state = shoeStateByTable.get(key) || { shoeNo: 1, lastRoundNo: 0 };
  if (isLikelyNewShoe(state.lastRoundNo, roundNo)) {
    state.shoeNo += 1;
  }
  if (roundNo > 0) state.lastRoundNo = roundNo;
  shoeStateByTable.set(key, state);
  return {
    ...round,
    shoeId: `live:${round.tableCode}:${today}:${state.shoeNo}`
  };
}

function shouldInsertRound(round) {
  return Boolean(round);
}

function updateStatus(patch) {
  Object.assign(scraperStatus, patch);
  setStatus("scraper", {
    urlConfigured: Boolean(TARGET_URL),
    running: true,
    insertedTotal,
    pid: process.pid,
    ...scraperStatus
  });
}

function safePayload(payload) {
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

function handlePayload(payload, source) {
  const text = safePayload(payload);
  const cardSnapshots = extractCardSnapshotsFromPayload(text);
  if (cardSnapshots.length) {
    for (const snapshot of cardSnapshots) storeCardSnapshot(snapshot);
    pruneCardSnapshots();
    updateStatus({
      cardSnapshotCount: cardSnapshotsByTable.size,
      lastCardSnapshotAt: new Date().toISOString()
    });
  }

  const refs = extractTableReferencesFromPayload(text);
  if (refs.length) {
    for (const ref of refs) tableRefs.set(ref.tableId, ref);
    updateStatus({
      tableRefCount: tableRefs.size,
      lastTableRefAt: new Date().toISOString()
    });
  }

  const live = extractLiveRoundsFromPayload(text, tableRefs, { source });
  let rounds = live.rounds;
  if (!rounds.length && live.unmatched.length) {
    pendingPayloads.push({ text, source, at: Date.now() });
    if (pendingPayloads.length > 50) pendingPayloads.shift();
    updateStatus({ unmatchedTableIds: live.unmatched.slice(0, 10) });
  }

  if (refs.length && pendingPayloads.length) {
    const retry = pendingPayloads.splice(0, pendingPayloads.length);
    for (const pending of retry) {
      const retried = extractLiveRoundsFromPayload(pending.text, tableRefs, { source: pending.source });
      rounds.push(...retried.rounds);
    }
  }

  if (text.includes('"getGameHall"')) {
    const snapshotRounds = extractRoundsFromPayload(text, {
      source,
      sourceEvent: "roadSnapshot",
      snapshotShoeId: `road:${new Date().toISOString().slice(0, 10)}`
    });
    for (const round of snapshotRounds) {
      rounds.push(round);
    }
    if (snapshotRounds.length) {
      updateStatus({
        lastRoadSnapshotAt: new Date().toISOString(),
        lastRoadSnapshotRounds: snapshotRounds.length
      });
    }
  }

  archivePayload(text, source, {
    liveRounds: rounds.filter((round) => round.sourceEvent !== "roadSnapshot").length,
    roadSnapshotRounds: rounds.filter((round) => round.sourceEvent === "roadSnapshot").length,
    cardSnapshots: cardSnapshots.length,
    tableRefs: refs.length
  });

  let inserted = 0;
  for (const rawRound of rounds) {
    const round = attachShoe(attachCards(rawRound));
    if (!shouldInsertRound(round)) continue;
    const hasCards = (round.bankerCardsRaw?.length || 0) + (round.playerCardsRaw?.length || 0) > 0;
    if (round.sourceEvent !== "getGameHall:snapshot" && seenRecently(round)) {
      if (hasCards) updateRoundCards(round);
      continue;
    }
    const result = insertRound(round);
    if (result.inserted) inserted += 1;
  }
  if (inserted > 0) {
    insertedTotal += inserted;
    logEvent("info", `scraper inserted ${inserted} rounds`, { source });
    updateStatus({ lastInsertAt: new Date().toISOString(), lastInserted: inserted });
  }
}

async function attachPage(page) {
  page.on("websocket", (ws) => {
    lastWebsocketAtMs = Date.now();
    logEvent("info", "websocket connected", ws.url());
    updateStatus({ lastWebsocketUrl: ws.url(), lastWebsocketAt: new Date().toISOString() });
    ws.on("framereceived", (frame) => handlePayload(frame.payload, "allbet-ws"));
    ws.on("close", () => {
      logEvent("warn", "websocket closed", ws.url());
      updateStatus({ lastWebsocketClosedAt: new Date().toISOString() });
    });
  });

  page.on("response", async (response) => {
    const headers = response.headers();
    const type = headers["content-type"] || "";
    const requestUrl = response.url();
    if (!/(json|text|javascript)/i.test(type)) return;
    if (!/(api-gw|game|road|hall|websocket|sfs)/i.test(requestUrl)) return;
    try {
      const text = await response.text();
      handlePayload(text, `http:${response.status()}`);
    } catch {
      // Some responses are streams or already consumed by the page.
    }
  });

  page.on("console", (msg) => {
    const type = msg.type();
    if (["error", "warning"].includes(type)) {
      logEvent(type === "error" ? "error" : "warn", `page console ${type}`, msg.text().slice(0, 500));
    }
  });
}

async function inspectPageHealth(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  if (/請求過於頻繁|\[5001\]/.test(bodyText)) {
    const now = Date.now();
    updateStatus({
      health: "RATE_LIMITED",
      healthDetail: "Allbet trial page returned request frequency limit [5001]. Waiting before recovery.",
      lastRateLimitAt: new Date().toISOString()
    });
    if (now - lastRecoveryAtMs > 5 * 60 * 1000) {
      lastRecoveryAtMs = now;
      await page.getByText("確定").click({ timeout: 2000 }).catch(() => {});
    }
    return "RATE_LIMITED";
  }

  const startedAtMs = Date.parse(scraperStatus.startedAt || "") || Date.now();
  const noWebsocketTooLong = !lastWebsocketAtMs && Date.now() - startedAtMs > 2 * 60 * 1000;
  if (noWebsocketTooLong) {
    updateStatus({
      health: "NO_WEBSOCKET",
      healthDetail: "Page loaded but no Allbet websocket has connected yet."
    });
    if (Date.now() - lastRecoveryAtMs > 10 * 60 * 1000) {
      lastRecoveryAtMs = Date.now();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch((error) => {
        logEvent("warn", "scraper websocket recovery reload failed", error.message);
      });
      updateStatus({ lastRecoveryReloadAt: new Date().toISOString() });
    }
    return "NO_WEBSOCKET";
  }

  if (lastWebsocketAtMs) {
    updateStatus({ health: "OK", healthDetail: "" });
  }
  return "OK";
}

async function run() {
  if (!TARGET_URL) {
    setStatus("scraper", { running: false, urlConfigured: false, error: "ALLBET_URL is not configured" });
    throw new Error("ALLBET_URL is not configured");
  }

  updateStatus({ startedAt: new Date().toISOString(), headless: ALLBET_HEADLESS });
  browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: ALLBET_HEADLESS,
    viewport: { width: 1365, height: 768 },
    locale: "zh-TW",
    timezoneId: "Asia/Shanghai"
  });

  const page = browserContext.pages()[0] || await browserContext.newPage();
  await attachPage(page);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  updateStatus({ pageLoadedAt: new Date().toISOString(), pageUrl: page.url() });

  setInterval(async () => {
    try {
      updateStatus({ heartbeatAt: new Date().toISOString(), pageUrl: page.url() });
      if (page.isClosed()) return;
      const title = await page.title().catch(() => "");
      if (title !== undefined) updateStatus({ title });
      await inspectPageHealth(page);
    } catch (error) {
      logEvent("warn", "scraper heartbeat failed", error.message);
    }
  }, 15000);

  setInterval(async () => {
    try {
      if (!page.isClosed()) await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      updateStatus({ lastReloadAt: new Date().toISOString() });
    } catch (error) {
      logEvent("warn", "scraper reload failed", error.message);
    }
  }, 45 * 60 * 1000);
}

async function shutdown() {
  updateStatus({ running: false, stoppedAt: new Date().toISOString() });
  if (browserContext) await browserContext.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run().catch((error) => {
  setStatus("scraper", { running: false, error: error.message, failedAt: new Date().toISOString() });
  logEvent("error", "scraper failed", error.stack || error.message);
  console.error(error);
  process.exit(1);
});
