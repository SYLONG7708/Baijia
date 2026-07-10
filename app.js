const labels = {
  banker: "莊",
  player: "閒",
  tie: "和",
  bankerPair: "莊對",
  playerPair: "閒對",
  luckySix: "幸運6"
};

const cardRanks = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const cardValues = { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 0, J: 0, Q: 0, K: 0 };
const cardSideNames = { banker: "莊", player: "閒" };
const apiTimeoutMs = 15_000;

const state = {
  status: null,
  analysis: null,
  pattern: [],
  pendingFlags: {
    bankerPair: false,
    playerPair: false,
    luckySix: false
  },
  pendingCards: {
    banker: [],
    player: []
  },
  analysisTables: [],
  selectedTableId: "",
  lastAnalyzedKey: "",
  pendingPrediction: null,
  predictionChecks: []
};

const isLiveMode = document.body?.dataset?.mode === "live";

const els = {
  serverBadge: document.getElementById("serverBadge"),
  refreshBtn: document.getElementById("refreshBtn"),
  statusRoundCount: document.getElementById("statusRoundCount"),
  statusUpdateAt: document.getElementById("statusUpdateAt"),
  allbetTableCount: document.getElementById("allbetTableCount"),
  patternCount: document.getElementById("patternCount"),
  nextResult: document.getElementById("nextResult"),
  nextDescription: document.getElementById("nextDescription"),
  savedDataCount: document.getElementById("savedDataCount"),
  sidePrediction: document.getElementById("sidePrediction"),
  advancedAnalysis: document.getElementById("advancedAnalysis"),
  patternButtons: [...document.querySelectorAll(".pattern-result-btn")],
  sideFlagButtons: [...document.querySelectorAll(".side-flag-btn")],
  cardButtons: [...document.querySelectorAll("[data-card-rank]")],
  cardPairButtons: [...document.querySelectorAll("[data-card-pair]")],
  cardClearButtons: [...document.querySelectorAll("[data-card-clear]")],
  cardSummaries: Object.fromEntries([...document.querySelectorAll("[data-card-summary]")].map((item) => [item.dataset.cardSummary, item])),
  analysisTableSelect: document.getElementById("analysisTableSelect"),
  patternInput: document.getElementById("patternInput"),
  undoPatternBtn: document.getElementById("undoPatternBtn"),
  clearPatternBtn: document.getElementById("clearPatternBtn"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  collectorMessage: document.getElementById("collectorMessage")
};

let autoAnalyzeTimer = null;

init();

function init() {
  bindEvents();
  renderPendingFlags();
  renderPendingCards();
  renderPattern();
  renderAnalysis();
  if (!isLiveMode) {
    loadStatus();
    loadAnalysisTables();
    setInterval(loadStatus, 60_000);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  els.refreshBtn?.addEventListener("click", loadStatus);
  els.analyzeBtn.addEventListener("click", analyzeInput);

  els.patternButtons.forEach((button) => {
    button.addEventListener("click", () => appendPatternResult(button.dataset.result));
  });
  els.sideFlagButtons.forEach((button) => {
    button.addEventListener("click", () => togglePendingFlag(button.dataset.flag));
  });
  els.cardButtons.forEach((button) => {
    button.addEventListener("click", () => addPendingCard(button.dataset.cardSide, button.dataset.cardRank));
  });
  els.cardPairButtons.forEach((button) => {
    button.addEventListener("click", () => applyPendingPair(button.dataset.cardPair));
  });
  els.cardClearButtons.forEach((button) => {
    button.addEventListener("click", () => clearPendingCardSide(button.dataset.cardClear));
  });
  els.analysisTableSelect?.addEventListener("change", () => {
    state.selectedTableId = els.analysisTableSelect.value || "";
    state.lastAnalyzedKey = "";
    if (state.pattern.length >= 8) maybeAutoAnalyze();
  });

  els.undoPatternBtn.addEventListener("click", () => {
    const nextLength = state.pattern.length;
    if (state.predictionChecks[0]?.handNumber === nextLength) {
      state.predictionChecks.shift();
    }
    state.pattern.pop();
    renderPattern();
    if (state.pattern.length < 8) {
      state.analysis = null;
      state.pendingPrediction = null;
      renderAnalysis();
      return;
    }
    maybeAutoAnalyze();
  });

  els.clearPatternBtn.addEventListener("click", () => {
    state.pattern = [];
    resetPendingFlags();
    resetPendingCards();
    state.analysis = null;
    state.lastAnalyzedKey = "";
    state.pendingPrediction = null;
    state.predictionChecks = [];
    renderPattern();
    renderAnalysis();
  });
}

async function loadStatus() {
  if (isLiveMode) return;
  try {
    const status = await api("/api/status");
    state.status = status;
    if (els.statusRoundCount) els.statusRoundCount.textContent = `${Number(status.rounds || 0).toLocaleString("zh-TW")} 局`;
    if (els.statusUpdateAt) els.statusUpdateAt.textContent = formatDateTime(status.updatedAt);
    if (els.allbetTableCount) els.allbetTableCount.textContent = `${Number(status.allbetTables || 0)} 桌`;
    if (els.savedDataCount) els.savedDataCount.textContent = `已保存 ${Number(status.rounds || 0).toLocaleString("zh-TW")} 局`;
    if (els.serverBadge) {
      els.serverBadge.textContent = "本機正常";
      els.serverBadge.className = "status-pill ok";
    }
    if (els.collectorMessage) els.collectorMessage.textContent = status.collector?.lastMessage || status.collector?.lastError || "等待抓取";
  } catch (error) {
    if (els.serverBadge) {
      els.serverBadge.textContent = "API 未連線";
      els.serverBadge.className = "status-pill bad";
    }
    if (els.statusRoundCount) els.statusRoundCount.textContent = "0 局";
    if (els.collectorMessage) els.collectorMessage.textContent = error.message;
  }
}

async function loadAnalysisTables() {
  if (isLiveMode || !els.analysisTableSelect) return;
  try {
    const json = await api("/api/analysis/tables");
    state.analysisTables = Array.isArray(json.tables) ? json.tables : [];
    renderAnalysisTableOptions();
  } catch (_) {
    state.analysisTables = [];
  }
}

function renderAnalysisTableOptions() {
  if (!els.analysisTableSelect) return;
  const current = els.analysisTableSelect.value || state.selectedTableId || "";
  els.analysisTableSelect.innerHTML = `
    <option value="">全部 36 桌</option>
    ${state.analysisTables.map((table) => `
      <option value="${escapeHtml(table.id)}">${escapeHtml(table.tableCode || table.name || table.id)} · ${Number(table.rounds || 0).toLocaleString("zh-TW")} 局</option>
    `).join("")}
  `;
  els.analysisTableSelect.value = state.analysisTables.some((table) => table.id === current) ? current : "";
  state.selectedTableId = els.analysisTableSelect.value || "";
}

function appendPatternResult(result) {
  if (!["banker", "player", "tie"].includes(result)) return;
  const checkedPrediction = recordPredictionCheck(result);
  state.pattern.push(makeManualRound(result));
  resetPendingFlags();
  resetPendingCards();
  renderPattern();
  if (checkedPrediction && state.analysis) {
    renderAnalysis();
  }
  maybeAutoAnalyze();
}

function togglePendingFlag(flag) {
  if (!["bankerPair", "playerPair", "luckySix"].includes(flag)) return;
  state.pendingFlags[flag] = !state.pendingFlags[flag];
  renderPendingFlags();
}

function resetPendingFlags() {
  state.pendingFlags = {
    bankerPair: false,
    playerPair: false,
    luckySix: false
  };
  renderPendingFlags();
}

function resetPendingCards() {
  state.pendingCards = {
    banker: [],
    player: []
  };
  renderPendingCards();
}

function renderPendingFlags() {
  els.sideFlagButtons.forEach((button) => {
    const active = Boolean(state.pendingFlags[button.dataset.flag]);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function addPendingCard(side, rank) {
  if (!["banker", "player"].includes(side)) return;
  const normalized = normalizeCardRank(rank);
  if (!normalized) return;
  const cards = state.pendingCards[side].slice(0, 3);
  if (cards.length >= 3) cards.shift();
  cards.push(normalized);
  state.pendingCards[side] = cards;
  syncPairFlagFromCards(side);
  renderPendingCards();
}

function applyPendingPair(side) {
  if (!["banker", "player"].includes(side)) return;
  const cards = state.pendingCards[side].slice(0, 3);
  if (cards.length >= 1) {
    state.pendingCards[side] = [cards[0], cards[0], ...cards.slice(2)].slice(0, 3);
  }
  const flag = side === "banker" ? "bankerPair" : "playerPair";
  state.pendingFlags[flag] = true;
  renderPendingFlags();
  renderPendingCards();
}

function clearPendingCardSide(side) {
  if (!["banker", "player"].includes(side)) return;
  state.pendingCards[side] = [];
  const flag = side === "banker" ? "bankerPair" : "playerPair";
  state.pendingFlags[flag] = false;
  renderPendingFlags();
  renderPendingCards();
}

function syncPairFlagFromCards(side) {
  const flag = side === "banker" ? "bankerPair" : "playerPair";
  const cards = state.pendingCards[side] || [];
  if (cards.length >= 2) state.pendingFlags[flag] = isPair(cards);
  renderPendingFlags();
}

function renderPendingCards() {
  for (const side of ["banker", "player"]) {
    const cards = state.pendingCards[side] || [];
    const points = cardPoints(cards);
    const text = cards.length
      ? `${cards.join(" ")} · ${points}點${isPair(cards) ? " · 對子" : ""}`
      : "未輸入";
    if (els.cardSummaries[side]) els.cardSummaries[side].textContent = text;
  }
  els.cardPairButtons.forEach((button) => {
    const side = button.dataset.cardPair;
    const active = side === "banker" ? state.pendingFlags.bankerPair : state.pendingFlags.playerPair;
    button.classList.toggle("active", Boolean(active));
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function makeManualRound(result) {
  const bankerCards = (state.pendingCards.banker || []).slice(0, 3);
  const playerCards = (state.pendingCards.player || []).slice(0, 3);
  const bankerPoints = cardPoints(bankerCards);
  const playerPoints = cardPoints(playerCards);
  const bankerPair = Boolean(state.pendingFlags.bankerPair) || isPair(bankerCards);
  const playerPair = Boolean(state.pendingFlags.playerPair) || isPair(playerCards);
  const luckySix = Boolean(state.pendingFlags.luckySix) || (result === "banker" && bankerPoints === 6);
  return {
    result,
    bankerPair,
    playerPair,
    luckySix,
    bankerCards,
    playerCards,
    bankerPoints,
    playerPoints
  };
}

function normalizeCardRank(value) {
  const key = String(value || "").trim().toUpperCase();
  if (key === "A" || key === "ACE" || key === "01") return "1";
  if (key === "T") return "10";
  return cardRanks.includes(key) ? key : "";
}

function cardPoints(cards = []) {
  if (!cards.length) return null;
  return cards.reduce((sum, rank) => sum + (cardValues[normalizeCardRank(rank)] || 0), 0) % 10;
}

function isPair(cards = []) {
  return cards.length >= 2 && cards[0] === cards[1];
}

function formatCardSide(side, cards = [], points = null) {
  const filtered = (Array.isArray(cards) ? cards : []).map(normalizeCardRank).filter(Boolean);
  if (!filtered.length) return "";
  const value = Number.isFinite(Number(points)) ? Number(points) : cardPoints(filtered);
  return `${cardSideNames[side]}[${filtered.join(",")}:${value}]`;
}

function renderPattern() {
  const visible = state.pattern.map(formatManualRound).join(" ");
  els.patternInput.value = visible;
  els.patternCount.textContent = `${state.pattern.length} 手`;
}

function getPatternWindow() {
  return state.pattern.slice(-8);
}

function maybeAutoAnalyze() {
  const latest = getPatternWindow();
  if (latest.length < 8) {
    state.lastAnalyzedKey = "";
    clearTimeout(autoAnalyzeTimer);
    return;
  }
  const key = buildAnalysisKey(latest);
  if (key === state.lastAnalyzedKey) return;
  clearTimeout(autoAnalyzeTimer);
  autoAnalyzeTimer = setTimeout(() => {
    if (buildAnalysisKey(getPatternWindow()) !== key) return;
    analyzeInput();
  }, 180);
}

async function analyzeInput() {
  const sequence = getPatternWindow();
  if (sequence.length < 8) {
    state.analysis = null;
    state.pendingPrediction = null;
    renderAnalysis();
    return;
  }

  const tableId = getSelectedAnalysisTableId();
  const key = buildAnalysisKey(sequence);
  state.lastAnalyzedKey = key;
  els.nextResult.textContent = "分析中";
  els.nextDescription.textContent = tableId ? "使用指定桌台近期路型比對" : "使用全部 36 桌近期路型比對";
  try {
    state.analysis = await api("/api/analyze", {
      method: "POST",
      body: {
        scope: tableId ? "table" : "all",
        tableId,
        limit: tableId ? 1200 : 7200,
        localOnly: false,
        sequence,
        manualSequence: state.pattern
      }
    });
    state.pendingPrediction = buildPendingPrediction(state.analysis, key);
    renderAnalysis();
  } catch (error) {
    state.analysis = null;
    state.pendingPrediction = null;
    els.nextResult.textContent = "分析失敗";
    els.nextDescription.textContent = error.message;
    els.sidePrediction.innerHTML = renderEmptyProbability();
    if (els.advancedAnalysis) els.advancedAnalysis.innerHTML = "";
  }
}

function getSelectedAnalysisTableId() {
  if (isLiveMode) return "";
  return els.analysisTableSelect?.value || state.selectedTableId || "";
}

function buildAnalysisKey(rounds) {
  return `${getSelectedAnalysisTableId() || "all"}::${rounds.map(roundKey).join("|")}`;
}

function recordPredictionCheck(actualResult) {
  if (!state.pendingPrediction || state.pattern.length < 8) return false;
  const prediction = state.pendingPrediction;
  const same = prediction.result === actualResult;
  state.predictionChecks.unshift({
    handNumber: state.pattern.length + 1,
    basisKey: prediction.basisKey,
    expected: prediction.result,
    expectedLabel: prediction.label,
    actual: actualResult,
    actualLabel: labels[actualResult] || actualResult,
    rate: prediction.rate,
    source: prediction.source,
    same,
    mark: same ? "OK" : "XX",
    checkedAt: new Date().toISOString()
  });
  state.predictionChecks = state.predictionChecks.slice(0, 8);
  state.pendingPrediction = null;
  return true;
}

function buildPendingPrediction(analysis, basisKey) {
  const profile = analysis?.decisionProfile;
  if (profile) {
    if (profile.action !== "advise" || !["banker", "player"].includes(profile.result)) {
      const forced = profile.forced || null;
      if (!forced || !["banker", "player"].includes(forced.result)) return null;
      return {
        result: forced.result,
        label: forced.label || labels[forced.result],
        rate: forced.rate,
        source: forced.qualityPassed
          ? `品質通過 · ${forced.source || "quality-gate"}`
          : `每局方向估計 · ${forced.source || "online-ensemble"}`,
        basisKey
      };
    }
    return {
      result: profile.result,
      label: profile.label,
      rate: profile.rate,
      source: `${profile.levelLabel || "品質"} · ${profile.source || "quality-gate"}`,
      basisKey
    };
  }
  const preferred = analysis?.roadBreakdown?.overall?.preferred;
  const highest = analysis?.roadBreakdown?.overall?.highest;
  const consensus = analysis?.roadBreakdown?.overall?.consensus;
  const next = analysis?.nextResult;
  const candidate = ["banker", "player"].includes(preferred?.result)
    ? {
      result: preferred.result,
      label: preferred.label,
      rate: preferred.rate,
      source: preferred.roadLabel || preferred.strategy || "五路統整"
    }
    : ["banker", "player"].includes(highest?.result)
    ? {
      result: highest.result,
      label: highest.label,
      rate: highest.rate,
      source: highest.roadLabel || "路單最高百分比"
    }
    : ["banker", "player"].includes(consensus?.result)
      ? {
        result: consensus.result,
        label: consensus.label,
        rate: consensus.rate,
        source: "五路統整"
      }
      : {
        result: next?.result || "neutral",
        label: next?.label || "-",
        rate: next?.rate || 0,
        source: "歷史資料"
      };
  return {
    ...candidate,
    basisKey
  };
}

function roundResult(round) {
  return typeof round === "string" ? round : round?.result;
}

function roundKey(round) {
  const result = roundResult(round) || "";
  const item = typeof round === "string" ? { result } : round || {};
  return [
    result,
    item.bankerPair ? "BP" : "",
    item.playerPair ? "PP" : "",
    item.luckySix ? "L6" : "",
    (item.bankerCards || []).join("-"),
    (item.playerCards || []).join("-"),
    item.bankerPoints !== null && item.bankerPoints !== undefined && Number.isFinite(Number(item.bankerPoints)) ? `B${item.bankerPoints}` : "",
    item.playerPoints !== null && item.playerPoints !== undefined && Number.isFinite(Number(item.playerPoints)) ? `P${item.playerPoints}` : ""
  ].filter(Boolean).join("+");
}

function formatManualRound(round) {
  const result = roundResult(round);
  const item = typeof round === "string" ? { result } : round || {};
  const extra = [];
  if (item.bankerPair) extra.push(labels.bankerPair);
  if (item.playerPair) extra.push(labels.playerPair);
  if (item.luckySix) extra.push(labels.luckySix);
  const bankerCards = formatCardSide("banker", item.bankerCards, item.bankerPoints);
  const playerCards = formatCardSide("player", item.playerCards, item.playerPoints);
  if (bankerCards) extra.push(bankerCards);
  if (playerCards) extra.push(playerCards);
  return [labels[result] || result, ...extra].filter(Boolean).join("+");
}

function renderAnalysis() {
  const analysis = state.analysis;
  if (!analysis) {
    els.nextResult.textContent = "等待 8 手";
    els.nextDescription.textContent = "輸入莊、閒、和後自動分析最近 8 手";
    els.sidePrediction.innerHTML = renderEmptyProbability();
    if (els.advancedAnalysis) els.advancedAnalysis.innerHTML = "";
    return;
  }

  const top = getDisplayPrediction(analysis);
  els.nextResult.textContent = `${top.label || "-"} ${percent(top.rate)}`;
  els.nextDescription.textContent = renderDecisionSummaryText(analysis);
  els.sidePrediction.innerHTML = renderProbabilityList(analysis.fullRates || []);
  if (els.advancedAnalysis) {
    els.advancedAnalysis.innerHTML = renderAdvancedAnalysis(
      analysis.decisionProfile,
      analysis.advanced,
      analysis.roadBreakdown,
      analysis.cardModel,
      state.predictionChecks
    );
  }
}

function getDisplayPrediction(analysis) {
  const profile = analysis?.decisionProfile;
  if (profile) {
    if (profile.action === "advise" && ["banker", "player"].includes(profile.result)) {
      return profile;
    }
    const forced = profile.forced || null;
    if (forced && ["banker", "player"].includes(forced.result)) {
      return {
        result: forced.result,
        label: forced.label || labels[forced.result],
        rate: forced.rate || 0.5
      };
    }
    return {
      result: "neutral",
      label: "觀察",
      rate: profile.score || 0.5
    };
  }
  const preferred = analysis?.roadBreakdown?.overall?.preferred;
  if (["banker", "player"].includes(preferred?.result)) return preferred;
  return analysis?.nextResult || { label: "-", rate: 0 };
}

function renderDecisionSummaryText(analysis) {
  const runtimeText = renderRuntimeText(analysis?.runtime);
  const profile = analysis?.decisionProfile;
  if (!profile) return runtimeText;
  const forcedText = profile.action === "advise" ? "品質通過" : profile.forced ? "僅方向估計" : "觀察";
  return `${runtimeText} · ${forcedText} · ${profile.levelLabel || "-"} ${percent(profile.score)}`;
}

function renderRuntimeText(runtime) {
  if (!runtime) return "";
  if (runtime.localOnly) return `現場版 · 只用輸入資料 · ${Number(runtime.analyzeMs || 0)}ms`;
  const scope = runtime.scope === "table" ? `指定桌 ${runtime.tableCode || ""}`.trim() : "全部 36 桌";
  return `${scope} · ${Number(runtime.roundsLoaded || 0).toLocaleString("zh-TW")} 局 · ${Number(runtime.analyzeMs || 0)}ms`;
}

function renderEmptyProbability() {
  return ["banker", "player", "tie", "bankerPair", "playerPair", "luckySix"].map((key) => `
    <div class="probability-chip">
      <span>${labels[key]}</span>
      <b>0.0%</b>
    </div>
  `).join("");
}

function renderProbabilityList(items = []) {
  const order = ["banker", "player", "tie", "bankerPair", "playerPair", "luckySix"];
  const byKey = new Map();
  for (const item of items) {
    byKey.set(item.key || item.result, {
      label: item.label || labels[item.key || item.result],
      rate: Number(item.rate || 0),
      count: Number(item.count || 0)
    });
  }
  return order.map((key) => {
    const item = byKey.get(key) || { label: labels[key], rate: 0, count: 0 };
    const strong = item.rate >= 0.58;
    return `
      <div class="probability-chip${strong ? " strong" : ""}">
        <span>${strong ? "<em>▲</em> " : ""}${escapeHtml(item.label)}</span>
        <b>${percent(item.rate)}</b>
      </div>
    `;
  }).join("");
}

function renderAdvancedAnalysis(decisionProfile, advanced, roadBreakdown, cardModel, checks = []) {
  if (!decisionProfile && !advanced && !roadBreakdown) return "";
  return `
    ${renderDecisionProfile(decisionProfile)}
    ${renderRoadBreakdown(roadBreakdown, advanced)}
    ${renderCardModel(cardModel)}
    ${renderPredictionChecks(checks, roadBreakdown)}
  `;
}

function renderDecisionProfile(profile) {
  if (!profile) return "";
  const action = profile.action === "advise" ? "品質通過" : "未證明優勢";
  const forced = profile.forced || null;
  const selected = profile.selected || {};
  const ensemble = profile.ensemble || null;
  const validation = ensemble?.validation || null;
  const direction = ensemble?.directional || forced || null;
  return `
    <article class="advanced-panel decision-profile-panel">
      <div class="advanced-header">
        <span>決策品質</span>
        <strong>${escapeHtml(action)} ${renderResultIcon(profile.result, profile.label)} ${percent(profile.score)}</strong>
      </div>
      <div class="decision-quality-grid">
        <div><span>等級</span><b>${escapeHtml(profile.levelLabel || "-")}</b></div>
        ${profile.adaptive?.profile ? `<div><span>策略腦</span><b>${escapeHtml(profile.adaptive.profile.label || profile.adaptive.profile.key || "-")}</b></div>` : ""}
        <div><span>一致度</span><b>${percent(profile.agreement)}</b></div>
        ${forced ? `<div><span>每局方向估計</span><b>${renderResultIcon(forced.result, forced.label)} ${percent(forced.rate)}</b></div>` : ""}
        ${direction ? `<div><span>含佣金期望</span><b>${formatSignedPct(direction.expectedValue || 0)}</b></div>` : ""}
        ${validation ? `<div><span>樣本外驗證</span><b>${validation.approved ? "通過" : "未通過"} · ${Number(validation.checks || 0).toLocaleString("zh-TW")} 局</b></div>` : ""}
        ${validation ? `<div><span>Brier lift</span><b>${formatSignedNumber(validation.pairedBrierLift)} / 下限 ${formatSignedNumber(validation.pairedBrierLiftLower)}</b></div>` : ""}
        ${ensemble?.dominantExpert ? `<div><span>主導專家</span><b>${escapeHtml(ensemble.dominantExpert.label || ensemble.dominantExpert.key || "-")} ${percent(ensemble.dominantExpert.weight)}</b></div>` : ""}
        ${ensemble?.drift ? `<div><span>模型漂移</span><b>${ensemble.drift.detected ? "已降權" : "未偵測"}</b></div>` : ""}
        <div><span>數據</span><b>${escapeHtml(compactDisplayText(profile.sample?.read || "-"))}</b></div>
        <div><span>證據</span><b>${escapeHtml(profile.evidence?.read || "-")}</b></div>
        ${profile.fiveStep?.available ? `<div><span>5注對照</span><b>${percent(profile.fiveStep.completionRate)} / 自然 ${percent(profile.fiveStep.baselineCompletionRate)} / 超額 ${formatSignedPct(profile.fiveStep.completionLift)}</b></div>` : ""}
        ${profile.evidence?.calibration ? `<div><span>保守下限</span><b>${percent(profile.evidence.calibration.nonTieWilsonLower)} / ${formatSignedPct(profile.evidence.calibration.lowerEdgeVsBaseline)}</b></div>` : ""}
      </div>
      <p class="advanced-note">${escapeHtml(compactDisplayText(profile.read || selected.label || "-"))}</p>
    </article>
  `;
}

function formatSignedNumber(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(5)}`;
}

function renderCardModel(cardModel) {
  if (!cardModel?.usable) return "";
  const rates = Array.isArray(cardModel.rates) ? cardModel.rates : [];
  return `
    <article class="advanced-panel card-model-panel">
      <div class="advanced-header">
        <span>8 副牌點數</span>
        <strong>${escapeHtml(cardModel.top?.label || "-")} ${percent(cardModel.top?.rate)}</strong>
      </div>
      <div class="card-model-grid">
        ${rates.map((item) => `
          <div>
            <span>${escapeHtml(item.label || labels[item.key] || item.key)}</span>
            <b>${percent(item.rate)}</b>
          </div>
        `).join("")}
      </div>
      <p class="card-model-read">已輸入 ${Number(cardModel.seenCards || 0)} 張，剩餘 ${Number(cardModel.remainingCards || 0)} 張。</p>
    </article>
  `;
}

function renderAdvancedPanel(advanced) {
  const synthesis = advanced.synthesis || {};
  return `
    <article class="advanced-panel advanced-compact-panel">
      <div class="advanced-header">
        <span>進階交叉分析</span>
        <strong>${escapeHtml(synthesis.label || "綜合中性")} ${percent(synthesis.confidence)}</strong>
      </div>
    </article>
  `;
}

function renderRoadBreakdown(roadBreakdown, advanced) {
  if (!roadBreakdown) return "";
  const overall = roadBreakdown.overall || {};
  const highest = overall.highest || {};
  const preferred = overall.preferred || highest;
  const consensus = overall.consensus || {};
  const synthesis = advanced?.synthesis || {};
  return `
    <article class="advanced-panel road-breakdown-panel road-score-panel">
      <div class="advanced-header">
        <span>進階交叉分析</span>
        <strong>${escapeHtml(preferred.roadLabel || synthesis.label || "-")} ${renderResultIcon(preferred.result || consensus.result, preferred.label || consensus.label)} ${percent(preferred.rate || consensus.rate || synthesis.confidence)}</strong>
      </div>
      <div class="road-breakdown-grid compact-road-grid">
        ${(roadBreakdown.roads || []).map(renderRoadCard).join("")}
      </div>
    </article>
  `;
}

function renderAskRoadPanel(askRoad) {
  if (!askRoad) return "";
  const roads = ["bigEyeRoad", "smallRoad", "cockroachRoad"];
  const names = {
    bigEyeRoad: "大眼仔",
    smallRoad: "小路",
    cockroachRoad: "蟑螂路"
  };
  return `
    <div class="ask-road-panel">
      <span>莊問路 / 閒問路</span>
      <div class="ask-road-grid">
        ${roads.map((key) => `
          <div>
            <b>${escapeHtml(names[key])}</b>
            <p>莊：${renderAskChip(askRoad.banker?.[key])}</p>
            <p>閒：${renderAskChip(askRoad.player?.[key])}</p>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderAskChip(item) {
  if (!item || item.color === "none") return `<em class="ask-chip none">-</em>`;
  return `<em class="ask-chip ${escapeHtml(item.color)}">${escapeHtml(item.colorLabel)} ${escapeHtml(item.meaning)}</em>`;
}

function renderRoadCard(road) {
  const prediction = road.prediction || {};
  const manualCycle = road.manualCycle || {};
  const replay = road.replay || {};
  const replayText = Number(replay.checked || 0) > 0
    ? `復盤 ${percent(replay.hitRate)}`
    : "復盤 -";
  return `
    <div class="road-card compact-road-card">
      <div class="road-card-head">
        <span>${escapeHtml(road.label || "-")}</span>
        <strong>${renderResultIcon(prediction.result, prediction.label)} ${percent(prediction.rate)}</strong>
        <small>輸入6欄 ${renderResultIcon(manualCycle.result, manualCycle.label)} ${percent(manualCycle.rate)} · ${escapeHtml(replayText)}</small>
      </div>
    </div>
  `;
}

function renderPredictionChecks(checks = [], roadBreakdown = null) {
  const list = Array.isArray(checks) ? checks.slice(0, 6) : [];
  const records = Array.isArray(roadBreakdown?.records) ? roadBreakdown.records : [];
  if (!list.length) {
    return `
      <article class="advanced-panel prediction-check-panel">
        <div class="advanced-header">
          <span>即時路單驗證</span>
          <strong>待輸入下一手</strong>
        </div>
        ${renderAnalysisRecordList(records)}
      </article>
    `;
  }
  return `
    <article class="advanced-panel prediction-check-panel">
      <div class="advanced-header">
        <span>即時路單驗證</span>
        <strong>${escapeHtml(list[0].mark)} ${renderResultIcon(list[0].expected, list[0].expectedLabel)} ${percent(list[0].rate)}</strong>
      </div>
      <div class="prediction-check-list">
        ${list.map((item) => `
          <div class="${item.same ? "ok" : "miss"}">
            <b>${escapeHtml(item.mark)}</b>
            <span class="check-hand">#${Number(item.handNumber || 0)}</span>
            <span class="check-icons">
              <em>預測</em>${renderResultIcon(item.expected, item.expectedLabel)}
              <em>輸入</em>${renderResultIcon(item.actual, item.actualLabel)}
            </span>
            <strong>${percent(item.rate)}</strong>
          </div>
        `).join("")}
      </div>
      ${renderAnalysisRecordList(records)}
    </article>
  `;
}

function renderAnalysisRecordList(records = []) {
  const list = Array.isArray(records) ? records.slice(0, 5) : [];
  if (!list.length) return "";
  return `
    <div class="analysis-record-list">
      ${list.map((record) => `
        <div class="analysis-record-row">
          <span>${escapeHtml(record.roadLabel || "-")}</span>
          <strong>${renderResultIcon(record.result, record.label)} ${percent(record.rate)}</strong>
          <strong class="manual-cycle-cell">${renderResultIcon(record.manualCycleResult, record.manualCycleLabel)} ${percent(record.manualCycleRate)}</strong>
          <em>${escapeHtml(compactRecordDetail(record))}</em>
        </div>
      `).join("")}
    </div>
  `;
}

function compactRecordDetail(record) {
  const parts = [];
  if (record.trendProfile?.label) {
    parts.push(`${record.trendProfile.label} ${percent(record.trendProfile.score)}`);
  }
  if (record.evidenceLabel) {
    parts.push(`證據${record.evidenceLabel}`);
  }
  if (Number.isFinite(Number(record.manualCycleRate))) {
    const sampleText = Number(record.manualCycleSamples || 0) > 0 ? ` / ${Number(record.manualCycleSamples || 0)} 組` : "";
    parts.push(`輸入6欄 ${percent(record.manualCycleRate)}${sampleText}`);
  }
  if (Number(record.replayChecked || 0) > 0) {
    parts.push(`復盤 ${percent(record.replayHitRate)} ${Number(record.replayHits || 0)}/${Number(record.replayChecked || 0)}`);
    parts.push(`近段 ${percent(record.replayMomentumRate)}`);
  }
  if (!isLiveMode && Number.isFinite(Number(record.cycleRate))) {
    parts.push(`資料庫6欄 ${percent(record.cycleRate)}`);
  }
  if (!isLiveMode && Number(record.cycleSamples || 0) > 0) {
    parts.push(`${Number(record.cycleSamples || 0)} 筆`);
  }
  if (record.topTrend?.label) {
    parts.push(`${record.topTrend.label} ${percent(record.topTrend.rate)}`);
  }
  return parts.join(" / ") || record.cycleRead || record.basis || "-";
}

function renderResultIcon(result, label) {
  const key = ["banker", "player", "tie"].includes(result) ? result : "neutral";
  const text = key === "neutral" ? (label || "觀察") : labels[key];
  return `<i class="result-icon ${key}">${escapeHtml(text)}</i>`;
}

function renderAdvancedMetric(title, label, read, value) {
  return `
    <div class="advanced-metric">
      <span>${escapeHtml(title)}</span>
      <strong>${escapeHtml(label || "-")}</strong>
      <p>${escapeHtml(read || "-")}</p>
      <b>${escapeHtml(value || "-")}</b>
    </div>
  `;
}

function renderTableMatches(items = [], key) {
  const list = Array.isArray(items) ? items.slice(0, 4) : [];
  if (!list.length) return "-";
  return list.map((item) => {
    const value = Number(item[key] || 0);
    return `<em>${escapeHtml(item.tableCode || item.tableId || "-")} ${percent(value)}</em>`;
  }).join("");
}

function compactDisplayText(value) {
  return String(value || "").replace(/樣本/g, "數據");
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || apiTimeoutMs));
  const init = {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    signal: controller.signal
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  try {
    const response = await fetch(path, init);
    const text = await response.text();
    const payload = text ? safeJson(text) : {};
    if (!response.ok) {
      const message = payload?.error || payload?.detail || text || response.statusText || "API request failed";
      throw new Error(`${init.method} ${path} HTTP ${response.status}: ${message}`);
    }
    return payload || {};
  } catch (error) {
    if (error.name === "AbortError") throw new Error("API 請求逾時，請稍後再分析。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function percent(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function formatSigned(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(3)}`;
}

function formatSignedPct(value) {
  const number = Number(value || 0) * 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function sourceLabel(type) {
  return {
    exact: "完全相同 8 手",
    fuzzy: "相近路型",
    global: "全庫基準"
  }[type] || "資料庫比對";
}

function formatDateTime(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  } catch (_) {
    return value;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
