const labels = {
  BANKER: "莊",
  PLAYER: "閒",
  TIE: "和"
};

const DEFAULT_ALERT_LIMIT = 2;

const outcomeShort = {
  BANKER: "B",
  PLAYER: "P",
  TIE: "T"
};

function clamp(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function pct(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
}

function tableSeverity(validation, code) {
  return (validation?.tables || []).find((table) => table.code === code)?.severity || "";
}

function otherMainOutcome(outcome) {
  if (outcome === "BANKER") return "PLAYER";
  if (outcome === "PLAYER") return "BANKER";
  return "";
}

function probabilityFor(prediction, outcome) {
  const probability = Number(prediction?.probabilities?.[outcome]);
  if (Number.isFinite(probability) && probability > 0) return probability;
  const percent = Number(prediction?.percentages?.[outcome]);
  if (Number.isFinite(percent) && percent > 0) return percent / 100;
  return 0;
}

function predictionOutcome(table, streak) {
  const pick = table?.prediction?.pick;
  if (pick === "BANKER" || pick === "PLAYER") return pick;
  if (streak?.outcome === "BANKER" || streak?.outcome === "PLAYER") return streak.outcome;
  return "";
}

function shrinkToBaseline(rawRate, sample, base = 0.5, prior = 20) {
  const rate = clamp(rawRate, 0, 1);
  const weight = Math.max(0, Number(sample || 0)) / (Math.max(0, Number(sample || 0)) + prior);
  return base + (rate - base) * weight;
}

function trendSignal(streak, outcome) {
  if (!streak?.outcome || !outcome || !Number(streak.opportunities || 0)) {
    return {
      rate: 0.5,
      rawRate: 0.5,
      sample: 0,
      mode: "neutral"
    };
  }
  const continuationRate = clamp(streak.continuationRate, 0, 1);
  const rawRate = streak.outcome === outcome ? continuationRate : 1 - continuationRate;
  return {
    rate: clamp(shrinkToBaseline(rawRate, streak.opportunities, 0.5, 20), 0.35, 0.85),
    rawRate,
    sample: Number(streak.opportunities || 0),
    mode: streak.outcome === outcome ? "continue" : "reverse"
  };
}

function modelSignal(prediction, outcome) {
  const other = otherMainOutcome(outcome);
  const pickRate = probabilityFor(prediction, outcome);
  const otherRate = probabilityFor(prediction, other);
  if (!pickRate || !otherRate) {
    return {
      rate: 0.5,
      rawRate: pickRate || 0,
      margin: 0,
      sample: Number(prediction?.sampleSize || 0)
    };
  }
  const margin = pickRate - otherRate;
  return {
    rate: clamp(0.5 + margin * 1.4, 0.35, 0.75),
    rawRate: pickRate,
    margin,
    sample: Number(prediction?.sampleSize || prediction?.tableSampleSize || 0)
  };
}

function tableSignal(table, outcome) {
  const banker = Number(table?.counts?.BANKER || 0);
  const player = Number(table?.counts?.PLAYER || 0);
  const nonTie = banker + player;
  if (!nonTie || !outcome) {
    return {
      rate: 0.5,
      rawRate: 0.5,
      sample: nonTie
    };
  }
  const rawRate = outcome === "BANKER" ? banker / nonTie : player / nonTie;
  return {
    rate: clamp(shrinkToBaseline(rawRate, nonTie, 0.5, 80), 0.4, 0.68),
    rawRate,
    sample: nonTie
  };
}

function recentSignal(table, outcome) {
  const short = outcomeShort[outcome];
  const latest = (table?.latestSix || []).filter((value) => value === "B" || value === "P");
  if (!latest.length || !short) {
    return {
      rate: 0.5,
      rawRate: 0.5,
      sample: latest.length
    };
  }
  const rawRate = latest.filter((value) => value === short).length / latest.length;
  return {
    rate: clamp(shrinkToBaseline(rawRate, latest.length, 0.5, 8), 0.38, 0.72),
    rawRate,
    sample: latest.length
  };
}

function cardSignal(table, outcome) {
  const cardModel = table?.prediction?.cardModel;
  if (!cardModel?.available || !outcome) return null;
  const banker = Number(cardModel.probabilities?.BANKER || 0);
  const player = Number(cardModel.probabilities?.PLAYER || 0);
  const nonTie = banker + player;
  if (!nonTie) return null;
  const rawRate = outcome === "BANKER" ? banker / nonTie : player / nonTie;
  const observedCards = Number(cardModel.observedCards || 0);
  return {
    rate: clamp(shrinkToBaseline(rawRate, observedCards, 0.5, 180), 0.42, 0.62),
    rawRate,
    sample: observedCards
  };
}

function roadSignal(table, outcome) {
  const roadModel = table?.prediction?.roadModel || table?.roadModel;
  if (!roadModel?.available || !outcome) return null;
  const banker = Number(roadModel.noTieProbabilities?.BANKER || roadModel.probabilities?.BANKER || 0);
  const player = Number(roadModel.noTieProbabilities?.PLAYER || roadModel.probabilities?.PLAYER || 0);
  const nonTie = banker + player;
  if (!nonTie) return null;
  const rawRate = outcome === "BANKER" ? banker / nonTie : player / nonTie;
  const sample = Number(roadModel.effectiveSample || 0);
  return {
    rate: clamp(shrinkToBaseline(rawRate, sample, 0.5, 90), 0.4, 0.68),
    rawRate,
    sample,
    modelWeight: Number(roadModel.modelWeight || 0),
    features: roadModel.features || {}
  };
}

function performanceSignal(table) {
  const model = table?.tableModel;
  const tested = Number(model?.tested || 0);
  const accuracy = Number(model?.accuracyNoTie || 0) / 100;
  if (!model || tested < 20 || !Number.isFinite(accuracy) || accuracy <= 0) {
    return {
      rate: 0.5,
      rawRate: 0.5,
      tested: 0,
      modelId: table?.activeModel || table?.prediction?.modelId || ""
    };
  }
  return {
    rate: clamp(shrinkToBaseline(accuracy, tested, 0.5, 120), 0.42, 0.64),
    rawRate: accuracy,
    tested,
    modelId: model.modelId || table?.activeModel || table?.prediction?.modelId || "",
    averageLogLoss: Number(model.averageLogLoss || 0)
  };
}

function calibrateModelSignal(model, performance) {
  if (!performance?.tested) return model;
  const trust = clamp(performance.tested / 500, 0.4, 1);
  const edgeMultiplier = clamp(0.4 + (performance.rawRate - 0.5) * 8, 0.2, 1.2);
  return {
    ...model,
    rawRate: model.rawRate,
    uncalibratedRate: model.rate,
    rate: clamp(0.5 + (model.rate - 0.5) * trust * edgeMultiplier, 0.42, 0.68)
  };
}

function weightedAverage(components) {
  const active = components.filter((component) => component && component.weight > 0);
  const totalWeight = active.reduce((sum, component) => sum + component.weight, 0) || 1;
  return active.reduce((sum, component) => sum + component.rate * component.weight, 0) / totalWeight;
}

function scoreForTable(table, validation) {
  const streak = table.streak || {};
  const prediction = table.prediction || {};
  const outcome = predictionOutcome(table, streak);
  if (!outcome) return null;

  const trend = trendSignal(streak, outcome);
  const tableFrequency = tableSignal(table, outcome);
  const recent = recentSignal(table, outcome);
  const card = cardSignal(table, outcome);
  const road = roadSignal(table, outcome);
  const performance = performanceSignal(table);
  const rawModel = modelSignal(prediction, outcome);
  const model = calibrateModelSignal(rawModel, performance);
  const components = [
    { key: "trend", label: "連勝訊號", rate: trend.rate, weight: 0.34 },
    { key: "model", label: "預測模型", rate: model.rate, weight: 0.28 },
    { key: "performance", label: "回測表現", rate: performance.rate, weight: 0.14 },
    { key: "table", label: "本桌比例", rate: tableFrequency.rate, weight: 0.12 },
    { key: "recent", label: "最近六局", rate: recent.rate, weight: card ? 0.07 : 0.12 }
  ];
  if (card) components.push({ key: "card", label: "牌靴", rate: card.rate, weight: 0.05 });

  if (road) {
    components.push({ key: "road", label: "路單規律", rate: road.rate, weight: 0.18 });
  }

  const severity = tableSeverity(validation, table.code) || "OK";
  const qualityPenalty = severity === "WARN" ? 0.97 : 1;
  const scoreRate = severity === "ERROR" ? 0 : clamp(weightedAverage(components) * qualityPenalty, 0, 1);
  const sampleSize = Math.max(
    Number(streak.opportunities || 0),
    Number(prediction.sampleSize || 0),
    Number(prediction.tableSampleSize || 0),
    Number(prediction.globalSampleSize || 0)
  );

  return {
    outcome,
    outcomeLabel: labels[outcome] || outcome || "-",
    scoreRate,
    scorePercent: pct(scoreRate),
    displayPercent: pct(scoreRate),
    scoreLabel: "平均分數",
    sampleSize,
    severity,
    trendRate: trend.rate,
    trendPercent: pct(trend.rate),
    rawTrendPercent: pct(trend.rawRate),
    trendMode: trend.mode,
    predictionScoreRate: model.rate,
    predictionScorePercent: pct(model.rate),
    rawPredictionScorePercent: pct(model.uncalibratedRate || model.rate),
    performanceScoreRate: performance.rate,
    performanceScorePercent: pct(performance.rate),
    modelId: performance.modelId || table.activeModel || prediction.modelId || "",
    modelBacktestAccuracyNoTie: pct(performance.rawRate),
    modelBacktestTested: performance.tested || 0,
    modelBacktestLogLoss: performance.averageLogLoss || 0,
    modelOutcomeRate: model.rawRate,
    modelOutcomePercent: pct(model.rawRate),
    modelMarginPercent: pct(model.margin),
    tableScoreRate: tableFrequency.rate,
    tableScorePercent: pct(tableFrequency.rate),
    recentScoreRate: recent.rate,
    recentScorePercent: pct(recent.rate),
    cardScoreRate: card?.rate || 0,
    cardScorePercent: card ? pct(card.rate) : 0,
    roadScoreRate: road?.rate || 0,
    roadScorePercent: road ? pct(road.rate) : 0,
    roadScoreSample: road?.sample || 0,
    rawRoadScorePercent: road ? pct(road.rawRate) : 0,
    scoreBreakdown: components.map((component) => ({
      key: component.key,
      label: component.label,
      weight: component.weight,
      percent: pct(component.rate)
    }))
  };
}

function buildStreakAlerts(summary, validation, options = {}) {
  const minRate = Number(options.minRate ?? 0);
  const minSample = Number(options.minSample ?? 0);
  const limit = Math.max(1, Number(options.limit ?? DEFAULT_ALERT_LIMIT) || DEFAULT_ALERT_LIMIT);
  const candidates = (summary?.tables || [])
    .map((table) => {
      const streak = table.streak || {};
      const score = scoreForTable(table, validation);
      if (!score) return null;
      return {
        code: table.code,
        category: table.category || "",
        outcome: score.outcome,
        outcomeLabel: score.outcomeLabel,
        length: streak.length || 0,
        continuationRate: Number(streak.continuationRate || 0),
        continuationPercent: streak.continuationPercent || 0,
        opportunities: streak.opportunities || 0,
        continuations: streak.continuations || 0,
        sampleType: streak.sampleType || "",
        sampleSize: score.sampleSize,
        scoreRate: score.scoreRate,
        scorePercent: score.scorePercent,
        displayPercent: score.displayPercent,
        scoreLabel: score.scoreLabel,
        trendRate: score.trendRate,
        trendPercent: score.trendPercent,
        rawTrendPercent: score.rawTrendPercent,
        trendMode: score.trendMode,
        predictionScoreRate: score.predictionScoreRate,
        predictionScorePercent: score.predictionScorePercent,
        rawPredictionScorePercent: score.rawPredictionScorePercent,
        performanceScoreRate: score.performanceScoreRate,
        performanceScorePercent: score.performanceScorePercent,
        modelId: score.modelId,
        modelBacktestAccuracyNoTie: score.modelBacktestAccuracyNoTie,
        modelBacktestTested: score.modelBacktestTested,
        modelBacktestLogLoss: score.modelBacktestLogLoss,
        modelOutcomeRate: score.modelOutcomeRate,
        modelOutcomePercent: score.modelOutcomePercent,
        modelMarginPercent: score.modelMarginPercent,
        tableScorePercent: score.tableScorePercent,
        recentScorePercent: score.recentScorePercent,
        cardScorePercent: score.cardScorePercent,
        roadScorePercent: score.roadScorePercent,
        roadScoreSample: score.roadScoreSample,
        rawRoadScorePercent: score.rawRoadScorePercent,
        scoreBreakdown: score.scoreBreakdown,
        total: table.total || 0,
        lastRoundNo: table.lastRoundNo || 0,
        lastOutcome: table.lastOutcome || "",
        severity: score.severity
      };
    })
    .filter(Boolean)
    .filter((table) => {
      return table.total > 0
        && Number(table.scoreRate || 0) >= minRate
        && Number(table.sampleSize || 0) >= minSample
        && table.severity !== "ERROR";
    })
    .sort((left, right) => {
      if (right.scoreRate !== left.scoreRate) return right.scoreRate - left.scoreRate;
      if (right.performanceScoreRate !== left.performanceScoreRate) return right.performanceScoreRate - left.performanceScoreRate;
      if (right.predictionScoreRate !== left.predictionScoreRate) return right.predictionScoreRate - left.predictionScoreRate;
      if (right.roadScorePercent !== left.roadScorePercent) return right.roadScorePercent - left.roadScorePercent;
      if (right.sampleSize !== left.sampleSize) return right.sampleSize - left.sampleSize;
      return left.code.localeCompare(right.code);
    });
  const alerts = candidates.slice(0, limit);

  return {
    generatedAt: new Date().toISOString(),
    minRate,
    minPercent: Math.round(minRate * 1000) / 10,
    minSample,
    topLimit: limit,
    scoreLabel: "平均分數",
    candidateCount: candidates.length,
    count: alerts.length,
    alerts
  };
}

function alertSignature(alerts) {
  return alerts.map((alert) => [
    alert.code,
    alert.outcome,
    alert.length,
    alert.scorePercent,
    alert.predictionScorePercent,
    alert.performanceScorePercent,
    alert.modelId,
    alert.roadScorePercent,
    alert.sampleSize,
    alert.lastRoundNo
  ].join(":")).join("|");
}

module.exports = {
  buildStreakAlerts,
  alertSignature
};
