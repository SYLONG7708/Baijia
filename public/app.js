const state = {
  config: null,
  summary: null,
  selectedTable: "B601",
  selectedRoad: "bead",
  roads: null,
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
  if (value === "OK") return "正常";
  if (value === "RATE_LIMITED") return "限流";
  if (value === "NO_WEBSOCKET") return "等待資料流";
  return value || "未知";
}

function monitorLabel(value) {
  if (value === "READING") return "可讀取新資料";
  if (value === "WAITING") return "等待新局";
  if (value === "NO_WEBSOCKET") return "無資料流";
  if (value === "RATE_LIMITED") return "試玩站限流";
  if (value === "STALE_WARN") return "超過10分鐘未更新";
  if (value === "STALE_CRITICAL") return "超過30分鐘未更新";
  return value || "未啟動";
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

function streakText(streak) {
  if (!streak?.outcome || !streak.length) return "等待";
  return `${labels[streak.outcome] || ""}連${streak.length}`;
}

function streakRateText(streak) {
  if (!streak?.opportunities) return "樣本0";
  return `${streak.continuationPercent}%`;
}

function renderTopMetrics() {
  const summary = state.summary || {};
  $("topMetrics").innerHTML = [
    ["總局數", summary.totalRounds || 0],
    ["有效桌", summary.activeTables || 0],
    ["莊", summary.counts?.BANKER || 0],
    ["閒", summary.counts?.PLAYER || 0],
    ["和", summary.counts?.TIE || 0]
  ].map(([label, value]) => `<span class="metric-pill">${label}<strong>${value}</strong></span>`).join("");

  const scraper = state.status?.scraper || {};
  const monitor = state.status?.monitor || {};
  const status = scraper.running ? "擷取中" : "待命";
  const health = monitor.state && monitor.state !== "READING"
    ? ` · ${monitorLabel(monitor.state)}`
    : scraper.health && scraper.health !== "OK"
      ? ` · ${healthLabel(scraper.health)}`
      : "";
  $("connectionText").textContent = `${status}${health} · ${state.apiBase || location.origin}`;
}

function renderTableGroups() {
  const summaryByCode = new Map((state.summary?.tables || []).map((table) => [table.code, table]));
  $("tableGroups").innerHTML = (state.config?.tableGroups || []).map((group) => {
    const buttons = group.codes.map((code) => {
      const table = summaryByCode.get(code) || {};
      const active = code === state.selectedTable ? " active" : "";
      const streak = table.streak || {};
      const streakInfo = streak.outcome ? ` · ${streakText(streak)} ${streakRateText(streak)}` : "";
      return `<button class="table-button${active}" type="button" data-table="${code}">
        <span class="table-code">${code}</span>
        <span class="table-sub">${table.total || 0} 局 · ${table.lastOutcome ? labels[table.lastOutcome] : "無資料"}${streakInfo}</span>
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
  const counts = table.counts || {};
  const streak = table.streak || {};
  $("tableCategory").textContent = table.category || "";
  $("tableTitle").textContent = `${table.code} ${table.category || ""}`.trim();
  $("latestSix").replaceChildren(...(table.latestSix || []).map(chip));

  $("tableMetrics").innerHTML = [
    ["累計局數", table.total || 0],
    ["莊率", pct(table.rates?.BANKER)],
    ["閒率", pct(table.rates?.PLAYER)],
    ["和率", pct(table.rates?.TIE)],
    ["連勝", streakText(streak)],
    ["連勝率", streakRateText(streak)],
    ["連勝樣本", `${streak.continuations || 0}/${streak.opportunities || 0}`],
    ["莊對", counts.bankerPair || 0],
    ["閒對", counts.playerPair || 0],
    ["已見牌", cardModel.available ? `${cardModel.observedCards}/${cardModel.totalCards}` : "等待"],
    ["剩餘牌", cardModel.available ? cardModel.remainingCards : "-"]
  ].map(([label, value]) => `<div class="metric-card">
    <span class="metric-label">${label}</span>
    <strong class="metric-value">${value}</strong>
  </div>`).join("");
}

function renderPredictionAlerts() {
  const tables = [...(state.summary?.tables || [])]
    .filter((table) => table.total > 0)
    .sort((left, right) => {
      const leftRate = left.streak?.opportunities ? left.streak.continuationRate : -1;
      const rightRate = right.streak?.opportunities ? right.streak.continuationRate : -1;
      if (rightRate !== leftRate) return rightRate - leftRate;
      return (right.streak?.length || 0) - (left.streak?.length || 0);
    });

  $("predictionAlerts").innerHTML = tables.map((table) => {
    const streak = table.streak || {};
    const outcome = streak.outcome || "";
    const sample = streak.opportunities ? `${streak.continuations}/${streak.opportunities}` : "樣本0";
    return `<button class="alert-item" type="button" data-table="${table.code}">
      <span class="alert-code">${table.code}</span>
      <span class="chip ${outcomeClass[outcome]}">${labels[outcome] || "-"}</span>
      <strong>${streakRateText(streak)}</strong>
      <small>${streakText(streak)} · 續連樣本 ${sample} · 最長莊${streak.longest?.BANKER || 0}/閒${streak.longest?.PLAYER || 0}</small>
    </button>`;
  }).join("");
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
  const monitor = state.status?.monitor || {};
  const monitorProcess = state.status?.monitorProcess || {};
  $("statusList").innerHTML = [
    ["Daemon", daemon.running ? "運行" : "待命"],
    ["Scraper", scraper.running ? "運行" : "待命"],
    ["Monitor", monitor.running || monitorProcess.running ? "24H 檢測" : "待命"],
    ["讀取", monitorLabel(monitor.state)],
    ["5分鐘新增", monitor.recent?.last5m ?? 0],
    ["15分鐘新增", monitor.recent?.last15m ?? 0],
    ["最新資料", monitor.latestRound?.insertedAt ? fmtTime(monitor.latestRound.insertedAt) : ""],
    ["檢查", monitor.lastCheckAt ? fmtTime(monitor.lastCheckAt) : ""],
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
    await refresh();
  });

  $("predictionAlerts").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-table]");
    if (!button) return;
    state.selectedTable = button.dataset.table;
    await refresh();
  });

  $("roadTabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-road]");
    if (!button) return;
    state.selectedRoad = button.dataset.road;
    renderRoad();
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
    setInterval(refresh, 15000);
  })
  .catch((error) => {
    $("connectionText").textContent = `初始化失敗 · ${error.message}`;
  });
