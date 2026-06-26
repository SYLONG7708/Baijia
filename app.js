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
  lastAnalyzedKey: "",
  pendingPrediction: null,
  predictionChecks: []
};

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
  patternInput: document.getElementById("patternInput"),
  undoPatternBtn: document.getElementById("undoPatternBtn"),
  clearPatternBtn: document.getElementById("clearPatternBtn"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  collectorMessage: document.getElementById("collectorMessage"),
  dbPath: document.getElementById("dbPath")
};

let autoAnalyzeTimer = null;

init();

function init() {
  bindEvents();
  renderPattern();
  renderAnalysis();
  loadStatus();
  setInterval(loadStatus, 60_000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", loadStatus);
  els.analyzeBtn.addEventListener("click", analyzeInput);

  els.patternButtons.forEach((button) => {
    button.addEventListener("click", () => appendPatternResult(button.dataset.result));
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
    state.analysis = null;
    state.lastAnalyzedKey = "";
    state.pendingPrediction = null;
    state.predictionChecks = [];
    renderPattern();
    renderAnalysis();
  });
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    state.status = status;
    els.statusRoundCount.textContent = `${Number(status.rounds || 0).toLocaleString("zh-TW")} 局`;
    els.statusUpdateAt.textContent = formatDateTime(status.updatedAt);
    els.allbetTableCount.textContent = `${Number(status.allbetTables || 0)} 桌`;
    els.savedDataCount.textContent = `已保存 ${Number(status.rounds || 0).toLocaleString("zh-TW")} 局`;
    els.serverBadge.textContent = "本機正常";
    els.serverBadge.className = "status-pill ok";
    els.dbPath.textContent = status.dbPath || "-";
    els.collectorMessage.textContent = status.collector?.lastMessage || status.collector?.lastError || "等待抓取";
  } catch (error) {
    els.serverBadge.textContent = "API 未連線";
    els.serverBadge.className = "status-pill bad";
    els.statusRoundCount.textContent = "0 局";
    els.collectorMessage.textContent = error.message;
  }
}

function appendPatternResult(result) {
  if (!["banker", "player", "tie"].includes(result)) return;
  recordPredictionCheck(result);
  state.pattern.push(result);
  renderPattern();
  maybeAutoAnalyze();
}

function renderPattern() {
  const visible = state.pattern.map((result) => labels[result]).join(" ");
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
  const key = latest.join("|");
  if (key === state.lastAnalyzedKey) return;
  clearTimeout(autoAnalyzeTimer);
  autoAnalyzeTimer = setTimeout(() => {
    if (getPatternWindow().join("|") !== key) return;
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

  const key = sequence.join("|");
  state.lastAnalyzedKey = key;
  els.nextResult.textContent = "分析中";
  els.nextDescription.textContent = "使用最近 8 手與資料庫歷史路型比對";
  try {
    state.analysis = await api("/api/analyze", {
      method: "POST",
      body: {
        scope: "all",
        sequence
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
  if (!state.pendingPrediction || state.pattern.length < 8) return;
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
  const advancedPanel = advanced ? renderAdvancedPanel(advanced) : "";
  return `
    ${advancedPanel}
    ${renderRoadBreakdown(roadBreakdown)}
    ${renderPredictionChecks(checks)}
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

function renderRoadBreakdown(roadBreakdown) {
  if (!roadBreakdown) return "";
  const overall = roadBreakdown.overall || {};
  const highest = overall.highest || {};
  const consensus = overall.consensus || {};
  return `
    <article class="advanced-panel road-breakdown-panel">
      <div class="advanced-header">
        <span>五路路單拆解</span>
        <strong>${escapeHtml(highest.roadLabel || "-")} ${escapeHtml(highest.label || consensus.label || "-")} ${percent(highest.rate || consensus.rate)}</strong>
      </div>
      <div class="road-summary compact-summary">
        <div>
          <span>最高百分比</span>
          <strong>${escapeHtml(highest.roadLabel || "-")} ${escapeHtml(highest.label || "-")} ${percent(highest.rate)}</strong>
        </div>
        <div>
          <span>五路統整</span>
          <strong>${escapeHtml(consensus.label || "-")} ${percent(consensus.rate)}</strong>
        </div>
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
  return `
    <div class="road-card compact-road-card">
      <div class="road-card-head">
        <span>${escapeHtml(road.label || "-")}</span>
        <strong>${renderResultIcon(prediction.result, prediction.label)} ${percent(prediction.rate)}</strong>
      </div>
    </div>
  `;
}

function renderPredictionChecks(checks = []) {
  const list = Array.isArray(checks) ? checks.slice(0, 6) : [];
  if (!list.length) {
    return `
      <article class="advanced-panel prediction-check-panel">
        <div class="advanced-header">
          <span>即時路單驗證</span>
          <strong>等待下一手</strong>
        </div>
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
    </article>
  `;
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
