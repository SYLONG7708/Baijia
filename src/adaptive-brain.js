"use strict";

const { buildFiveStepRisk } = require("./five-step-risk");

const SIDE_RESULTS = new Set(["banker", "player"]);
const RESULT_LABELS = {
  banker: "莊",
  player: "閒",
  neutral: "觀望"
};

const MIN_INPUT_LENGTH = Number(process.env.BAIJIA_BRAIN_MIN_INPUT_LENGTH || 8);
const MIN_SELECTED_RATE = Number(process.env.BAIJIA_BRAIN_MIN_SELECTED_RATE || 0.62);
const MIN_SCORE = Number(process.env.BAIJIA_BRAIN_MIN_SCORE || 0.59);
const MIN_AGREEMENT = Number(process.env.BAIJIA_BRAIN_MIN_AGREEMENT || 0.72);
const MIN_RISK_SAMPLES = Number(process.env.BAIJIA_BRAIN_MIN_RISK_SAMPLES || 12);
const MIN_RISK_WILSON = Number(process.env.BAIJIA_BRAIN_MIN_RISK_WILSON || 0.74);
const MAX_FAILURE_RATE = Number(process.env.BAIJIA_BRAIN_MAX_FAILURE_RATE || 0);
const MAX_RECENT_FAILURE_RATE = Number(process.env.BAIJIA_BRAIN_MAX_RECENT_FAILURE_RATE || 0);
const MAX_CONSECUTIVE_FAILURES = Number(process.env.BAIJIA_BRAIN_MAX_CONSECUTIVE_FAILURES || 1);
const MIN_CALIBRATION_CHECKS = Number(process.env.BAIJIA_BRAIN_MIN_CALIBRATION_CHECKS || 40);
const MIN_CALIBRATION_LOWER = Number(process.env.BAIJIA_BRAIN_MIN_CALIBRATION_LOWER || 0.5);
const MIN_CALIBRATION_SIGNAL_RATE = Number(process.env.BAIJIA_BRAIN_MIN_CALIBRATION_SIGNAL_RATE || 0.45);
const MIN_CALIBRATION_LOWER_EDGE = Number(process.env.BAIJIA_BRAIN_MIN_CALIBRATION_LOWER_EDGE || -0.02);
const MIN_CALIBRATION_ROI_LOWER = Number(process.env.BAIJIA_BRAIN_MIN_CALIBRATION_ROI_LOWER || 0);
const DEFAULT_MAX_SAMPLES = Number(process.env.BAIJIA_BRAIN_FIVE_STEP_MAX_SAMPLES || 720);
const PRECISION_MIN_RECENT_RISK_WILSON = Number(process.env.BAIJIA_BRAIN_PRECISION_MIN_RECENT_RISK_WILSON || 0.86);
const ENABLE_STABLE_PROFILE = envFlag("BAIJIA_BRAIN_ENABLE_STABLE", true);
const ENABLE_BALANCED_PROFILE = envFlag("BAIJIA_BRAIN_ENABLE_BALANCED", false);
const BORDERLINE_MAX_WEAK_SAMPLES = Number(process.env.BAIJIA_BRAIN_BORDERLINE_MAX_WEAK_SAMPLES || 32);
const BORDERLINE_MIN_SIMILARITY = Number(process.env.BAIJIA_BRAIN_BORDERLINE_MIN_SIMILARITY || 0.78);
const BORDERLINE_MAX_AVERAGE_STEP = Number(process.env.BAIJIA_BRAIN_BORDERLINE_MAX_AVERAGE_STEP || 1.9);
const STABLE_MIN_SCORE = Number(process.env.BAIJIA_BRAIN_STABLE_MIN_SCORE || 0.59);
const STABLE_MIN_AGREEMENT = Number(process.env.BAIJIA_BRAIN_STABLE_MIN_AGREEMENT || 0.5);
const STABLE_MIN_SELECTED_RATE = Number(process.env.BAIJIA_BRAIN_STABLE_MIN_SELECTED_RATE || 0.5);
const STABLE_MIN_RISK_SAMPLES = Number(process.env.BAIJIA_BRAIN_STABLE_MIN_RISK_SAMPLES || 12);
const STABLE_MIN_RISK_WILSON = Number(process.env.BAIJIA_BRAIN_STABLE_MIN_RISK_WILSON || 0.74);
const STABLE_MIN_RECENT_RISK_WILSON = Number(process.env.BAIJIA_BRAIN_STABLE_MIN_RECENT_RISK_WILSON || 0.86);
const BALANCED_MIN_SCORE = Number(process.env.BAIJIA_BRAIN_BALANCED_MIN_SCORE || 0.58);
const BALANCED_MIN_AGREEMENT = Number(process.env.BAIJIA_BRAIN_BALANCED_MIN_AGREEMENT || 0.62);
const BALANCED_MIN_SELECTED_RATE = Number(process.env.BAIJIA_BRAIN_BALANCED_MIN_SELECTED_RATE || 0.58);
const BALANCED_MIN_RISK_SAMPLES = Number(process.env.BAIJIA_BRAIN_BALANCED_MIN_RISK_SAMPLES || 24);
const BALANCED_MIN_RISK_WILSON = Number(process.env.BAIJIA_BRAIN_BALANCED_MIN_RISK_WILSON || 0.82);
const BALANCED_MIN_RECENT_RISK_WILSON = Number(process.env.BAIJIA_BRAIN_BALANCED_MIN_RECENT_RISK_WILSON || 0.82);

function buildAdaptiveBrain({
  analysis = {},
  inputRounds = [],
  historyGroups = null,
  allRounds = [],
  calibration = null,
  maxSamples = DEFAULT_MAX_SAMPLES
} = {}) {
  const candidates = collectCandidates(analysis);
  const votes = buildVotes(candidates);
  const inputLength = Number(analysis.input?.manualLength || analysis.input?.length || (Array.isArray(inputRounds) ? inputRounds.length : 0));
  const riskByResult = Object.fromEntries([...SIDE_RESULTS].map((side) => [
    side,
    buildFiveStepRisk({
      inputRounds,
      historyGroups,
      allRounds,
      targetResult: side,
      maxBets: 5,
      windowSize: 8,
      maxSamples
    })
  ]));

  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, { votes, riskByResult, calibration }))
    .sort((left, right) => right.score - left.score);
  const profiles = buildBrainProfiles();
  const approval = selectApprovedCandidate(scored, inputLength, profiles);
  const selected = approval?.candidate || scored[0] || null;
  const selectedProfile = approval?.profile || null;
  const guards = approval ? [] : buildGuards({ selected, inputLength, profile: profiles[0] });
  const action = approval ? "advise" : "observe";
  const riskSummary = buildRiskSummaryMap(riskByResult, selected, action, selectedProfile);

  return {
    ok: true,
    source: "adaptive-strategy-brain",
    action,
    result: action === "advise" ? selected.result : "neutral",
    label: action === "advise" ? RESULT_LABELS[selected.result] : RESULT_LABELS.neutral,
    inputLength,
    score: round(selected?.score || 0),
    agreement: round(selected?.agreement || 0),
    profile: selectedProfile ? summarizeProfile(selectedProfile) : null,
    profiles: buildProfileSummaries(scored, inputLength, profiles),
    selected: selected ? summarizeCandidate(selected, action === "advise", selectedProfile) : null,
    candidates: scored.slice(0, 10).map(summarizeCandidate),
    riskByResult: riskSummary,
    votes: {
      banker: round(votes.banker),
      player: round(votes.player)
    },
    guards,
    strategyChange: buildStrategyChange(analysis, selected, action),
    read: buildRead(action, selected, guards, selectedProfile)
  };
}

function buildRiskSummaryMap(riskByResult = {}, selected = null, action = "observe", profile = null) {
  return Object.fromEntries(Object.entries(riskByResult).map(([key, risk]) => {
    const summary = summarizeRisk(risk);
    if (action === "advise" && selected?.result === key) {
      return [key, {
        ...summary,
        action: "advise",
        adaptivePass: true,
        adaptiveGate: profile?.key ? `multi-strategy-five-step:${profile.key}` : "multi-strategy-five-step",
        profile: profile ? summarizeProfile(profile) : null
      }];
    }
    return [key, {
      ...summary,
      adaptivePass: false
    }];
  }));
}

function collectCandidates(analysis = {}) {
  const overall = analysis.roadBreakdown?.overall || {};
  const records = Array.isArray(analysis.roadBreakdown?.records) ? analysis.roadBreakdown.records : [];
  const advanced = analysis.advanced?.synthesis || {};
  const ensemble = analysis.ensembleBrain || null;
  const output = [];

  if (SIDE_RESULTS.has(ensemble?.directional?.result)) {
    addCandidate(output, {
      ...ensemble.directional,
      rate: ensemble.directional.rate,
      basis: ensemble.read || "無洩漏線上集成",
      validationApproved: Boolean(ensemble.validation?.approved),
      modelValidation: ensemble.validation || null,
      expectedValue: ensemble.directional.expectedValue,
      conservativeExpectedValue: ensemble.directional.conservativeExpectedValue
    }, {
      key: "onlineEnsemble",
      label: "線上多專家集成",
      weight: ensemble.validation?.approved ? 1.48 : 0.72,
      calibrationKey: "onlineEnsemble"
    });
  }

  addCandidate(output, sideNormalizedPrediction(analysis.nextResult, analysis.resultRates), {
    key: "mainNextResult",
    label: "歷史樣本",
    weight: 0.86,
    calibrationKey: "mainNextResult"
  });
  addCandidate(output, overall.recommended, {
    key: "evidenceWeighted",
    label: "證據加權",
    weight: 1.16,
    calibrationKey: "evidenceWeighted"
  });
  addCandidate(output, overall.highest, {
    key: "advancedHighestRoad",
    label: "最高路",
    weight: 0.92,
    calibrationKey: "advancedHighestRoad"
  });
  addCandidate(output, overall.consensus, {
    key: "fiveRoadConsensus",
    label: "五路統整",
    weight: 1.02,
    calibrationKey: "fiveRoadConsensus"
  });
  addCandidate(output, overall.preferred, {
    key: "currentPreferred",
    label: "目前主策略",
    weight: 0.98,
    calibrationKey: calibrationKeyFromPreferred(overall.preferred)
  });

  if (SIDE_RESULTS.has(advanced.direction)) {
    addCandidate(output, {
      result: advanced.direction,
      label: RESULT_LABELS[advanced.direction],
      rate: 0.5 + Math.abs(Number(advanced.score || 0)) * 0.42,
      basis: advanced.read || ""
    }, {
      key: "advancedSignal",
      label: "進階交叉",
      weight: 0.72
    });
  }

  for (const record of records) {
    addCandidate(output, record, {
      key: `road:${record.roadKey || record.roadLabel || output.length}`,
      label: record.roadLabel || "單路",
      weight: 0.78,
      roadKey: record.roadKey || "",
      evidenceScore: Number(record.evidenceScore || 0),
      replayChecked: Number(record.replayChecked || 0),
      replayHitRate: Number(record.replayHitRate || 0.5)
    });
    addCandidate(output, {
      result: record.manualCycleResult,
      label: record.manualCycleLabel,
      rate: record.manualCycleRate,
      basis: record.manualCycleRead || ""
    }, {
      key: `manual-cycle:${record.roadKey || record.roadLabel || output.length}`,
      label: `${record.roadLabel || "單路"}6欄`,
      weight: 0.68,
      roadKey: record.roadKey || "",
      manualCycle: true,
      evidenceScore: Number(record.evidenceScore || 0) * 0.8,
      replayChecked: Number(record.replayChecked || 0),
      replayHitRate: Number(record.replayHitRate || 0.5)
    });
  }

  const seen = new Set();
  return output.filter((candidate) => {
    if (!SIDE_RESULTS.has(candidate.result)) return false;
    if (seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    return true;
  });
}

function addCandidate(target, item, options = {}) {
  const result = item?.result || item?.key;
  if (!SIDE_RESULTS.has(result)) return;
  const rate = clamp(Number(item.rate || 0.5), 0, 0.95);
  target.push({
    key: options.key || item.key || `candidate-${target.length}`,
    label: options.label || item.label || RESULT_LABELS[result],
    result,
    resultLabel: item.label || RESULT_LABELS[result],
    rate,
    rawRate: Number.isFinite(Number(item.rawRate)) ? Number(item.rawRate) : rate,
    weight: Number(options.weight || 1),
    calibrationKey: options.calibrationKey || "",
    roadKey: options.roadKey || item.roadKey || "",
    manualCycle: Boolean(options.manualCycle),
    evidenceScore: Number(options.evidenceScore ?? item.evidenceScore ?? 0),
    replayChecked: Number(options.replayChecked ?? item.replayChecked ?? 0),
    replayHitRate: Number(options.replayHitRate ?? item.replayHitRate ?? 0.5),
    validationApproved: Boolean(item.validationApproved),
    modelValidation: item.modelValidation || null,
    expectedValue: Number(item.expectedValue || 0),
    conservativeExpectedValue: Number(item.conservativeExpectedValue || 0),
    basis: item.basis || item.read || item.roadLabel || item.strategy || ""
  });
}

function scoreCandidate(candidate, { votes, riskByResult, calibration }) {
  const risk = riskByResult[candidate.result] || null;
  const stat = calibrationForCandidate(calibration, candidate);
  const voteTotal = Math.max(0.0001, Number(votes.banker || 0) + Number(votes.player || 0));
  const agreement = clamp(Number(votes[candidate.result] || 0) / voteTotal, 0, 1);
  const edgeScore = clamp((Number(candidate.rate || 0.5) - 0.5) / 0.16, 0, 1);
  const riskScore = scoreRisk(risk);
  const calibrationScore = scoreCalibration(stat);
  const evidenceScore = clamp(
    Number(candidate.evidenceScore || 0) * 0.55
      + scoreByLog(Number(candidate.replayChecked || 0), 48) * 0.25
      + clamp((Number(candidate.replayHitRate || 0.5) - 0.48) / 0.12, 0, 1) * 0.2,
    0,
    1
  );
  const economicScore = clamp((Number(candidate.expectedValue || 0) + 0.03) / 0.09, 0, 1);
  const validationScore = candidate.key === "onlineEnsemble"
    ? candidate.validationApproved
      ? 1
      : clamp((Number(candidate.modelValidation?.pairedBrierLift || 0) + 0.004) / 0.012, 0, 0.55)
    : 0.5;
  const consecutivePenalty = clamp((Number(risk?.recentMaxConsecutiveFailures || risk?.maxConsecutiveFailures || 0) - MAX_CONSECUTIVE_FAILURES) / 2, 0, 1) * 0.24;
  const validationPenalty = candidate.key === "onlineEnsemble" && !candidate.validationApproved ? 0.12 : 0;
  const score = clamp(
    calibrationScore * 0.24
      + riskScore * 0.24
      + edgeScore * 0.13
      + agreement * 0.11
      + evidenceScore * 0.08
      + economicScore * 0.1
      + validationScore * 0.1
      - consecutivePenalty
      - validationPenalty,
    0,
    1
  );
  return {
    ...candidate,
    score: round(score),
    agreement: round(agreement),
    risk,
    calibration: stat,
    parts: {
      edge: round(edgeScore),
      risk: round(riskScore),
      calibration: round(calibrationScore),
      agreement: round(agreement),
      evidence: round(evidenceScore),
      economics: round(economicScore),
      validation: round(validationScore),
      consecutivePenalty: round(consecutivePenalty)
    }
  };
}

function buildBrainProfiles() {
  const profiles = [{
    key: "precision-zero-loss",
    label: "precision-zero-loss",
    tier: "precision",
    minInputLength: MIN_INPUT_LENGTH,
    minSelectedRate: MIN_SELECTED_RATE,
    minScore: MIN_SCORE,
    minAgreement: MIN_AGREEMENT,
    minRiskSamples: MIN_RISK_SAMPLES,
    minRiskWilson: MIN_RISK_WILSON,
    minRecentRiskWilson: PRECISION_MIN_RECENT_RISK_WILSON,
    maxFailureRate: MAX_FAILURE_RATE,
    maxRecentFailureRate: MAX_RECENT_FAILURE_RATE,
    maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    minCalibrationChecks: MIN_CALIBRATION_CHECKS,
    minCalibrationLower: MIN_CALIBRATION_LOWER,
    minCalibrationSignalRate: MIN_CALIBRATION_SIGNAL_RATE,
    minCalibrationLowerEdge: MIN_CALIBRATION_LOWER_EDGE
  }];

  if (ENABLE_STABLE_PROFILE) {
    profiles.push({
      key: "stable-zero-loss",
      label: "stable-zero-loss",
      tier: "stable",
      minInputLength: MIN_INPUT_LENGTH,
      minSelectedRate: STABLE_MIN_SELECTED_RATE,
      minScore: STABLE_MIN_SCORE,
      minAgreement: STABLE_MIN_AGREEMENT,
      minRiskSamples: STABLE_MIN_RISK_SAMPLES,
      minRiskWilson: STABLE_MIN_RISK_WILSON,
      minRecentRiskWilson: STABLE_MIN_RECENT_RISK_WILSON,
      maxFailureRate: 0,
      maxRecentFailureRate: 0,
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      minCalibrationChecks: MIN_CALIBRATION_CHECKS,
      minCalibrationLower: MIN_CALIBRATION_LOWER,
      minCalibrationSignalRate: MIN_CALIBRATION_SIGNAL_RATE,
      minCalibrationLowerEdge: MIN_CALIBRATION_LOWER_EDGE
    });
  }

  if (ENABLE_BALANCED_PROFILE) {
    profiles.push({
      key: "balanced-controlled",
      label: "balanced-controlled",
      tier: "balanced",
      minInputLength: MIN_INPUT_LENGTH,
      minSelectedRate: BALANCED_MIN_SELECTED_RATE,
      minScore: BALANCED_MIN_SCORE,
      minAgreement: BALANCED_MIN_AGREEMENT,
      minRiskSamples: BALANCED_MIN_RISK_SAMPLES,
      minRiskWilson: BALANCED_MIN_RISK_WILSON,
      minRecentRiskWilson: BALANCED_MIN_RECENT_RISK_WILSON,
      maxFailureRate: 0,
      maxRecentFailureRate: 0,
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      minCalibrationChecks: MIN_CALIBRATION_CHECKS,
      minCalibrationLower: MIN_CALIBRATION_LOWER,
      minCalibrationSignalRate: MIN_CALIBRATION_SIGNAL_RATE,
      minCalibrationLowerEdge: MIN_CALIBRATION_LOWER_EDGE
    });
  }

  return profiles;
}

function selectApprovedCandidate(scored = [], inputLength = 0, profiles = []) {
  for (const profile of profiles) {
    const candidate = scored.find((item) => buildGuards({ selected: item, inputLength, profile }).length === 0);
    if (candidate) return { candidate, profile };
  }
  return null;
}

function buildProfileSummaries(scored = [], inputLength = 0, profiles = []) {
  return profiles.map((profile) => {
    const approved = scored.filter((item) => buildGuards({ selected: item, inputLength, profile }).length === 0);
    return {
      ...summarizeProfile(profile),
      passed: approved.length,
      topCandidate: approved[0] ? summarizeCandidate(approved[0]) : null
    };
  });
}

function buildVotes(candidates = []) {
  const votes = { banker: 0, player: 0 };
  for (const candidate of candidates) {
    if (!SIDE_RESULTS.has(candidate.result)) continue;
    const edge = clamp(Number(candidate.rate || 0.5) - 0.5, 0, 0.45);
    votes[candidate.result] += (edge + 0.01) * clamp(Number(candidate.weight || 1), 0.1, 1.6);
  }
  return votes;
}

function buildGuards({ selected, inputLength, profile = null }) {
  const guards = [];
  const minInputLength = Number(profile?.minInputLength ?? MIN_INPUT_LENGTH);
  const minSelectedRate = Number(profile?.minSelectedRate ?? MIN_SELECTED_RATE);
  const minScore = Number(profile?.minScore ?? MIN_SCORE);
  const minAgreement = Number(profile?.minAgreement ?? MIN_AGREEMENT);
  const minRiskSamples = Number(profile?.minRiskSamples ?? MIN_RISK_SAMPLES);
  const minRiskWilson = Number(profile?.minRiskWilson ?? MIN_RISK_WILSON);
  const minRecentRiskWilson = Number(profile?.minRecentRiskWilson ?? minRiskWilson);
  const maxFailureRate = Number(profile?.maxFailureRate ?? MAX_FAILURE_RATE);
  const maxRecentFailureRate = Number(profile?.maxRecentFailureRate ?? MAX_RECENT_FAILURE_RATE);
  const maxConsecutiveFailures = Number(profile?.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES);
  const minCalibrationChecks = Number(profile?.minCalibrationChecks ?? MIN_CALIBRATION_CHECKS);
  const minCalibrationLower = Number(profile?.minCalibrationLower ?? MIN_CALIBRATION_LOWER);
  const minCalibrationSignalRate = Number(profile?.minCalibrationSignalRate ?? MIN_CALIBRATION_SIGNAL_RATE);
  const minCalibrationLowerEdge = Number(profile?.minCalibrationLowerEdge ?? MIN_CALIBRATION_LOWER_EDGE);

  if (inputLength < minInputLength) guards.push(`輸入未滿 ${minInputLength} 局`);
  if (!selected) {
    guards.push("沒有可用候選策略");
    return guards;
  }
  if (Number(selected.rate || 0) < minSelectedRate) guards.push("方向優勢不足");
  if (Number(selected.score || 0) < minScore) guards.push("策略腦分數不足");
  if (Number(selected.agreement || 0) < minAgreement) guards.push("多策略方向分歧");

  const risk = selected.risk || {};
  if (risk.action !== "advise") guards.push("五注未證明超越自然基準");
  if (Number(risk.samples || 0) < minRiskSamples) guards.push("五注相似樣本不足");
  if (Number(risk.completionWilsonLower || 0) < minRiskWilson) guards.push("五注保守完成下限不足");
  if (Number(risk.recentCompletionWilsonLower || 0) < minRecentRiskWilson) guards.push("近期五注保守下限不足");
  if (Number(risk.failureRate || 0) > maxFailureRate) guards.push("五注失敗率偏高");
  if (Number(risk.recentFailureRate || 0) > maxRecentFailureRate) guards.push("近期五注失敗率偏高");
  if (Number(risk.maxConsecutiveFailures || 0) > maxConsecutiveFailures) guards.push("歷史出現連續五注失敗");
  if (Number(risk.recentMaxConsecutiveFailures || 0) > maxConsecutiveFailures) guards.push("近期出現連續五注失敗");
  if (
    Number(risk.samples || 0) <= BORDERLINE_MAX_WEAK_SAMPLES
    && (
      Number(risk.averageSimilarity || 0) < BORDERLINE_MIN_SIMILARITY
      || Number(risk.averageStep || 0) > BORDERLINE_MAX_AVERAGE_STEP
    )
  ) {
    guards.push("低樣本五注型態不穩");
  }

  const stat = selected.calibration || null;
  if (selected.key === "onlineEnsemble") {
    if (!selected.validationApproved) guards.push("線上集成尚未通過逐局樣本外驗證");
    if (Number(selected.conservativeExpectedValue || 0) <= 0) guards.push("含莊佣金的保守期望值未轉正");
  }
  if (stat && Number(stat.nonTieChecked || 0) >= minCalibrationChecks) {
    if (Number(stat.nonTieWilsonLower || 0) < minCalibrationLower) guards.push("校準保守下限未達 50%");
    if (Number(stat.signalRate || 0) < minCalibrationSignalRate) guards.push("校準有效出手率不足");
    if (Number(stat.lowerEdgeVsBaseline || 0) < minCalibrationLowerEdge) guards.push("校準低於基準過多");
    if (Number(stat.roiLower95 || 0) <= MIN_CALIBRATION_ROI_LOWER) guards.push("平注 ROI 保守下限未轉正");
  }
  return guards;
}

function scoreRisk(risk = {}) {
  const samples = Number(risk.samples || 0);
  if (!samples) return 0;
  const failureScore = scoreFailureMargin(Number(risk.failureRate || 0), MAX_FAILURE_RATE);
  const recentFailureScore = scoreFailureMargin(Number(risk.recentFailureRate || 0), MAX_RECENT_FAILURE_RATE);
  return clamp(
    scoreByLog(samples, 180) * 0.15
      + clamp((Number(risk.completionLowerLift || 0) - 0.002) / 0.02, 0, 1) * 0.3
      + clamp((Number(risk.completionLift || 0) - 0.002) / 0.02, 0, 1) * 0.2
      + failureScore * 0.18
      + recentFailureScore * 0.12
      + clamp((Number(risk.averageSimilarity || 0) - 0.78) / 0.14, 0, 1) * 0.05,
    0,
    1
  );
}

function scoreFailureMargin(failureRate, maxFailureRate) {
  const failure = Number(failureRate || 0);
  const max = Number(maxFailureRate || 0);
  if (max <= 0) return failure <= 0 ? 1 : 0;
  return clamp((max - failure) / max, 0, 1);
}

function scoreCalibration(stat = null) {
  if (!stat) return 0.32;
  return clamp(
    scoreByLog(Number(stat.nonTieChecked || 0), 900) * 0.16
      + clamp((Number(stat.nonTieWilsonLower || 0) - 0.485) / 0.06, 0, 1) * 0.36
      + clamp((Number(stat.lowerEdgeVsBaseline || 0) + 0.025) / 0.055, 0, 1) * 0.18
      + clamp(Number(stat.signalRate || 0), 0, 1) * 0.08
      + clamp((Number(stat.fiveStepWilsonLower || 0) - 0.9) / 0.08, 0, 1) * 0.14
      + clamp((Number(stat.roiLower95 || 0) + 0.08) / 0.16, 0, 1) * 0.08,
    0,
    1
  );
}

function calibrationForCandidate(calibration = null, candidate = {}) {
  if (!calibration) return null;
  const strategies = calibration.strategies || {};
  if (candidate.calibrationKey && strategies[candidate.calibrationKey]) {
    return { key: candidate.calibrationKey, ...strategies[candidate.calibrationKey] };
  }
  if (candidate.key === "currentPreferred" && strategies.instantVerifiedCurrent) {
    return { key: "instantVerifiedCurrent", ...strategies.instantVerifiedCurrent };
  }
  if (candidate.key.startsWith("road:") && calibration.bestRoad?.key && calibration.bestRoad.key === candidate.roadKey) {
    return { key: `road:${candidate.roadKey}`, ...calibration.bestRoad };
  }
  if (candidate.key.startsWith("manual-cycle:") && calibration.bestManualCycle?.key && calibration.bestManualCycle.key === candidate.roadKey) {
    return { key: `manual-cycle:${candidate.roadKey}`, ...calibration.bestManualCycle };
  }
  return null;
}

function sideNormalizedPrediction(item, resultRates = []) {
  const result = item?.result || item?.key;
  if (!SIDE_RESULTS.has(result)) return item;
  const rates = new Map((Array.isArray(resultRates) ? resultRates : []).map((rate) => [rate.result || rate.key, Number(rate.rate || 0)]));
  const banker = rates.get("banker") || 0;
  const player = rates.get("player") || 0;
  const total = banker + player;
  if (total <= 0 || !Number.isFinite(rates.get(result))) return item;
  return {
    ...item,
    rawRate: Number(item.rate || 0),
    rate: clamp(rates.get(result) / total, 0, 0.95)
  };
}

function calibrationKeyFromPreferred(preferred = {}) {
  const strategy = String(preferred?.strategy || "");
  if (strategy.includes("evidenceWeighted") || strategy.includes("evidence-weighted")) return "evidenceWeighted";
  if (strategy.includes("advancedHighestRoad") || strategy.includes("highest-road")) return "advancedHighestRoad";
  if (strategy.includes("fiveRoadConsensus") || strategy.includes("five-road-consensus")) return "fiveRoadConsensus";
  if (strategy.includes("mainNextResult")) return "mainNextResult";
  if (strategy.includes("instantVerifiedCurrent")) return "instantVerifiedCurrent";
  return "";
}

function buildStrategyChange(analysis, selected, action) {
  const current = analysis.roadBreakdown?.overall?.preferred || null;
  const currentKey = calibrationKeyFromPreferred(current) || current?.strategy || current?.roadKey || "";
  const selectedKey = selected?.calibrationKey || selected?.key || "";
  return {
    changed: action === "advise" && Boolean(currentKey && selectedKey && currentKey !== selectedKey),
    from: currentKey || "",
    to: action === "advise" ? selectedKey : "",
    reason: action === "advise" ? "adaptive-score-and-risk-gate" : "observe-until-quality-gate-passes"
  };
}

function buildRead(action, selected, guards = [], profile = null) {
  if (action !== "advise" || !selected) {
    return `自適應策略腦：觀望。${guards.slice(0, 4).join("、") || "等待更高品質訊號"}。`;
  }
  const profileLabel = profile?.label ? `，層級 ${profile.label}` : "";
  return `自適應策略腦：採用 ${selected.label}${profileLabel}，方向 ${RESULT_LABELS[selected.result]}，分數 ${formatPercent(selected.score)}，五注失敗率 ${formatPercent(selected.risk?.failureRate || 0)}。`;
}

function summarizeCandidate(candidate = {}, adaptivePass = false, profile = null) {
  return {
    key: candidate.key,
    label: candidate.label,
    result: candidate.result,
    resultLabel: RESULT_LABELS[candidate.result] || candidate.resultLabel || "",
    rate: round(candidate.rate),
    score: round(candidate.score),
    agreement: round(candidate.agreement),
    calibrationKey: candidate.calibration?.key || candidate.calibrationKey || "",
    calibrationLower: round(candidate.calibration?.nonTieWilsonLower || 0),
    lowerEdgeVsBaseline: round(candidate.calibration?.lowerEdgeVsBaseline || 0),
    roi: round(candidate.calibration?.roi || candidate.expectedValue || 0),
    roiLower95: round(candidate.calibration?.roiLower95 || candidate.conservativeExpectedValue || 0),
    validationApproved: Boolean(candidate.validationApproved),
    modelValidation: candidate.modelValidation ? {
      checks: Number(candidate.modelValidation.checks || 0),
      brierSkill: round(candidate.modelValidation.brierSkill || 0, 6),
      pairedBrierLift: round(candidate.modelValidation.pairedBrierLift || 0, 6),
      pairedBrierLiftLower: round(candidate.modelValidation.pairedBrierLiftLower || 0, 6),
      approved: Boolean(candidate.modelValidation.approved)
    } : null,
    profile: profile ? summarizeProfile(profile) : null,
    risk: {
      ...summarizeRisk(candidate.risk),
      ...(adaptivePass ? {
        action: "advise",
        adaptivePass: true,
        adaptiveGate: profile?.key ? `multi-strategy-five-step:${profile.key}` : "multi-strategy-five-step",
        profile: profile ? summarizeProfile(profile) : null
      } : {})
    },
    parts: candidate.parts || {}
  };
}

function summarizeProfile(profile = {}) {
  return {
    key: profile.key || "",
    label: profile.label || profile.key || "",
    tier: profile.tier || "",
    minScore: round(profile.minScore || 0),
    minAgreement: round(profile.minAgreement || 0),
    minSelectedRate: round(profile.minSelectedRate || 0),
    minRiskSamples: Number(profile.minRiskSamples || 0),
    minRiskWilson: round(profile.minRiskWilson || 0),
    minRecentRiskWilson: round(profile.minRecentRiskWilson || 0),
    maxFailureRate: round(profile.maxFailureRate || 0),
    maxRecentFailureRate: round(profile.maxRecentFailureRate || 0)
  };
}

function summarizeRisk(risk = {}) {
  return {
    action: risk.action || "observe",
    targetResult: risk.targetResult || "",
    samples: Number(risk.samples || 0),
    completed: Number(risk.completed || 0),
    failures: Number(risk.failures || 0),
    completionRate: round(risk.completionRate || 0),
    completionWilsonLower: round(risk.completionWilsonLower || 0),
    recentCompletionWilsonLower: round(risk.recentCompletionWilsonLower || 0),
    failureRate: round(risk.failureRate || 0),
    recentFailureRate: round(risk.recentFailureRate || 0),
    maxConsecutiveFailures: Number(risk.maxConsecutiveFailures || 0),
    recentMaxConsecutiveFailures: Number(risk.recentMaxConsecutiveFailures || 0),
    averageStep: Number(risk.averageStep || 0),
    averageSimilarity: round(risk.averageSimilarity || 0),
    baselineCompletionRate: round(risk.baselineCompletionRate || 0),
    completionLift: round(risk.completionLift || 0),
    completionLowerLift: round(risk.completionLowerLift || 0)
  };
}

function scoreByLog(value, target) {
  const number = Math.max(0, Number(value || 0));
  return clamp(Math.log1p(number) / Math.log1p(Math.max(1, target)), 0, 1);
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
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
  buildAdaptiveBrain
};
