const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.BAIJIA_SMOKE_BASE_URL || `http://localhost:${PORT}`;
const EXPECTED_TARGET_TABLES = 36;
const ANALYSIS_SEQUENCE = [
  { result: "banker", bankerPair: true, bankerCards: ["8", "8"], playerCards: ["K", "5"], bankerPoints: 6, playerPoints: 5 },
  { result: "player", bankerCards: ["4", "Q"], playerCards: ["7", "2"], bankerPoints: 4, playerPoints: 9 },
  { result: "banker", luckySix: true, bankerCards: ["3", "3"], playerCards: ["10", "5"], bankerPoints: 6, playerPoints: 5 },
  { result: "banker", bankerCards: ["9", "1"], playerCards: ["2", "6"], bankerPoints: 0, playerPoints: 8 },
  { result: "player", playerPair: true, bankerCards: ["5", "K"], playerCards: ["6", "6"], bankerPoints: 5, playerPoints: 2 },
  { result: "tie", bankerCards: ["7", "2"], playerCards: ["4", "5"], bankerPoints: 9, playerPoints: 9 },
  { result: "banker", bankerCards: ["1", "5"], playerCards: ["2", "3"], bankerPoints: 6, playerPoints: 5 },
  { result: "player", bankerCards: ["J", "4"], playerCards: ["8", "1"], bankerPoints: 4, playerPoints: 9 }
];

const errors = [];
const results = [];

await checkJson("ping", "/api/ping", (json) => {
  assert(json.ok === true, "ping ok is not true");
  assert(json.service === "baijia-monitor", "ping service mismatch");
  assert(Number(json.uptimeSeconds || 0) >= 0, "ping uptime missing");
  assert(Number(json.memory?.rss || 0) > 0, "ping memory rss missing");
});

await checkJson("status", "/api/status", (json) => {
  assert(json.ok === true, "status ok is not true");
  assert(json.statusSource === "version" || json.statusSource === "database", "status source missing");
  assert(Number(json.allbetTables || 0) === EXPECTED_TARGET_TABLES, `status allbetTables is ${json.allbetTables}`);
  assert(Number(json.rounds || 0) > 0, "status rounds is zero");
  assert((json.collector?.runHistory || []).length <= 20, "status runHistory is not trimmed");
});

let firstAllbetTableId = "";
let firstAllbetTableCode = "";
await checkJson("tables", "/api/tables", (json) => {
  assert(json.ok === true, "tables ok is not true");
  const allbet = (json.tables || []).filter((table) => table.provider === "allbet");
  assert(allbet.length === EXPECTED_TARGET_TABLES, `api tables allbet count is ${allbet.length}`);
  firstAllbetTableId = allbet[0]?.id || "";
  firstAllbetTableCode = allbet[0]?.tableCode || "";
  assert(Boolean(firstAllbetTableId), "no first ALLBET table id");
});

await checkJson("analysis-tables", "/api/analysis/tables", (json) => {
  assert(json.ok === true, "analysis tables ok is not true");
  assert((json.tables || []).length === EXPECTED_TARGET_TABLES, `analysis table count is ${(json.tables || []).length}`);
  assert((json.tables || []).every((table) => table.id && table.tableCode), "analysis table id/code missing");
  assert(!(JSON.stringify(json).includes("baijia-db.json")), "analysis tables leaked database path");
});

await checkJson("health-1h", "/api/health?hours=1", (json) => {
  assert(Number(json.allbet?.totalTables || 0) === EXPECTED_TARGET_TABLES, "health allbet total is not 36");
  assert(json.heartbeat?.exists === true, "heartbeat missing");
});

await checkJson("roads", "/api/roads?limit=20", (json) => {
  assert(json.ok === true, "roads ok is not true");
  assert(Array.isArray(json.roads?.bead), "roads bead is not an array");
  assert(Number(json.summary?.total || 0) > 0, "roads summary total is zero");
});

if (firstAllbetTableId) {
  await checkJson("table-rounds", `/api/tables/${encodeURIComponent(firstAllbetTableId)}/rounds?limit=5`, (json) => {
    assert(json.ok === true, "table rounds ok is not true");
    assert(Array.isArray(json.rounds), "table rounds is not an array");
    assert(json.rounds.length > 0, "table rounds is empty");
  });
}

await checkJson("analyze", "/api/analyze", (json) => {
  assert(json.ok === true, "analyze ok is not true");
  assert(json.input?.length === 8, "analyze input length is not 8");
  assert(Boolean(json.advanced), "analyze advanced block missing");
  assert(Number(json.advanced?.crossTable?.comparedTables || 0) === EXPECTED_TARGET_TABLES, "advanced comparedTables is not 36");
  assert(Boolean(json.advanced?.frontBack), "advanced frontBack missing");
  assert(Boolean(json.advanced?.leftRight), "advanced leftRight missing");
  assert(Boolean(json.advanced?.fiveElements), "advanced fiveElements missing");
  assert(Boolean(json.advanced?.bagua), "advanced bagua missing");
  assert(Boolean(json.roadBreakdown), "roadBreakdown block missing");
  assert((json.roadBreakdown?.roads || []).length === 5, "roadBreakdown does not contain five roads");
  assert((json.roadBreakdown?.records || []).every((item) => item.manualCycleResult), "manual input cycle result missing");
  assert((json.roadBreakdown?.roads || []).every((item) => item.manualCycle?.source === "manual-input-only"), "manual cycle is not marked input-only");
  assert((json.roadBreakdown?.roads || []).every((item) => item.replay?.source === "manual-input-replay"), "manual replay stats missing");
  assert((json.roadBreakdown?.roads || []).every((item) => item.evidence?.label), "evidence grade missing");
  assert((json.roadBreakdown?.roads || []).every((item) => item.trendProfile?.label), "trend profile missing");
  assert(json.roadBreakdown?.manualReplay?.source === "manual-input-replay", "manual replay summary missing");
  assert(Boolean(json.roadBreakdown?.askRoad?.banker?.bigEyeRoad), "banker ask road missing");
  assert(Boolean(json.roadBreakdown?.askRoad?.player?.cockroachRoad), "player ask road missing");
  assert(Boolean(json.roadBreakdown?.overall?.highest), "roadBreakdown highest prediction missing");
  assert(json.ensembleBrain?.source === "leakage-safe-online-ensemble", "online ensemble missing");
  assert(json.ensembleBrain?.validation?.leakageSafe === true, "ensemble leakage-safe validation missing");
  assert((json.ensembleBrain?.experts || []).length === 18, "ensemble expert set incomplete");
  assert(["banker", "player"].includes(json.ensembleBrain?.directional?.result), "ensemble direction missing");
  assert(Number(json.ensembleBrain?.directional?.rate || 0) >= 0.5, "ensemble direction is below 50 percent");
  assert(json.ensembleBrain?.probabilityDirection?.result === json.ensembleBrain?.directional?.result, "probability direction alias mismatch");
  assert(["banker", "player"].includes(json.ensembleBrain?.economicPreference?.result), "economic preference missing");
  assert(["banker", "player"].includes(json.decisionProfile?.forced?.trendResult), "forced trend direction missing");
  assert(["banker", "player"].includes(json.decisionProfile?.forced?.probabilityResult), "forced AI probability direction missing");
  assert(Number.isFinite(Number(json.fiveStepRisk?.baselineCompletionRate)), "five-step natural baseline missing");
  assert(json.cardModel?.usable === true, "card model is not active");
  assert(Number(json.cardModel?.seenCards || 0) > 0, "card model saw no cards");
  assert((json.cardModel?.rates || []).length === 6, "card model six rates missing");
}, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scope: "all", sequence: ANALYSIS_SEQUENCE })
});

if (firstAllbetTableId) {
  await checkJson("analyze-table", "/api/analyze", (json) => {
    assert(json.ok === true, "table analyze ok is not true");
    assert(json.dataset?.scope === "table", "table analyze scope is not table");
    assert(json.runtime?.scope === "table", "table analyze runtime scope is not table");
    assert(json.runtime?.tableId === firstAllbetTableId, "table analyze id mismatch");
    assert(Number(json.runtime?.roundsLoaded || 0) > 0, "table analyze loaded no rounds");
    assert(Number(json.runtime?.roundsLoaded || 0) <= 1800, "table analyze ignored limit");
    assert((json.roadBreakdown?.roads || []).length === 5, "table analyze five-road block missing");
  }, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "table",
      tableId: firstAllbetTableId,
      tableCode: firstAllbetTableCode,
      limit: 1800,
      sequence: ANALYSIS_SEQUENCE
    })
  });
}

if (firstAllbetTableId) {
  await checkJson("analysis-backtest", "/api/analysis/backtest", (json) => {
    assert(json.ok === true, "analysis backtest ok is not true");
    assert(json.table?.id === firstAllbetTableId, "analysis backtest table id mismatch");
    assert(Number(json.sample?.checkedWindows || 0) > 0, "analysis backtest checked no windows");
    assert(Boolean(json.summary?.currentStrategy), "analysis backtest current strategy missing");
    assert(Boolean(json.summary?.evidenceWeighted), "analysis backtest evidence weighted missing");
    assert(Boolean(json.summary?.onlineEnsemble), "analysis backtest online ensemble missing");
    assert(Number.isFinite(Number(json.summary?.onlineEnsemble?.roiLower95)), "analysis backtest ROI lower bound missing");
    assert(Number.isFinite(Number(json.summary?.onlineEnsemble?.brierScore)), "analysis backtest Brier score missing");
    assert(Object.keys(json.roads || {}).length === 5, "analysis backtest five road stats missing");
    assert(Array.isArray(json.details), "analysis backtest details missing");
  }, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tableId: firstAllbetTableId,
      tableCode: firstAllbetTableCode,
      limit: 360,
      maxChecks: 8,
      detailLimit: 3
    })
  });
}

await checkJson("analyze-local-only", "/api/analyze", (json) => {
  assert(json.ok === true, "local-only analyze ok is not true");
  assert(json.dataset?.allRounds === 0, "local-only analyze read database rounds");
  assert(json.input?.manualLength === 10, "local-only manual length mismatch");
  assert((json.roadBreakdown?.records || []).every((item) => item.manualCycleResult), "local-only manual cycle result missing");
  assert((json.roadBreakdown?.records || []).every((item) => Number.isFinite(Number(item.replayHitRate))), "local-only replay rate missing");
  assert((json.roadBreakdown?.records || []).every((item) => item.evidenceLabel), "local-only evidence label missing");
  assert((json.roadBreakdown?.records || []).every((item) => item.trendProfile?.label), "local-only trend profile missing");
  assert(json.roadBreakdown?.manualReplay?.inputLength === 10, "local-only manual replay input length mismatch");
  assert(json.cardModel?.usable === true, "local-only card model is not active");
  assert(Number(json.cardModel?.seenCards || 0) > 0, "local-only card model saw no cards");
}, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scope: "all",
    localOnly: true,
    sequence: ANALYSIS_SEQUENCE,
    manualSequence: [
      { result: "banker", bankerPair: true, bankerCards: ["8", "8"], playerCards: ["K", "5"], bankerPoints: 6, playerPoints: 5 },
      { result: "player", bankerCards: ["4", "Q"], playerCards: ["7", "2"], bankerPoints: 4, playerPoints: 9 },
      { result: "banker", luckySix: true, bankerCards: ["3", "3"], playerCards: ["10", "5"], bankerPoints: 6, playerPoints: 5 },
      { result: "banker", bankerCards: ["9", "1"], playerCards: ["2", "6"], bankerPoints: 0, playerPoints: 8 },
      { result: "player", playerPair: true, bankerCards: ["5", "K"], playerCards: ["6", "6"], bankerPoints: 5, playerPoints: 2 },
      { result: "tie", bankerCards: ["7", "2"], playerCards: ["4", "5"], bankerPoints: 9, playerPoints: 9 },
      { result: "banker", bankerCards: ["1", "5"], playerCards: ["2", "3"], bankerPoints: 6, playerPoints: 5 },
      { result: "player", bankerCards: ["J", "4"], playerCards: ["8", "1"], bankerPoints: 4, playerPoints: 9 },
      { result: "banker", bankerPair: true, bankerCards: ["2", "2"], playerCards: ["3", "K"], bankerPoints: 4, playerPoints: 3 },
      { result: "player", bankerCards: ["6", "Q"], playerCards: ["9", "K"], bankerPoints: 6, playerPoints: 9 }
    ]
  })
});

await checkText("app-js", "/app.js", (text) => {
  assert(text.includes("renderAdvancedAnalysis"), "app.js missing advanced renderer");
});

await checkText("live-page", "/live.html", (text) => {
  assert(text.includes('data-mode="live"'), "live page missing live mode marker");
  assert(text.includes("幸運6"), "live page missing special buttons");
  assert(text.includes("data-card-rank"), "live page missing card rank buttons");
});

await checkText("logic-page", "/logic.html", (text) => {
  assert(text.includes("Baijia Logic Guide"), "logic page missing title marker");
  assert(text.includes("珠盤路 / 大路 / 大眼仔 / 小路 / 蟑螂路"), "logic page missing five-road heading");
  assert(text.includes("6 欄循環"), "logic page missing six-column cycle section");
  assert(text.includes("時時刻刻復盤"), "logic page missing replay section");
});

await checkText("service-worker", "/sw.js", (text) => {
  assert(text.includes("trend-repair"), "sw.js cache version was not bumped for current trend repair");
  assert(text.includes("./logic.html"), "sw.js does not cache logic guide");
  assert(text.includes("./simulator.html") && text.includes("./simulator.js"), "sw.js does not cache advisor assets");
});

await checkText("csv-export", "/api/export/csv", (text) => {
  assert(text.startsWith("tableName,roomId,shoe,handNumber,result"), "csv export header mismatch");
});

await checkBlockedStaticPaths();

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  ok: errors.length === 0,
  errors,
  results
};

console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 2;

async function checkJson(name, path, validate, options = {}) {
  try {
    const response = await fetch(`${BASE_URL}${path}`, options);
    const text = await response.text();
    const json = JSON.parse(text);
    assert(response.ok, `${name} HTTP ${response.status}`);
    validate(json);
    results.push({ name, status: response.status, ok: true, bytes: Buffer.byteLength(text) });
  } catch (error) {
    errors.push(`${name}: ${error.message}`);
    results.push({ name, ok: false, error: error.message });
  }
}

async function checkText(name, path, validate) {
  try {
    const response = await fetch(`${BASE_URL}${path}`);
    const text = await response.text();
    assert(response.ok, `${name} HTTP ${response.status}`);
    validate(text);
    results.push({ name, status: response.status, ok: true, bytes: Buffer.byteLength(text) });
  } catch (error) {
    errors.push(`${name}: ${error.message}`);
    results.push({ name, ok: false, error: error.message });
  }
}

async function checkBlockedStaticPaths() {
  const paths = ["/package.json", "/%2e%2e/package.json", "/data/baijia-db.json", "/src/server.js"];
  for (const path of paths) {
    const name = `blocked-static:${path}`;
    try {
      const response = await fetch(`${BASE_URL}${path}`);
      const text = await response.text();
      assert(response.status >= 400, `${path} returned HTTP ${response.status}`);
      assert(!text.includes("\"private\""), `${path} leaked package metadata`);
      assert(!text.includes("\"rounds\""), `${path} leaked database-looking content`);
      assert(!text.includes("startServer"), `${path} leaked server source`);
      results.push({ name, status: response.status, ok: true, bytes: Buffer.byteLength(text) });
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
      results.push({ name, ok: false, error: error.message });
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
