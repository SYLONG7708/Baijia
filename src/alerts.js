const { ALERT_MIN_RATE, ALERT_MIN_SAMPLE } = require("./env");

const labels = {
  BANKER: "莊",
  PLAYER: "閒",
  TIE: "和"
};

function tableSeverity(validation, code) {
  return (validation?.tables || []).find((table) => table.code === code)?.severity || "";
}

function buildStreakAlerts(summary, validation, options = {}) {
  const minRate = Number(options.minRate ?? ALERT_MIN_RATE);
  const minSample = Number(options.minSample ?? ALERT_MIN_SAMPLE);
  const alerts = (summary?.tables || [])
    .filter((table) => {
      const streak = table.streak || {};
      return table.total > 0
        && Number(streak.continuationRate || 0) >= minRate
        && Number(streak.opportunities || 0) >= minSample
        && tableSeverity(validation, table.code) !== "ERROR";
    })
    .map((table) => {
      const streak = table.streak || {};
      return {
        code: table.code,
        category: table.category || "",
        outcome: streak.outcome || "",
        outcomeLabel: labels[streak.outcome] || streak.outcome || "-",
        length: streak.length || 0,
        continuationRate: Number(streak.continuationRate || 0),
        continuationPercent: streak.continuationPercent || 0,
        opportunities: streak.opportunities || 0,
        continuations: streak.continuations || 0,
        sampleType: streak.sampleType || "",
        total: table.total || 0,
        lastRoundNo: table.lastRoundNo || 0,
        lastOutcome: table.lastOutcome || "",
        severity: tableSeverity(validation, table.code) || "OK"
      };
    })
    .sort((left, right) => {
      if (right.continuationRate !== left.continuationRate) return right.continuationRate - left.continuationRate;
      if (right.opportunities !== left.opportunities) return right.opportunities - left.opportunities;
      return left.code.localeCompare(right.code);
    });

  return {
    generatedAt: new Date().toISOString(),
    minRate,
    minPercent: Math.round(minRate * 1000) / 10,
    minSample,
    count: alerts.length,
    alerts
  };
}

function alertSignature(alerts) {
  return alerts.map((alert) => [
    alert.code,
    alert.outcome,
    alert.length,
    alert.continuationPercent,
    alert.opportunities,
    alert.lastRoundNo
  ].join(":")).join("|");
}

module.exports = {
  buildStreakAlerts,
  alertSignature
};
