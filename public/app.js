const state = {
  config: null,
  summary: null,
  selectedTable: "B601",
  selectedRoad: "bead",
  roads: null,
  sequence: [],
  manualOutcome: "BANKER",
  apiBase: localStorage.getItem("baijia.apiBase") || "",
  apiToken: localStorage.getItem("baijia.apiToken") || ""
};

const labels = {
  BANKER: "莊",
  PLAYER: "閒",
  TIE: "和",
  bankerPair: "莊對",
  playerPair: "閒對",
  luckySix: "幸運六"
};

const shortLabels = {
  B: "莊",
  P: "閒",
  T: "和"
};

const outcomeClass = {
  BANKER: "banker",
  PLAYER: "player",
  TIE: "tie",
  B: "banker",
  P: "player",
  T: "tie"
};

function $(id) {
  return document.getElementById(id);
}

function apiUrl(path) {
  const base = state.apiBase.replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

async function fetchJson(path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  if (state.apiToken && options.method && options.method !== "GET") {
    headers.authorization = `Bearer ${state.apiToken}`;
  }
  const response = await fetch(apiUrl(path), { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

function pct(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function fmtTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function healthLabel(value) {
  if (value === "OK") return "\u6b63\u5e38";
  if (value === "RATE_LIMITED") return "\u9650\u6d41";
  if (value === "NO_WEBSOCKET") return "\u7b49\u5f85\u8cc7\u6599\u6d41";
  return value || "\u672a\u77e5";
}

function currentTable() {
  return state.summary?.tables?.find((table) => table.code === state.selectedTable) ||
    state.config?.tables?.find((table) => table.code === state.selectedTable) ||
    { code: state.selectedTable, label: state.selectedTable, category: "" };
}

function chip(value) {
  const span = document.createElement("span");
  span.className = `chip ${outcomeClass[value] || ""}`;
  span.textContent = shortLabels[value] || labels[value] || value || "-";
  return span;
}

function renderTopMetrics() {
  const summary = state.summary || {};
  $("topMetrics").innerHTML = [
    ["總局數", summary.totalRounds || 0],
    ["有資料桌", summary.activeTables || 0],
    ["莊", summary.counts?.BANKER || 0],
    ["閒", summary.counts?.PLAYER || 0],
    ["和", summary.counts?.TIE || 0]
  ].map(([label, value]) => `<span class="metric-pill">${label}<strong>${value}</strong></span>`).join("");

  const scraper = state.status?.scraper || {};
  const status = scraper.running ? "擷取中" : "待命";
  const health = scraper.health && scraper.health !== "OK" ? ` · ${healthLabel(scraper.health)}` : "";
  $("connectionText").textContent = `${status}${health} · ${state.apiBase || location.origin}`;
}

function renderTableGroups() {
  const summaryByCode = new Map((state.summary?.tables || []).map((table) => [table.code, table]));
  $("tableGroups").innerHTML = (state.config?.tableGroups || []).map((group) => {
    const buttons = group.codes.map((code) => {
      const table = summaryByCode.get(code) || {};
      const active = code === state.selectedTable ? " active" : "";
      return `<button class="table-button${active}" type="button" data-table="${code}">
        <span class="table-code">${code}</span>
        <span class="table-sub">${table.total || 0} 局 · ${table.lastOutcome ? labels[table.lastOutcome] : "無資料"}</span>
      </button>`;
    }).join("");
    return `<div>
      <div class="group-title">${group.name}</div>
      <div class="table-list">${buttons}</div>
    </div>`;
  }).join("");
}

function renderTableHeader() {
  const table = currentTable();
  const cardModel = table.prediction?.cardModel || {};
  $("tableCategory").textContent = table.category || "";
  $("tableTitle").textContent = `${table.code} ${table.category || ""}`.trim();
  $("latestSix").replaceChildren(...(table.latestSix || []).map(chip));

  const counts = table.counts || {};
  $("tableMetrics").innerHTML = [
    ["累計局數", table.total || 0],
    ["莊率", pct(table.rates?.BANKER)],
    ["閒率", pct(table.rates?.PLAYER)],
    ["和率", pct(table.rates?.TIE)],
    ["莊對", counts.bankerPair || 0],
    ["閒對", counts.playerPair || 0],
    ["已記牌", cardModel.available ? `${cardModel.observedCards}/${cardModel.totalCards}` : "等待"],
    ["剩餘牌", cardModel.available ? cardModel.remainingCards : "-"]
  ].map(([label, value]) => `<div class="metric-card">
    <span class="metric-label">${label}</span>
    <strong class="metric-value">${value}</strong>
  </div>`).join("");
}

function renderPrediction(prediction) {
  const data = prediction || currentTable().prediction || {};
  const cardText = data.cardModel?.available
    ? ` · 牌靴 ${data.cardModel.observedCards}/${data.cardModel.totalCards}`
    : "";
  $("predictionTitle").textContent = `下一把統計 · 樣本 ${data.sampleSize || 0}${cardText}`;
  $("predictionGrid").innerHTML = [
    ["BANKER", "莊", "banker"],
    ["PLAYER", "閒", "player"],
    ["TIE", "和局", "tie"],
    ["bankerPair", "莊對", "side"],
    ["playerPair", "閒對", "side"],
    ["luckySix", "幸運六", "side"]
  ].map(([key, label, cls]) => `<div class="prediction-card ${cls}">
    <span class="prediction-label">${label}</span>
    <strong class="prediction-value">${data.percentages?.[key] ?? 0}%</strong>
    <small>${key === data.pick ? "最高主結果" : `歷史 ${data.historicalPercentages?.[key] ?? 0}%`}</small>
  </div>`).join("");
}

function renderPredictionAlerts() {
  const tables = [...(state.summary?.tables || [])]
    .filter((table) => table.total > 0)
    .sort((left, right) => {
      const lp = Math.max(
        left.prediction?.probabilities?.BANKER || 0,
        left.prediction?.probabilities?.PLAYER || 0,
        left.prediction?.probabilities?.TIE || 0
      );
      const rp = Math.max(
        right.prediction?.probabilities?.BANKER || 0,
        right.prediction?.probabilities?.PLAYER || 0,
        right.prediction?.probabilities?.TIE || 0
      );
      return rp - lp;
    });
  $("predictionAlerts").innerHTML = tables.map((table) => {
    const prediction = table.prediction || {};
    const pick = prediction.pick || "";
    const rawPick = prediction.rawPick || pick;
    const percent = prediction.percentages?.[pick] ?? 0;
    const rawPercent = prediction.percentages?.[rawPick] ?? percent;
    return `<button class="alert-item" type="button" data-table="${table.code}">
      <span class="alert-code">${table.code}</span>
      <span class="chip ${outcomeClass[pick]}">${labels[pick] || "-"}</span>
      <strong>${percent}%</strong>
      <small>最高 ${labels[rawPick] || "-"} ${rawPercent}% · ${table.latestSix?.join("") || ""}</small>
    </button>`;
  }).join("");
}

function renderSequence() {
  $("sequenceChips").replaceChildren(...state.sequence.map(chip));
}

async function predictNow() {
  renderSequence();
  try {
    const prediction = await fetchJson("/api/predict", {
      method: "POST",
      body: JSON.stringify({
        tableCode: state.selectedTable,
        sequence: state.sequence
      })
    });
    renderPrediction(prediction);
  } catch (error) {
    toast(`預測失敗：${error.message}`);
  }
}

function roadDot(point, derived) {
  const node = document.createElement("div");
  if (derived) {
    node.className = `road-dot derived ${point.color === "B" ? "blue" : ""}`;
  } else {
    node.className = `road-dot outcome-${String(point.outcome || "").toLowerCase()}`;
    node.textContent = labels[point.outcome] || "";
    const flags = [
      point.bankerPair || point.playerPair ? "對" : "",
      point.luckySix ? "6" : "",
      point.tie ? point.tie : ""
    ].filter(Boolean).join("");
    if (flags) {
      const flag = document.createElement("span");
      flag.className = "flag";
      flag.textContent = flags;
      node.appendChild(flag);
    }
  }
  node.style.gridColumn = `${point.x + 1}`;
  node.style.gridRow = `${point.y + 1}`;
  return node;
}

function renderRoad() {
  const points = state.roads?.roads?.[state.selectedRoad] || [];
  const derived = ["bigEye", "small", "cockroach"].includes(state.selectedRoad);
  const cols = Math.max(24, ...points.map((point) => point.x + 2), 24);
  const grid = $("roadGrid");
  grid.style.gridTemplateColumns = `repeat(${cols}, var(--cell))`;
  grid.replaceChildren(...points.map((point) => roadDot(point, derived)));

  document.querySelectorAll("[data-road]").forEach((button) => {
    button.classList.toggle("active", button.dataset.road === state.selectedRoad);
  });
}

function renderRounds() {
  const rounds = state.roads?.rounds || [];
  const cardText = (items) => (items || []).join(" ");
  $("recentRounds").innerHTML = rounds.slice(-36).reverse().map((round) => `<tr>
    <td>${round.roundNo || ""}</td>
    <td><span class="chip ${outcomeClass[round.outcome]}">${labels[round.outcome] || ""}</span></td>
    <td>${cardText(round.bankerCardsRaw)} <span class="metric-label">${cardText(round.bankerCardPoints)}</span></td>
    <td>${cardText(round.playerCardsRaw)} <span class="metric-label">${cardText(round.playerCardPoints)}</span></td>
    <td>${round.bankerPair ? "是" : ""}</td>
    <td>${round.playerPair ? "是" : ""}</td>
    <td>${round.luckySix ? "是" : ""}</td>
    <td>${fmtTime(round.observedAt)}</td>
  </tr>`).join("");
}

function renderStatus() {
  const scraper = state.status?.scraper || {};
  const daemon = state.status?.daemon || {};
  $("statusList").innerHTML = [
    ["Daemon", daemon.running ? "運行" : "待命"],
    ["Scraper", scraper.running ? "運行" : "待命"],
    ["健康", healthLabel(scraper.health)],
    ["新增", scraper.insertedTotal || 0],
    ["WebSocket", scraper.lastWebsocketAt ? fmtTime(scraper.lastWebsocketAt) : ""],
    ["心跳", scraper.heartbeatAt ? fmtTime(scraper.heartbeatAt) : ""]
  ].map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("");
}

async function loadRoads() {
  state.roads = await fetchJson(`/api/roads?tableCode=${encodeURIComponent(state.selectedTable)}`);
  renderRoad();
  renderRounds();
}

async function refresh() {
  try {
    const status = await fetchJson("/api/status");
    state.status = status.scraper || {};
    state.summary = status.summary;
    renderTopMetrics();
    renderTableGroups();
    renderTableHeader();
    renderPrediction(currentTable().prediction);
    renderPredictionAlerts();
    renderStatus();
    await loadRoads();
  } catch (error) {
    $("connectionText").textContent = `離線 · ${error.message}`;
  }
}

async function initConfig() {
  $("apiBaseInput").value = state.apiBase;
  $("apiTokenInput").value = state.apiToken;
  state.config = await fetchJson("/api/config");
  if (!state.apiBase && state.config.publicApiBase) {
    state.apiBase = state.config.publicApiBase;
  }
  if (!state.config.tables.some((table) => table.code === state.selectedTable)) {
    state.selectedTable = state.config.tables[0]?.code || "B601";
  }
}

function bindEvents() {
  $("refreshButton").addEventListener("click", refresh);
  $("tableGroups").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-table]");
    if (!button) return;
    state.selectedTable = button.dataset.table;
    const table = currentTable();
    state.sequence = table.latestSix || [];
    renderSequence();
    await refresh();
    await predictNow();
  });

  $("predictionAlerts").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-table]");
    if (!button) return;
    state.selectedTable = button.dataset.table;
    state.sequence = currentTable().latestSix || [];
    renderSequence();
    await refresh();
    await predictNow();
  });

  $("roadTabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-road]");
    if (!button) return;
    state.selectedRoad = button.dataset.road;
    renderRoad();
  });

  document.querySelectorAll("[data-add-outcome]").forEach((button) => {
    button.addEventListener("click", () => {
      const map = { BANKER: "B", PLAYER: "P", TIE: "T" };
      state.sequence = [...state.sequence, map[button.dataset.addOutcome]].slice(-6);
      predictNow();
    });
  });
  $("sequenceClear").addEventListener("click", () => {
    state.sequence = [];
    predictNow();
  });

  document.querySelectorAll("[data-manual-outcome]").forEach((button) => {
    button.addEventListener("click", () => {
      state.manualOutcome = button.dataset.manualOutcome;
      document.querySelectorAll("[data-manual-outcome]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
    });
  });

  $("manualSubmit").addEventListener("click", async () => {
    try {
      const table = currentTable();
      await fetchJson("/api/rounds", {
        method: "POST",
        body: JSON.stringify({
          tableCode: state.selectedTable,
          tableName: table.label,
          category: table.category,
          outcome: state.manualOutcome,
          bankerPair: $("manualBankerPair").checked,
          playerPair: $("manualPlayerPair").checked,
          luckySix: $("manualLuckySix").checked,
          roundNo: (table.lastRoundNo || 0) + 1,
          source: "manual-app"
        })
      });
      $("manualBankerPair").checked = false;
      $("manualPlayerPair").checked = false;
      $("manualLuckySix").checked = false;
      toast("已寫入");
      await refresh();
    } catch (error) {
      toast(`寫入失敗：${error.message}`);
    }
  });

  $("saveSettings").addEventListener("click", async () => {
    state.apiBase = $("apiBaseInput").value.trim().replace(/\/+$/, "");
    state.apiToken = $("apiTokenInput").value.trim();
    localStorage.setItem("baijia.apiBase", state.apiBase);
    localStorage.setItem("baijia.apiToken", state.apiToken);
    toast("已套用");
    await refresh();
  });

  $("exportButton").addEventListener("click", () => {
    window.open(apiUrl("/api/export"), "_blank", "noopener");
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

bindEvents();
initConfig()
  .then(async () => {
    await refresh();
    state.sequence = currentTable().latestSix || [];
    renderSequence();
    await predictNow();
    setInterval(refresh, 15000);
  })
  .catch((error) => {
    $("connectionText").textContent = `初始化失敗 · ${error.message}`;
  });
