"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { groupRoundSequences } = require("../src/round-sequences");

test("shoeless rounds are chronological and split when the hand counter resets", () => {
  const rounds = [
    makeRound(2, "player", "2026-01-02T10:00:00Z"),
    makeRound(1, "player", "2026-01-02T10:00:00Z"),
    makeRound(3, "banker", "2026-01-01T10:00:00Z"),
    makeRound(1, "banker", "2026-01-01T10:00:00Z"),
    makeRound(2, "banker", "2026-01-01T10:00:00Z")
  ];

  const groups = groupRoundSequences(rounds, { minimumLength: 1 });

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].rounds.map((round) => round.handNumber), [1, 2, 3]);
  assert.deepEqual(groups[0].rounds.map((round) => round.result), ["banker", "banker", "banker"]);
  assert.deepEqual(groups[1].rounds.map((round) => round.handNumber), [1, 2]);
  assert.deepEqual(groups[1].rounds.map((round) => round.result), ["player", "player"]);
  assert.equal(groups[0].inferredSession, true);
});

test("an explicit shoe keeps hand order and the latest correction once", () => {
  const rounds = [
    { ...makeRound(1, "banker", "2026-01-01T10:00:00Z"), shoe: "S100" },
    { ...makeRound(2, "player", "2026-01-01T10:00:00Z"), shoe: "S100" },
    { ...makeRound(1, "player", "2026-01-01T10:02:00Z"), id: "correction", shoe: "S100" }
  ];

  const groups = groupRoundSequences(rounds, { minimumLength: 1 });

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rounds.map((round) => round.handNumber), [1, 2]);
  assert.deepEqual(groups[0].rounds.map((round) => round.result), ["player", "player"]);
  assert.equal(groups[0].inferredSession, false);
});

function makeRound(handNumber, result, observedAt) {
  return {
    id: `${observedAt}:${handNumber}`,
    tableId: "T1",
    shoe: "",
    handNumber,
    result,
    observedAt
  };
}
