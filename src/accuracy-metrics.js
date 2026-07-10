"use strict";

const SIDE_KEYS = ["banker", "player"];
const DEFAULT_WILSON_Z = 1.96;
const THEORETICAL_BANKER_RATE = 0.5068;

function enrichOutcomeStat(stat, options = {}) {
  if (!stat || typeof stat !== "object") return stat;
  const z = Number(options.z || DEFAULT_WILSON_Z);
  const checked = Number(stat.checked || 0);
  const hits = Number(stat.hits || 0);
  const nonTieChecked = Number(stat.nonTieChecked || 0);
  const nonTieHits = Number(stat.nonTieHits || 0);
  const abstained = Number(stat.abstained || 0);
  const fiveStepChecked = Number(stat.fiveStepChecked || 0);
  const fiveStepWins = Number(stat.fiveStepWins || 0);
  const fiveStepFailures = Number(stat.fiveStepFailures || 0);
  const fiveStepStepSum = Number(stat.fiveStepStepSum || 0);
  const actualByResult = normalizeActualByResult(stat.actualByResult);
  const sideActualTotal = SIDE_KEYS.reduce((sum, key) => sum + Number(actualByResult[key] || 0), 0);
  const baseline = nonTieChecked ? Number(actualByResult.banker || 0) / nonTieChecked : 0;
  const probabilityChecks = Number(stat.probabilityChecks || 0);
  const netUnits = Number(stat.netUnits || 0);
  const unitSquareSum = Number(stat.unitSquareSum || 0);
  const baselineNetUnits = Number(stat.baselineNetUnits || 0);
  const baselineUnitSquareSum = Number(stat.baselineUnitSquareSum || 0);

  stat.hitRate = checked ? round(hits / checked) : 0;
  stat.nonTieHitRate = nonTieChecked ? round(nonTieHits / nonTieChecked) : 0;
  stat.hitWilsonLower = round(wilsonLowerBound(hits, checked, z));
  stat.nonTieWilsonLower = round(wilsonLowerBound(nonTieHits, nonTieChecked, z));
  stat.baselineNonTieHitRate = round(baseline);
  stat.theoreticalBankerRate = THEORETICAL_BANKER_RATE;
  stat.edgeVsBaseline = nonTieChecked ? round(stat.nonTieHitRate - baseline) : 0;
  stat.lowerEdgeVsBaseline = nonTieChecked ? round(stat.nonTieWilsonLower - baseline) : 0;
  stat.edgeVsTheoretical = nonTieChecked ? round(stat.nonTieHitRate - THEORETICAL_BANKER_RATE) : 0;
  stat.signalRate = checked + abstained ? round(checked / (checked + abstained)) : 0;
  stat.fiveStepCompletionRate = fiveStepChecked ? round(fiveStepWins / fiveStepChecked) : 0;
  stat.fiveStepFailureRate = fiveStepChecked ? round(fiveStepFailures / fiveStepChecked) : 0;
  stat.fiveStepWilsonLower = round(wilsonLowerBound(fiveStepWins, fiveStepChecked, z));
  stat.fiveStepAverageStep = fiveStepWins ? round(fiveStepStepSum / fiveStepWins, 2) : 0;
  stat.fiveStepBaselineCompletionRate = fiveStepChecked
    ? round(Number(stat.fiveStepBaselineSum || 0) / fiveStepChecked)
    : 0;
  stat.fiveStepLiftVsNatural = fiveStepChecked
    ? round(stat.fiveStepCompletionRate - stat.fiveStepBaselineCompletionRate)
    : 0;
  stat.roi = checked ? round(netUnits / checked) : 0;
  stat.resolvedRoi = nonTieChecked ? round(netUnits / nonTieChecked) : 0;
  stat.roiLower95 = round(meanLowerBound(netUnits, unitSquareSum, checked, z));
  stat.baselineBankerRoi = checked ? round(baselineNetUnits / checked) : 0;
  stat.baselineBankerRoiLower95 = round(meanLowerBound(baselineNetUnits, baselineUnitSquareSum, checked, z));
  stat.roiLiftVsBanker = checked ? round(stat.roi - stat.baselineBankerRoi) : 0;
  stat.brierScore = probabilityChecks ? round(Number(stat.brierSum || 0) / probabilityChecks, 6) : 0;
  stat.baselineBrierScore = probabilityChecks ? round(Number(stat.baselineBrierSum || 0) / probabilityChecks, 6) : 0;
  stat.brierSkill = stat.baselineBrierScore > 0
    ? round(1 - stat.brierScore / stat.baselineBrierScore, 6)
    : 0;
  stat.logLoss = probabilityChecks ? round(Number(stat.logLossSum || 0) / probabilityChecks, 6) : 0;
  stat.baselineLogLoss = probabilityChecks ? round(Number(stat.baselineLogLossSum || 0) / probabilityChecks, 6) : 0;
  stat.calibrationError = round(expectedCalibrationError(stat.calibrationBins), 6);
  stat.sideActualByResult = actualByResult;
  stat.sideActualTotal = sideActualTotal;
  stat.selectionScore = round(selectionScore(stat));
  return stat;
}

function compareOutcomeStats(left, right) {
  const scoreDiff = metricValue(right, "selectionScore") - metricValue(left, "selectionScore");
  if (Math.abs(scoreDiff) > 0.000001) return scoreDiff;
  const lowerDiff = metricValue(right, "nonTieWilsonLower") - metricValue(left, "nonTieWilsonLower");
  if (Math.abs(lowerDiff) > 0.000001) return lowerDiff;
  const edgeDiff = metricValue(right, "lowerEdgeVsBaseline") - metricValue(left, "lowerEdgeVsBaseline");
  if (Math.abs(edgeDiff) > 0.000001) return edgeDiff;
  const rateDiff = metricValue(right, "nonTieHitRate") - metricValue(left, "nonTieHitRate");
  if (Math.abs(rateDiff) > 0.000001) return rateDiff;
  return Number(right?.nonTieChecked || 0) - Number(left?.nonTieChecked || 0);
}

function selectionScore(stat = {}) {
  const lower = metricValue(stat, "nonTieWilsonLower");
  const lowerEdge = clamp(metricValue(stat, "lowerEdgeVsBaseline"), -0.08, 0.08);
  const signal = clamp(metricValue(stat, "signalRate"), 0, 1);
  const sample = scoreByLog(Number(stat.nonTieChecked || 0), 1600);
  const roiLower = clamp(metricValue(stat, "roiLower95"), -0.25, 0.25);
  const roiLift = clamp(metricValue(stat, "roiLiftVsBanker"), -0.15, 0.15);
  const brierSkill = clamp(metricValue(stat, "brierSkill"), -0.2, 0.2);
  const fiveStepLift = clamp(metricValue(stat, "fiveStepLiftVsNatural"), -0.05, 0.05);
  return lower
    + lowerEdge * 0.24
    + roiLower * 0.2
    + roiLift * 0.08
    + brierSkill * 0.05
    + fiveStepLift * 0.03
    + signal * 0.008
    + sample * 0.006;
}

function meanLowerBound(sum, squareSum, count, z = DEFAULT_WILSON_Z) {
  const n = Number(count || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const mean = Number(sum || 0) / n;
  if (n < 2) return mean;
  const variance = Math.max(0, (Number(squareSum || 0) - n * mean * mean) / (n - 1));
  return mean - Number(z || DEFAULT_WILSON_Z) * Math.sqrt(variance / n);
}

function expectedCalibrationError(bins = []) {
  const rows = Array.isArray(bins) ? bins : [];
  const total = rows.reduce((sum, bin) => sum + Number(bin?.count || 0), 0);
  if (!total) return 0;
  return rows.reduce((sum, bin) => {
    const count = Number(bin?.count || 0);
    if (!count) return sum;
    const predicted = Number(bin?.probabilitySum || 0) / count;
    const actual = Number(bin?.actualSum || 0) / count;
    return sum + Math.abs(predicted - actual) * count / total;
  }, 0);
}

function wilsonLowerBound(hits, total, z = DEFAULT_WILSON_Z) {
  const n = Number(total || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const successes = clamp(Number(hits || 0), 0, n);
  const p = successes / n;
  const zValue = Number.isFinite(Number(z)) && Number(z) > 0 ? Number(z) : DEFAULT_WILSON_Z;
  const z2 = zValue * zValue;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = zValue * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return clamp((center - margin) / denominator, 0, 1);
}

function normalizeActualByResult(value = {}) {
  return {
    banker: Number(value.banker || 0),
    player: Number(value.player || 0)
  };
}

function metricValue(item, key) {
  const value = Number(item?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function scoreByLog(value, target) {
  const number = Math.max(0, Number(value || 0));
  return clamp(Math.log1p(number) / Math.log1p(Math.max(1, target)), 0, 1);
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
  compareOutcomeStats,
  enrichOutcomeStat,
  meanLowerBound,
  selectionScore,
  THEORETICAL_BANKER_RATE,
  wilsonLowerBound
};
