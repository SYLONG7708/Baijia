const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.BAIJIA_SMOKE_BASE_URL || `http://127.0.0.1:${PORT}`;
const PATTERNS = {
  longB: "BBBBBBBB",
  longP: "PPPPPPPP",
  altBP: "BPBPBPBP",
  altPB: "PBPBPBPB",
  twoBP: "BBPPBBPP",
  twoPB: "PPBBPPBB",
  bRun: "PPBPBBBB",
  pRun: "BBPBPPPP",
  mixed1: "BBBPPBPB",
  mixed2: "PPPBBPBP",
  mixed3: "BPBBPPPB",
  mixed4: "PBPBPPBB"
};

const tablesResponse = await fetch(`${BASE_URL}/api/analysis/tables`);
assert(tablesResponse.ok, `analysis tables returned HTTP ${tablesResponse.status}`);
const tables = (await tablesResponse.json()).tables || [];
assert(tables.length > 0, "analysis table list is empty");
const table = tables[0];
const rows = [];

for (const [name, pattern] of Object.entries(PATTERNS)) {
  const sequence = [...pattern].map((token) => ({ result: token === "B" ? "banker" : "player" }));
  const response = await fetch(`${BASE_URL}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "table",
      tableId: table.id,
      tableCode: table.tableCode,
      limit: 1200,
      sequence,
      manualSequence: sequence
    })
  });
  assert(response.ok, `${name} returned HTTP ${response.status}`);
  const json = await response.json();
  const direction = json.ensembleBrain?.probabilityDirection || json.ensembleBrain?.directional;
  const forced = json.decisionProfile?.forced;
  const selected = json.decisionProfile?.selected;

  assert(["banker", "player"].includes(direction?.result), `${name} has no AI probability direction`);
  assert(Number(direction.rate || 0) >= 0.5, `${name} AI direction is below 50 percent`);
  assert(["banker", "player"].includes(forced?.result), `${name} has no composite direction`);
  assert(["banker", "player"].includes(forced?.trendResult), `${name} has no trend direction`);
  if (!forced.validationApproved && ["banker", "player"].includes(selected?.result)) {
    assert(forced.result === selected.result, `${name} unvalidated AI overwrote the voted trend`);
  }

  rows.push({
    name,
    pattern,
    forced: forced.result,
    strength: forced.rate,
    trend: forced.trendResult,
    ai: direction.result,
    aiRate: direction.rate,
    economic: json.ensembleBrain?.economicPreference?.result || "",
    mode: forced.mode
  });
}

const counts = countBy(rows, "forced");
assert(Object.keys(counts).length >= 2, `direction collapse detected: ${JSON.stringify(counts)}`);
console.table(rows);
console.log(JSON.stringify({ ok: true, table: table.tableCode, patterns: rows.length, forcedDirections: counts }, null, 2));

function countBy(rowsToCount, key) {
  return rowsToCount.reduce((countsByValue, row) => {
    countsByValue[row[key]] = (countsByValue[row[key]] || 0) + 1;
    return countsByValue;
  }, {});
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
