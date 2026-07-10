"use strict";

const { wilsonLowerBound } = require("./accuracy-metrics");
const { normalizeRound } = require("./roads");

const SIDE_RESULTS = new Set(["banker", "player"]);
const DEFAULT_MAX_BETS = 5;
const DEFAULT_WINDOW_SIZE = 8;
const DEFAULT_MAX_SAMPLES = 900;
const MIN_PASS_SAMPLES = Number(process.env.BAIJIA_FIVE_STEP_MIN_SAMPLES || 48);
const MIN_PASS_COMPLETION_RATE = Number(process.env.BAIJIA_FIVE_STEP_MIN_COMPLETION_RATE || 0.96);
const MIN_PASS_WILSON_LOWER = Number(process.env.BAIJIA_FIVE_STEP_MIN_WILSON_LOWER || 0.9);
const MAX_PASS_FAILURE_RATE = Number(process.env.BAIJIA_FIVE_STEP_MAX_FAILURE_RATE || 0.035);
const MIN_PASS_SIMILARITY = Number(process.env.BAIJIA_FIVE_STEP_MIN_SIMILARITY || 0.8);
const MAX_RECENT_FAILURE_RATE = Number(process.env.BAIJIA_FIVE_STEP_MAX_RECENT_FAILURE_RATE || 0.04);
const MAX_CONSECUTIVE_FAILURES = Number(process.env.BAIJIA_FIVE_STEP_MAX_CONSECUTIVE_FAILURES || 1);
const MIN_PASS_LIFT = Number(process.env.BAIJIA_FIVE_STEP_MIN_LIFT || 0.002);
const BASE_SIDE_RATES = {
  banker: 0.5068,
  player: 0.4932
};

function buildFiveStepRisk({
  inputRounds = [],
  historyGroups = null,
  allRounds = [],
  targetResult = "",
  maxBets = DEFAULT_MAX_BETS,
  windowSize = DEFAULT_WINDOW_SIZE,
  maxSamples = DEFAULT_MAX_SAMPLES
} = {}) {
  const target = String(targetResult || "");
  if (!SIDE_RESULTS.has(target)) {
    return emptyRisk(target, "沒有可評估的莊閒方向");
  }
  const input = normalizeInput(inputRounds).slice(-Math.max(3, Number(windowSize || DEFAULT_WINDOW_SIZE)));
  if (input.length < 6) {
    return emptyRisk(target, "未滿 6 手，5 注風險樣本不足");
  }
  const groups = normalizeGroups(historyGroups, allRounds);
  const matches = collectMatches(groups, input, target, Number(maxBets || DEFAULT_MAX_BETS), Number(maxSamples || DEFAULT_MAX_SAMPLES));
  const stats = summarizeMatches(matches, target, Number(maxBets || DEFAULT_MAX_BETS));
  return {
    ok: true,
    targetResult: target,
    targetLabel: target === "banker" ? "莊" : "閒",
    maxBets: Number(maxBets || DEFAULT_MAX_BETS),
    windowSize: input.length,
    ...stats,
    action: shouldPass(stats) ? "advise" : "observe",
    read: buildRead(target, stats)
  };
}

function evaluateFiveStepOutcome(rounds = [], startIndex = 0, targetResult = "", maxBets = DEFAULT_MAX_BETS) {
  if (!SIDE_RESULTS.has(targetResult)) return { status: "invalid", step: 0 };
  let step = 0;
  for (let index = Number(startIndex || 0); index < rounds.length; index += 1) {
    const round = normalizeRound(rounds[index]);
    if (!round || !SIDE_RESULTS.has(round.result)) continue;
    if (round.result === targetResult) {
      return { status: "win", step: step + 1 };
    }
    step += 1;
    if (step >= maxBets) {
      return { status: "fail", step };
    }
  }
  return { status: "incomplete", step };
}

function collectMatches(groups, input, target, maxBets, maxSamples) {
  const output = [];
  const inputLength = input.length;
  for (const group of groups) {
    const rounds = group.rounds || [];
    if (rounds.length <= inputLength + 1) continue;
    for (let index = inputLength; index < rounds.length; index += 1) {
      const window = rounds.slice(index - inputLength, index);
      const similarity = scoreSimilarity(input, window);
      if (similarity < 0.74) continue;
      const outcome = evaluateFiveStepOutcome(rounds, index, target, maxBets);
      if (outcome.status === "incomplete" || outcome.status === "invalid") continue;
      output.push({
        similarity,
        status: outcome.status,
        step: outcome.step,
        at: rounds[index]?.observedAt || rounds[index]?.createdAt || ""
      });
    }
  }
  return output
    .sort((left, right) => {
      const timeDiff = Date.parse(right.at || 0) - Date.parse(left.at || 0);
      if (Number.isFinite(timeDiff) && timeDiff) return timeDiff;
      return right.similarity - left.similarity;
    })
    .slice(0, Math.max(20, maxSamples));
}

function summarizeMatches(matches, target, maxBets = DEFAULT_MAX_BETS) {
  const samples = matches.length;
  const completed = matches.filter((item) => item.status === "win");
  const failures = matches.filter((item) => item.status === "fail");
  const completionRate = samples ? completed.length / samples : 0;
  const failureRate = samples ? failures.length / samples : 0;
  const completionWilsonLower = wilsonLowerBound(completed.length, samples);
  const baseline = fiveStepNaturalBaseline(target, maxBets);
  const completionLift = completionRate - baseline.completionRate;
  const completionLowerLift = completionWilsonLower - baseline.completionRate;
  const failureLift = baseline.failureRate - failureRate;
  const recent = matches.slice(0, Math.min(80, samples));
  const recentCompleted = recent.filter((item) => item.status === "win");
  const recentFailures = recent.filter((item) => item.status === "fail");
  const recentFailureRate = recent.length ? recentFailures.length / recent.length : 0;
  const recentCompletionWilsonLower = wilsonLowerBound(recentCompleted.length, recent.length);
  const chronological = [...matches].sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
  const recentChronological = [...recent].sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
  const maxConsecutiveFailures = maxStatusRun(chronological, "fail");
  const recentMaxConsecutiveFailures = maxStatusRun(recentChronological, "fail");
  const stepAverage = completed.length
    ? completed.reduce((sum, item) => sum + Number(item.step || 0), 0) / completed.length
    : 0;
  const sameStep = Object.fromEntries([1, 2, 3, 4, 5].map((step) => [
    step,
    completed.filter((item) => Number(item.step || 0) === step).length
  ]));
  const similarityAverage = samples
    ? matches.reduce((sum, item) => sum + Number(item.similarity || 0), 0) / samples
    : 0;
  const score = clamp(
    scoreByLog(samples, 160) * 0.2
      + clamp((completionLowerLift - MIN_PASS_LIFT) / 0.02, 0, 1) * 0.42
      + clamp((completionLift - MIN_PASS_LIFT) / 0.02, 0, 1) * 0.18
      + clamp((MAX_RECENT_FAILURE_RATE - recentFailureRate) / MAX_RECENT_FAILURE_RATE, 0, 1) * 0.1
      + clamp((similarityAverage - MIN_PASS_SIMILARITY) / 0.12, 0, 1) * 0.1
      - clamp((recentMaxConsecutiveFailures - MAX_CONSECUTIVE_FAILURES) / 2, 0, 1) * 0.18,
    0,
    1
  );
  return {
    samples,
    completed: completed.length,
    failures: failures.length,
    completionRate: round(completionRate),
    failureRate: round(failureRate),
    completionWilsonLower: round(completionWilsonLower),
    baselineCompletionRate: round(baseline.completionRate),
    baselineFailureRate: round(baseline.failureRate),
    completionLift: round(completionLift),
    completionLowerLift: round(completionLowerLift),
    failureLift: round(failureLift),
    recentFailureRate: round(recentFailureRate),
    recentCompletionWilsonLower: round(recentCompletionWilsonLower),
    maxConsecutiveFailures,
    recentMaxConsecutiveFailures,
    averageStep: round(stepAverage, 2),
    stepWins: sameStep,
    averageSimilarity: round(similarityAverage),
    score: round(score),
    targetResult: target
  };
}

function shouldPass(stats) {
  if (Number(stats.samples || 0) < MIN_PASS_SAMPLES) return false;
  if (Number(stats.completionRate || 0) < MIN_PASS_COMPLETION_RATE) return false;
  if (Number(stats.failureRate || 0) > MAX_PASS_FAILURE_RATE) return false;
  if (Number(stats.recentFailureRate || 0) > MAX_RECENT_FAILURE_RATE) return false;
  if (Number(stats.completionWilsonLower || 0) < MIN_PASS_WILSON_LOWER) return false;
  if (Number(stats.completionLift || 0) < MIN_PASS_LIFT) return false;
  if (Number(stats.completionLowerLift || 0) < MIN_PASS_LIFT) return false;
  if (Number(stats.recentCompletionWilsonLower || 0) < MIN_PASS_WILSON_LOWER) return false;
  if (Number(stats.averageSimilarity || 0) < MIN_PASS_SIMILARITY) return false;
  if (Number(stats.maxConsecutiveFailures || 0) > MAX_CONSECUTIVE_FAILURES) return false;
  if (Number(stats.recentMaxConsecutiveFailures || 0) > MAX_CONSECUTIVE_FAILURES) return false;
  return true;
}

function scoreSimilarity(input, window) {
  const left = input.map((round) => round?.result || "");
  const right = normalizeInput(window).map((round) => round?.result || "");
  if (left.length !== right.length || left.length === 0) return 0;
  let exact = 0;
  let side = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) exact += 1;
    if (normalizeSide(left[index]) === normalizeSide(right[index])) side += 1;
  }
  const tailSize = Math.min(4, left.length);
  let tail = 0;
  for (let index = left.length - tailSize; index < left.length; index += 1) {
    if (left[index] === right[index]) tail += 1;
  }
  const streakDiff = Math.abs(currentStreak(left) - currentStreak(right));
  const alternationDiff = Math.abs(alternationRate(left) - alternationRate(right));
  return clamp(
    (exact / left.length) * 0.5
      + (side / left.length) * 0.22
      + (tail / tailSize) * 0.18
      + (1 - Math.min(1, streakDiff / 5)) * 0.05
      + (1 - Math.min(1, alternationDiff)) * 0.05,
    0,
    1
  );
}

function normalizeGroups(historyGroups, allRounds) {
  if (Array.isArray(historyGroups) && historyGroups.length) {
    return historyGroups.map((group) => ({
      ...group,
      rounds: normalizeInput(group.rounds).sort(compareRounds)
    })).filter((group) => group.rounds.length);
  }
  const groups = new Map();
  for (const round of normalizeInput(allRounds)) {
    const key = `${round.tableId || "table"}::${round.shoe || "shoe"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(round);
  }
  return [...groups.entries()].map(([key, rounds]) => ({ key, rounds: rounds.sort(compareRounds) }));
}

function normalizeInput(rounds) {
  return (Array.isArray(rounds) ? rounds : [])
    .map((round) => normalizeRound(round))
    .filter(Boolean);
}

function currentStreak(results) {
  const items = results.filter((result) => SIDE_RESULTS.has(result));
  const last = items.at(-1);
  if (!last) return 0;
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index] !== last) break;
    count += 1;
  }
  return count;
}

function alternationRate(results) {
  const items = results.filter((result) => SIDE_RESULTS.has(result));
  if (items.length < 2) return 0.5;
  let changes = 0;
  for (let index = 1; index < items.length; index += 1) {
    if (items[index] !== items[index - 1]) changes += 1;
  }
  return changes / (items.length - 1);
}

function normalizeSide(result) {
  return SIDE_RESULTS.has(result) ? result : "tie";
}

function buildRead(target, stats) {
  const label = target === "banker" ? "莊" : "閒";
  if (!stats.samples) return `5 注風險：${label} 樣本不足，先觀察。`;
  const action = shouldPass(stats) ? "通過" : "未通過";
  return `5 注風險${action}：${label} 完成率 ${formatPercent(stats.completionRate)}，自然基準 ${formatPercent(stats.baselineCompletionRate)}，超額 ${formatSignedPercent(stats.completionLift)}，保守超額 ${formatSignedPercent(stats.completionLowerLift)}，樣本 ${stats.samples}。`;
}

function emptyRisk(target, reason) {
  return {
    ok: false,
    targetResult: target,
    maxBets: DEFAULT_MAX_BETS,
    samples: 0,
    completed: 0,
    failures: 0,
    completionRate: 0,
    failureRate: 0,
    completionWilsonLower: 0,
    baselineCompletionRate: fiveStepNaturalBaseline(target, DEFAULT_MAX_BETS).completionRate,
    baselineFailureRate: fiveStepNaturalBaseline(target, DEFAULT_MAX_BETS).failureRate,
    completionLift: 0,
    completionLowerLift: 0,
    failureLift: 0,
    recentFailureRate: 0,
    recentCompletionWilsonLower: 0,
    maxConsecutiveFailures: 0,
    recentMaxConsecutiveFailures: 0,
    averageStep: 0,
    score: 0,
    action: "observe",
    read: reason
  };
}

function fiveStepNaturalBaseline(targetResult, maxBets = DEFAULT_MAX_BETS) {
  const sideRate = BASE_SIDE_RATES[targetResult] || 0.5;
  const bets = Math.max(1, Number(maxBets || DEFAULT_MAX_BETS));
  const failureRate = (1 - sideRate) ** bets;
  return {
    targetResult,
    sideRate: round(sideRate),
    maxBets: bets,
    completionRate: round(1 - failureRate),
    failureRate: round(failureRate)
  };
}

function maxStatusRun(items = [], status = "") {
  let current = 0;
  let max = 0;
  for (const item of items) {
    if (item.status === status) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function compareRounds(left, right) {
  const shoeCompare = String(left.shoe || "").localeCompare(String(right.shoe || ""));
  if (shoeCompare) return shoeCompare;
  return Number(left.handNumber || 0) - Number(right.handNumber || 0);
}

function scoreByLog(value, target) {
  const number = Math.max(0, Number(value || 0));
  return clamp(Math.log1p(number) / Math.log1p(Math.max(1, target)), 0, 1);
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function formatSignedPercent(value) {
  const number = Number(value || 0) * 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

module.exports = {
  buildFiveStepRisk,
  evaluateFiveStepOutcome,
  fiveStepNaturalBaseline
};
