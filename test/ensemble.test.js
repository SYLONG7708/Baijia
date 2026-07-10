"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEnsembleBrain } = require("../src/ensemble-brain");
const { enrichOutcomeStat } = require("../src/accuracy-metrics");
const { fiveStepNaturalBaseline } = require("../src/five-step-risk");

test("five-step metric exposes the natural same-side baseline", () => {
  const banker = fiveStepNaturalBaseline("banker", 5);
  const player = fiveStepNaturalBaseline("player", 5);

  assert.equal(banker.completionRate, 0.9708);
  assert.equal(player.completionRate, 0.9666);
  assert.equal(banker.failureRate, 0.0292);
  assert.equal(player.failureRate, 0.0334);
});

test("outcome metrics compare against always-banker and include commission ROI", () => {
  const stat = {
    checked: 10,
    hits: 8,
    nonTieChecked: 10,
    nonTieHits: 8,
    abstained: 0,
    actualByResult: { banker: 2, player: 8 },
    fiveStepChecked: 0,
    fiveStepWins: 0,
    fiveStepFailures: 0,
    netUnits: 6,
    unitSquareSum: 10,
    baselineNetUnits: -6.1,
    baselineUnitSquareSum: 9.805,
    probabilityChecks: 10,
    brierSum: 1.8,
    baselineBrierSum: 2.6,
    logLossSum: 5.5,
    baselineLogLossSum: 7.1,
    calibrationBins: []
  };

  enrichOutcomeStat(stat);

  assert.equal(stat.baselineNonTieHitRate, 0.2);
  assert.equal(stat.theoreticalBankerRate, 0.5068);
  assert.equal(stat.roi, 0.6);
  assert.equal(stat.baselineBankerRoi, -0.61);
  assert.equal(stat.roiLiftVsBanker, 1.21);
  assert.ok(stat.brierSkill > 0);
});

test("online ensemble learns only by prequential prediction then update", () => {
  const startedAt = Date.parse("2026-01-01T00:00:00Z");
  const rounds = Array.from({ length: 1200 }, (_, index) => ({
    tableId: "T1",
    shoe: "S1",
    handNumber: index + 1,
    result: index % 2 === 0 ? "banker" : "player",
    observedAt: new Date(startedAt + index * 1000).toISOString()
  }));

  const result = buildEnsembleBrain({
    inputRounds: rounds.slice(-24),
    allRounds: rounds,
    tableId: "T1"
  });

  assert.equal(result.validation.method, "prequential-walk-forward");
  assert.equal(result.validation.leakageSafe, true);
  assert.equal(result.validation.checks, 1176);
  assert.equal(result.validation.approved, true);
  assert.ok(result.validation.pairedBrierLiftLower > 0);
  assert.equal(result.experts.length, 18);
  assert.ok(Math.abs(result.experts.reduce((sum, expert) => sum + expert.weight, 0) - 1) < 0.001);
  assert.equal(result.experts[0].key, "markov-1");
});

test("ensemble refuses a quality claim without validation data", () => {
  const result = buildEnsembleBrain({
    inputRounds: ["banker", "player", "banker", "player", "banker", "player", "banker", "player"]
  });

  assert.equal(result.action, "observe");
  assert.equal(result.validation.approved, false);
  assert.ok(["banker", "player"].includes(result.directional.result));
  assert.ok(result.directional.rate >= 0.5);
  assert.equal(result.directional.result, result.bankerRate >= 0.5 ? "banker" : "player");
  assert.ok(result.directional.expectedValue < 0);
});

test("probability direction is not replaced by the less-negative commission EV side", () => {
  let state = 2;
  const startedAt = Date.parse("2026-01-01T00:00:00Z");
  const rounds = Array.from({ length: 700 }, (_, index) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return {
      tableId: "T1",
      shoe: `S${Math.floor(index / 70)}`,
      handNumber: index % 70 + 1,
      result: state / 2 ** 32 < 0.5 ? "banker" : "player",
      observedAt: new Date(startedAt + index * 1000).toISOString()
    };
  });

  const result = buildEnsembleBrain({
    inputRounds: rounds.slice(-8),
    allRounds: rounds,
    tableId: "T1"
  });

  assert.ok(result.bankerRate >= 0.5 && result.bankerRate < 0.506329);
  assert.equal(result.probabilityDirection.result, "banker");
  assert.equal(result.directional.result, "banker");
  assert.equal(result.economicPreference.result, "player");
  assert.ok(result.directional.rate >= 0.5);
});
