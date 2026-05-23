const { chromium } = require("playwright");
const { ALLBET_URL, ALLBET_HEADLESS, ROOT } = require("./env");
const { insertRound, setStatus, logEvent } = require("./db");
const { extractRoundsFromPayload } = require("./extractor");

const urlArg = process.argv.find((arg) => arg.startsWith("http"));
const TARGET_URL = urlArg || ALLBET_URL;
const userDataDir = `${ROOT}/data/playwright-profile`;

let insertedTotal = 0;
let browserContext;

function updateStatus(patch) {
  setStatus("scraper", {
    urlConfigured: Boolean(TARGET_URL),
    running: true,
    insertedTotal,
    pid: process.pid,
    ...patch
  });
}

function safePayload(payload) {
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

function handlePayload(payload, source) {
  const text = safePayload(payload);
  const rounds = extractRoundsFromPayload(text, { source });
  let inserted = 0;
  for (const round of rounds) {
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
