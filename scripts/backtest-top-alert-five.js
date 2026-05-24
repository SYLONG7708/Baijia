const { openDatabase, getAllRounds, getStatus } = require("../src/db");
const { buildCanonicalView } = require("../src/canonical");
const { isPredictionUsable } = require("../src/analytics");
const { TARGET_TABLES } = require("../src/tables");
const { buildStreakAlerts } = require("../src/alerts");
const {
  createFastState,
  fastPredictionByModel,
  updateFastState
} = require("../src/model-selection");

function pct(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function emptyCounts() {
  return {
    total: 0,
    BANKER: 0,
    PLAYER: 0,
    TIE: 0,
    bankerPair: 0,
    playerPair: 0,
    luckySix: 0
  };
}

function ratesFromCounts(counts) {
  const total = Math.max(1, counts.total);
  return {
    BANKER: counts.BANKER / total,
    PLAYER: counts.PLAYER / total,
    TIE: counts.TIE / total
  };
}

function atLeastSample(streak, outcome, length) {
  const total = { opportunities: 0, continuations: 0 };
  for (const [key, sample] of streak.exact.entries()) {
    const [sampleOutcome, sampleLength] = String(key).split(":");
    if (sampleOutcome === outcome && Number(sampleLength || 0) >= length) {
      total.opportunities += Number(sample.opportunities || 0);
      total.continuations += Number(sample.continuations || 0);
    }
  }
  return total;
}

function streakFromState(state) {
  const outcome = state.streak.outcome || "";
  const length = Number(state.streak.length || 0);
  if (!outcome || !length) {
    return {
      outcome: "",
      length: 0,
      continuationRate: 0,
      continuationPercent: 0,
      opportunities: 0,
      continuations: 0,
      sampleType: "none"
    };
  }

  const exact = state.streak.exact.get(`${outcome}:${length}`) || { opportunities: 0, continuations: 0 };
  const sampleType = exact.opportunities >= 5 ? "exact" : "atLeast";
  const sample = sampleType === "exact" ? exact : atLeastSample(state.streak, outcome, length);
  const rate = sample.opportunities ? sample.continuations / sample.opportunities : 0;
  return {
    outcome,
    length,
    continuationRate: rate,
    continuationPercent: pct(rate),
    opportunities: sample.opportunities || 0,
    continuations: sample.continuations || 0,
    sampleType
  };
}

function tableFromState(meta, state, tableModel, activeModel) {
  const counts = {
    ...emptyCounts(),
    total: state.counts.total,
    BANKER: state.counts.BANKER,
    PLAYER: state.counts.PLAYER,
    TIE: state.counts.TIE
  };
  const modelId = tableModel?.modelId || activeModel || "commercial_blend";
  return {
    ...meta,
    total: counts.total,
    counts,
    rates: ratesFromCounts(counts),
    latestSix: state.sequence.slice(-6),
    streak: streakFromState(state),
    prediction: fastPredictionByModel(state, modelId),
    activeModel: modelId,
    tableModel: tableModel || null,
    lastRoundNo: state.lastRoundNo || 0,
    lastOutcome: state.lastOutcome || ""
  };
}

function firstAlert(states, tableModels, activeModel, minRounds) {
  const tables = [];
  for (const meta of TARGET_TABLES) {
    const state = states.get(meta.code);
    if (!state || state.counts.total < minRounds) continue;
    tables.push(tableFromState(meta, state, tableModels.get(meta.code), activeModel));
  }
  return buildStreakAlerts({ tables }, { tables: [] }, { limit: 1, minRate: 0, minSample: 0 }).alerts[0] || null;
}

function upperBoundById(rows, id) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Number(rows[mid].id || 0) <= id) low = mid + 1;
    else high = mid;
  }
  return low;
}

function evaluateWindow(tableRows, afterId, pick, maxBets) {
  let attempts = 0;
  let tiePushes = 0;
  let lastSeenId = afterId;
  const sequence = [];
  const start = upperBoundById(tableRows, afterId);
  for (let index = start; index < tableRows.length; index += 1) {
    const round = tableRows[index];
    lastSeenId = Number(round.id || lastSeenId);
    sequence.push(round.outcome);
    if (round.outcome === "TIE") {
      tiePushes += 1;
      continue;
    }
    attempts += 1;
    if (round.outcome === pick) {
      return { complete: true, hit: true, attempts, tiePushes, lastSeenId, sequence };
    }
    if (attempts >= maxBets) {
      return { complete: true, hit: false, attempts, tiePushes, lastSeenId, sequence };
    }
  }
  return { complete: false, hit: false, attempts, tiePushes, lastSeenId, sequence };
}

function flatNet(session) {
  if (!session.hit) return -5;
  const payout = session.pick === "BANKER" ? 0.95 : 1;
  return payout - (session.hitAttempt - 1);
}

function summarizeSessions(sessions) {
  const complete = sessions.filter((item) => item.complete);
  const wins = complete.filter((item) => item.hit);
  const losses = complete.filter((item) => !item.hit);
  const byAttempt = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byPick = {
    BANKER: { total: 0, wins: 0 },
    PLAYER: { total: 0, wins: 0 }
  };
  const byTable = new Map();
  let totalNet = 0;
  let totalTiePushes = 0;

  for (const item of complete) {
    totalNet += item.net;
    totalTiePushes += item.tiePushes;
    if (item.hit) byAttempt[item.hitAttempt] += 1;
    if (byPick[item.pick]) {
      byPick[item.pick].total += 1;
      if (item.hit) byPick[item.pick].wins += 1;
    }
    const table = byTable.get(item.code) || {
      code: item.code,
      category: item.category,
      total: 0,
      wins: 0,
      net: 0
    };
    table.total += 1;
    if (item.hit) table.wins += 1;
    table.net += item.net;
    byTable.set(item.code, table);
  }

  return {
    signals: sessions.length,
    complete: complete.length,
    incomplete: sessions.length - complete.length,
    wins: wins.length,
    losses: losses.length,
    hitWithin5Percent: pct(wins.length / Math.max(1, complete.length)),
    fiveLossPercent: pct(losses.length / Math.max(1, complete.length)),
    firstBetHitPercent: pct(byAttempt[1] / Math.max(1, complete.length)),
    averageNetUnits: round3(totalNet / Math.max(1, complete.length)),
    totalNetUnits: round3(totalNet),
    averageTiePushes: round3(totalTiePushes / Math.max(1, complete.length)),
    hitAttemptDistribution: Object.fromEntries(
      Object.entries(byAttempt).map(([key, value]) => [
        key,
        { count: value, percent: pct(value / Math.max(1, complete.length)) }
      ])
    ),
    byPick: Object.fromEntries(
      Object.entries(byPick).map(([key, value]) => [
        key,
        { ...value, hitWithin5Percent: pct(value.wins / Math.max(1, value.total)) }
      ])
    ),
    topTables: [...byTable.values()]
      .filter((item) => item.total >= 5)
      .map((item) => ({
        ...item,
        hitWithin5Percent: pct(item.wins / item.total),
        averageNetUnits: round3(item.net / item.total)
      }))
      .sort((left, right) => right.total - left.total || right.hitWithin5Percent - left.hitWithin5Percent)
      .slice(0, 10)
  };
}

function runBacktest(options = {}) {
  openDatabase();
  const allRounds = getAllRounds();
  const reliable = buildCanonicalView(allRounds)
    .predictionRounds
    .filter(isPredictionUsable)
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  const status = getStatus();
  const modelSelection = status.modelSelection || {};
  const activeModel = modelSelection.activeModel || "commercial_blend";
  const tableModels = new Map((modelSelection.tableModels || []).map((item) => [item.tableCode, item]));
  const tableRows = new Map();
  for (const round of reliable) {
    if (!tableRows.has(round.tableCode)) tableRows.set(round.tableCode, []);
    tableRows.get(round.tableCode).push(round);
  }

  const states = new Map(TARGET_TABLES.map((table) => [table.code, createFastState()]));
  const sessions = [];
  let blockedUntilId = 0;
  const minRounds = Number(options.minRounds || 80);
  const maxBets = Number(options.maxBets || 5);

  for (const round of reliable) {
    const state = states.get(round.tableCode);
    if (!state) continue;
    updateFastState(state, round);
    state.lastRoundNo = round.roundNo || 0;
    state.lastOutcome = round.outcome || "";

    const currentId = Number(round.id || 0);
    if (currentId <= blockedUntilId) continue;
    const alert = firstAlert(states, tableModels, activeModel, minRounds);
    if (!alert || !["BANKER", "PLAYER"].includes(alert.outcome)) continue;

    const result = evaluateWindow(tableRows.get(alert.code) || [], currentId, alert.outcome, maxBets);
    if (!result.complete) {
      sessions.push({
        complete: false,
        code: alert.code,
        category: alert.category,
        pick: alert.outcome,
        scorePercent: alert.scorePercent,
        atId: currentId
      });
      continue;
    }

    const session = {
      complete: true,
      code: alert.code,
      category: alert.category,
      pick: alert.outcome,
      scorePercent: alert.scorePercent,
      modelId: alert.modelId,
      modelBacktestAccuracyNoTie: alert.modelBacktestAccuracyNoTie,
      atId: currentId,
      hit: result.hit,
      hitAttempt: result.hit ? result.attempts : null,
      attempts: result.attempts,
      tiePushes: result.tiePushes,
      lastSeenId: result.lastSeenId,
      nextOutcomes: result.sequence
    };
    session.net = flatNet(session);
    sessions.push(session);
    blockedUntilId = result.lastSeenId;
  }

  const complete = sessions.filter((item) => item.complete);
  const output = {
    generatedAt: new Date().toISOString(),
    method: "first-ranked-alert, same table and side, up to 5 non-tie bets; ties are pushes and do not consume a bet; stop after first hit",
    source: {
      reliableRounds: reliable.length,
      activeModel,
      tableModels: tableModels.size,
      minRoundsPerTable: minRounds,
      maxBets
    },
    overall: summarizeSessions(sessions),
    recent100: summarizeSessions(complete.slice(-100)),
    recent50: summarizeSessions(complete.slice(-50)),
    last10Sessions: complete.slice(-10)
  };
  if (options.includeSessions) output.sessions = sessions;
  return output;
}

if (require.main === module) {
  const result = runBacktest({
    minRounds: process.env.MIN_ROUNDS || 80,
    maxBets: process.env.MAX_BETS || 5,
    includeSessions: process.env.INCLUDE_SESSIONS === "true"
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  runBacktest
};
