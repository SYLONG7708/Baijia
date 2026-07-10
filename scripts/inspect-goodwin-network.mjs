import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outputDir = join(root, "output", "network");
const storageState = join(root, "storage", "goodwin-session.json");
const url = process.env.GOODWIN_URL || "https://www.goodwin77.com/liveView";
const maxItems = Number(process.env.NETWORK_CAPTURE_MAX || 120);
const terms = ["road", "history", "shoe", "game", "baccarat", "classicBacc", "局號", "百家樂", "莊", "閒", "和"];

mkdirSync(outputDir, { recursive: true });

const captures = [];
const browser = await chromium.launch({ headless: String(process.env.GOODWIN_HEADLESS || "true").toLowerCase() !== "false" });
const context = await browser.newContext(existsSync(storageState)
  ? { storageState, viewport: { width: 1440, height: 950 } }
  : { viewport: { width: 1440, height: 950 } });

context.on("page", attachCapture);
const page = await context.newPage();
attachCapture(page);

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
const playNow = page.getByText("PLAY NOW", { exact: false }).first();
if (await playNow.count().catch(() => 0)) await playNow.click({ timeout: 8000 }).catch(() => {});
const lobby = await popupPromise || page;
attachCapture(lobby);
await lobby.waitForTimeout(12000);
await lobby.keyboard.press("Escape").catch(() => {});
await lobby.mouse.click(1350, 120).catch(() => {});
await lobby.waitForTimeout(3000);

const firstDesk = lobby.locator(".desk").first();
if (await firstDesk.count().catch(() => 0)) {
  await firstDesk.click({ timeout: 8000 }).catch(() => {});
  await lobby.waitForTimeout(12000);
}

const compact = captures.slice(0, maxItems);
writeFileSync(join(outputDir, "goodwin-network-candidates.json"), JSON.stringify(compact, null, 2), "utf8");
console.log(JSON.stringify({
  saved: compact.length,
  path: join(outputDir, "goodwin-network-candidates.json"),
  types: compact.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {})
}, null, 2));

await browser.close();

function attachCapture(page) {
  if (page.__baijiaCaptureAttached) return;
  page.__baijiaCaptureAttached = true;

  page.on("response", async (response) => {
    try {
      const contentType = response.headers()["content-type"] || "";
      const requestUrl = response.url();
      if (!/json|text|javascript/i.test(contentType) && !looksRelevant(requestUrl)) return;
      const text = await response.text();
      if (!looksRelevant(text) && !looksRelevant(requestUrl)) return;
      pushCapture({
        type: "http",
        status: response.status(),
        url: sanitizeUrl(requestUrl),
        contentType,
        preview: compactText(text)
      });
    } catch (_) {}
  });

  page.on("websocket", (socket) => {
    const wsUrl = sanitizeUrl(socket.url());
    socket.on("framereceived", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload?.toString("utf8") || "";
      if (!looksRelevant(text) && !looksRelevant(wsUrl)) return;
      pushCapture({
        type: "websocket",
        url: wsUrl,
        preview: compactText(text)
      });
    });
  });
}

function pushCapture(item) {
  if (captures.length >= maxItems) return;
  captures.push({
    capturedAt: new Date().toISOString(),
    ...item
  });
}

function looksRelevant(value) {
  const text = String(value || "");
  return terms.some((term) => text.toLowerCase().includes(term.toLowerCase()));
}

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|auth|session|expire|uid|user/i.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    parsed.pathname = parsed.pathname
      .split("/")
      .map((segment) => isSensitivePathSegment(segment) ? "[redacted]" : segment)
      .join("/");
    return parsed.toString();
  } catch (_) {
    return String(rawUrl)
      .replace(/token=[^&]+/gi, "token=[redacted]")
      .replace(/eyJ[A-Za-z0-9._-]{40,}/g, "[jwt-redacted]");
  }
}

function isSensitivePathSegment(segment) {
  return /^eyJ[A-Za-z0-9._-]{40,}$/.test(segment)
    || /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i.test(segment);
}

function compactText(text) {
  return String(text || "")
    .replace(/data:image\/[^"')\s]+/g, "[image-data]")
    .replace(/eyJ[A-Za-z0-9._-]{40,}/g, "[jwt-redacted]")
    .replace(/(Token=)[A-Za-z0-9-]+/gi, "$1[redacted]")
    .replace(/(LoginToken["']?\s*[:=]\s*["']?)[A-Za-z0-9-]+/gi, "$1[redacted]")
    .replace(/(UserKey["']?\s*[:=]\s*["']?)[A-Za-z0-9-]+/gi, "$1[redacted]")
    .replace(/(CompanyToken["']?\s*[:=]\s*["']?)[A-Za-z0-9-]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 2500);
}
