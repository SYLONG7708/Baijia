const labels = {
  banker: "莊",
  player: "閒",
  tie: "和"
};

const tableFallbackCodes = [
  "B201", "B202", "B203", "B219", "B220",
  "B501", "B502", "B503", "B504", "B505", "B506", "B507",
  "B601", "B602", "B603", "B604", "B605", "B618",
  "C201", "C202", "C501", "C701",
  "IB201", "IB202",
  "Q201", "Q202", "Q204", "Q501", "Q502", "Q601", "Q701", "Q702",
  "V911", "V912", "V971", "V972"
];

const ladders = {
  flat: [1, 1, 1, 1, 1],
  soft: [1, 1, 2, 3, 5],
  double: [1, 2, 4, 8, 16]
};

const storageKey = "baijia-advisor-v6-trend-repair";
const legacyStorageKeys = ["baijia-simulator-v1", "baijia-advisor-v2", "baijia-advisor-v3-no-switch"];
const windowSize = 8;
const apiTimeoutMs = 15_000;
const manualSequenceLimit = 80;
const manualRecordLimit = 300;
const eventLimit = 400;
const adviceMaxAgeMs = 10 * 60 * 1000;
let analyzingManual = false;
let manualAnalyzeQueued = false;
let manualAnalyzeRunId = 0;

const state = {
  status: null,
  tables: [],
  events: [],
  manual: {
    selectedTableId: "",
    tableIndex: 0,
    sequence: [],
    step: 1,
    units: 0,
    betCount: 0,
    winCount: 0,
    lossCount: 0,
    pushCount: 0,
    failedSets: 0,
    pendingAdvice: null,
    activeSet: null,
    analysisNote: "",
    records: []
  },
  config: {
    baseStake: 1,
    ladder: "flat",
    bankerPayout: 0.95
  }
};

const els = {
  serverBadge: document.getElementById("serverBadge"),
  refreshBtn: document.getElementById("refreshBtn"),
  historyRoundCount: document.getElementById("historyRoundCount"),
  historyTableCount: document.getElementById("historyTableCount"),
  historyUpdateAt: document.getElementById("historyUpdateAt"),
  currentTableName: document.getElementById("currentTableName"),
  manualStep: document.getElementById("manualStep"),
  manualStake: document.getElementById("manualStake"),
  baseStakeInput: document.getElementById("baseStakeInput"),
  ladderSelect: document.getElementById("ladderSelect"),
  bankerPayoutInput: document.getElementById("bankerPayoutInput"),
  ladderBoard: document.getElementById("ladderBoard"),
  manualTableSelect: document.getElementById("manualTableSelect"),
  clearManualBtn: document.getElementById("clearManualBtn"),
  undoManualBtn: document.getElementById("undoManualBtn"),
  analyzeManualBtn: document.getElementById("analyzeManualBtn"),
  manualCount: document.getElementById("manualCount"),
  manualSequence: document.getElementById("manualSequence"),
  manualAdvice: document.getElementById("manualAdvice"),
  manualAdviceMeta: document.getElementById("manualAdviceMeta"),
  manualUnits: document.getElementById("manualUnits"),
  manualHitRate: document.getElementById("manualHitRate"),
  manualBetCount: document.getElementById("manualBetCount"),
  manualWinCount: document.getElementById("manualWinCount"),
  manualLossCount: document.getElementById("manualLossCount"),
  manualFailedSets: document.getElementById("manualFailedSets"),
  manualPushCount: document.getElementById("manualPushCount"),
  loadedTables: document.getElementById("loadedTables"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  eventLog: document.getElementById("eventLog"),
  manualResultButtons: [...document.querySelectorAll("[data-manual-result]")]
};

init();

function init() {
  clearLegacySessions();
  restoreSession();
  bindEvents();
  syncInputsFromConfig();
  render();
  loadRuntimeData();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  els.refreshBtn?.addEventListener("click", loadRuntimeData);
  [els.baseStakeInput, els.ladderSelect, els.bankerPayoutInput].forEach((input) => {
    input?.addEventListener("change", () => {
      syncConfigFromInputs();
      render();
      persistSession();
    });
  });
  els.manualTableSelect.addEventListener("change", () => {
    state.manual.selectedTableId = els.manualTableSelect.value || "";
    state.manual.pendingAdvice = null;
    state.manual.activeSet = null;
    state.manual.analysisNote = "";
    runManualAnalyze();
    persistSession();
  });
  els.manualResultButtons.forEach((button) => {
    button.addEventListener("click", () => recordManualResult(button.dataset.manualResult));
  });
  els.clearManualBtn.addEventListener("click", () => {
    resetManualSession();
    render();
    persistSession();
  });
  els.undoManualBtn.addEventListener("click", () => {
    state.manual.sequence.pop();
    state.manual.pendingAdvice = null;
    state.manual.activeSet = null;
    state.manual.analysisNote = "";
    render();
    persistSession();
  });
  els.analyzeManualBtn.addEventListener("click", runManualAnalyze);
  els.exportJsonBtn.addEventListener("click", () => exportSession("json"));
  els.exportCsvBtn.addEventListener("click", () => exportSession("csv"));
}

async function loadRuntimeData() {
  await Promise.allSettled([loadStatus(), loadTables()]);
  render();
  persistSession();
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    state.status = status;
    els.serverBadge.textContent = "本機正常";
    els.serverBadge.className = "status-pill ok";
  } catch (error) {
    els.serverBadge.textContent = "API 未連線";
    els.serverBadge.className = "status-pill bad";
    logEvent("system", "API", null, error.message, 0, "loss");
  }
}

async function loadTables() {
  try {
    const json = await api("/api/analysis/tables");
    const loaded = Array.isArray(json.tables) ? json.tables : [];
    state.tables = loaded.length ? loaded.map(normalizeTable) : buildFallbackTables();
  } catch (_) {
    state.tables = buildFallbackTables();
  }
  if (!state.manual.selectedTableId && state.tables[0]) {
    state.manual.selectedTableId = state.tables[0].id;
  }
  renderTableOptions();
}

async function recordManualResult(result) {
  if (!labels[result]) return;
  const advice = state.manual.pendingAdvice;
  if (advice) settleManualAdvice(result, advice);
  state.manual.sequence.push(makeRound(result, state.manual.sequence.length + 1, "manual"));
  state.manual.sequence = state.manual.sequence.slice(-80);
  state.manual.pendingAdvice = null;
  state.manual.analysisNote = "";
  render();
  persistSession();
  if (state.manual.sequence.length >= windowSize) await runManualAnalyze();
}

function settleManualAdvice(actualResult, advice) {
  const tableLock = {
    selectedTableId: state.manual.selectedTableId,
    tableIndex: state.manual.tableIndex
  };
  const settlement = settleBet(advice.result, actualResult, advice.stake);
  if (settlement.type === "push") {
    state.manual.pushCount += 1;
    addManualRecord(advice, actualResult, settlement);
    logEvent("manual", "退回", currentManualTable(), `${advice.label} ${formatUnits(advice.stake)} 注 → ${labels[actualResult]}`, 0, "neutral");
    restoreManualTableLock(tableLock);
    return;
  }

  state.manual.betCount += 1;
  if (settlement.type === "win") {
    state.manual.winCount += 1;
    state.manual.units += settlement.units;
    state.manual.step = 1;
    state.manual.activeSet = null;
    addManualRecord(advice, actualResult, settlement);
    logEvent("manual", "成功", currentManualTable(), `${advice.label} ${formatUnits(advice.stake)} 注 → ${labels[actualResult]}`, settlement.units, "profit");
    restoreManualTableLock(tableLock);
    return;
  }

  state.manual.lossCount += 1;
  state.manual.units += settlement.units;
  addManualRecord(advice, actualResult, settlement);
  logEvent("manual", "失敗", currentManualTable(), `${advice.label} ${formatUnits(advice.stake)} 注 → ${labels[actualResult]}`, settlement.units, "loss");
  if (state.manual.step >= 5) {
    state.manual.failedSets += 1;
    state.manual.step = 1;
    state.manual.activeSet = null;
  } else {
    state.manual.step += 1;
  }
  restoreManualTableLock(tableLock);
}

async function runManualAnalyze() {
  if (analyzingManual) {
    manualAnalyzeQueued = true;
    manualAnalyzeRunId += 1;
    render();
    return;
  }
  const runId = ++manualAnalyzeRunId;
  if (state.manual.sequence.length < windowSize) {
    state.manual.pendingAdvice = null;
    state.manual.analysisNote = "";
    render();
    return;
  }
  if (state.manual.activeSet && state.manual.step > 1) {
    state.manual.pendingAdvice = buildLockedSetAdvice();
    state.manual.analysisNote = buildLockedSetNote();
    render();
    persistSession();
    return;
  }
  analyzingManual = true;
  render();
  try {
    const table = currentManualTable();
    const analysis = await analyzeSequence(state.manual.sequence.slice(-24), table);
    const decision = pickBetDecision(analysis);
    const stake = currentStake(state.manual.step);
    if (runId !== manualAnalyzeRunId) return;
    state.manual.analysisNote = buildAdvisorAnalysisNote(analysis);
    if (!decision) {
      state.manual.pendingAdvice = null;
      return;
    }
    state.manual.pendingAdvice = {
      ...decision,
      tableId: table?.id || "",
      tableCode: table?.tableCode || "",
      stake,
      step: state.manual.step,
      conservativeNote: mergeAdvisorNotes(
        decision.conservativeNote,
        decision.conservativeNote
          ? buildEnsembleNote(analysis?.ensembleBrain || analysis?.decisionProfile?.ensemble)
          : buildAdvisorConservativeNote(analysis)
      ),
      createdAt: new Date().toISOString(),
      sourceType: analysis?.source?.type || ""
    };
    if (state.manual.step === 1) {
      state.manual.activeSet = createActiveSet(state.manual.pendingAdvice, analysis);
    }
  } catch (error) {
    if (runId !== manualAnalyzeRunId) return;
    state.manual.pendingAdvice = null;
    logEvent("manual", "錯誤", currentManualTable(), error.message, 0, "loss");
  } finally {
    analyzingManual = false;
    if (runId === manualAnalyzeRunId) {
      render();
      persistSession();
    }
    if (manualAnalyzeQueued && !analyzingManual) {
      manualAnalyzeQueued = false;
      await runManualAnalyze();
    }
  }
}

function mergeAdvisorNotes(...values) {
  const output = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || output.some((item) => item.includes(text) || text.includes(item))) continue;
    output.push(text);
  }
  return output.join(" · ");
}

async function analyzeSequence(sequence, table) {
  const payload = {
    sequence,
    manualSequence: sequence,
    scope: table?.id ? "table" : "all",
    tableId: table?.id || "",
    tableCode: table?.tableCode || "",
    limit: table?.id ? 1200 : 7200
  };
  return api("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function createActiveSet(advice, analysis) {
  if (!advice || !["banker", "player"].includes(advice.result)) return null;
  const fiveStep = advice.fiveStep || analysis?.decisionProfile?.fiveStep || analysis?.fiveStepRisk || null;
  return {
    result: advice.result,
    label: labels[advice.result],
    rate: clamp(Number(advice.rate || 0), 0, 1),
    source: advice.source || "decision-quality-gate",
    conservativeNote: advice.conservativeNote || buildAdvisorConservativeNote(analysis),
    fiveStepNote: buildFiveStepNote(fiveStep),
    tableId: advice.tableId || "",
    tableCode: advice.tableCode || "",
    startedAt: new Date().toISOString()
  };
}

function buildLockedSetAdvice() {
  const active = state.manual.activeSet;
  if (!active || !["banker", "player"].includes(active.result)) return null;
  const table = currentManualTable();
  const notes = [active.conservativeNote].filter(Boolean);
  if (active.fiveStepNote && !String(active.conservativeNote || "").includes(active.fiveStepNote)) {
    notes.push(active.fiveStepNote);
  }
  return {
    result: active.result,
    label: labels[active.result],
    rate: clamp(Number(active.rate || 0), 0, 1),
    source: `5注鎖定 · ${active.source || "quality-gate"}`,
    conservativeNote: notes.join(" · "),
    tableId: active.tableId || table?.id || "",
    tableCode: active.tableCode || table?.tableCode || "",
    stake: currentStake(state.manual.step),
    step: state.manual.step,
    createdAt: new Date().toISOString(),
    sourceType: "five-step-lock"
  };
}

function buildLockedSetNote() {
  const active = state.manual.activeSet;
  if (!active) return "";
  return `5 注組鎖定 ${labels[active.result]}，目前第 ${state.manual.step} 注；成功、推和或第 5 注失敗前不切換方向。此流程不構成必過保證。${active.fiveStepNote ? ` ${active.fiveStepNote}。` : ""}`;
}

function pickBetDecision(analysis) {
  const profile = analysis?.decisionProfile || null;
  if (profile) {
    if (profile.action !== "advise" || !["banker", "player"].includes(profile.result)) {
      const forced = profile.forced || null;
      if (forced && ["banker", "player"].includes(forced.result)) {
        return {
          result: forced.result,
          label: labels[forced.result],
          rate: Number(forced.rate || 0),
          source: forced.qualityPassed
            ? `品質通過 · ${forced.source || "quality-gate"}`
            : `路型趨勢 · ${forced.trendSource || directionModeLabel(forced.mode)}`,
          conservativeNote: buildForcedDecisionNote(forced),
          fiveStep: forced.risk || null,
          sourceType: forced.qualityPassed ? "quality-gate" : "always-direction-estimate"
        };
      }
      return null;
    }
    return {
      result: profile.result,
      label: labels[profile.result],
      rate: Number(profile.rate || 0),
      source: `${profile.levelLabel || "品質"} · ${profile.adaptive?.profile?.label || profile.source || "quality-gate"}`
    };
  }
  const overall = analysis?.roadBreakdown?.overall || {};
  const resultRates = Array.isArray(analysis?.resultRates) ? analysis.resultRates : [];
  const rawCandidates = [
    overall.preferred,
    overall.recommended,
    overall.consensus,
    overall.highest,
    analysis?.nextResult,
    ...resultRates
  ];
  for (const item of rawCandidates) {
    const result = item?.result || item?.key;
    if (!["banker", "player"].includes(result)) continue;
    if (Number(item.rate || 0) < 0.525) continue;
    return {
      result,
      label: labels[result],
      rate: Number(item.rate || 0),
      source: item.strategy || item.roadLabel || item.source || analysis?.source?.type || "analysis"
    };
  }
  return null;
}

function buildForcedDecisionNote(forced) {
  const risk = forced?.risk || null;
  const notes = [forced?.read || "每把方向"];
  notes.push(`綜合方向EV ${formatSignedRate(forced?.expectedValue || 0)}`);
  if (forced?.probabilityResult) {
    notes.push(`AI機率 ${labels[forced.probabilityResult] || "-"}${formatRate(forced.probabilityRate || 0.5)}`);
  }
  if (forced?.economicResult) {
    notes.push(`佣金EV較優 ${labels[forced.economicResult] || "-"}${formatSignedRate(forced.economicExpectedValue || 0)}`);
  }
  if (!forced?.qualityPassed) notes.push("未通過樣本外品質門檻");
  if (risk?.samples) {
    notes.push(`5注 完成${formatRate(risk.completionRate)} / 自然${formatRate(risk.baselineCompletionRate)} / 超額${formatSignedRate(risk.completionLift)} / ${Number(risk.samples || 0)}樣本`);
  }
  if (forced?.primaryResult && forced.primaryResult !== forced.result) {
    notes.push(`主方向${labels[forced.primaryResult]}未達平衡分數，改用${labels[forced.result]}`);
  }
  return notes.filter(Boolean).join(" 路 ");
}

function buildAdvisorAnalysisNote(analysis) {
  const profile = analysis?.decisionProfile;
  const fiveStepNote = buildFiveStepNote(profile?.fiveStep || analysis?.fiveStepRisk);
  const ensemble = analysis?.ensembleBrain || profile?.ensemble || null;
  const ensembleNote = buildEnsembleNote(ensemble);
  if (profile?.read) {
    const calibration = profile.evidence?.calibration;
    if (calibration?.nonTieWilsonLower) {
      return `${profile.read} 保守下限 ${formatRate(calibration.nonTieWilsonLower)}，基準差 ${formatSignedRate(calibration.lowerEdgeVsBaseline)}。${ensembleNote ? ` ${ensembleNote}` : ""}${fiveStepNote ? ` ${fiveStepNote}` : ""}`;
    }
    return `${profile.read}${ensembleNote ? ` ${ensembleNote}` : ""}${fiveStepNote ? ` ${fiveStepNote}` : ""}`;
  }
  const warning = Array.isArray(analysis?.warnings) ? analysis.warnings.at(-1) : "";
  if (warning) return safeText(warning, 220);
  return `品質閘門資料不足，先觀察下一手。${fiveStepNote ? ` ${fiveStepNote}` : ""}`;
}

function buildAdvisorConservativeNote(analysis) {
  const calibration = analysis?.decisionProfile?.evidence?.calibration;
  const fiveStepNote = buildFiveStepNote(analysis?.decisionProfile?.fiveStep || analysis?.fiveStepRisk);
  const notes = [];
  const ensembleNote = buildEnsembleNote(analysis?.ensembleBrain || analysis?.decisionProfile?.ensemble);
  if (calibration?.nonTieWilsonLower) {
    notes.push(`保守 ${formatRate(calibration.nonTieWilsonLower)} / 基準 ${formatSignedRate(calibration.lowerEdgeVsBaseline)}`);
  }
  if (fiveStepNote) notes.push(fiveStepNote);
  if (ensembleNote) notes.push(ensembleNote);
  return notes.join(" · ");
}

function buildEnsembleNote(ensemble) {
  if (!ensemble) return "";
  const validation = ensemble.validation || {};
  const direction = ensemble.probabilityDirection || ensemble.directional || {};
  const economic = ensemble.economicPreference || direction;
  const quality = validation.approved ? "通過" : "未通過";
  const drift = ensemble.drift?.detected ? " / 漂移降權" : "";
  return `AI${quality} 機率${direction.label || "-"}${formatRate(direction.rate || 0.5)} / EV較優${economic.label || "-"}${formatSignedRate(economic.expectedValue || 0)} / Brier lift ${Number(validation.pairedBrierLift || 0).toFixed(5)}${drift}`;
}

function directionModeLabel(mode) {
  const labelsByMode = {
    quality: "品質通過",
    "validated-ensemble": "驗證 AI",
    "trend-ai-agree": "五路與 AI 同向",
    "trend-composite": "五路投票趨勢",
    "probability-baseline": "機率基準"
  };
  return labelsByMode[mode] || "路型綜合";
}

function buildFiveStepNote(fiveStep) {
  if (!fiveStep) return "";
  const samples = Number(fiveStep.samples || 0);
  if (!samples) return "";
  const completion = Number(fiveStep.completionRate || 0);
  const failure = Number(fiveStep.failureRate || 0);
  const lower = Number(fiveStep.completionWilsonLower || fiveStep.fiveStepWilsonLower || 0);
  const baseline = Number(fiveStep.baselineCompletionRate || fiveStep.fiveStepBaselineCompletionRate || 0);
  const lift = Number(fiveStep.completionLift || fiveStep.fiveStepLiftVsNatural || 0);
  const averageStep = Number(fiveStep.averageStep || fiveStep.fiveStepAverageStep || 0);
  const action = fiveStep.action === "advise" ? "通過" : "未過";
  const stepText = averageStep ? ` / 均${averageStep.toFixed(2)}注` : "";
  return `5注${action} 完成${formatRate(completion)} / 自然${formatRate(baseline)} / 超額${formatSignedRate(lift)} / 下限${formatRate(lower)} / ${samples}樣本${stepText}`;
}

function settleBet(betResult, actualResult, stake) {
  if (actualResult === "tie") return { type: "push", units: 0 };
  if (betResult === actualResult) {
    const payout = betResult === "banker" ? Number(state.config.bankerPayout || 0.95) : 1;
    return { type: "win", units: roundUnits(stake * payout) };
  }
  return { type: "loss", units: roundUnits(-stake) };
}

function makeRound(result, handNumber, source) {
  return {
    result,
    handNumber,
    source,
    observedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
}

function currentManualTable() {
  if (!state.tables.length) return null;
  if (state.manual.selectedTableId) {
    return state.tables.find((table) => table.id === state.manual.selectedTableId) || null;
  }
  return state.tables[state.manual.tableIndex % state.tables.length] || null;
}

function currentStake(step) {
  const ladder = ladders[state.config.ladder] || ladders.flat;
  const multiplier = ladder[Math.max(0, Math.min(4, Number(step || 1) - 1))] || 1;
  return roundUnits(Number(state.config.baseStake || 1) * multiplier);
}

function addManualRecord(advice, actualResult, settlement) {
  state.manual.records.unshift({
    at: new Date().toISOString(),
    tableCode: advice.tableCode || currentManualTable()?.tableCode || "",
    step: advice.step,
    stake: advice.stake,
    bet: advice.result,
    actual: actualResult,
    settlement: settlement.type,
    units: settlement.units
  });
  state.manual.records = state.manual.records.slice(0, manualRecordLimit);
}

function restoreManualTableLock(tableLock) {
  state.manual.selectedTableId = tableLock.selectedTableId;
  state.manual.tableIndex = tableLock.tableIndex;
}

function resetManualSession() {
  manualAnalyzeRunId += 1;
  manualAnalyzeQueued = false;
  const selectedTableId = state.manual.selectedTableId;
  const tableIndex = state.manual.tableIndex;
  state.manual = {
    ...state.manual,
    selectedTableId,
    tableIndex,
    sequence: [],
    step: 1,
    units: 0,
    betCount: 0,
    winCount: 0,
    lossCount: 0,
    pushCount: 0,
    failedSets: 0,
    pendingAdvice: null,
    activeSet: null,
    analysisNote: "",
    records: []
  };
  state.events = [];
}

function logEvent(mode, action, table, message, units = 0, tone = "neutral") {
  state.events.unshift({
    at: new Date().toISOString(),
    mode,
    action,
    tableCode: table?.tableCode || table?.name || "-",
    message,
    units: roundUnits(units),
    tone
  });
  state.events = state.events.slice(0, eventLimit);
}

function render() {
  renderStatus();
  renderManual();
  renderEvents();
}

function renderStatus() {
  const status = state.status || {};
  const table = currentManualTable();
  els.historyRoundCount.textContent = `${Number(status.rounds || 0).toLocaleString("zh-TW")} 局`;
  els.historyTableCount.textContent = `${Number(status.allbetTables || state.tables.length || 0)} 桌`;
  els.historyUpdateAt.textContent = status.updatedAt ? formatDateTime(status.updatedAt) : "-";
  els.loadedTables.textContent = `${state.tables.length || 0} 桌`;
  els.currentTableName.textContent = tableLabel(table);
}

function renderManual() {
  const stake = currentStake(state.manual.step);
  els.manualCount.textContent = `${state.manual.sequence.length} 手`;
  els.manualUnits.textContent = `${formatUnits(state.manual.units)} 注`;
  els.manualHitRate.textContent = percent(state.manual.winCount, state.manual.betCount);
  els.manualBetCount.textContent = String(state.manual.betCount);
  els.manualWinCount.textContent = String(state.manual.winCount);
  els.manualLossCount.textContent = String(state.manual.lossCount);
  els.manualFailedSets.textContent = String(state.manual.failedSets);
  els.manualPushCount.textContent = String(state.manual.pushCount);
  els.manualStep.textContent = String(state.manual.step);
  els.manualStake.textContent = formatUnits(stake);
  renderManualSequence();
  renderManualAdvice();
  renderLadder();
}

function renderManualSequence() {
  els.manualSequence.replaceChildren();
  state.manual.sequence.forEach((round, index) => {
    const chip = document.createElement("span");
    chip.className = `sequence-chip ${round.result}`;
    chip.title = `第 ${index + 1} 手`;
    chip.textContent = labels[round.result] || "?";
    els.manualSequence.append(chip);
  });
  if (!state.manual.sequence.length) {
    const empty = document.createElement("span");
    empty.textContent = "-";
    empty.className = "neutral";
    els.manualSequence.append(empty);
  }
}

function renderManualAdvice() {
  if (analyzingManual) {
    els.manualAdvice.textContent = "分析中";
    els.manualAdviceMeta.textContent = "正在比對目前牌序與歷史資料";
    return;
  }
  const advice = state.manual.pendingAdvice;
  if (!advice) {
    const needed = Math.max(0, windowSize - state.manual.sequence.length);
    els.manualAdvice.textContent = needed ? `等待 ${needed} 手` : state.manual.analysisNote ? "觀察" : "可分析";
    els.manualAdviceMeta.textContent = state.manual.analysisNote || "顯示樣本外驗證、含佣金期望與 5 注自然基準";
    return;
  }
  const table = currentManualTable();
  els.manualAdvice.textContent = `${tableLabel(table)} · ${advice.label} ${formatUnits(advice.stake)} 注`;
  els.manualAdviceMeta.textContent = `第 ${advice.step} 注 · ${advice.source || "analysis"} · 參考 ${formatRate(advice.rate)}${advice.conservativeNote ? ` · ${advice.conservativeNote}` : ""}`;
}

function renderLadder() {
  els.ladderBoard.replaceChildren();
  const ladder = ladders[state.config.ladder] || ladders.flat;
  ladder.forEach((multiplier, index) => {
    const item = document.createElement("div");
    item.className = "ladder-step";
    if (index + 1 === state.manual.step) item.classList.add("active");
    if (index + 1 < state.manual.step) item.classList.add("done");
    const title = document.createElement("span");
    title.textContent = `第 ${index + 1} 注`;
    const value = document.createElement("strong");
    value.textContent = formatUnits(Number(state.config.baseStake || 1) * multiplier);
    item.append(title, value);
    els.ladderBoard.append(item);
  });
}

function renderEvents() {
  els.eventLog.replaceChildren();
  const rows = state.events.slice(0, 80);
  rows.forEach((event) => {
    const row = document.createElement("div");
    row.className = "event-row";
    const time = document.createElement("span");
    time.textContent = formatTime(event.at);
    const mode = document.createElement("span");
    mode.textContent = event.mode === "manual" ? "提醒" : "系統";
    const action = document.createElement("b");
    action.textContent = event.action;
    const message = document.createElement("span");
    message.textContent = `${event.tableCode} · ${event.message}`;
    const units = document.createElement("b");
    units.className = `event-units ${event.tone || "neutral"}`;
    units.textContent = Number(event.units || 0) ? `${event.units > 0 ? "+" : ""}${formatUnits(event.units)}` : "-";
    row.append(time, mode, action, message, units);
    els.eventLog.append(row);
  });
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "event-row";
    empty.textContent = "-";
    els.eventLog.append(empty);
  }
}

function renderTableOptions() {
  const current = state.manual.selectedTableId || "";
  els.manualTableSelect.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部 36 桌";
  els.manualTableSelect.append(all);
  state.tables.forEach((table) => {
    const option = document.createElement("option");
    option.value = table.id;
    option.textContent = `${table.tableCode || table.name || table.id} · ${Number(table.rounds || 0).toLocaleString("zh-TW")} 局`;
    els.manualTableSelect.append(option);
  });
  els.manualTableSelect.value = state.tables.some((table) => table.id === current) ? current : "";
}

function syncInputsFromConfig() {
  els.baseStakeInput.value = state.config.baseStake;
  els.ladderSelect.value = state.config.ladder;
  els.bankerPayoutInput.value = state.config.bankerPayout;
}

function syncConfigFromInputs() {
  state.config = sanitizeConfig({
    baseStake: els.baseStakeInput.value,
    ladder: els.ladderSelect.value,
    bankerPayout: els.bankerPayoutInput.value
  });
}

function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    if (saved.config) state.config = sanitizeConfig({ ...state.config, ...saved.config });
    if (saved.manual) state.manual = sanitizeManualState({ ...state.manual, ...saved.manual });
    if (Array.isArray(saved.events)) state.events = sanitizeEvents(saved.events);
  } catch (_) {}
}

function clearLegacySessions() {
  try {
    legacyStorageKeys.forEach((key) => localStorage.removeItem(key));
  } catch (_) {}
}

function sanitizeConfig(config = {}) {
  return {
    baseStake: clamp(Number(config.baseStake || 1), 0.1, 100000),
    ladder: ladders[config.ladder] ? config.ladder : "flat",
    bankerPayout: clamp(Number(config.bankerPayout || 0.95), 0.5, 1.2)
  };
}

function sanitizeManualState(manual = {}) {
  const sequence = Array.isArray(manual.sequence)
    ? manual.sequence.map(sanitizeRound).filter(Boolean).slice(-manualSequenceLimit)
    : [];
  const records = Array.isArray(manual.records)
    ? manual.records.map(sanitizeRecord).filter(Boolean).slice(0, manualRecordLimit)
    : [];
  return {
    ...state.manual,
    selectedTableId: safeText(manual.selectedTableId, 120),
    tableIndex: safeInteger(manual.tableIndex, 0, 10_000, 0),
    sequence,
    step: safeInteger(manual.step, 1, 5, 1),
    units: roundUnits(clamp(Number(manual.units || 0), -10_000_000, 10_000_000)),
    betCount: safeInteger(manual.betCount, 0, 1_000_000, 0),
    winCount: safeInteger(manual.winCount, 0, 1_000_000, 0),
    lossCount: safeInteger(manual.lossCount, 0, 1_000_000, 0),
    pushCount: safeInteger(manual.pushCount, 0, 1_000_000, 0),
    failedSets: safeInteger(manual.failedSets, 0, 1_000_000, 0),
    pendingAdvice: sanitizeAdvice(manual.pendingAdvice),
    activeSet: sanitizeActiveSet(manual.activeSet),
    analysisNote: safeText(manual.analysisNote, 320),
    records
  };
}

function sanitizeAdvice(advice) {
  if (!advice || !["banker", "player"].includes(advice.result)) return null;
  const createdAt = safeIso(advice.createdAt);
  if (Date.now() - new Date(createdAt).getTime() > adviceMaxAgeMs) return null;
  return {
    result: advice.result,
    label: labels[advice.result],
    rate: clamp(Number(advice.rate || 0), 0, 1),
    source: safeText(advice.source || advice.sourceType || "analysis", 80),
    conservativeNote: safeText(advice.conservativeNote || "", 220),
    tableId: safeText(advice.tableId, 120),
    tableCode: safeText(advice.tableCode, 40),
    stake: roundUnits(clamp(Number(advice.stake || 1), 0.1, 100000)),
    step: safeInteger(advice.step, 1, 5, 1),
    createdAt,
    sourceType: safeText(advice.sourceType, 80)
  };
}

function sanitizeActiveSet(activeSet) {
  if (!activeSet || !["banker", "player"].includes(activeSet.result)) return null;
  return {
    result: activeSet.result,
    label: labels[activeSet.result],
    rate: clamp(Number(activeSet.rate || 0), 0, 1),
    source: safeText(activeSet.source || "quality-gate", 100),
    conservativeNote: safeText(activeSet.conservativeNote || "", 220),
    fiveStepNote: safeText(activeSet.fiveStepNote || "", 220),
    tableId: safeText(activeSet.tableId, 120),
    tableCode: safeText(activeSet.tableCode, 40),
    startedAt: safeIso(activeSet.startedAt)
  };
}

function sanitizeRound(round, index) {
  const result = typeof round === "string" ? round : round?.result;
  if (!labels[result]) return null;
  return {
    result,
    handNumber: safeInteger(round?.handNumber, 1, 1_000_000, index + 1),
    source: safeText(round?.source || "manual", 30),
    observedAt: safeIso(round?.observedAt),
    createdAt: safeIso(round?.createdAt)
  };
}

function sanitizeRecord(record) {
  if (!record || !["banker", "player"].includes(record.bet) || !labels[record.actual]) return null;
  return {
    at: safeIso(record.at),
    tableCode: safeText(record.tableCode, 40),
    step: safeInteger(record.step, 1, 5, 1),
    stake: roundUnits(clamp(Number(record.stake || 1), 0.1, 100000)),
    bet: record.bet,
    actual: record.actual,
    settlement: ["win", "loss", "push"].includes(record.settlement) ? record.settlement : "loss",
    units: roundUnits(clamp(Number(record.units || 0), -100000, 100000))
  };
}

function sanitizeEvents(events = []) {
  return events.map((event) => ({
    at: safeIso(event?.at),
    mode: event?.mode === "manual" ? "manual" : "system",
    action: safeText(event?.action, 40),
    tableCode: safeText(event?.tableCode || "-", 40),
    message: safeText(event?.message, 240),
    units: roundUnits(clamp(Number(event?.units || 0), -100000, 100000)),
    tone: ["profit", "loss", "neutral"].includes(event?.tone) ? event.tone : "neutral"
  })).slice(0, eventLimit);
}

function safeText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

function safeInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(clamp(number, min, max));
}

function safeIso(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function persistSession() {
  const payload = {
    config: state.config,
    manual: state.manual,
    events: state.events
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (_) {}
}

function exportSession(type) {
  const payload = {
    exportedAt: new Date().toISOString(),
    status: state.status,
    tables: state.tables,
    config: state.config,
    manual: state.manual,
    events: state.events
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (type === "csv") {
    const rows = [
      ["section", "time", "table", "step", "bet", "actual", "settlement", "stake", "units", "message"],
      [
        "summary",
        payload.exportedAt,
        currentManualTable()?.tableCode || "",
        state.manual.step,
        "",
        "",
        "",
        currentStake(state.manual.step),
        state.manual.units,
        `bets=${state.manual.betCount};wins=${state.manual.winCount};losses=${state.manual.lossCount};pushes=${state.manual.pushCount};failedSets=${state.manual.failedSets}`
      ],
      ...state.manual.records.slice().reverse().map((record) => [
        "record",
        record.at,
        record.tableCode,
        record.step,
        labels[record.bet] || record.bet,
        labels[record.actual] || record.actual,
        record.settlement,
        record.stake,
        record.units,
        ""
      ]),
      ...state.events.slice().reverse().map((event) => [
        "event",
        event.at,
        event.tableCode,
        "",
        "",
        "",
        event.action,
        "",
        event.units,
        event.message
      ])
    ];
    downloadFile(`baijia-advisor-${stamp}.csv`, rows.map((row) => row.map(csvCell).join(",")).join("\n"), "text/csv;charset=utf-8");
    return;
  }
  downloadFile(`baijia-advisor-${stamp}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || apiTimeoutMs));
  const requestOptions = { ...options, signal: controller.signal };
  delete requestOptions.timeoutMs;
  try {
    const response = await fetch(path, requestOptions);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!response.ok) {
      throw new Error(json?.error || text || `HTTP ${response.status}`);
    }
    return json;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("API 請求逾時，請稍後再分析。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTable(table, index) {
  const code = table.tableCode || table.name || table.id || tableFallbackCodes[index] || `T${index + 1}`;
  return {
    id: table.id || `advisor-${code}`,
    tableCode: code,
    name: table.name || code,
    rounds: Number(table.rounds || 0),
    lastSeenAt: table.lastSeenAt || ""
  };
}

function buildFallbackTables() {
  return tableFallbackCodes.map((code) => ({
    id: `advisor-${code}`,
    tableCode: code,
    name: `Baccarat ${code}`,
    rounds: 0,
    lastSeenAt: ""
  }));
}

function tableLabel(table) {
  if (!table) return "-";
  return table.tableCode || table.name || table.id || "-";
}

function percent(part, total) {
  return total ? `${((Number(part || 0) / Number(total || 1)) * 100).toFixed(1)}%` : "0.0%";
}

function formatRate(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "-";
}

function formatSignedRate(value) {
  if (!Number.isFinite(Number(value))) return "-";
  const number = Number(value) * 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function formatUnits(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function roundUnits(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-TW", { hour12: false });
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-TW", { hour12: false });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}
