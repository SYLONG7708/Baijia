const labels = {
  banker: "莊",
  player: "閒",
  tie: "和",
  bankerPair: "莊對",
  playerPair: "閒對",
  luckySix: "幸運6"
};

const state = {
  status: null,
  analysis: null,
  pattern: [],
  pendingFlags: {
    bankerPair: false,
    playerPair: false,
    luckySix: false
  },
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
  renderPattern();
  renderAnalysis();
  if (!isLiveMode) {
    loadStatus();
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

function appendPatternResult(result) {
  if (!["banker", "player", "tie"].includes(result)) return;
  const checkedPrediction = recordPredictionCheck(result);
  state.pattern.push(makeManualRound(result));
  resetPendingFlags();
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

function renderPendingFlags() {
  els.sideFlagButtons.forEach((button) => {
    const active = Boolean(state.pendingFlags[button.dataset.flag]);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function makeManualRound(result) {
  return {
    result,
    bankerPair: Boolean(state.pendingFlags.bankerPair),
    playerPair: Boolean(state.pendingFlags.playerPair),
    luckySix: Boolean(state.pendingFlags.luckySix)
  };
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
  const key = latest.map(roundKey).join("|");
  if (key === state.lastAnalyzedKey) return;
  clearTimeout(autoAnalyzeTimer);
  autoAnalyzeTimer = setTimeout(() => {
    if (getPatternWindow().map(roundKey).join("|") !== key) return;
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

  const key = sequence.map(roundKey).join("|");
  state.lastAnalyzedKey = key;
  els.nextResult.textContent = "分析中";
  els.nextDescription.textContent = "使用最近 8 手與資料庫歷史路型比對";
  try {
    state.analysis = await api("/api/analyze", {
      method: "POST",
      body: {
        scope: "all",
        localOnly: isLiveMode,
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
  const highest = analysis?.roadBreakdown?.overall?.highest;
  const consensus = analysis?.roadBreakdown?.overall?.consensus;
  const next = analysis?.nextResult;
  const candidate = ["banker", "player"].includes(highest?.result)
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
        source: "歷史樣本"
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
    item.luckySix ? "L6" : ""
  ].filter(Boolean).join("+");
}

function formatManualRound(round) {
  const result = roundResult(round);
  const item = typeof round === "string" ? { result } : round || {};
  const extra = [];
  if (item.bankerPair) extra.push(labels.bankerPair);
  if (item.playerPair) extra.push(labels.playerPair);
  if (item.luckySix) extra.push(labels.luckySix);
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

  const top = analysis.nextResult || { label: "-", rate: 0 };
  els.nextResult.textContent = `${top.label || "-"} ${percent(top.rate)}`;
  els.nextDescription.textContent = "";
  els.sidePrediction.innerHTML = renderProbabilityList(analysis.fullRates || []);
  if (els.advancedAnalysis) {
    els.advancedAnalysis.innerHTML = renderAdvancedAnalysis(
      analysis.advanced,
      analysis.roadBreakdown,
      state.predictionChecks
    );
  }
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

function renderAdvancedAnalysis(advanced, roadBreakdown, checks = []) {
  if (!advanced && !roadBreakdown) return "";
  return `
    ${renderRoadBreakdown(roadBreakdown, advanced)}
    ${renderPredictionChecks(checks, roadBreakdown)}
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
  const consensus = overall.consensus || {};
  const synthesis = advanced?.synthesis || {};
  return `
    <article class="advanced-panel road-breakdown-panel road-score-panel">
      <div class="advanced-header">
        <span>進階交叉分析</span>
        <strong>${escapeHtml(highest.roadLabel || synthesis.label || "-")} ${renderResultIcon(highest.result || consensus.result, highest.label || consensus.label)} ${percent(highest.rate || consensus.rate || synthesis.confidence)}</strong>
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

async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: { "content-type": "application/json" }
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const response = await fetch(path, init);
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) {
    const message = payload?.error || payload?.detail || text || response.statusText || "API request failed";
    throw new Error(`${init.method} ${path} HTTP ${response.status}: ${message}`);
  }
  return payload || {};
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
