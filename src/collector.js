"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { loadLocalEnv } = require("./env");
const store = require("./store");

loadLocalEnv();

const ROOT = path.resolve(__dirname, "..");
const STORAGE_DIR = path.join(ROOT, "storage");
const STORAGE_STATE = path.join(STORAGE_DIR, "goodwin-session.json");
const OUTPUT_DIR = path.join(ROOT, "output", "playwright");

const DEFAULT_EXPECTED_TABLES = 36;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CAPTURE_MS = 45_000;
const DEFAULT_TARGET_TABLE_CODES = [
  "B201", "B202", "B203", "B219", "B220",
  "B501", "B502", "B503", "B504", "B505", "B506", "B507",
  "B601", "B602", "B603", "B604", "B605", "B618",
  "C201", "C202", "C501", "C701",
  "IB201", "IB202",
  "Q201", "Q202", "Q204", "Q501", "Q502", "Q601", "Q701", "Q702",
  "V911", "V912", "V971", "V972"
];
const TARGET_TABLE_CODE_PATTERN = /\b(?:IB\d{3}|[BQCV]\d{3})\b/i;
const UNAVAILABLE_TABLE_TEXT_PATTERN = /shuffle|shuffling|washing|stopped|settling|\u6d17\u724c|\u505c\u6b62\u4e0b\u6ce8|\u7d50\u7b97|\u5df2\u5305\u684c/i;

function readConfig(overrides = {}) {
  const targetTableCodes = readTargetTableCodes(overrides.targetTableCodes || process.env.GOODWIN_TARGET_TABLE_CODES);
  return {
    url: overrides.url || process.env.GOODWIN_URL || "https://www.goodwin77.com/",
    username: overrides.username || process.env.GOODWIN_USERNAME || "",
    password: overrides.password || process.env.GOODWIN_PASSWORD || "",
    headless: parseBool(overrides.headless ?? process.env.GOODWIN_HEADLESS, true),
    intervalMs: Number(overrides.intervalMs || process.env.COLLECT_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    captureMs: Number(overrides.captureMs || process.env.GOODWIN_CAPTURE_MS || DEFAULT_CAPTURE_MS),
    expectedTables: Number(overrides.expectedTables || process.env.GOODWIN_EXPECTED_TABLES || targetTableCodes.length || DEFAULT_EXPECTED_TABLES),
    targetTableCodes,
    runTimeoutMs: Number(overrides.runTimeoutMs || process.env.COLLECT_RUN_TIMEOUT_MS || 360_000),
    maxRetries: Number(overrides.maxRetries || process.env.COLLECT_MAX_RETRIES || 4),
    retryBaseMs: Number(overrides.retryBaseMs || process.env.COLLECT_RETRY_BASE_MS || 30_000),
    retryMaxMs: Number(overrides.retryMaxMs || process.env.COLLECT_RETRY_MAX_MS || 240_000),
    allbetReadyTimeoutMs: Number(overrides.allbetReadyTimeoutMs || process.env.GOODWIN_ALLBET_READY_TIMEOUT_MS || 90_000),
    allbetReadyRetries: Number(overrides.allbetReadyRetries || process.env.GOODWIN_ALLBET_READY_RETRIES || 2),
    tableSwitchMs: Number(overrides.tableSwitchMs || process.env.GOODWIN_TABLE_SWITCH_MS || 700),
    tableWaitMs: Number(overrides.tableWaitMs || process.env.GOODWIN_TABLE_WAIT_MS || 2000),
    debug: parseBool(overrides.debug ?? process.env.GOODWIN_DEBUG, false),
    viewport: {
      width: Number(process.env.GOODWIN_VIEWPORT_WIDTH || 1680),
      height: Number(process.env.GOODWIN_VIEWPORT_HEIGHT || 950)
    }
  };
}

async function runCollectorLoop(overrides = {}) {
  const config = readConfig(overrides);
  store.ensureStore();
  store.updateCollectorStatus({
    enabled: true,
    runIntervalMs: config.intervalMs,
    expectedBaccaratTables: config.expectedTables,
    lastMessage: "Collector loop started."
  });

  let failureStreak = 0;
  while (true) {
    const startedAt = Date.now();
    try {
      const summary = await withTimeout(collectOnce(config), config.runTimeoutMs, "Collector run timeout");
      failureStreak = 0;
      const elapsedMs = Date.now() - startedAt;
      const nextRunAt = new Date(Date.now() + config.intervalMs).toISOString();
      store.updateCollectorStatus({
        enabled: true,
        lastRunAt: new Date(startedAt).toISOString(),
        lastOkAt: new Date().toISOString(),
        lastError: "",
        lastFailureReason: "",
        lastMessage: summary.message,
        streakFailures: 0,
        runLatencyMs: elapsedMs,
        runIntervalMs: config.intervalMs,
        nextRunAt,
        lastRunScanned: summary.scanned,
        lastRunAdded: summary.added,
        expectedBaccaratTables: config.expectedTables,
        detectedBaccaratTables: summary.detectedTables,
        detailCapturedTables: summary.detailCaptured,
        missingBaccaratTables: summary.missingTables,
        lastRunTableIds: summary.tableIds,
        lastRunMissingTableIds: summary.missingTableIds
      });
      store.appendCollectorRunHistory({
        at: new Date().toISOString(),
        elapsedMs,
        ok: true,
        scanned: summary.scanned,
        added: summary.added,
        expectedTables: config.expectedTables,
        detectedTables: summary.detectedTables,
        detailCaptured: summary.detailCaptured,
        missingTables: summary.missingTables,
        skippedUnavailableTables: Number(summary.skippedUnavailableTableIds?.length || 0),
        sourceView: summary.sourceView,
        message: summary.message
      });
      await sleep(config.intervalMs);
    } catch (error) {
      failureStreak += 1;
      const elapsedMs = Date.now() - startedAt;
      const delay = Math.min(config.retryMaxMs, config.retryBaseMs * Math.max(1, failureStreak));
      store.updateCollectorStatus({
        enabled: true,
        lastRunAt: new Date(startedAt).toISOString(),
        lastError: error.message || String(error),
        lastFailureReason: error.code || "collector-error",
        lastMessage: `Collector failed, retrying in ${Math.round(delay / 1000)}s.`,
        streakFailures: failureStreak,
        runLatencyMs: elapsedMs,
        runIntervalMs: config.intervalMs,
        nextRunAt: new Date(Date.now() + delay).toISOString()
      });
      store.appendCollectorRunHistory({
        at: new Date().toISOString(),
        elapsedMs,
        ok: false,
        expectedTables: config.expectedTables,
        message: error.message || String(error)
      });
      await sleep(delay);
    }
  }
}

async function collectOnce(overrides = {}) {
  const config = readConfig(overrides);
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  store.ensureStore();

  const state = new CaptureState(config);
  const browser = await chromium.launch({
    headless: config.headless,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  try {
    const contextOptions = {
      viewport: config.viewport,
      ignoreHTTPSErrors: true,
      locale: "zh-TW",
      timezoneId: "Asia/Taipei"
    };
    if (fs.existsSync(STORAGE_STATE)) {
      contextOptions.storageState = STORAGE_STATE;
    }

    const context = await browser.newContext(contextOptions);
    context.on("page", (page) => {
      attachCapture(page, state);
    });

    const page = await context.newPage();
    attachCapture(page, state);
    debugLog(config, "opening-goodwin");
    const target = await openGoodwinAllbet(page, context, config);
    debugLog(config, "opened-allbet", sanitizeUrl(target.url()));
    attachCapture(target, state);
    await selectAllBaccarat(target);
    debugLog(config, "selected-baccarat");
    await waitForAllbetReadyWithRecovery(target, config);
    debugLog(config, "allbet-ready");
    await target.waitForTimeout(config.captureMs);
    debugLog(config, "capture-wait-complete");
    await captureAllbetTableRoadmaps(target, state, config);
    debugLog(config, "roadmap-capture-complete");

    const domTables = await collectDomTables(target);
    state.ingestDomTables(domTables, target.url());
    const summary = state.flush();
    store.cleanupAllbetTablePollution();
    debugLog(config, "flush-complete", summary);
    await context.storageState({ path: STORAGE_STATE }).catch(() => {});
    await target.screenshot({ path: path.join(OUTPUT_DIR, "collector-latest.png"), fullPage: true }).catch(() => {});

    store.addSnapshot({
      source: "goodwin-allbet-collector",
      url: sanitizeUrl(target.url()),
      tableCandidates: domTables.length,
      sample: domTables.slice(0, 60).map((table) => ({
        name: table.name,
        roomId: table.roomId,
        text: table.text.slice(0, 180)
      })),
      coverage: {
        expectedTables: config.expectedTables,
        detectedTables: summary.detectedTables,
        detailCaptured: summary.detailCaptured,
        missingTables: summary.missingTables,
        missingTableIds: summary.missingTableIds,
        skippedUnavailableTableIds: summary.skippedUnavailableTableIds || []
      }
    });

    return {
      ...summary,
      sourceView: sanitizeUrl(target.url()),
      message: `Collected ${summary.added} new rounds from ${summary.detailCaptured}/${summary.detectedTables} baccarat tables.`
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function openGoodwinAllbet(page, context, config) {
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1800);
  await dismissGoodwinPopup(page);
  await loginIfNeeded(page, config);
  await page.waitForTimeout(1200);
  await dismissGoodwinPopup(page);

  await clickByText(page, [/真人/u, /Live/i], { timeout: 5000 }).catch(() => false);
  await page.waitForTimeout(1000);

  const clickedAllbet = await clickByText(page, [/歐博/u, /欧博/u, /ALLBET/i, /\bAB\b/i], { timeout: 8000 }).catch(() => false);
  if (!clickedAllbet) {
    await clickLikelyAllbetCard(page).catch(() => false);
  }
  await page.waitForTimeout(1200);

  const popupPromise = context.waitForEvent("page", { timeout: 20_000 }).catch(() => null);
  const clickedEntry = await clickAllbetVisualEntry(page).catch(() => false);
  if (!clickedEntry) {
    const clickedDomEntry = await clickLikelyAllbetCard(page).catch(() => false);
    if (!clickedDomEntry) {
      await clickByText(page, [/PLAY NOW/i, /進入/u, /进入/u, /ALLBET/i], { timeout: 5000 }).catch(() => false);
    }
  }

  const popup = await popupPromise;
  const pages = context.pages();
  const target = [popup, ...pages.reverse()].filter(Boolean).find((item) => /ab8888|luckycat|allbet/i.test(item.url())) || popup || page;
  await target.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
  if (!/ab8888|luckycat|allbet/i.test(target.url())) {
    await target.waitForURL(/ab8888|luckycat|allbet/i, { timeout: 20_000 }).catch(() => {});
  }
  await target.waitForTimeout(3000);
  if (!/ab8888|luckycat|allbet/i.test(target.url())) {
    const error = new Error("Allbet entry did not open after clicking Goodwin card.");
    error.code = "allbet-entry-not-open";
    throw error;
  }
  return target;
}

async function dismissGoodwinPopup(page) {
  await clickByText(page, [/今日不再顯示/u, /今日不再显示/u], { timeout: 1500 }).catch(() => false);
  const selectors = [
    ".box_bg.pop_home .box_close",
    ".box_bg.pop_home .btn_close",
    ".box_bg.pop_home [class*='close']",
    ".pop_home .box_close",
    ".pop_home .btn_close",
    ".pop_home [class*='close']",
    ".box_close",
    ".btn_close",
    ".close",
    "[class*='close']",
    "button[aria-label*='close' i]",
    "button[title*='close' i]"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await visibleCount(locator)) {
      await locator.click({ timeout: 1500, force: true }).catch(() => {});
      await page.waitForTimeout(300);
      const stillBlocked = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".box_bg.pop_home,.pop_home")).some((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 80 && rect.height > 80 && style.display !== "none" && style.visibility !== "hidden";
        });
      }).catch(() => false);
      if (!stillBlocked) return;
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      ".box_bg.pop_home .box_close,.box_bg.pop_home .btn_close,.box_bg.pop_home [class*='close'],.pop_home .box_close,.pop_home .btn_close,.pop_home [class*='close']"
    ));
    for (const node of candidates) {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") {
        node.click();
        return;
      }
    }
    for (const blocker of document.querySelectorAll(".box_bg.pop_home,.pop_home")) {
      blocker.remove();
    }
  }).catch(() => {});
}

async function clickAllbetVisualEntry(page) {
  const abImage = page.locator("img[src*='icon_01_ab']").first();
  if (await visibleCount(abImage)) {
    const abCard = abImage.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' are_gamelist ')][1]");
    const target = await visibleCount(abCard) ? abCard : abImage;
    await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);
    const box = await target.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.waitForTimeout(250);
      await page.mouse.click(x, y);
      await page.waitForTimeout(800);
      return true;
    }
    await target.click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  const point = await page.evaluate(() => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1365;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const candidates = Array.from(document.querySelectorAll("a,button,div,li,img,section,article"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const text = [
          node.textContent || "",
          node.getAttribute("alt") || "",
          node.getAttribute("title") || "",
          node.getAttribute("src") || "",
          node.getAttribute("href") || "",
          style.backgroundImage || "",
          node.className || "",
          node.id || ""
        ].join(" ");
        return { node, rect, style, text };
      })
      .filter(({ rect, style }) => {
        if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
        if (rect.width < 250 || rect.height < 120) return false;
        if (rect.right < viewportWidth * 0.2 || rect.bottom < viewportHeight * 0.32) return false;
        if (rect.left > viewportWidth * 0.98 || rect.top > viewportHeight * 0.85) return false;
        return true;
      })
      .sort((left, right) => {
        const score = (item) => {
          const hasAllbet = /allbet|歐博|欧博|ab8888/i.test(item.text) ? 100000000 : 0;
          const area = item.rect.width * item.rect.height;
          const cardBand = item.rect.left > viewportWidth * 0.2 && item.rect.top > viewportHeight * 0.28 ? 1000000 : 0;
          const notWholePage = area < viewportWidth * viewportHeight * 0.75 ? 500000 : 0;
          return hasAllbet + cardBand + notWholePage + area;
        };
        return score(right) - score(left);
      });
    const target = candidates[0];
    if (target) {
      target.node.scrollIntoView({ block: "center", inline: "center" });
      const rect = target.node.getBoundingClientRect();
      return {
        x: Math.max(20, Math.min(viewportWidth - 20, rect.left + rect.width / 2)),
        y: Math.max(20, Math.min(viewportHeight - 20, rect.top + rect.height / 2))
      };
    }
    return null;
  });
  if (point) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(250);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(800);
    return true;
  }
  await page.evaluate(() => window.scrollTo(0, Math.min(460, Math.max(0, document.body.scrollHeight - window.innerHeight)))).catch(() => {});
  await page.waitForTimeout(250);
  const size = page.viewportSize() || { width: 1365, height: 768 };
  await page.mouse.move(size.width * 0.58, size.height * 0.58);
  await page.waitForTimeout(250);
  await page.mouse.click(size.width * 0.58, size.height * 0.58);
  await page.waitForTimeout(800);
  return true;
}

async function loginIfNeeded(page, config) {
  if (!config.username || !config.password) return false;
  const password = page.locator("input[type='password']").first();
  if (!(await visibleCount(password))) return false;

  const inputs = page.locator("input");
  const count = await inputs.count().catch(() => 0);
  let userInput = null;
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const type = String(await input.getAttribute("type").catch(() => "") || "").toLowerCase();
    if (type === "password" || type === "hidden" || !(await input.isVisible().catch(() => false))) continue;
    userInput = input;
    break;
  }
  if (!userInput) return false;

  await userInput.fill(config.username, { timeout: 5000 });
  await password.fill(config.password, { timeout: 5000 });
  const clicked = await clickByText(page, [/登入/u, /登錄/u, /登录/u, /Login/i], { timeout: 3000 }).catch(() => false);
  if (!clicked) await password.press("Enter").catch(() => {});
  await page.waitForTimeout(3500);
  await dismissGoodwinPopup(page);
  return true;
}

async function clickLikelyAllbetCard(page) {
  return page.evaluate(() => {
    const terms = [/歐博/u, /欧博/u, /ALLBET/i, /\bAB\b/i];
    const nodes = [...document.querySelectorAll("a,button,div,li,section")];
    const candidates = nodes.map((node) => {
      const text = (node.innerText || node.textContent || "").trim();
      const cls = node.className ? String(node.className) : "";
      const rect = node.getBoundingClientRect();
      const matched = terms.some((term) => term.test(text) || term.test(cls));
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      return { node, matched, area, rect };
    }).filter((item) => item.matched && item.area > 20_000 && item.rect.width > 180 && item.rect.height > 70);
    candidates.sort((a, b) => b.area - a.area);
    const target = candidates[0]?.node;
    if (!target) return false;
    target.click();
    return true;
  });
}

async function selectAllBaccarat(page) {
  const selectors = [
    "[class*='classicBacc']",
    "[class*='baccarat']",
    "[class*='Bacc']",
    "[class*='sideBar']"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await visibleCount(locator)) {
      await locator.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(1200);
      break;
    }
  }
  await clickByText(page, [/所有百家樂/u, /所有百家乐/u, /百家樂/u, /百家乐/u, /Baccarat/i], { timeout: 3000 }).catch(() => false);
}

async function captureAllbetTableRoadmaps(page, state, config) {
  await ensureBaccaratTablePage(page);
  debugLog(config, "entered-table-page", sanitizeUrl(page.url()));
  const sideTables = await collectSideHallTables(page);
  debugLog(config, "sidehall-tables", { count: sideTables.length });
  state.ingestDomTables(sideTables, page.url());
  const currentAtStart = await collectCurrentAllbetRoadmap(page, null).catch(() => null);
  const currentAtStartCode = normalizeTableCode(currentAtStart?.table?.tableCode || currentAtStart?.table?.deskNo || currentAtStart?.table?.name);
  if (currentAtStartCode && isTargetTableCode(currentAtStartCode, config)) {
    state.ingestDomTables([currentAtStart.table], page.url());
    if (currentAtStart.unavailable) state.markUnavailableTable(currentAtStartCode);
  }
  const imageRoadmaps = await collectSideHallImageRoadmaps(page, config);
  const pageUnavailableCodes = await collectUnavailableTargetCodesFromPage(page, config).catch(() => []);
  for (const code of pageUnavailableCodes) {
    state.markUnavailableTable(code);
  }

  const targetSideTables = sideTables
    .filter((table) => isTargetTableCode(table.deskNo || table.name, config));
  for (const table of targetSideTables) {
    if (isUnavailableTableText(`${table.name || ""} ${table.text || ""}`)) {
      state.markUnavailableTable(table.deskNo || table.name);
    }
  }
  const targets = targetSideTables
    .filter((table) => !isUnavailableTableText(`${table.name || ""} ${table.text || ""}`))
    .sort((left, right) => tableCapturePriority(left) - tableCapturePriority(right))
    .slice(0, Math.max(1, config.targetTableCodes.length || config.expectedTables || 36));

  if (!targets.length) {
    const current = currentAtStart || await collectCurrentAllbetRoadmap(page, null);
    const currentCode = normalizeTableCode(current.table.tableCode || current.table.deskNo || current.table.name);
    if (currentCode && !current.unavailable && current.entries.length) {
      state.addResultEntries(current.table, current.entries, page.url());
    }
    return;
  }

  const captured = new Set();
  const skipped = [];
  for (const table of targets) {
    const targetCode = normalizeTableCode(table.deskNo || table.name);
    if (isUnavailableTableText(`${table.name || ""} ${table.text || ""}`)) {
      skipped.push(targetCode || table.name);
      state.markUnavailableTable(targetCode || table.name);
      continue;
    }
    const opened = await openSideHallTable(page, table, config);
    if (!opened) {
      debugLog(config, "roadmap-table-open-failed", table.deskNo || table.name);
      continue;
    }
    const current = await collectCurrentAllbetRoadmap(page, table);
    const currentCode = normalizeTableCode(current.table.tableCode || current.table.deskNo || current.table.name);
    debugLog(config, "roadmap-table", { target: targetCode || table.name, current: currentCode || current.table.name, entries: current.entries.length });
    if (!currentCode || (targetCode && currentCode !== targetCode)) continue;
    if (current.unavailable) {
      skipped.push(targetCode || currentCode);
      state.markUnavailableTable(targetCode || currentCode);
      continue;
    }
    if (!current.entries.length) continue;
    const captureKey = currentCode || current.table.deskNo || current.table.name;
    if (captured.has(captureKey)) continue;
    captured.add(captureKey);
    state.addResultEntries(current.table, current.entries, page.url());
  }

  let imageCaptured = 0;
  for (const roadmap of imageRoadmaps) {
    const code = normalizeTableCode(roadmap.table?.tableCode || roadmap.table?.deskNo || roadmap.table?.name);
    if (!code || captured.has(code) || !isTargetTableCode(code, config)) continue;
    if (roadmap.unavailable || isUnavailableTableText(`${roadmap.table?.name || ""} ${roadmap.table?.text || ""}`)) {
      state.markUnavailableTable(code);
      continue;
    }
    if (!roadmap.entries.length) continue;
    state.addResultEntries(roadmap.table, roadmap.entries, page.url());
    captured.add(code);
    imageCaptured += 1;
  }
  debugLog(config, "sidehall-image-roadmaps", { tables: imageRoadmaps.length, captured: imageCaptured, skipped });
}

function tableCapturePriority(table) {
  const text = `${table?.name || ""} ${table?.text || ""}`;
  let score = 0;
  if (isUnavailableTableText(text)) score += 1000;
  if (/博丁|龍虎|龙虎|賭場大戰|赌场大战|牛牛|骰|輪盤|轮盘|魚蝦蟹|鱼虾蟹|色碟|blackjack|sicbo|roulette|dragon|tiger/i.test(text)) score += 5000;
  if (/快速|經典|经典|VIP|咪牌|性感|保險|保险|百家/i.test(text)) score -= 100;
  return score;
}

function isUnavailableTableText(value) {
  return UNAVAILABLE_TABLE_TEXT_PATTERN.test(String(value || ""));
}

async function collectUnavailableTargetCodesFromPage(page, config) {
  const text = await page.evaluate(() => document.body?.innerText || "");
  if (!text) return [];
  const found = [];
  for (const code of config.targetTableCodes || DEFAULT_TARGET_TABLE_CODES) {
    if (hasUnavailableStatusNearCode(text, code)) {
      found.push(code);
    }
  }
  return found;
}

function hasUnavailableStatusNearCode(text, code) {
  const upper = text.toUpperCase();
  const target = String(code).toUpperCase();
  let index = upper.indexOf(target);
  while (index >= 0) {
    const after = text.slice(index, Math.min(text.length, index + 160));
    const rest = after.slice(target.length);
    const nextCodeMatch = rest.match(TARGET_TABLE_CODE_PATTERN);
    const segment = nextCodeMatch?.index >= 0 ? after.slice(0, target.length + nextCodeMatch.index) : after;
    if (isUnavailableTableText(segment)) return true;
    index = upper.indexOf(target, index + target.length);
  }
  return false;
}

async function ensureBaccaratTablePage(page) {
  if (/#\/baccaratTable/i.test(page.url())) return true;
  const clicked = await clickByText(page, [/快速百家樂/u, /快速百家乐/u, /經典百家樂/u, /经典百家乐/u, /VIP百家樂/u, /VIP百家乐/u, /咪牌百家樂/u, /咪牌百家乐/u, /百家樂/u, /百家乐/u, /Baccarat/i], { timeout: 8000 }).catch(() => false);
  if (!clicked) return false;
  await page.waitForURL(/#\/baccaratTable/i, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return /#\/baccaratTable/i.test(page.url());
}

async function collectSideHallTables(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const codePattern = /\b(?:IB\d{3}|[BQCV]\d{3})\b/i;
    const unavailablePattern = /shuffle|shuffling|washing|stopped|settling|\u6d17\u724c|\u505c\u6b62\u4e0b\u6ce8|\u7d50\u7b97|\u5df2\u5305\u684c/i;
    const parseTable = (node) => {
      const text = clean(node.innerText || node.textContent || "");
      const id = node.id || "";
      const desk = text.match(codePattern)?.[0] || "";
      const nameMatch = text.match(/((?:快速|經典|经典|VIP|咪牌|性感|保險|保险)?百家[樂乐]\s+(?:IB\d{3}|[BQCV]\d{3}))/i);
      const name = nameMatch ? nameMatch[1] : text.replace(/\s+(洗牌中|停止下注|結算中|已包桌|\d+)$/g, "");
      return {
        id,
        elementId: id,
        serverId: id.replace(/^table(?:Container)?_/, "").replace(/__.*/, ""),
        deskNo: desk,
        name,
        text,
        unavailable: unavailablePattern.test(text),
        source: "goodwin-allbet-sidehall"
      };
    };
    const nodes = Array.from(document.querySelectorAll("[id^='tableContainer_'],[id^='table_'].sideHallTable"));
    const seen = new Set();
    const tables = [];
    for (const node of nodes) {
      const item = parseTable(node);
      const key = item.deskNo || item.serverId || item.text;
      if (!item.text || !item.deskNo || seen.has(key)) continue;
      seen.add(key);
      tables.push(item);
    }
    return tables;
  });
}

async function collectSideHallImageRoadmaps(page, config = {}) {
  const maxTables = Math.max(1, config.expectedTables || 36);
  const targetTableCodes = config.targetTableCodes || DEFAULT_TARGET_TABLE_CODES;
  return page.evaluate(async ({ maxTables, targetTableCodes }) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const codePattern = /\b(?:IB\d{3}|[BQCV]\d{3})\b/i;
    const unavailablePattern = /shuffle|shuffling|washing|stopped|settling|\u6d17\u724c|\u505c\u6b62\u4e0b\u6ce8|\u7d50\u7b97|\u5df2\u5305\u684c/i;
    const targetCodes = new Set(targetTableCodes);
    const tableCode = (value) => String(value || "").toUpperCase().match(codePattern)?.[0] || "";
    const isBaccarat = (value) => {
      const text = String(value || "");
      if (!targetCodes.has(tableCode(text))) return false;
      if (!/百家|百家乐|baccarat/i.test(text)) return false;
      if (/博丁|龍虎|龙虎|賭場大戰|赌场大战|牛牛|骰|輪盤|轮盘|魚蝦蟹|鱼虾蟹|色碟|blackjack|sicbo|roulette|dragon|tiger/i.test(text)) return false;
      return true;
    };
    const priority = (item) => {
      let score = 0;
      if (unavailablePattern.test(item.text)) score += 1000;
      if (/快速|經典|经典|VIP|咪牌|性感|保險|保险|百家/i.test(item.text)) score -= 100;
      return score;
    };
    const extractDataUrl = (value) => {
      const match = String(value || "").match(/url\(["']?(data:image\/png;base64,[^)"']+)/i);
      return match ? match[1] : "";
    };
    const loadImage = (src) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    });
    const decodeRoadImage = async (src) => {
      const image = await loadImage(src);
      if (!image) return [];
      const width = image.naturalWidth || image.width || 240;
      const height = image.naturalHeight || image.height || 72;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return [];
      context.drawImage(image, 0, 0, width, height);
      const imageData = context.getImageData(0, 0, width, height).data;
      const cell = 12;
      const columns = Math.floor(width / cell);
      const rows = Math.floor(height / cell);
      const entries = [];
      for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          let red = 0;
          let blue = 0;
          let green = 0;
          for (let y = row * cell + 2; y < Math.min(height, row * cell + cell - 2); y += 1) {
            for (let x = column * cell + 2; x < Math.min(width, column * cell + cell - 2); x += 1) {
              const offset = (y * width + x) * 4;
              const r = imageData[offset];
              const g = imageData[offset + 1];
              const b = imageData[offset + 2];
              const a = imageData[offset + 3];
              if (a < 80) continue;
              if (r > 170 && g < 130 && b < 130) red += 1;
              else if (b > 150 && r < 140 && g < 180) blue += 1;
              else if (g > 135 && r < 150 && b < 150) green += 1;
            }
          }
          const strongest = Math.max(red, blue, green);
          if (strongest < 4) continue;
          if (red >= blue && red >= green) entries.push({ result: "banker", bankerPair: null, playerPair: null, luckySix: false });
          else if (blue >= red && blue >= green) entries.push({ result: "player", bankerPair: null, playerPair: null, luckySix: false });
          else entries.push({ result: "tie", bankerPair: null, playerPair: null, luckySix: false });
        }
      }
      return entries.map((entry, index) => ({ ...entry, handNumber: index + 1 }));
    };

    const nodes = Array.from(document.querySelectorAll("[id^='table_'].sideHallTable"))
      .map((node) => {
        const title = clean(node.querySelector(".title")?.innerText || node.innerText || "");
        const text = clean(node.innerText || node.textContent || "");
        const deskNo = tableCode(`${title} ${text}`);
        const style = window.getComputedStyle(node.querySelector(".roadmap #roadmapAll,.roadmap .roadmapImage[id='roadmapAll']") || node.querySelector(".roadmapImage[id='roadmapAll']") || node);
        return {
          node,
          id: node.id || "",
          serverId: (node.id || "").replace(/^table_/, "").replace(/__.*/, ""),
          tableCode: deskNo,
          name: title,
          deskNo,
          text,
          unavailable: unavailablePattern.test(text),
          src: extractDataUrl(style.backgroundImage)
        };
      })
      .filter((item) => item.src && !item.unavailable && isBaccarat(`${item.name} ${item.text}`))
      .sort((left, right) => priority(left) - priority(right));

    const deduped = [];
    const seenCodes = new Set();
    for (const item of nodes) {
      if (!item.deskNo || seenCodes.has(item.deskNo)) continue;
      seenCodes.add(item.deskNo);
      deduped.push(item);
      if (deduped.length >= maxTables) break;
    }

    const result = [];
    for (const item of deduped) {
      const entries = await decodeRoadImage(item.src);
      result.push({
        table: {
          serverId: item.serverId || item.deskNo,
          tableCode: item.deskNo,
          deskNo: item.deskNo,
          name: item.name,
          text: item.text,
          source: "goodwin-allbet-sidehall-png"
        },
        entries,
        unavailable: item.unavailable
      });
    }
    return result;
  }, { maxTables, targetTableCodes }).catch(() => []);
}

async function openSideHallTable(page, table, config = {}) {
  if (!table || !table.elementId) return false;
  const selectors = [
    `#${table.elementId}`,
    table.serverId ? `#table_${table.serverId}` : "",
    table.serverId ? `#tableContainer_${table.serverId}` : ""
  ].filter(Boolean);
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await visibleCount(locator)) {
      await locator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await locator.click({ timeout: 1500, force: true }).catch(() => {});
      await page.waitForTimeout(config.tableSwitchMs || 700);
      if (table.deskNo) {
        await page.waitForFunction((deskNo) => {
          const text = document.querySelector("#gameInfo")?.innerText || "";
          return text.includes(deskNo);
        }, table.deskNo, { timeout: config.tableWaitMs || 1000 }).catch(() => {});
        if (!(await currentGameInfoHasDesk(page, table.deskNo))) {
          await clickSideHallEnterPopup(page, table);
          await page.waitForFunction((deskNo) => {
            const text = document.querySelector("#gameInfo")?.innerText || "";
            return text.includes(deskNo);
          }, table.deskNo, { timeout: Math.max(1500, config.tableWaitMs || 1000) }).catch(() => {});
        }
        return currentGameInfoHasDesk(page, table.deskNo);
      }
      return true;
    }
  }
  const clicked = await page.evaluate((elementId) => {
    const node = document.getElementById(elementId) || document.getElementById(elementId.replace("tableContainer_", "table_"));
    if (!node) return false;
    node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    if (typeof node.click === "function") node.click();
    return true;
  }, table.elementId).catch(() => false);
  if (!clicked) return false;
  await page.waitForTimeout(config.tableSwitchMs || 700);
  if (table.deskNo) {
    await page.waitForFunction((deskNo) => {
      const text = document.querySelector("#gameInfo")?.innerText || "";
      return text.includes(deskNo);
    }, table.deskNo, { timeout: config.tableWaitMs || 1000 }).catch(() => {});
    if (!(await currentGameInfoHasDesk(page, table.deskNo))) {
      await clickSideHallEnterPopup(page, table);
      await page.waitForFunction((deskNo) => {
        const text = document.querySelector("#gameInfo")?.innerText || "";
        return text.includes(deskNo);
      }, table.deskNo, { timeout: Math.max(1500, config.tableWaitMs || 1000) }).catch(() => {});
    }
    return currentGameInfoHasDesk(page, table.deskNo);
  }
  return true;
}

async function currentGameInfoHasDesk(page, deskNo) {
  if (!deskNo) return false;
  return page.evaluate((value) => {
    const text = document.querySelector("#gameInfo")?.innerText || "";
    return text.includes(value);
  }, deskNo).catch(() => false);
}

async function clickSideHallEnterPopup(page, table = {}) {
  const point = await page.evaluate((deskNo) => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1680;
    if (deskNo) {
      const containers = Array.from(document.querySelectorAll("div,section,article"))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          const text = node.innerText || node.textContent || "";
          return { rect, style, text };
        })
        .filter(({ rect, style, text }) => {
          if (!text.includes(deskNo)) return false;
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (rect.width < 120 || rect.width > 420 || rect.height < 65 || rect.height > 240) return false;
          if (rect.left < viewportWidth - 560 || rect.top < 0 || rect.top > 780) return false;
          return true;
        })
        .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height));
      const popup = containers[0];
      if (popup) {
        return {
          x: popup.rect.left + Math.min(42, popup.rect.width * 0.18),
          y: popup.rect.bottom - Math.min(24, popup.rect.height * 0.18)
        };
      }
    }
    const candidates = Array.from(document.querySelectorAll("button,div,span"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return { node, rect, style };
      })
      .filter(({ rect, style }) => {
        if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
        if (style.cursor !== "pointer") return false;
        if (rect.left < viewportWidth - 360 || rect.top > 240 || rect.width < 24 || rect.width > 95 || rect.height < 20 || rect.height > 60) return false;
        return true;
      })
      .sort((left, right) => {
        const row = Math.round(right.rect.top - left.rect.top);
        if (Math.abs(row) > 10) return right.rect.top - left.rect.top;
        return left.rect.left - right.rect.left;
      });
    const target = candidates[0];
    if (!target) return null;
    return {
      x: target.rect.left + target.rect.width / 2,
      y: target.rect.top + target.rect.height / 2
    };
  }, table.deskNo || "").catch(() => null);
  const size = page.viewportSize() || { width: 1680, height: 950 };
  const x = point?.x || size.width - 275;
  const y = point?.y || 150;
  await page.mouse.move(x, y);
  await page.waitForTimeout(100);
  await page.mouse.click(x, y);
  await page.waitForTimeout(700);
  return true;
}

async function collectCurrentAllbetRoadmap(page, fallbackTable) {
  return page.evaluate((fallback) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const codePattern = /\b(?:IB\d{3}|[BQCV]\d{3})\b/i;
    const unavailablePattern = /shuffle|shuffling|washing|stopped|settling|\u6d17\u724c|\u505c\u6b62\u4e0b\u6ce8|\u7d50\u7b97|\u5df2\u5305\u684c/i;
    const gameInfo = clean(document.querySelector("#gameInfo")?.innerText || "");
    const roadmap = clean(document.querySelector("#roadmap")?.innerText || "");
    const tableMatch = gameInfo.match(/((?:快速|經典|经典|VIP|咪牌|性感|保險|保险)?百家[樂乐]\s+(?:IB\d{3}|[BQCV]\d{3}))/i);
    const deskMatch = gameInfo.match(codePattern);
    const currentDesk = deskMatch ? deskMatch[0] : "";
    const shoeMatch = gameInfo.match(/\b(\d{6,})\b/);
    const unavailable = unavailablePattern.test(`${gameInfo} ${roadmap}`);
    const tokens = roadmap.split(/\s+/).filter(Boolean);
    const entries = [];
    for (const token of tokens) {
      if (/^(莊|庄|banker|B)$/i.test(token)) {
        entries.push({ result: "banker", bankerPair: null, playerPair: null, luckySix: false });
      } else if (/^(閒|闲|player|P)$/i.test(token)) {
        entries.push({ result: "player", bankerPair: null, playerPair: null, luckySix: false });
      } else if (/^(和|tie|T)$/i.test(token)) {
        entries.push({ result: "tie", bankerPair: null, playerPair: null, luckySix: false });
      } else if (/^(6|幸運6|幸运6)$/i.test(token) && entries.length && entries[entries.length - 1].result === "banker") {
        entries[entries.length - 1].luckySix = true;
      }
    }
    return {
      table: {
        ...(fallback || {}),
        name: tableMatch ? tableMatch[1] : currentDesk ? `Baccarat ${currentDesk}` : gameInfo || fallback?.name || "Baccarat",
        deskNo: currentDesk,
        tableCode: currentDesk,
        serverId: fallback?.serverId || currentDesk || "",
        shoe: shoeMatch ? shoeMatch[1] : fallback?.shoe || "",
        source: "goodwin-allbet-roadmap-dom"
      },
      entries: entries.map((entry, index) => ({ ...entry, handNumber: index + 1, shoe: shoeMatch ? shoeMatch[1] : fallback?.shoe || "" })),
      roadmap,
      gameInfo,
      unavailable
    };
  }, fallbackTable || null);
}

async function waitForAllbetReady(page, config) {
  const timeoutMs = Math.max(15_000, Math.min(config.runTimeoutMs - 15_000, config.allbetReadyTimeoutMs || 90_000));
  await page.waitForFunction(() => {
    const text = document.body ? document.body.innerText || "" : "";
    const desks = document.querySelectorAll(".desk,.lobby-desk,[class*='desk']").length;
    const hasGameText = /百家|百家乐|bacc|baccarat/i.test(text);
    const stuck = /100\s*%/.test(text) && desks < 4;
    return desks >= 12 || (hasGameText && !stuck);
  }, null, { timeout: timeoutMs }).catch(async () => {
    const text = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
    const error = new Error(/100\s*%/.test(text) ? "Allbet loading stuck at 100%" : "Allbet lobby did not become ready");
    error.code = "allbet-not-ready";
    throw error;
  });
}

async function waitForAllbetReadyWithRecovery(page, config) {
  const attempts = Math.max(1, Number(config.allbetReadyRetries || 1));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await waitForAllbetReady(page, config);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      debugLog(config, "allbet-ready-retry", {
        attempt,
        message: error.message || String(error),
        url: sanitizeUrl(page.url())
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(async () => {
        await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      });
      await page.waitForTimeout(Math.max(3000, Math.min(8000, Number(config.tableWaitMs || 2000) * 3)));
      await selectAllBaccarat(page).catch(() => false);
    }
  }
  throw lastError;
}

async function clickByText(page, patterns, options = {}) {
  for (const pattern of patterns) {
    const locator = page.getByText(pattern).first();
    if (await visibleCount(locator)) {
      await locator.click({ timeout: options.timeout || 3000 });
      return true;
    }
  }
  return false;
}

async function visibleCount(locator) {
  try {
    return (await locator.count()) > 0 && await locator.isVisible({ timeout: 250 });
  } catch (_) {
    return false;
  }
}

function attachCapture(page, state) {
  if (!page || page.__baijiaCollectorAttached) return;
  page.__baijiaCollectorAttached = true;

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (!/json|text/i.test(contentType) && !/api|road|history|count|lobby|user/i.test(url)) return;
      const text = await response.text();
      if (!looksRelevant(text) && !looksRelevant(url)) return;
      state.ingestText(text, `http:${sanitizeUrl(url)}`);
    } catch (_) {}
  });

  page.on("websocket", (socket) => {
    const wsUrl = sanitizeUrl(socket.url());
    socket.on("framereceived", (frame) => {
      try {
        const payload = typeof frame.payload === "string" ? frame.payload : Buffer.from(frame.payload || "").toString("utf8");
        if (!looksRelevant(payload) && !looksRelevant(wsUrl)) return;
        state.ingestText(payload, `ws:${wsUrl}`);
      } catch (_) {}
    });
  });
}

class CaptureState {
  constructor(config) {
    this.config = config;
    this.tablesByKey = new Map();
    this.roundsByTableKey = new Map();
    this.detectedTableKeys = new Set();
    this.skippedUnavailableTableKeys = new Set();
    this.sources = new Set();
    this.scanned = 0;
  }

  ingestText(text, source) {
    const parsed = parseMaybeJson(text);
    if (parsed === undefined) return;
    this.sources.add(source);
    this.walk(parsed, {}, source);
  }

  ingestDomTables(tables, source) {
    this.sources.add(`dom:${sanitizeUrl(source)}`);
    for (const item of tables) {
      const table = normalizeTableInfo(item);
      if (!table || !isTargetBaccaratName(table.name)) continue;
      if (isUnavailableTableText(`${item.name || ""} ${item.text || ""}`)) {
        this.markUnavailableTable(table.tableCode || table.key);
      }
      this.registerTable(table);
    }
  }

  markUnavailableTable(value) {
    const code = normalizeTableCode(value);
    if (code && isTargetTableCode(code, this.config)) {
      this.skippedUnavailableTableKeys.add(code);
    }
  }

  walk(value, context, source) {
    if (Array.isArray(value)) {
      const entries = extractRoadEntries(value);
      if (entries.length && context.table) this.addRoadEntries(context.table, entries, source);
      for (const item of value) this.walk(item, context, source);
      return;
    }
    if (!value || typeof value !== "object") return;

    const roadPacket = normalizeAllbetRoadPacket(value);
    if (roadPacket) {
      this.addRoadEntries(roadPacket.table, roadPacket.entries, source);
    }

    const table = normalizeTableInfo(value) || context.table || tableFromContextKey(context.key, value);
    const nextContext = table ? { ...context, table } : context;
    if (table) this.registerTable(table);

    for (const [key, child] of Object.entries(value)) {
      const childTable = tableFromContextKey(key, child) || nextContext.table;
      const childContext = childTable ? { ...nextContext, key, table: childTable } : { ...nextContext, key };
      const singleEntry = normalizeRoadEntry(child);
      if (singleEntry && childTable && /road|result|history|card|game|round|r$/i.test(key)) {
        this.addRoadEntries(childTable, [singleEntry], source);
      }
      if (Array.isArray(child)) {
        const entries = extractRoadEntries(child);
        if (entries.length && childTable) this.addRoadEntries(childTable, entries, source);
      }
      this.walk(child, childContext, source);
    }
  }

  registerTable(input) {
    const table = normalizeTableInfo(input);
    if (!table) return null;
    const key = table.key;
    if (this.tablesByKey.has(key)) {
      const existing = this.tablesByKey.get(key);
      const hasGenericName = !existing.name || /^Baccarat\s+\w+$/i.test(existing.name);
      const hasBetterName = table.name && !/^Baccarat\s+\w+$/i.test(table.name);
      if (hasBetterName && (hasGenericName || table.name !== existing.name)) {
        const saved = store.upsertTable({
          id: existing.id || "",
          name: table.name,
          roomId: table.roomId || existing.roomId,
          tableCode: table.tableCode || existing.tableCode || "",
          provider: "allbet",
          gameType: "baccarat",
          shoe: table.shoe || existing.shoe || "",
          source: table.source || existing.source || "goodwin-allbet",
          lastSeenAt: new Date().toISOString()
        });
        Object.assign(existing, table, { id: saved.id, roomId: saved.roomId, name: table.name });
      }
      this.detectedTableKeys.add(key);
      return existing;
    }
    const saved = store.upsertTable({
      id: table.id || "",
      name: table.name,
      roomId: table.roomId,
      tableCode: table.tableCode,
      provider: "allbet",
      gameType: "baccarat",
      shoe: table.shoe || "",
      source: table.source || "goodwin-allbet",
      lastSeenAt: new Date().toISOString()
    });
    const item = { ...table, id: saved.id, roomId: saved.roomId };
    this.tablesByKey.set(key, item);
    this.detectedTableKeys.add(key);
    return item;
  }

  addRoadEntries(tableInput, entries, source) {
    const table = this.registerTable(tableInput);
    if (!table) return;
    const validEntries = entries.map((entry, index) => buildRoundFromRoadEntry(entry, table, index, source)).filter(Boolean);
    if (!validEntries.length) return;
    const key = table.key;
    const existing = this.roundsByTableKey.get(key) || [];
    existing.push(...validEntries);
    this.roundsByTableKey.set(key, existing);
    this.scanned += validEntries.length;
  }

  addResultEntries(tableInput, entries, source) {
    const table = this.registerTable(tableInput);
    if (!table) return;
    const validEntries = entries.map((entry, index) => buildRoundFromResultEntry(entry, table, index, source)).filter(Boolean);
    if (!validEntries.length) return;
    const key = table.key;
    const existing = this.roundsByTableKey.get(key) || [];
    existing.push(...validEntries);
    this.roundsByTableKey.set(key, existing);
    this.scanned += validEntries.length;
  }

  flush() {
    let added = 0;
    const tableIds = [];
    const capturedCodes = new Set();
    for (const [key, entries] of this.roundsByTableKey.entries()) {
      const table = this.tablesByKey.get(key);
      if (!table || !entries.length) continue;
      const unique = dedupeRounds(entries);
      const saved = store.addRounds(table.id, unique, { source: "goodwin-allbet" });
      added += saved.length;
      capturedCodes.add(table.tableCode || table.key);
      tableIds.push(table.id);
    }
    const detectedCodes = new Set([...this.tablesByKey.values()].map((table) => table.tableCode || table.key).filter(Boolean));
    const targetCodes = this.config.targetTableCodes || DEFAULT_TARGET_TABLE_CODES;
    const missingTableIds = targetCodes.filter((code) => !capturedCodes.has(code));
    const skippedUnavailableTableIds = targetCodes.filter((code) => this.skippedUnavailableTableKeys.has(code));
    return {
      scanned: this.scanned,
      added,
      detectedTables: detectedCodes.size,
      detailCaptured: capturedCodes.size,
      missingTables: missingTableIds.length,
      tableIds,
      missingTableIds,
      skippedUnavailableTableIds
    };
  }
}

function normalizeTableInfo(value = {}) {
  if (!value || typeof value !== "object") return null;
  const serverId = firstValue(value.serverId, value.ServerId, value.serverID, value.deskId, value.DeskId, value.tableId, value.TableId, value.id, value.AA);
  const deskNo = firstValue(value.deskNo, value.DeskNo, value.ShowDeskName, value.serverType, value.ServerType, value.tableNo, value.TableNo, value.BB);
  const rawName = firstValue(value.name, value.Name, value.gameName, value.GameName, value.tableName, value.TableName, value.title, value.text, value.BB);
  const tableCode = normalizeTableCode(firstValue(value.tableCode, value.TableCode, deskNo, rawName, value.roomId, value.RoomId));
  const name = cleanTableName(rawName || (deskNo ? `百家樂 ${deskNo}` : serverId ? `百家樂 ${serverId}` : ""));
  const gameNo = Number(firstValue(value.gameNo, value.GameNo, value.gameType, value.GameTypeNo) || 0);
  const gameType = String(firstValue(value.gameType, value.GameType, value.type, value.Type) || "").toLowerCase();
  if (!name && !serverId && !deskNo) return null;
  if (gameNo && gameNo !== 11) return null;
  if (gameType && /dragon|longhu|roulette|sic|bull|hilo|fish/i.test(gameType)) return null;
  if (!isTargetTableCode(tableCode)) return null;
  if (!isTargetBaccaratName(`${name} ${tableCode}`)) return null;

  const shoe = String(firstValue(value.shoe, value.Shoe, value.shoeNo, value.ShoeNo, value.bootNo, value.BootNo) || parseShoeFromText(value.text || "") || "");
  const key = tableCode;
  const safeDesk = tableCode;
  return {
    key,
    serverId: String(serverId || "").trim(),
    deskNo: safeDesk,
    tableCode,
    name: name && normalizeTableCode(name) ? name : `百家樂 ${safeDesk}`,
    roomId: `allbet:${serverId || slugify(name)}:${safeDesk}`,
    shoe,
    source: "goodwin-allbet"
  };
}

function tableFromContextKey(key, child) {
  const keyText = String(key || "");
  if (!/^\d{3,}$|^[A-Z]{1,4}\d{2,6}$|^[A-Z]-[A-Z]$/i.test(keyText)) return null;
  if (!child || typeof child !== "object") return null;
  const text = JSON.stringify(child).slice(0, 1200);
  if (!looksLikeRoadPayload(text) && !/bacc|百家|百家乐/i.test(text)) return null;
  return normalizeTableInfo({ serverId: keyText, name: `百家樂 ${keyText}` });
}

function isTargetBaccaratName(value) {
  const text = String(value || "");
  if (!text) return false;
  if (/區塊鏈|区块链|block|dragon|tiger|龍虎|龙虎|roulette|sicbo|骰寶|骰宝|牛牛|bull/i.test(text)) return false;
  return /百家|百家乐|bacc|baccarat|快速|經典|经典|咪牌|VIP|P-[A-Z]|C-[A-Z]|B\d{3}|Q\d{3}/i.test(text);
}

function normalizeAllbetRoadPacket(value) {
  if (!value || typeof value !== "object") return null;
  const command = String(firstValue(value.c, value.C, value.cmd, value.command, value.event) || "");
  const payload = value.p && typeof value.p === "object" ? value.p : value.P && typeof value.P === "object" ? value.P : value;
  const roadSource = firstValue(payload.G, payload.g, payload.WW3, payload.ww3, payload.roadData, payload.RoadData, payload.roads, payload.history);
  if (!roadSource) return null;
  const entries = flattenRoadEntries(roadSource);
  if (!entries.length) return null;
  const compactTable = normalizeTableInfo(payload);
  if (compactTable) {
    return {
      table: compactTable,
      entries
    };
  }
  const tableId = String(
    command === "getRoadData"
      ? firstValue(payload.C, payload.tableId, payload.TableId, payload.deskId, payload.DeskId)
      : firstValue(payload.C, payload.A, payload.tableId, payload.TableId, payload.deskId, payload.DeskId)
  || "").trim();
  if (!tableId || tableId === "0") return null;
  return {
    table: {
      serverId: tableId,
      name: `Baccarat ${tableId}`,
      source: "goodwin-allbet-ws-road"
    },
    entries
  };
}

function flattenRoadEntries(value) {
  const entries = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const entry = normalizeRoadEntry(item, entries.length);
    if (entry) entries.push({ ...entry, handNumber: entries.length + 1 });
  };
  visit(value);
  return entries;
}

function extractRoadEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  value.forEach((item, index) => {
    const entry = normalizeRoadEntry(item, index);
    if (entry) entries.push(entry);
  });
  if (!entries.length) return [];
  return entries.length >= Math.max(1, Math.floor(value.length * 0.35)) ? entries : [];
}

function normalizeRoadEntry(value, index = 0) {
  if (typeof value === "string" || typeof value === "number") {
    const rawRoad = String(value).trim().toUpperCase();
    return isRoadCode(rawRoad) ? { rawRoad, handNumber: index + 1 } : null;
  }
  if (!value || typeof value !== "object") return null;
  const rawRoad = String(firstValue(
    value.rawRoad,
    value.roadCode,
    value.RoadCode,
    value.resultCode,
    value.ResultCode,
    value.code,
    value.Code,
    value.r,
    value.R
  ) || "").trim().toUpperCase();
  if (!isRoadCode(rawRoad)) return null;
  return {
    rawRoad,
    handNumber: Number(firstValue(value.handNumber, value.HandNumber, value.roundNo, value.RoundNo, value.no, value.No)) || index + 1,
    shoe: String(firstValue(value.shoe, value.Shoe, value.shoeNo, value.ShoeNo, value.bootNo, value.BootNo) || "")
  };
}

function buildRoundFromRoadEntry(entry, table, index, source) {
  const decoded = decodeRoadCode(entry.rawRoad);
  if (!decoded) return null;
  const handNumber = Number(entry.handNumber || index + 1);
  const shoe = entry.shoe || table.shoe || "";
  return {
    shoe,
    handNumber,
    result: decoded.result,
    bankerPair: decoded.bankerPair,
    playerPair: decoded.playerPair,
    luckySix: decoded.luckySix,
    bankerPoints: decoded.bankerPoints,
    playerPoints: decoded.playerPoints,
    source: "allbet-ws-road-code",
    observedAt: new Date().toISOString(),
    externalKey: `allbet:${table.serverId || table.key}:${shoe || "noshoe"}:${handNumber}:${entry.rawRoad}`,
    note: source ? sanitizeUrl(source).slice(0, 220) : ""
  };
}

function buildRoundFromResultEntry(entry, table, index, source) {
  const result = String(entry.result || "").toLowerCase();
  if (!["banker", "player", "tie"].includes(result)) return null;
  const handNumber = Number(entry.handNumber || index + 1);
  const shoe = entry.shoe || table.shoe || "";
  return {
    shoe,
    handNumber,
    result,
    bankerPair: entry.bankerPair === null ? null : Boolean(entry.bankerPair),
    playerPair: entry.playerPair === null ? null : Boolean(entry.playerPair),
    luckySix: Boolean(entry.luckySix),
    bankerPoints: null,
    playerPoints: null,
    source: "allbet-dom-roadmap",
    observedAt: new Date().toISOString(),
    externalKey: `allbet-dom:${table.serverId || table.key}:${shoe || "noshoe"}:${handNumber}:${result}:${entry.luckySix ? "L6" : "N"}`,
    note: source ? sanitizeUrl(source).slice(0, 220) : ""
  };
}

function decodeRoadCode(rawRoad) {
  const code = String(rawRoad || "").trim().toUpperCase();
  if (!isRoadCode(code)) return null;
  const result = { "0": "tie", "1": "banker", "2": "player" }[code[0]];
  if (!result) return null;
  const pairFlag = code[3] || "0";
  const bankerPoints = parsePoint(code[1]);
  const playerPoints = parsePoint(code[2]);
  return {
    result,
    bankerPoints,
    playerPoints,
    bankerPair: ["1", "3", "4", "6"].includes(pairFlag),
    playerPair: ["2", "3", "5", "6"].includes(pairFlag),
    luckySix: result === "banker" && bankerPoints === 6
  };
}

function isRoadCode(value) {
  return /^[012][0-9A-Z]{10,15}$/.test(String(value || "").trim().toUpperCase());
}

function parsePoint(value) {
  const parsed = Number.parseInt(String(value || ""), 16);
  return Number.isFinite(parsed) ? parsed % 10 : null;
}

async function collectDomTables(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const desks = [...document.querySelectorAll(".desk,[class*='desk']")];
    return desks.map((desk, index) => {
      const box = desk.getBoundingClientRect();
      const name = clean(
        desk.querySelector(".game-name,[class*='game-name'],[class*='name']")?.innerText
        || desk.querySelector(".left,[class*='left'],.top,[class*='top']")?.innerText
        || desk.innerText
      );
      const text = clean(desk.innerText || desk.textContent || "");
      const shoeMatch = text.match(/(\d{2,4})\s*-\s*(\d{2,5})/);
      return {
        index,
        name,
        text,
        shoe: shoeMatch ? shoeMatch[1] : "",
        roomId: shoeMatch ? shoeMatch[0] : "",
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height)
      };
    }).filter((item) => item.text);
  });
}

function dedupeRounds(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = entry.externalKey || `${entry.shoe}:${entry.handNumber}:${entry.result}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result.sort((a, b) => Number(a.handNumber || 0) - Number(b.handNumber || 0));
}

function parseMaybeJson(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 2_000_000) return undefined;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return undefined;
    }
  }
  const match = raw.match(/(\{(?:.|\n|\r)*\}|\[(?:.|\n|\r)*\])/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return undefined;
  }
}

function looksRelevant(value) {
  const text = String(value || "");
  return looksLikeRoadPayload(text) || /allbet|ab8888|luckycat|bacc|baccarat|百家|百家乐|歐博|欧博/i.test(text);
}

function looksLikeRoadPayload(text) {
  return /[012][0-9A-Z]{10,15}/.test(String(text || ""));
}

function cleanTableName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\b\d{2,4}\s*-\s*\d{2,5}\b/g, "")
    .trim();
}

function parseShoeFromText(value) {
  const match = String(value || "").match(/(\d{2,4})\s*-\s*\d{2,5}/);
  return match ? match[1] : "";
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function readTargetTableCodes(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "").trim();
  const values = raw ? raw.split(/[,\s]+/) : DEFAULT_TARGET_TABLE_CODES;
  const seen = new Set();
  return values
    .map((item) => normalizeTableCode(item))
    .filter((item) => item && !seen.has(item) && seen.add(item));
}

function normalizeTableCode(value) {
  const match = String(value || "").toUpperCase().match(TARGET_TABLE_CODE_PATTERN);
  return match ? match[0] : "";
}

function isTargetTableCode(value, config = readConfig()) {
  const code = normalizeTableCode(value);
  return Boolean(code && new Set(config.targetTableCodes || DEFAULT_TARGET_TABLE_CODES).has(code));
}

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function slugify(value) {
  return String(value || "table").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80) || "table";
}

function sanitizeUrl(rawUrl) {
  return String(rawUrl || "")
    .replace(/(token|sessionId|sid|uid|userKey|companyToken|expireTime)=([^&#]+)/gi, "$1=[redacted]")
    .replace(/eyJ[A-Za-z0-9._-]{40,}/g, "[jwt-redacted]");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function debugLog(config, message, detail = "") {
  if (!config?.debug) return;
  const suffix = detail ? ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "";
  console.error(`[collector] ${new Date().toISOString()} ${message}${suffix}`);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = "timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const mode = args.has("--loop") ? "loop" : "once";
  const config = readConfig();
  const runner = mode === "loop" ? runCollectorLoop() : withTimeout(collectOnce(config), config.runTimeoutMs, "Collector run timeout");
  runner.then((summary) => {
    if (summary) console.log(JSON.stringify(summary, null, 2));
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  runCollectorLoop,
  collectOnce,
  decodeRoadCode
};
