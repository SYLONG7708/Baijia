const { TARGET_TABLES, normalizeTableCode } = require("./tables");
const { currentShoeRounds, isPredictionUsable } = require("./analytics");
const { buildCanonicalView } = require("./canonical");

function pct(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
}

function latestByTable(rounds) {
  const latest = new Map();
  for (const round of rounds) latest.set(round.tableCode, round);
  return latest;
}

function sourceCounts(rounds) {
  const counts = {};
  for (const round of rounds) {
    const key = round.sourceEvent || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function duplicateSlots(rounds) {
  const seen = new Map();
  for (const round of rounds) {
    const roundRef = round.gameRoundId || `${round.shoeId}|${round.roundNo}`;
    const key = `${round.tableCode}|${roundRef}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(round.rawResult);
  }
  return [...seen.entries()]
    .filter(([, values]) => new Set(values).size > 1)
    .slice(0, 50)
    .map(([key, values]) => {
      const [tableCode, roundRef] = key.split("|");
      return { tableCode, roundRef, count: values.length, rawResults: values.slice(0, 8) };
    });
}

function suspiciousAliases(rounds) {
  const aliases = new Map();
  for (const round of rounds) {
    const name = String(round.tableName || "").toUpperCase();
    if (/^[A-Z]+[0-9]+$/.test(name) && name !== String(round.tableCode).toUpperCase()) {
      const key = `${round.tableCode}|${round.tableName}`;
      aliases.set(key, (aliases.get(key) || 0) + 1);
    }
  }
  return [...aliases.entries()].map(([key, count]) => {
    const [tableCode, tableName] = key.split("|");
    return { tableCode, tableName, count };
  });
}

function tableQuality(rounds) {
  const latest = latestByTable(rounds);
  return TARGET_TABLES.map((table) => {
    const tableRounds = rounds.filter((round) => round.tableCode === table.code);
    const live = tableRounds.filter(isPredictionUsable);
    const currentShoe = currentShoeRounds(live);
    const currentSlots = new Set(currentShoe.map((round) => Number(round.roundNo || 0)).filter(Boolean));
    const currentRoundNo = Math.max(0, ...currentSlots);
    const firstCurrentRoundNo = currentSlots.size ? Math.min(...currentSlots) : 0;
    const missingRoundNos = [];
    for (let roundNo = firstCurrentRoundNo; roundNo <= currentRoundNo; roundNo += 1) {
      if (!currentSlots.has(roundNo)) missingRoundNos.push(roundNo);
    }
    const cardRows = tableRounds.filter((round) => round.cardCount > 0);
    const latestRound = latest.get(table.code);
    return {
      code: table.code,
      total: tableRounds.length,
      reliable: live.length,
      currentShoeRounds: currentShoe.length,
      firstCurrentRoundNo,
      currentRoundNo,
      missingRoundNos,
      cardRows: cardRows.length,
      cardCoverage: pct(cardRows.length / Math.max(1, live.length)),
      latestRoundNo: latestRound?.roundNo || 0,
      latestAt: latestRound?.insertedAt || "",
      status: live.length >= 20 ? "OK" : live.length ? "WARMING" : "NO_LIVE_DATA"
    };
  });
}

function buildDataQuality(rounds, status = {}) {
  const canonical = buildCanonicalView(rounds);
  const reliable = rounds.filter(isPredictionUsable);
  const canonicalReliable = canonical.predictionRounds.filter(isPredictionUsable);
  const cardRows = reliable.filter((round) => round.cardCount > 0);
  const invalidRoundNo = rounds.filter((round) => Number(round.roundNo || 0) <= 0).length;
  const noRawResult = rounds.filter((round) => !round.rawResult).length;
  const tables = tableQuality(rounds);
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      rounds: rounds.length,
      reliableRounds: reliable.length,
      canonicalReliableRounds: canonicalReliable.length,
      quarantinedRounds: canonical.summary.quarantinedRounds,
      cardRows: cardRows.length,
      cardCoverage: pct(cardRows.length / Math.max(1, reliable.length)),
      invalidRoundNo,
      noRawResult
    },
    scraper: status.scraper || {},
    canonical: canonical.summary,
    sources: sourceCounts(rounds),
    duplicateSlots: duplicateSlots(reliable),
    suspiciousAliases: suspiciousAliases(rounds),
    currentShoeGaps: tables
      .filter((table) => table.missingRoundNos.length)
      .map((table) => ({
        code: table.code,
        firstCurrentRoundNo: table.firstCurrentRoundNo,
        currentRoundNo: table.currentRoundNo,
        missingRoundNos: table.missingRoundNos,
        recordedCurrentShoeRounds: table.currentShoeRounds
      })),
    tables,
    checklist: [
      "Use live result events before hall snapshots.",
      "Store provider table id, table code, game round id, round number, raw result, cards, source event, and timestamps.",
      "Reject invalid table aliases, -1/-2 placeholder results, and non-positive round numbers.",
      "Track card coverage and prediction backtests before trusting model changes.",
      "Keep old snapshot data out of prediction training unless reliable live data is unavailable."
    ]
  };
}

module.exports = {
  buildDataQuality
};
