const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.BAIJIA_SMOKE_BASE_URL || `http://localhost:${PORT}`;
const EXPECTED_TARGET_TABLES = 36;
const ANALYSIS_SEQUENCE = ["banker", "player", "banker", "banker", "player", "tie", "banker", "player"];

const errors = [];
const results = [];

await checkJson("status", "/api/status", (json) => {
  assert(json.ok === true, "status ok is not true");
  assert(Number(json.allbetTables || 0) === EXPECTED_TARGET_TABLES, `status allbetTables is ${json.allbetTables}`);
  assert(Number(json.rounds || 0) > 0, "status rounds is zero");
  assert((json.collector?.runHistory || []).length <= 20, "status runHistory is not trimmed");
});

let firstAllbetTableId = "";
await checkJson("tables", "/api/tables", (json) => {
  assert(json.ok === true, "tables ok is not true");
  const allbet = (json.tables || []).filter((table) => table.provider === "allbet");
  assert(allbet.length === EXPECTED_TARGET_TABLES, `api tables allbet count is ${allbet.length}`);
  firstAllbetTableId = allbet[0]?.id || "";
  assert(Boolean(firstAllbetTableId), "no first ALLBET table id");
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
  assert(Boolean(json.roadBreakdown?.askRoad?.banker?.bigEyeRoad), "banker ask road missing");
  assert(Boolean(json.roadBreakdown?.askRoad?.player?.cockroachRoad), "player ask road missing");
  assert(Boolean(json.roadBreakdown?.overall?.highest), "roadBreakdown highest prediction missing");
}, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scope: "all", sequence: ANALYSIS_SEQUENCE })
});

await checkText("app-js", "/app.js", (text) => {
  assert(text.includes("renderAdvancedAnalysis"), "app.js missing advanced renderer");
});

await checkText("service-worker", "/sw.js", (text) => {
  assert(text.includes("road-breakdown"), "sw.js cache version was not bumped for road breakdown analysis");
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
