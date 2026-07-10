"use strict";

const { wilsonLowerBound } = require("./accuracy-metrics");

const SIDE_RESULTS = new Set(["banker", "player"]);
const ADVISE_MIN_INPUT_LENGTH = Number(process.env.BAIJIA_ADVISE_MIN_INPUT_LENGTH || 8);
const ADVISE_MIN_SELECTED_RATE = Number(process.env.BAIJIA_ADVISE_MIN_SELECTED_RATE || 0.56);
const ADVISE_MIN_SCORE = Number(process.env.BAIJIA_ADVISE_MIN_SCORE || 0.62);
const ADVISE_MIN_AGREEMENT = Number(process.env.BAIJIA_ADVISE_MIN_AGREEMENT || 0.66);
const ADVISE_MIN_SAMPLE_SCORE = Number(process.env.BAIJIA_ADVISE_MIN_SAMPLE_SCORE || 0.24);
const ADVISE_MIN_EVIDENCE_SCORE = Number(process.env.BAIJIA_ADVISE_MIN_EVIDENCE_SCORE || 0.38);
const ADVISE_MIN_CALIBRATION_CHECKS = Number(process.env.BAIJIA_ADVISE_MIN_CALIBRATION_CHECKS || 40);
const ADVISE_MIN_CALIBRATION_LOWER = Number(process.env.BAIJIA_ADVISE_MIN_CALIBRATION_LOWER || 0.5);
const ADVISE_MIN_SIGNAL_RATE = Number(process.env.BAIJIA_ADVISE_MIN_SIGNAL_RATE || 0.55);
const ADVISE_MIN_LOWER_EDGE = Number(process.env.BAIJIA_ADVISE_MIN_LOWER_EDGE || -0.005);
const ADVISE_MIN_FIVE_STEP_WILSON_LOWER = Number(process.env.BAIJIA_ADVISE_MIN_FIVE_STEP_WILSON_LOWER || 0.74);
const ADVISE_MAX_FIVE_STEP_FAILURE_RATE = Number(process.env.BAIJIA_ADVISE_MAX_FIVE_STEP_FAILURE_RATE || 0);
const FORCE_PRIMARY_MIN_SCORE = Number(process.env.BAIJIA_FORCE_PRIMARY_MIN_SCORE || 0.6);
const FORCE_BANKER_RATE = Number(process.env.BAIJIA_FORCE_BANKER_RATE || 0.5068);
const RESULT_LABELS = {
  banker: "莊",
  player: "閒",
  neutral: "觀察"
};

function buildDecisionProfile(analysis = {}) {
  const candidates = collectCandidates(analysis);
  const adaptive = analysis.adaptiveBrain || null;
  const ensemble = analysis.ensembleBrain || null;
  const usableCandidates = candidates.filter((item) => SIDE_RESULTS.has(item.result));
  const votes = { banker: 0, player: 0 };

  for (const item of usableCandidates) {
    const edge = clamp(Number(item.rate || 0.5) - 0.5, 0, 0.45);
    const vote = (edge + 0.012) * clamp(Number(item.weight || 1), 0.1, 2.5) * clamp(Number(item.reliability || 0.5), 0.2, 1);
    votes[item.result] += vote;
  }

  const voteTotal = votes.banker + votes.player;
  const voteResult = voteTotal && votes.banker >= votes.player ? "banker" : voteTotal ? "player" : "neutral";
  const leadingVote = voteResult === "banker" ? votes.banker : voteResult === "player" ? votes.player : 0;
  const trailingVote = voteResult === "banker" ? votes.player : voteResult === "player" ? votes.banker : 0;
  const agreement = voteTotal ? leadingVote / voteTotal : 0;
  const selected = usableCandidates
    .filter((item) => item.result === voteResult)
    .sort((left, right) => scoreCandidate(right) - scoreCandidate(left))[0] || null;
  const sample = buildSampleProfile(analysis);
  const evidence = buildEvidenceProfile(analysis);
  const fiveStep = buildFiveStepProfile(analysis, selected?.result);
  const inputLength = Number(analysis.input?.length || 0);
  const selectedRate = clamp(Number(selected?.rate || 0.5), 0, 0.95);
  const edgeScore = clamp((selectedRate - 0.5) / 0.18, 0, 1);
  const agreementScore = clamp((agreement - 0.5) / 0.35, 0, 1);
  const conflictPenalty = voteTotal ? clamp(trailingVote / Math.max(leadingVote, 0.0001), 0, 1) * 0.16 : 0.12;
  const shortInputPenalty = inputLength >= 8 ? 0 : 0.25;
  const score = round(clamp(
    edgeScore * 0.24
      + agreementScore * 0.18
      + sample.score * 0.18
      + evidence.score * 0.17
      + fiveStep.score * 0.18
      + buildFreshnessScore(analysis) * 0.05
      - conflictPenalty
      - shortInputPenalty,
    0,
    1
  ));
  const level = score >= 0.8 ? "high" : score >= 0.64 ? "medium" : score >= 0.46 ? "low" : "wait";
  const reasons = buildReasons({ inputLength, selected, sample, evidence, fiveStep, agreement, score, level, adaptive, ensemble });
  const action = shouldAdvise({ inputLength, selected, score, agreement, sample, evidence, fiveStep, adaptive, ensemble })
    ? "advise"
    : "observe";
  const result = action === "advise" && SIDE_RESULTS.has(voteResult) ? voteResult : "neutral";
  const rate = result === "neutral"
    ? 0.5
    : round(clamp(0.5 + (selectedRate - 0.5) * (0.52 + score * 0.52), 0.5, 0.84));
  const forced = buildForcedEveryHandProfile({
    action,
    result,
    rate,
    score,
    adaptive,
    ensemble,
    selected,
    agreement
  });

  return {
    ok: true,
    source: "decision-quality-gate",
    action,
    result,
    label: RESULT_LABELS[result] || RESULT_LABELS.neutral,
    rate,
    rawRate: round(selectedRate),
    score,
    level,
    levelLabel: levelLabel(level),
    agreement: round(agreement),
    votes: {
      banker: round(votes.banker),
      player: round(votes.player)
    },
    selected: selected ? summarizeCandidate(selected) : null,
    sample,
    evidence,
    fiveStep,
    forced,
    ensemble: ensemble ? {
      action: ensemble.action || "observe",
      directional: ensemble.directional || null,
      validation: ensemble.validation || null,
      drift: ensemble.drift || null,
      regime: ensemble.regime || null,
      dominantExpert: ensemble.dominantExpert || null,
      read: ensemble.read || ""
    } : null,
    adaptive: adaptive ? {
      action: adaptive.action || "observe",
      score: round(adaptive.score || 0),
      agreement: round(adaptive.agreement || 0),
      profile: adaptive.profile || null,
      selected: adaptive.selected || null,
      guards: Array.isArray(adaptive.guards) ? adaptive.guards.slice(0, 6) : [],
      read: adaptive.read || ""
    } : null,
    candidates: usableCandidates
      .sort((left, right) => scoreCandidate(right) - scoreCandidate(left))
      .slice(0, 8)
      .map(summarizeCandidate),
    reasons,
    read: buildRead({ action, result, rate, score, level, selected, sample, evidence, fiveStep, agreement })
  };
}

function buildForcedEveryHandProfile({ action, result, rate, score, adaptive, ensemble, selected, agreement }) {
  if (action === "advise" && SIDE_RESULTS.has(result)) {
    const risk = adaptive?.riskByResult?.[result] || adaptive?.selected?.risk || null;
    return {
      action: "direction",
      mode: "quality",
      result,
      label: RESULT_LABELS[result] || result,
      rate: round(rate || 0.5),
      score: round(score || 0),
      agreement: round(agreement || 0),
      source: "quality-gate",
      qualityPassed: true,
      expectedValue: Number(ensemble?.directional?.expectedValue || 0),
      conservativeExpectedValue: Number(ensemble?.directional?.conservativeExpectedValue || 0),
      primaryResult: result,
      primaryScore: round(score || 0),
      reverseResult: oppositeResult(result),
      risk: summarizeForcedRisk(risk),
      read: "品質通過，使用原本方向。"
    };
  }

  const ensembleDirection = ensemble?.directional || null;
  const adaptiveSelected = adaptive?.selected || null;
  const primary = SIDE_RESULTS.has(ensembleDirection?.result)
    ? ensembleDirection.result
    : SIDE_RESULTS.has(adaptiveSelected?.result)
    ? adaptiveSelected.result
    : SIDE_RESULTS.has(selected?.result)
      ? selected.result
      : "banker";
  const primaryScore = Number(ensemble?.validation?.approved ? 1 : adaptiveSelected?.score ?? score ?? 0);
  const primaryRate = Number(ensembleDirection?.rate ?? adaptiveSelected?.rate ?? selected?.rate ?? 0.5);
  const usePrimary = primaryScore >= FORCE_PRIMARY_MIN_SCORE;
  const useEnsemble = SIDE_RESULTS.has(ensembleDirection?.result);
  const forcedResult = useEnsemble ? ensembleDirection.result : usePrimary ? primary : "banker";
  const forcedRisk = adaptive?.riskByResult?.[forcedResult] || (forcedResult === primary ? adaptiveSelected?.risk : null) || null;
  const forcedRate = useEnsemble
    ? Number(ensembleDirection.rate || 0.5)
    : forcedResult === "banker" && !usePrimary
    ? FORCE_BANKER_RATE
    : clamp(0.5 + (primaryRate - 0.5) * (0.35 + clamp(primaryScore, 0, 1) * 0.35), 0.505, 0.78);

  return {
    action: "direction",
    mode: useEnsemble ? "online-ensemble" : usePrimary ? "primary-score" : "banker-balance",
    result: forcedResult,
    label: RESULT_LABELS[forcedResult] || forcedResult,
    rate: round(forcedRate),
    score: round(primaryScore),
    agreement: round(agreement || adaptiveSelected?.agreement || 0),
    source: useEnsemble ? "online-ensemble-direction" : usePrimary ? "every-hand-primary" : "every-hand-banker-balance",
    qualityPassed: false,
    expectedValue: Number(ensembleDirection?.expectedValue || 0),
    conservativeExpectedValue: Number(ensembleDirection?.conservativeExpectedValue || 0),
    validationApproved: Boolean(ensemble?.validation?.approved),
    primaryResult: primary,
    primaryScore: round(primaryScore),
    reverseResult: oppositeResult(primary),
    risk: summarizeForcedRisk(forcedRisk),
    read: useEnsemble
      ? "每局方向估計：使用無洩漏線上集成；品質閘門未通過，不代表已證明優勢。"
      : usePrimary
        ? "每局方向估計：主策略分數達標，但品質閘門未通過。"
        : "每局方向估計：資料不足時使用莊方理論基準，不代表獲利訊號。"
  };
}

function summarizeForcedRisk(risk = null) {
  if (!risk) return null;
  return {
    action: risk.action || "observe",
    targetResult: risk.targetResult || "",
    samples: Number(risk.samples || 0),
    completionRate: Number(risk.completionRate || 0),
    completionWilsonLower: Number(risk.completionWilsonLower || 0),
    failureRate: Number(risk.failureRate || 0),
    baselineCompletionRate: Number(risk.baselineCompletionRate || 0),
    completionLift: Number(risk.completionLift || 0),
    completionLowerLift: Number(risk.completionLowerLift || 0),
    averageStep: Number(risk.averageStep || 0),
    read: risk.read || ""
  };
}

function oppositeResult(result) {
  return result === "banker" ? "player" : result === "player" ? "banker" : "neutral";
}

function collectCandidates(analysis) {
  const overall = analysis?.roadBreakdown?.overall || {};
  const advanced = analysis?.advanced?.synthesis || {};
  const cardTop = analysis?.cardModel?.top || null;
  const adaptive = analysis?.adaptiveBrain || null;
  const ensemble = analysis?.ensembleBrain || null;
  const candidates = [];
  if (SIDE_RESULTS.has(ensemble?.directional?.result)) {
    const validation = ensemble.validation || {};
    addCandidate(candidates, {
      ...ensemble.directional,
      basis: ensemble.read || "無洩漏線上集成"
    }, "online-ensemble", "線上多專家集成", validation.approved ? 1.55 : 0.78, validation.approved
      ? 0.92
      : clamp(0.35 + Math.max(0, Number(validation.brierSkill || 0)) * 2, 0.3, 0.58));
  }
  if (adaptive?.action === "advise" && SIDE_RESULTS.has(adaptive.selected?.result)) {
    addCandidate(candidates, {
      ...adaptive.selected,
      result: adaptive.selected.result,
      label: adaptive.selected.resultLabel,
      rate: adaptive.selected.rate,
      basis: adaptive.read || "adaptive strategy brain"
    }, "adaptive-brain", "自適應策略腦", 1.72, clamp(Number(adaptive.score || 0.72), 0.62, 0.96));
  }
  addCandidate(candidates, overall.preferred, "preferred", "主策略", 1.35, reliabilityFromOverall(overall.preferred));
  addCandidate(candidates, overall.recommended, "recommended", "證據加權", 1.22, reliabilityFromOverall(overall.recommended));
  addCandidate(candidates, overall.consensus, "consensus", "五路統整", 1.05, reliabilityFromConsensus(overall.consensus));
  addCandidate(candidates, overall.highest, "highest", "單路最高", 0.82, reliabilityFromOverall(overall.highest));
  addCandidate(candidates, withSideNormalizedRate(analysis.nextResult, analysis.resultRates), "history", "歷史相似", 0.92, reliabilityFromSource(analysis.source));

  if (SIDE_RESULTS.has(advanced.direction)) {
    addCandidate(candidates, {
      result: advanced.direction,
      label: RESULT_LABELS[advanced.direction],
      rate: 0.5 + Math.abs(Number(advanced.score || 0)) * 0.42,
      basis: advanced.read || "進階交叉分析"
    }, "advanced", "進階交叉", 0.66, clamp(Number(advanced.confidence || 0.5), 0.2, 0.82));
  }

  if (analysis.cardModel?.usable && SIDE_RESULTS.has(cardTop?.result)) {
    const seenCards = Number(analysis.cardModel.seenCards || 0);
    addCandidate(candidates, cardTop, "card-model", "8副牌點數", 0.42, clamp(0.32 + Math.min(seenCards, 80) / 200, 0.25, 0.72));
  }

  return candidates;
}

function addCandidate(target, item, key, label, weight, reliability) {
  const result = item?.result || item?.key;
  if (!SIDE_RESULTS.has(result)) return;
  const rate = clamp(Number(item.rate || 0.5), 0, 0.95);
  target.push({
    key,
    label,
    result,
    resultLabel: item.label || RESULT_LABELS[result] || result,
    rate,
    rawRate: Number.isFinite(Number(item.rawRate)) ? Number(item.rawRate) : rate,
    weight,
    reliability,
    basis: item.basis || item.read || item.roadLabel || item.strategy || "",
    roadLabel: item.roadLabel || "",
    strategy: item.strategy || ""
  });
}

function withSideNormalizedRate(item, resultRates = []) {
  const result = item?.result || item?.key;
  if (!SIDE_RESULTS.has(result)) return item;
  const rates = new Map((Array.isArray(resultRates) ? resultRates : []).map((rate) => [rate.result || rate.key, Number(rate.rate || 0)]));
  const banker = rates.get("banker") || 0;
  const player = rates.get("player") || 0;
  const total = banker + player;
  if (total <= 0) return item;
  const resultRate = rates.get(result);
  if (!Number.isFinite(resultRate)) return item;
  return {
    ...item,
    rawRate: Number(item.rate || resultRate || 0),
    rate: clamp(resultRate / total, 0, 0.95),
    basis: `${item?.basis || item?.description || "歷史相似"}；莊閒正規化`
  };
}

function buildSampleProfile(analysis = {}) {
  const source = analysis.source || {};
  const dataset = analysis.dataset || {};
  const manualReplay = analysis.roadBreakdown?.manualReplay || {};
  const exact = Number(source.exactSamples || 0);
  const fuzzy = Number(source.fuzzySamples || 0);
  const global = Number(source.globalSamples || 0);
  const totalRounds = Number(dataset.totalRounds || dataset.allRounds || 0);
  const replayChecked = Number(manualReplay.checked || 0);
  const exactScore = scoreByLog(exact, 48);
  const fuzzyScore = scoreByLog(fuzzy, 120);
  const globalScore = scoreByLog(global, 1400);
  const replayScore = scoreByLog(replayChecked, 32);
  let score = exactScore * 0.42 + fuzzyScore * 0.22 + globalScore * 0.22 + replayScore * 0.14;
  if (!totalRounds && exact + fuzzy + global === 0) score = Math.min(0.48, score + replayScore * 0.34);
  return {
    sourceType: source.type || "unknown",
    exact,
    fuzzy,
    global,
    totalRounds,
    replayChecked,
    score: round(clamp(score, 0, 1)),
    read: exact >= 8
      ? `完全相同樣本 ${exact} 筆`
      : fuzzy >= 20
        ? `相近樣本 ${fuzzy} 筆`
        : global >= 200
          ? `全庫樣本 ${global} 筆`
          : "樣本偏少"
  };
}

function buildEvidenceProfile(analysis = {}) {
  const records = Array.isArray(analysis.roadBreakdown?.records) ? analysis.roadBreakdown.records : [];
  const scores = records.map((record) => Number(record.evidenceScore || 0)).filter(Number.isFinite);
  const replayChecks = records.reduce((sum, record) => sum + Number(record.replayChecked || 0), 0);
  const cycleSamples = records.reduce((sum, record) => sum + Number(record.cycleSamples || 0), 0);
  const manualSamples = records.reduce((sum, record) => sum + Number(record.manualCycleSamples || 0), 0);
  const averageEvidence = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  const highEvidence = scores.filter((value) => value >= 0.72).length;
  const calibration = analysis.calibration || analysis.roadBreakdown?.overall?.preferred?.backtest || null;
  const calibrationChecked = Number(calibration?.nonTieChecked || 0);
  const calibrationLower = conservativeLower(calibration);
  const calibrationSignalRate = Number.isFinite(Number(calibration?.signalRate)) ? Number(calibration.signalRate) : 1;
  const calibrationScore = calibrationChecked
    ? clamp(
      scoreByLog(calibrationChecked, 160) * 0.48
        + clamp((calibrationLower - 0.485) / 0.07, 0, 1) * 0.34
        + clamp(calibrationSignalRate, 0, 1) * 0.12
        + clamp(Number(calibration?.lowerEdgeVsBaseline || 0) + 0.03, 0, 0.12) * 0.5,
      0,
      1
    )
    : 0;
  const score = clamp(
    averageEvidence * 0.46
      + scoreByLog(replayChecks, 80) * 0.18
      + scoreByLog(cycleSamples, 900) * 0.18
      + scoreByLog(manualSamples, 60) * 0.08
      + calibrationScore * 0.1,
    0,
    1
  );
  return {
    average: round(averageEvidence),
    highRoads: highEvidence,
    replayChecks,
    cycleSamples,
    manualSamples,
    calibration: calibration ? {
      key: calibration.key || "",
      nonTieChecked: Number(calibration.nonTieChecked || 0),
      nonTieHitRate: Number(calibration.nonTieHitRate || 0),
      nonTieWilsonLower: round(calibrationLower),
      baselineNonTieHitRate: Number(calibration.baselineNonTieHitRate || 0),
      lowerEdgeVsBaseline: Number(calibration.lowerEdgeVsBaseline || 0),
      signalRate: Number(calibration.signalRate || 0),
      selectionScore: Number(calibration.selectionScore || 0),
      delta: Number(calibration.delta || 0)
    } : null,
    score: round(score),
    read: highEvidence
      ? `${highEvidence} 條路證據高`
      : replayChecks
        ? `復盤 ${replayChecks} 次`
        : "證據仍低"
  };
}

function buildFiveStepProfile(analysis = {}, selectedResult = "") {
  const risk = analysis.fiveStepRisk || null;
  const targetMatches = risk?.targetResult && selectedResult
    ? risk.targetResult === selectedResult
    : true;
  if (!risk || !targetMatches) {
    return {
      available: false,
      action: "observe",
      samples: 0,
      completionRate: 0,
      completionWilsonLower: 0,
      failureRate: 0,
      averageStep: 0,
      score: 0.36,
      read: "5 注風險樣本不足"
    };
  }
  const samples = Number(risk.samples || 0);
  const completionRate = Number(risk.completionRate || 0);
  const completionWilsonLower = Number(risk.completionWilsonLower || 0);
  const failureRate = Number(risk.failureRate || 0);
  const baselineCompletionRate = Number(risk.baselineCompletionRate || 0);
  const completionLift = Number(risk.completionLift || 0);
  const completionLowerLift = Number(risk.completionLowerLift || 0);
  const action = risk.action === "advise" ? "advise" : "observe";
  return {
    available: true,
    action,
    targetResult: risk.targetResult || selectedResult || "",
    targetLabel: risk.targetLabel || RESULT_LABELS[risk.targetResult] || "",
    samples,
    completed: Number(risk.completed || 0),
    failures: Number(risk.failures || 0),
    completionRate,
    completionWilsonLower,
    failureRate,
    baselineCompletionRate,
    completionLift,
    completionLowerLift,
    averageStep: Number(risk.averageStep || 0),
    score: round(clamp(
      scoreByLog(samples, 160) * 0.2
        + clamp((completionLowerLift - 0.002) / 0.02, 0, 1) * 0.52
        + clamp((completionLift - 0.002) / 0.02, 0, 1) * 0.22
        + (action === "advise" ? 0.06 : 0),
      0,
      1
    )),
    read: risk.read || "5 注風險未通過"
  };
}

function scoreFailureMargin(failureRate, maxFailureRate) {
  const failure = Number(failureRate || 0);
  const max = Number(maxFailureRate || 0);
  if (max <= 0) return failure <= 0 ? 1 : 0;
  return clamp((max - failure) / max, 0, 1);
}

function buildFreshnessScore(analysis = {}) {
  const runtime = analysis.runtime || {};
  const roundsLoaded = Number(runtime.roundsLoaded || analysis.dataset?.totalRounds || 0);
  if (runtime.localOnly) return 0.5;
  return clamp(scoreByLog(roundsLoaded, runtime.scope === "table" ? 1200 : 7200), 0.25, 1);
}

function shouldAdvise({ inputLength, selected, score, agreement, sample, evidence, fiveStep, adaptive, ensemble }) {
  const calibration = evidence.calibration || {};
  if (ensemble) {
    if (!ensemble.validation?.approved) return false;
    if (ensemble.drift?.detected) return false;
    if (Number(ensemble.directional?.conservativeExpectedValue || 0) <= 0) return false;
  }
  if (adaptive && adaptive.action !== "advise") return false;
  if (adaptive?.selected?.result && selected?.result && adaptive.selected.result !== selected.result) return false;
  if (inputLength < ADVISE_MIN_INPUT_LENGTH) return false;
  if (!selected || !SIDE_RESULTS.has(selected.result)) return false;
  if (adaptive?.action === "advise") {
    return SIDE_RESULTS.has(adaptive.selected?.result)
      && fiveStep?.available
      && fiveStep.action === "advise"
      && Number(fiveStep.failureRate || 0) <= ADVISE_MAX_FIVE_STEP_FAILURE_RATE
      && Number(fiveStep.completionWilsonLower || 0) >= ADVISE_MIN_FIVE_STEP_WILSON_LOWER
      && Number(fiveStep.completionLowerLift || 0) > 0;
  }
  if (Number(selected.rate || 0) < ADVISE_MIN_SELECTED_RATE) return false;
  if (score < ADVISE_MIN_SCORE) return false;
  if (agreement < ADVISE_MIN_AGREEMENT) return false;
  if (sample.score < ADVISE_MIN_SAMPLE_SCORE || evidence.score < ADVISE_MIN_EVIDENCE_SCORE) return false;
  if (Number(calibration.nonTieChecked || 0) >= ADVISE_MIN_CALIBRATION_CHECKS && Number(calibration.nonTieWilsonLower || 0) < ADVISE_MIN_CALIBRATION_LOWER) return false;
  if (Number(calibration.signalRate || 1) < ADVISE_MIN_SIGNAL_RATE) return false;
  if (Number(calibration.nonTieChecked || 0) >= ADVISE_MIN_CALIBRATION_CHECKS && Number(calibration.lowerEdgeVsBaseline || 0) < ADVISE_MIN_LOWER_EDGE) return false;
  if (!fiveStep?.available) return false;
  if (fiveStep?.available && fiveStep.action !== "advise") return false;
  if (fiveStep?.available && Number(fiveStep.completionWilsonLower || 0) < ADVISE_MIN_FIVE_STEP_WILSON_LOWER) return false;
  if (fiveStep?.available && Number(fiveStep.failureRate || 0) > ADVISE_MAX_FIVE_STEP_FAILURE_RATE) return false;
  return true;
}

function buildReasons({ inputLength, selected, sample, evidence, fiveStep, agreement, score, level, adaptive, ensemble }) {
  const reasons = [];
  if (ensemble && !ensemble.validation?.approved) reasons.push("線上集成尚未證明優於莊方基準");
  if (ensemble?.drift?.detected) reasons.push("近期模型漂移");
  if (ensemble && Number(ensemble.directional?.conservativeExpectedValue || 0) <= 0) reasons.push("含佣金保守期望值未轉正");
  if (adaptive?.action === "observe") reasons.push(adaptive.guards?.[0] || "自適應策略腦觀望");
  if (inputLength < ADVISE_MIN_INPUT_LENGTH) reasons.push("未滿 8 手");
  if (!selected) reasons.push("沒有可用莊閒方向");
  if (selected && Number(selected.rate || 0) < ADVISE_MIN_SELECTED_RATE) reasons.push("方向優勢低於門檻");
  if (agreement < ADVISE_MIN_AGREEMENT) reasons.push("多路訊號分歧");
  if (sample.score < ADVISE_MIN_SAMPLE_SCORE) reasons.push("歷史相似樣本偏少");
  if (evidence.score < ADVISE_MIN_EVIDENCE_SCORE) reasons.push("證據等級不足");
  if (Number(evidence.calibration?.nonTieChecked || 0) >= ADVISE_MIN_CALIBRATION_CHECKS && Number(evidence.calibration?.nonTieWilsonLower || 0) < ADVISE_MIN_CALIBRATION_LOWER) reasons.push("保守回測下限偏低");
  if (Number(evidence.calibration?.signalRate || 1) < ADVISE_MIN_SIGNAL_RATE) reasons.push("有效出手率偏低");
  if (Number(evidence.calibration?.nonTieChecked || 0) >= ADVISE_MIN_CALIBRATION_CHECKS && Number(evidence.calibration?.lowerEdgeVsBaseline || 0) < ADVISE_MIN_LOWER_EDGE) reasons.push("保守回測低於基準");
  if (!fiveStep?.available) reasons.push("5 注風險樣本不足");
  if (fiveStep?.available && fiveStep.action !== "advise") reasons.push("5 注未證明超越自然基準");
  if (fiveStep?.available && Number(fiveStep.completionWilsonLower || 0) < ADVISE_MIN_FIVE_STEP_WILSON_LOWER) reasons.push("5 注保守下限不足");
  if (fiveStep?.available && Number(fiveStep.failureRate || 0) > ADVISE_MAX_FIVE_STEP_FAILURE_RATE) reasons.push("5 注失敗率偏高");
  if (score >= ADVISE_MIN_SCORE) reasons.push(`品質 ${levelLabel(level)}`);
  return reasons.slice(0, 5);
}

function buildRead({ action, result, rate, score, level, selected, sample, evidence, fiveStep, agreement }) {
  const prefix = action === "advise"
    ? `品質閘門通過：${RESULT_LABELS[result]} ${formatPercent(rate)}`
    : "品質閘門未通過：先觀察";
  const selectedText = selected ? `${selected.label} ${RESULT_LABELS[selected.result]} ${formatPercent(selected.rate)}` : "無主方向";
  const fiveStepText = fiveStep?.available ? `；${fiveStep.read}` : "";
  return `${prefix}，品質 ${levelLabel(level)} ${formatPercent(score)}，一致度 ${formatPercent(agreement)}；${selectedText}；${sample.read}；${evidence.read}${fiveStepText}。`;
}

function summarizeCandidate(item) {
  return {
    key: item.key,
    label: item.label,
    result: item.result,
    resultLabel: item.resultLabel,
    rate: round(item.rate),
    rawRate: round(item.rawRate),
    weight: round(item.weight),
    reliability: round(item.reliability),
    score: round(scoreCandidate(item)),
    roadLabel: item.roadLabel || "",
    strategy: item.strategy || ""
  };
}

function scoreCandidate(item) {
  return clamp(Number(item.rate || 0.5) - 0.5, 0, 0.45)
    * clamp(Number(item.weight || 1), 0.1, 2.5)
    * clamp(Number(item.reliability || 0.5), 0.2, 1);
}

function reliabilityFromSource(source = {}) {
  const exact = Number(source.exactSamples || 0);
  const fuzzy = Number(source.fuzzySamples || 0);
  const global = Number(source.globalSamples || 0);
  return clamp(
    scoreByLog(exact, 40) * 0.52
      + scoreByLog(fuzzy, 100) * 0.26
      + scoreByLog(global, 1200) * 0.22,
    0.22,
    0.92
  );
}

function reliabilityFromOverall(item = {}) {
  const backtest = item?.backtest || null;
  if (backtest?.nonTieChecked) {
    const lower = conservativeLower(backtest);
    const signalRate = Number.isFinite(Number(backtest.signalRate)) ? Number(backtest.signalRate) : 1;
    return clamp(
      0.32
        + scoreByLog(Number(backtest.nonTieChecked || 0), 160) * 0.34
        + clamp((lower - 0.48) / 0.08, 0, 1) * 0.2
        + clamp(Number(backtest.lowerEdgeVsBaseline || 0) + 0.03, 0, 0.12) * 0.45
        + clamp(signalRate, 0, 1) * 0.08,
      0.28,
      0.94
    );
  }
  return item?.roadKey || item?.roadLabel ? 0.58 : 0.5;
}

function conservativeLower(backtest = {}) {
  if (!backtest || typeof backtest !== "object") return 0;
  const explicit = Number(backtest.nonTieWilsonLower || 0);
  if (explicit > 0) return explicit;
  return wilsonLowerBound(Number(backtest.nonTieHits || 0), Number(backtest.nonTieChecked || 0));
}

function reliabilityFromConsensus(item = {}) {
  const votes = item?.votes || {};
  const total = Number(votes.banker || 0) + Number(votes.player || 0);
  if (!total) return 0.38;
  return clamp(0.42 + Math.min(total, 0.9) * 0.36, 0.38, 0.86);
}

function scoreByLog(value, target) {
  const number = Math.max(0, Number(value || 0));
  return clamp(Math.log1p(number) / Math.log1p(Math.max(1, target)), 0, 1);
}

function levelLabel(level) {
  return {
    high: "高",
    medium: "中",
    low: "低",
    wait: "等待"
  }[level] || "低";
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
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
  buildDecisionProfile
};
