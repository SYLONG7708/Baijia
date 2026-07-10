import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.BAIJIA_SMOKE_BASE_URL || `http://127.0.0.1:${PORT}`;
const OUT_DIR = join(process.cwd(), "output", "playwright");
const SEQUENCE = ["banker", "player", "banker", "banker", "player", "tie", "banker", "player"];
const CARD_INPUTS = [
  { banker: ["8", "8"], player: ["K", "5"] },
  { banker: ["4", "Q"], player: ["7", "2"] },
  { banker: ["3", "3"], player: ["10", "5"] },
  { banker: ["9", "1"], player: ["2", "6"] },
  { banker: ["5", "K"], player: ["6", "6"] },
  { banker: ["7", "2"], player: ["4", "5"] },
  { banker: ["1", "5"], player: ["2", "3"] },
  { banker: ["J", "4"], player: ["8", "1"] }
];
const SPECIAL_FLAGS = {
  0: ["bankerPair"],
  2: ["luckySix"],
  4: ["playerPair"],
  7: ["bankerPair", "luckySix"]
};

const errors = [];
const results = [];
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block"
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto(`${BASE_URL}/?compactUiSmoke=${Date.now()}`, { waitUntil: "networkidle" });
  for (const [index, result] of SEQUENCE.entries()) {
    await inputCards(page, CARD_INPUTS[index]);
    for (const flag of SPECIAL_FLAGS[index] || []) {
      await page.click(`.side-flag-btn[data-flag="${flag}"]`);
    }
    await page.click(`.pattern-result-btn[data-result="${result}"]`);
  }
  await page.waitForSelector(".road-breakdown-panel", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll(".compact-road-card").length === 5, null, { timeout: 30000 });

  const afterEight = await collectMetrics(page);
  assert(afterEight.analysisTableOptions >= 37, `analysis table options count is ${afterEight.analysisTableOptions}`);
  assert(afterEight.advancedGrid === 0, "advanced metric cards are visible");
  assert(afterEight.advancedTableRow === 0, "same/opposite detail rows are visible");
  assert(afterEight.roadRead === 0, "road detail paragraphs are visible");
  assert(afterEight.roadTrends === 0, "road trend detail rows are visible");
  assert(afterEight.askPanel === 0, "ask-road detail panel is visible");
  assert(afterEight.compactRoadCards === 5, `compact road cards count is ${afterEight.compactRoadCards}`);
  assert(afterEight.roadIcons >= 5, `road result icons count is ${afterEight.roadIcons}`);
  assert(afterEight.recordRows === 5, `analysis record row count is ${afterEight.recordRows}`);
  assert(afterEight.manualCycleCells === 5, `manual cycle cell count is ${afterEight.manualCycleCells}`);
  assert(afterEight.cardInputPanels === 1, `card input panel count is ${afterEight.cardInputPanels}`);
  assert(afterEight.cardRankButtons === 26, `card rank button count is ${afterEight.cardRankButtons}`);
  assert(afterEight.cardModelPanels === 1, `card model panel count is ${afterEight.cardModelPanels}`);
  assert(afterEight.cardModelChips === 6, `card model chip count is ${afterEight.cardModelChips}`);
  assert(afterEight.text.includes("輸入6欄"), "manual input cycle label is missing");
  assert(afterEight.text.includes("復盤"), "manual replay label is missing");
  assert(afterEight.text.includes("證據"), "evidence label is missing");
  assert(afterEight.patternText.includes("莊對"), "banker pair input is missing");
  assert(afterEight.patternText.includes("閒對"), "player pair input is missing");
  assert(afterEight.patternText.includes("幸運6"), "lucky six input is missing");
  assert(afterEight.probabilityChips === 6, `probability chip count is ${afterEight.probabilityChips}`);
  assert(afterEight.percentCount >= 8, `compact percentage count is ${afterEight.percentCount}`);
  assert(afterEight.text.includes("樣本外驗證"), "ensemble walk-forward validation is missing");
  assert(!/完全相同樣本|相近樣本|全庫樣本/.test(afterEight.text), "verbose sample detail is visible in compact analysis");
  assert(!afterEight.text.includes("同向桌"), "cross-table detail label is visible");
  assert(!afterEight.text.includes("反向桌"), "opposite-table detail label is visible");
  assertNoOverflow(afterEight, "desktop");

  await page.click('.pattern-result-btn[data-result="banker"]');
  await page.waitForSelector(".prediction-check-list", { timeout: 30000 });
  const afterNine = await collectMetrics(page);
  assert(afterNine.checkRows >= 1, "prediction check row is missing");
  assert(afterNine.checkIcons >= 2, `prediction check icons count is ${afterNine.checkIcons}`);
  assert(afterNine.recordRows === 5, `prediction analysis record row count is ${afterNine.recordRows}`);
  assert(afterNine.manualCycleCells === 5, `prediction manual cycle cell count is ${afterNine.manualCycleCells}`);
  assert(/\b(?:OK|XX)\b/.test(afterNine.checkText), "prediction check OK/XX marker is missing");
  assertNoOverflow(afterNine, "desktop-after-check");
  await page.screenshot({ path: join(OUT_DIR, "dashboard-compact-ui-health.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobile = await collectMetrics(page);
  assert(mobile.compactRoadCards === 5, `mobile compact road cards count is ${mobile.compactRoadCards}`);
  assert(mobile.checkIcons >= 2, `mobile prediction check icons count is ${mobile.checkIcons}`);
  assert(mobile.recordRows === 5, `mobile analysis record row count is ${mobile.recordRows}`);
  assert(mobile.manualCycleCells === 5, `mobile manual cycle cell count is ${mobile.manualCycleCells}`);
  assertNoOverflow(mobile, "mobile");
  await page.screenshot({ path: join(OUT_DIR, "dashboard-compact-ui-health-mobile.png"), fullPage: true });

  const liveRequests = [];
  const live = await context.newPage();
  live.on("request", (request) => {
    if (request.url().includes("/api/status")) liveRequests.push(request.url());
  });
  await live.setViewportSize({ width: 390, height: 844 });
  await live.goto(`${BASE_URL}/live.html?compactUiSmoke=${Date.now()}`, { waitUntil: "networkidle" });
  for (const [index, result] of SEQUENCE.entries()) {
    await inputCards(live, CARD_INPUTS[index]);
    for (const flag of SPECIAL_FLAGS[index] || []) {
      await live.click(`.side-flag-btn[data-flag="${flag}"]`);
    }
    await live.click(`.pattern-result-btn[data-result="${result}"]`);
  }
  await live.waitForSelector(".road-breakdown-panel", { timeout: 30000 });
  const liveMetrics = await collectMetrics(live);
  assert(liveMetrics.isLiveMode === true, "live page is not in live mode");
  assert(liveMetrics.summaryCards === 0, "live page shows monitor summary cards");
  assert(liveRequests.length === 0, "live page requested monitor status API");
  assert(!liveMetrics.text.includes("資料庫6欄"), "live page shows database cycle text");
  assert(liveMetrics.compactRoadCards === 5, `live compact road cards count is ${liveMetrics.compactRoadCards}`);
  assert(liveMetrics.manualCycleCells === 5, `live manual cycle cell count is ${liveMetrics.manualCycleCells}`);
  assert(liveMetrics.cardInputPanels === 1, `live card input panel count is ${liveMetrics.cardInputPanels}`);
  assert(liveMetrics.cardRankButtons === 26, `live card rank button count is ${liveMetrics.cardRankButtons}`);
  assert(liveMetrics.cardModelPanels === 1, `live card model panel count is ${liveMetrics.cardModelPanels}`);
  assert(liveMetrics.cardModelChips === 6, `live card model chip count is ${liveMetrics.cardModelChips}`);
  assert(liveMetrics.text.includes("復盤"), "live manual replay label is missing");
  assert(liveMetrics.text.includes("證據"), "live evidence label is missing");
  assert(liveMetrics.patternText.includes("莊對"), "live banker pair input is missing");
  assert(liveMetrics.patternText.includes("閒對"), "live player pair input is missing");
  assert(liveMetrics.patternText.includes("幸運6"), "live lucky six input is missing");
  assertNoOverflow(liveMetrics, "live-mobile");
  await live.screenshot({ path: join(OUT_DIR, "dashboard-live-iphone-health.png"), fullPage: true });

  const logic = await context.newPage();
  await logic.setViewportSize({ width: 390, height: 844 });
  await logic.goto(`${BASE_URL}/logic.html?logicSmoke=${Date.now()}`, { waitUntil: "networkidle" });
  const logicMetrics = await collectLogicMetrics(logic);
  assert(logicMetrics.hasTitle, "logic page title is missing");
  assert(logicMetrics.roadCards === 5, `logic road card count is ${logicMetrics.roadCards}`);
  assert(logicMetrics.sections >= 7, `logic section count is ${logicMetrics.sections}`);
  assert(logicMetrics.hasCycle, "logic page six-column section is missing");
  assert(logicMetrics.hasReplay, "logic page replay section is missing");
  assertNoOverflow(logicMetrics, "logic-mobile");
  await logic.screenshot({ path: join(OUT_DIR, "dashboard-logic-guide-mobile.png"), fullPage: true });

  results.push({ name: "compact-ui", ok: true, afterEight, afterNine, mobile, live: liveMetrics, logic: logicMetrics });
  await context.close();
} catch (error) {
  errors.push(error.message || String(error));
} finally {
  await browser.close().catch(() => {});
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  ok: errors.length === 0,
  errors,
  results,
  screenshots: [
    "output/playwright/dashboard-compact-ui-health.png",
    "output/playwright/dashboard-compact-ui-health-mobile.png",
    "output/playwright/dashboard-live-iphone-health.png",
    "output/playwright/dashboard-logic-guide-mobile.png"
  ]
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 2;

async function inputCards(page, cards = {}) {
  for (const side of ["banker", "player"]) {
    for (const rank of cards[side] || []) {
      await page.click(`[data-card-side="${side}"][data-card-rank="${rank}"]`);
    }
  }
}

async function collectMetrics(page) {
  return page.evaluate(() => {
    const advancedText = document.querySelector("#advancedAnalysis")?.innerText || "";
    const checkText = document.querySelector(".prediction-check-panel")?.innerText || "";
    return {
      advancedGrid: document.querySelectorAll(".advanced-grid").length,
      advancedTableRow: document.querySelectorAll(".advanced-table-row").length,
      roadRead: document.querySelectorAll(".road-read").length,
      roadTrends: document.querySelectorAll(".road-trends").length,
      askPanel: document.querySelectorAll(".ask-road-panel").length,
      compactRoadCards: document.querySelectorAll(".compact-road-card").length,
      roadIcons: document.querySelectorAll(".compact-road-card .result-icon").length,
      probabilityChips: document.querySelectorAll(".probability-chip").length,
      analysisTableOptions: document.querySelectorAll("#analysisTableSelect option").length,
      checkRows: document.querySelectorAll(".prediction-check-list > div").length,
      checkIcons: document.querySelectorAll(".prediction-check-list .result-icon").length,
      recordRows: document.querySelectorAll(".analysis-record-row").length,
      manualCycleCells: document.querySelectorAll(".analysis-record-row .manual-cycle-cell").length,
      cardInputPanels: document.querySelectorAll(".card-input-panel").length,
      cardRankButtons: document.querySelectorAll("[data-card-rank]").length,
      cardModelPanels: document.querySelectorAll(".card-model-panel").length,
      cardModelChips: document.querySelectorAll(".card-model-grid div").length,
      percentCount: (advancedText.match(/\d+(?:\.\d+)?%/g) || []).length,
      summaryCards: document.querySelectorAll(".summary-card").length,
      isLiveMode: document.body.dataset.mode === "live",
      patternText: document.querySelector("#patternInput")?.value || "",
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      text: advancedText,
      checkText
    };
  });
}

async function collectLogicMetrics(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || "";
    return {
      hasTitle: text.includes("珠盤路 / 大路 / 大眼仔 / 小路 / 蟑螂路分析邏輯"),
      hasCycle: text.includes("6 欄循環"),
      hasReplay: text.includes("時時刻刻復盤"),
      roadCards: document.querySelectorAll(".logic-road-grid article").length,
      sections: document.querySelectorAll(".logic-section").length,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    };
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoOverflow(metrics, label) {
  assert(metrics.scrollWidth <= metrics.clientWidth + 2, `${label} horizontal overflow ${metrics.scrollWidth} > ${metrics.clientWidth}`);
}
