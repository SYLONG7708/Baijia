"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDecisionProfile } = require("../src/decision-profile");

test("an unvalidated ensemble cannot overwrite a conflicting multi-road trend", () => {
  const bankerSignal = { result: "banker", label: "莊", rate: 0.72 };
  const profile = buildDecisionProfile({
    input: { length: 8 },
    dataset: { totalRounds: 1200, allRounds: 1200 },
    source: { type: "global", exactSamples: 0, fuzzySamples: 0, globalSamples: 1200 },
    nextResult: { result: "banker", label: "莊", rate: 0.58 },
    resultRates: [
      { result: "banker", rate: 0.53 },
      { result: "player", rate: 0.47 }
    ],
    roadBreakdown: {
      overall: {
        preferred: { ...bankerSignal, strategy: "five-road-consensus" },
        recommended: { ...bankerSignal, rate: 0.7, roadLabel: "大路" },
        consensus: { ...bankerSignal, rate: 0.68 },
        highest: { ...bankerSignal, rate: 0.74, roadLabel: "大路" }
      },
      records: []
    },
    advanced: { synthesis: { direction: "banker", score: 0.2, confidence: 0.6 } },
    ensembleBrain: {
      directional: { result: "player", label: "閒", rate: 0.53, expectedValue: 0.06, conservativeExpectedValue: -0.02 },
      probabilityDirection: { result: "player", label: "閒", rate: 0.53, expectedValue: 0.06, conservativeExpectedValue: -0.02 },
      economicPreference: { result: "player", label: "閒", rate: 0.53, expectedValue: 0.06, conservativeExpectedValue: -0.02 },
      economics: {
        banker: { expectedValue: -0.08, conservativeExpectedValue: -0.16 },
        player: { expectedValue: 0.06, conservativeExpectedValue: -0.02 }
      },
      validation: { approved: false, checks: 1000 },
      drift: { detected: false }
    }
  });

  assert.equal(profile.action, "observe");
  assert.equal(profile.selected.result, "banker");
  assert.equal(profile.forced.result, "banker");
  assert.equal(profile.forced.mode, "trend-composite");
  assert.equal(profile.forced.probabilityResult, "player");
  assert.equal(profile.forced.expectedValue, -0.08);
});
