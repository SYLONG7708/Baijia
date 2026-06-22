const STORAGE_KEY = "baijia-monitor-v2-empty-start";

const labels = {
  banker: "莊",
  player: "閒",
  tie: "和"
};

const state = loadState();

const els = {
  tableSelect: document.getElementById("tableSelect"),
  tableNameInput: document.getElementById("tableNameInput"),
  shoeInput: document.getElementById("shoeInput"),
  addTableBtn: document.getElementById("addTableBtn"),
  clearTableBtn: document.getElementById("clearTableBtn"),
  resultButtons: [...document.querySelectorAll(".result-btn")],
  bankerPairInput: document.getElementById("bankerPairInput"),
  playerPairInput: document.getElementById("playerPairInput"),
  luckySixInput: document.getElementById("luckySixInput"),
  noteInput: document.getElementById("noteInput"),
  undoBtn: document.getElementById("undoBtn"),
  totalHands: document.getElementById("totalHands"),
  resultSplit: document.getElementById("resultSplit"),
  recentBias: document.getElementById("recentBias"),
  currentStreak: document.getElementById("currentStreak"),
  maxStreak: document.getElementById("maxStreak"),
  sideStats: document.getElementById("sideStats"),
  beadRoad: document.getElementById("beadRoad"),
  bigRoad: document.getElementById("bigRoad"),
  beadCount: document.getElementById("beadCount"),
  bigRoadCount: document.getElementById("bigRoadCount"),
  alertsList: document.getElementById("alertsList"),
  qualityState: document.getElementById("qualityState"),
  roundLog: document.getElementById("roundLog"),
  lastUpdated: document.getElementById("lastUpdated"),
  bulkInput: document.getElementById("bulkInput"),
  bulkImportBtn: document.getElementById("bulkImportBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  importFile: document.getElementById("importFile")
};

init();

function init() {
  ensureDefaultTable();
  bindEvents();
  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  els.tableSelect.addEventListener("change", () => {
    state.activeTableId = els.tableSelect.value;
    saveState();
    render();
  });

  els.shoeInput.addEventListener("change", () => {
    currentTable().shoe = els.shoeInput.value.trim();
    saveState();
    render();
  });

  els.addTableBtn.addEventListener("click", () => {
    const name = els.tableNameInput.value.trim() || `T${state.tables.length + 1}`;
    const id = createId();
    state.tables.push({ id, name, shoe: "", rounds: [] });
    state.activeTableId = id;
    els.tableNameInput.value = "";
    saveState();
    render();
  });

  els.clearTableBtn.addEventListener("click", () => {
    const table = currentTable();
    if (!table.rounds.length) return;
    if (confirm(`清空 ${table.name} 的全部紀錄？`)) {
      table.rounds = [];
      saveState();
      render();
    }
  });

  els.resultButtons.forEach((button) => {
    button.addEventListener("click", () => addRound(button.dataset.result));
  });

  els.undoBtn.addEventListener("click", () => {
    const table = currentTable();
    table.rounds.pop();
    saveState();
    render();
  });

  els.bulkImportBtn.addEventListener("click", () => {
    const rounds = parseBulk(els.bulkInput.value);
    if (!rounds.length) return;
    currentTable().rounds.push(...rounds);
    els.bulkInput.value = "";
    saveState();
    render();
  });

  els.exportJsonBtn.addEventListener("click", () => {
    download("baijia-monitor-data.json", JSON.stringify(state, null, 2), "application/json");
  });

  els.exportCsvBtn.addEventListener("click", () => {
    download("baijia-monitor-data.csv", toCsv(), "text/csv;charset=utf-8");
  });

  els.importFile.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (file.name.toLowerCase().endsWith(".json")) {
      importJson(text);
    } else {
      const rounds = parseBulk(text);
      currentTable().rounds.push(...rounds);
    }
    els.importFile.value = "";
    saveState();
    render();
  });
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.tables?.length) return parsed;
  } catch (_) {
  }
  return {
    activeTableId: "",
    tables: []
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function ensureDefaultTable() {
  if (!state.tables.length) {
    const id = createId();
    state.tables.push({ id, name: "A01", shoe: "", rounds: [] });
    state.activeTableId = id;
    saveState();
  }
  if (!state.tables.some((table) => table.id === state.activeTableId)) {
    state.activeTableId = state.tables[0].id;
  }
}

function currentTable() {
  return state.tables.find((table) => table.id === state.activeTableId) || state.tables[0];
}

function addRound(result) {
  const round = {
    id: createId(),
    result,
    bankerPair: els.bankerPairInput.checked,
    playerPair: els.playerPairInput.checked,
    luckySix: els.luckySixInput.checked,
    note: els.noteInput.value.trim(),
    createdAt: new Date().toISOString()
  };
  currentTable().rounds.push(round);
  els.bankerPairInput.checked = false;
  els.playerPairInput.checked = false;
  els.luckySixInput.checked = false;
  els.noteInput.value = "";
  saveState();
  render();
}

function render() {
  renderTables();
  const table = currentTable();
  const stats = summarize(table.rounds);
  els.shoeInput.value = table.shoe || "";
  els.totalHands.textContent = String(stats.total);
  els.resultSplit.textContent = `${stats.banker} / ${stats.player} / ${stats.tie}`;
  els.recentBias.textContent = stats.recentBias;
  els.currentStreak.textContent = stats.currentStreak;
  els.maxStreak.textContent = stats.maxStreak;
  els.sideStats.textContent = `${stats.pairs} / ${stats.luckySix}`;
  renderBeadRoad(table.rounds);
  renderBigRoad(table.rounds);
  renderAlerts(stats, table.rounds);
  renderLog(table.rounds);
}

function renderTables() {
  els.tableSelect.innerHTML = state.tables.map((table) => (
    `<option value="${escapeHtml(table.id)}">${escapeHtml(table.name)}</option>`
  )).join("");
  els.tableSelect.value = state.activeTableId;
}

function summarize(rounds) {
  const total = rounds.length;
  const banker = rounds.filter((round) => round.result === "banker").length;
  const player = rounds.filter((round) => round.result === "player").length;
  const tie = rounds.filter((round) => round.result === "tie").length;
  const pairs = rounds.filter((round) => round.bankerPair || round.playerPair).length;
  const luckySix = rounds.filter((round) => round.luckySix).length;
  const recent = rounds.slice(-20);
  const rb = recent.filter((round) => round.result === "banker").length;
  const rp = recent.filter((round) => round.result === "player").length;
  const rt = recent.filter((round) => round.result === "tie").length;
  const streak = getCurrentStreak(rounds);
  return {
    total,
    banker,
    player,
    tie,
    pairs,
    luckySix,
    recentBias: total ? `莊 ${rb} / 閒 ${rp} / 和 ${rt}` : "-",
    currentStreak: streak ? `${labels[streak.result]} x ${streak.count}` : "-",
    maxStreak: getMaxStreak(rounds)
  };
}

function getCurrentStreak(rounds) {
  const nonTie = rounds.filter((round) => round.result !== "tie");
  if (!nonTie.length) return null;
  const last = nonTie[nonTie.length - 1].result;
  let count = 0;
  for (let i = nonTie.length - 1; i >= 0; i -= 1) {
    if (nonTie[i].result !== last) break;
    count += 1;
  }
  return { result: last, count };
}

function getMaxStreak(rounds) {
  let best = { result: "", count: 0 };
  let current = { result: "", count: 0 };
  rounds.filter((round) => round.result !== "tie").forEach((round) => {
    if (round.result === current.result) {
      current.count += 1;
    } else {
      current = { result: round.result, count: 1 };
    }
    if (current.count > best.count) best = { ...current };
  });
  return best.count ? `${labels[best.result]} x ${best.count}` : "-";
}

function renderBeadRoad(rounds) {
  const visible = rounds.slice(-72);
  els.beadCount.textContent = `${rounds.length} hand`;
  els.beadRoad.innerHTML = visible.map((round) => cellHtml(round)).join("") + emptyCells(72 - visible.length);
}

function renderBigRoad(rounds) {
  const cells = [];
  const columns = [];
  let currentColumn = [];
  let currentResult = "";
  rounds.forEach((round) => {
    if (round.result === "tie") {
      if (currentColumn.length) {
        currentColumn[currentColumn.length - 1].ties = (currentColumn[currentColumn.length - 1].ties || 0) + 1;
      } else {
        currentColumn.push({ ...round });
      }
      return;
    }
    if (round.result !== currentResult) {
      if (currentColumn.length) columns.push(currentColumn);
      currentColumn = [];
      currentResult = round.result;
    }
    currentColumn.push(round);
  });
  if (currentColumn.length) columns.push(currentColumn);

  columns.slice(-18).forEach((column) => {
    for (let row = 0; row < 6; row += 1) {
      cells.push(column[row] ? cellHtml(column[row], column[row].ties) : `<div class="cell empty"></div>`);
    }
  });
  els.bigRoadCount.textContent = `${columns.length} column`;
  els.bigRoad.innerHTML = cells.join("") || emptyCells(36);
}

function cellHtml(round, tieCount = 0) {
  const side = [
    round.bankerPair ? "莊對" : "",
    round.playerPair ? "閒對" : "",
    round.luckySix ? "幸運六" : ""
  ].filter(Boolean).join(" ");
  return `<div class="cell ${round.result}" title="${escapeHtml(side)}">
    ${labels[round.result]}${tieCount ? `<small>+${tieCount}</small>` : ""}
    ${round.bankerPair || round.playerPair ? '<span class="pair"></span>' : ""}
    ${round.luckySix ? '<span class="lucky"></span>' : ""}
  </div>`;
}

function emptyCells(count) {
  return Array.from({ length: Math.max(0, count) }, () => `<div class="cell empty"></div>`).join("");
}

function renderAlerts(stats, rounds) {
  const alerts = [];
  if (stats.total < 20) {
    alerts.push(["資料不足", "目前樣本少於 20 手，先累積紀錄再看趨勢。"]);
  }
  const streak = getCurrentStreak(rounds);
  if (streak && streak.count >= 5) {
    alerts.push(["長連段", `${labels[streak.result]} 已連續 ${streak.count} 手，請標記桌台狀態。`]);
  }
  const recent = rounds.slice(-20);
  const ties = recent.filter((round) => round.result === "tie").length;
  if (ties >= 4) {
    alerts.push(["和局偏多", `最近 20 手已有 ${ties} 次和局，建議檢查輸入是否正確。`]);
  }
  const nonTie = stats.banker + stats.player;
  if (nonTie >= 20) {
    const diff = Math.abs(stats.banker - stats.player) / nonTie;
    if (diff >= 0.18) {
      alerts.push(["比例偏斜", `莊閒比例差距 ${(diff * 100).toFixed(1)}%，列入觀察。`]);
    }
  }
  if (!alerts.length) {
    alerts.push(["狀態穩定", "目前沒有資料品質或連段異常提醒。"]);
  }
  els.qualityState.textContent = stats.total >= 20 ? "可觀察" : "累積中";
  els.alertsList.innerHTML = alerts.map(([title, message]) => (
    `<li><strong>${escapeHtml(title)}</strong><br>${escapeHtml(message)}</li>`
  )).join("");
}

function renderLog(rounds) {
  const recent = rounds.slice(-60).reverse();
  els.lastUpdated.textContent = rounds.length ? formatTime(rounds[rounds.length - 1].createdAt) : "尚未輸入";
  els.roundLog.innerHTML = recent.map((round, index) => {
    const number = rounds.length - index;
    const side = [
      round.bankerPair ? "莊對" : "",
      round.playerPair ? "閒對" : "",
      round.luckySix ? "幸運六" : ""
    ].filter(Boolean).join(" / ");
    return `<div class="round-row">
      <span class="round-badge ${round.result}">${labels[round.result]}</span>
      <div>
        <strong>#${number}</strong>
        <div class="round-meta">${formatTime(round.createdAt)}${round.note ? ` · ${escapeHtml(round.note)}` : ""}</div>
      </div>
      <span class="round-side">${escapeHtml(side)}</span>
    </div>`;
  }).join("") || `<div class="round-row"><span></span><div>尚未輸入資料</div><span></span></div>`;
}

function parseBulk(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rounds = [];
  lines.forEach((line) => {
    if (line.includes(",")) {
      const parts = line.split(",").map((part) => part.trim());
      const result = normalizeResult(parts[0]);
      if (result) {
        rounds.push({
          id: createId(),
          result,
          bankerPair: parseBool(parts[1]),
          playerPair: parseBool(parts[2]),
          luckySix: parseBool(parts[3]),
          note: parts[4] || "",
          createdAt: new Date().toISOString()
        });
      }
      return;
    }
    line.split(/\s+/).forEach((token) => {
      const result = normalizeResult(token);
      if (result) {
        rounds.push({
          id: createId(),
          result,
          bankerPair: false,
          playerPair: false,
          luckySix: false,
          note: "",
          createdAt: new Date().toISOString()
        });
      }
    });
  });
  return rounds;
}

function normalizeResult(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["b", "banker", "莊", "庄"].includes(normalized)) return "banker";
  if (["p", "player", "閒", "闲"].includes(normalized)) return "player";
  if (["t", "tie", "和"].includes(normalized)) return "tie";
  return "";
}

function parseBool(value) {
  return ["1", "true", "yes", "y", "是", "有"].includes(String(value || "").trim().toLowerCase());
}

function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed?.tables?.length) return;
  state.tables = parsed.tables.map((table) => ({
    id: table.id || createId(),
    name: table.name || "Imported",
    shoe: table.shoe || "",
    rounds: Array.isArray(table.rounds) ? table.rounds.filter((round) => normalizeResult(round.result)) : []
  }));
  state.activeTableId = state.tables[0].id;
}

function toCsv() {
  const rows = [["table", "shoe", "index", "result", "bankerPair", "playerPair", "luckySix", "note", "createdAt"]];
  state.tables.forEach((table) => {
    table.rounds.forEach((round, index) => {
      rows.push([
        table.name,
        table.shoe || "",
        String(index + 1),
        labels[round.result],
        round.bankerPair ? "1" : "0",
        round.playerPair ? "1" : "0",
        round.luckySix ? "1" : "0",
        round.note || "",
        round.createdAt
      ]);
    });
  });
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch (_) {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
