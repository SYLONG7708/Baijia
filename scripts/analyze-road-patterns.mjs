import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const store = createRequire(import.meta.url)("../src/store");

const TARGET_CODES = [
  "B201", "B202", "B203", "B219", "B220",
  "B501", "B502", "B503", "B504", "B505", "B506", "B507",
  "B601", "B602", "B603", "B604", "B605", "B618",
  "C201", "C202", "C501", "C701",
  "IB201", "IB202",
  "Q201", "Q202", "Q204", "Q501", "Q502", "Q601", "Q701", "Q702",
  "V911", "V912", "V971", "V972"
];
const TARGET_SET = new Set(TARGET_CODES);
const WINDOW = Number(process.argv[2] || 160);
const SHORT_WINDOW = Math.min(48, Math.max(24, Math.floor(WINDOW / 3)));
const REPORT_DIR = path.resolve("reports");

const db = store.readDb();
const tables = (db.tables || [])
  .filter((table) => table.provider === "allbet")
  .map((table) => ({
    ...table,
    code: normalizeCode(table.tableCode || table.deskNo || table.name || table.roomId)
  }))
  .filter((table) => TARGET_SET.has(table.code))
  .sort((left, right) => TARGET_CODES.indexOf(left.code) - TARGET_CODES.indexOf(right.code));
const tableById = new Map(tables.map((table) => [table.id, table]));
const roundsByCode = new Map();
for (const code of TARGET_CODES) roundsByCode.set(code, []);
for (const round of db.rounds || []) {
  const table = tableById.get(round.tableId);
  if (!table) continue;
  roundsByCode.get(table.code)?.push(round);
}
for (const rounds of roundsByCode.values()) {
  rounds.sort((left, right) => {
    const time = Date.parse(left.observedAt || left.createdAt || "") - Date.parse(right.observedAt || right.createdAt || "");
    if (time !== 0) return time;
    return Number(left.handNumber || 0) - Number(right.handNumber || 0);
  });
}

const tableAnalyses = TARGET_CODES.map((code, index) => analyzeTable(code, roundsByCode.get(code) || [], index));
const groups = analyzeGroups(tableAnalyses);
const cross = analyzeCrossTable(tableAnalyses);
const topTrend = [...tableAnalyses]
  .filter((item) => item.rounds >= 30)
  .sort((left, right) => right.trendScore - left.trendScore)
  .slice(0, 12);
const timestamp = fileTimestamp();
const report = {
  generatedAt: new Date().toISOString(),
  window: WINDOW,
  shortWindow: SHORT_WINDOW,
  disclaimer: "Baccarat outcomes are uncertain. This report is historical pattern analysis plus symbolic five-elements/bagua weighting for observation only, not a guaranteed betting method.",
  completeness: {
    targetTables: TARGET_CODES.length,
    analyzedTables: tableAnalyses.length,
    zeroRoundTables: tableAnalyses.filter((item) => item.rounds === 0).map((item) => item.code),
    totalRounds: tableAnalyses.reduce((sum, item) => sum + item.rounds, 0)
  },
  groups,
  topTrend,
  cross,
  tables: tableAnalyses
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
const jsonPath = path.join(REPORT_DIR, `baijia-road-analysis-${timestamp}.json`);
const mdPath = path.join(REPORT_DIR, `baijia-road-analysis-${timestamp}.md`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(mdPath, toMarkdown(report), "utf8");

console.log(JSON.stringify({
  generatedAt: report.generatedAt,
  jsonPath,
  mdPath,
  analyzedTables: tableAnalyses.length,
  totalRounds: report.completeness.totalRounds,
  topTrend: topTrend.slice(0, 8).map((item) => ({
    code: item.code,
    trendScore: item.trendScore,
    pattern: item.pattern,
    observeMode: item.observeMode,
    lastSignal: item.lastSignal,
    bagua: item.bagua.hexagram,
    element: item.fiveElements.dominant
  })),
  crossSummary: {
    strongestSameDirection: cross.sameDirection.slice(0, 5),
    strongestOppositeDirection: cross.oppositeDirection.slice(0, 5),
    adjacentPairs: cross.adjacent.slice(0, 8)
  }
}, null, 2));

function analyzeTable(code, rounds, targetIndex) {
  const windowRounds = rounds.slice(-WINDOW);
  const shortRounds = rounds.slice(-SHORT_WINDOW);
  const nonTie = windowRounds.filter((round) => round.result === "banker" || round.result === "player");
  const shortNonTie = shortRounds.filter((round) => round.result === "banker" || round.result === "player");
  const counts = countResults(windowRounds);
  const shortCounts = countResults(shortRounds);
  const longBias = bias(counts);
  const shortBias = bias(shortCounts);
  const current = currentStreak(nonTie);
  const alternationRate = calcAlternationRate(nonTie);
  const shortAlternationRate = calcAlternationRate(shortNonTie);
  const frontBack = splitBias(windowRounds);
  const fiveElements = calcFiveElements(windowRounds);
  const bagua = calcBagua(nonTie);
  const latestAt = rounds.map((round) => round.observedAt || round.createdAt || "").filter(Boolean).sort().at(-1) || "";
  const freshnessMinutes = ageMinutes(latestAt);
  const pattern = classifyPattern({ current, alternationRate, shortAlternationRate, shortBias, longBias, counts });
  const observeMode = classifyObserveMode({ current, alternationRate, shortAlternationRate, shortBias, freshnessMinutes, rounds: windowRounds.length });
  const trendScore = scoreTrend({ current, alternationRate, shortAlternationRate, shortBias, longBias, freshnessMinutes, rounds: windowRounds.length, fiveElements });
  const lastSignal = current.side ? `${labelResult(current.side)}${current.length}連` : "無明顯連段";

  return {
    code,
    group: code.replace(/\d+$/, ""),
    targetIndex,
    rounds: rounds.length,
    analyzedRounds: windowRounds.length,
    latestAt,
    freshnessMinutes,
    counts,
    shortCounts,
    bankerRate: rate(counts.banker, counts.banker + counts.player),
    playerRate: rate(counts.player, counts.banker + counts.player),
    tieRate: rate(counts.tie, windowRounds.length),
    bankerPairRate: rate(counts.bankerPair, windowRounds.length),
    playerPairRate: rate(counts.playerPair, windowRounds.length),
    luckySixRate: rate(counts.luckySix, windowRounds.length),
    longBias,
    shortBias,
    biasShift: round(shortBias - longBias, 4),
    alternationRate,
    shortAlternationRate,
    currentStreak: current,
    frontBack,
    pattern,
    observeMode,
    lastSignal,
    trendScore,
    fiveElements,
    bagua,
    recentSequence: nonTie.slice(-24).map((round) => resultChar(round.result)).join("")
  };
}

function analyzeGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.group) || {
      group: item.group,
      tables: 0,
      rounds: 0,
      banker: 0,
      player: 0,
      tie: 0,
      trendScore: 0,
      alternationRate: 0
    };
    group.tables += 1;
    group.rounds += item.analyzedRounds;
    group.banker += item.counts.banker;
    group.player += item.counts.player;
    group.tie += item.counts.tie;
    group.trendScore += item.trendScore;
    group.alternationRate += item.alternationRate;
    groups.set(item.group, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    bankerRate: rate(group.banker, group.banker + group.player),
    playerRate: rate(group.player, group.banker + group.player),
    tieRate: rate(group.tie, group.rounds),
    averageTrendScore: round(group.trendScore / Math.max(1, group.tables), 2),
    averageAlternationRate: round(group.alternationRate / Math.max(1, group.tables), 4)
  })).sort((left, right) => right.averageTrendScore - left.averageTrendScore);
}

function analyzeCrossTable(items) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      const leftSeq = normalizeSequence(roundsByCode.get(left.code) || []);
      const rightSeq = normalizeSequence(roundsByCode.get(right.code) || []);
      const comparison = compareSequences(leftSeq, rightSeq);
      if (comparison.compared < 40) continue;
      pairs.push({
        pair: `${left.code}-${right.code}`,
        left: left.code,
        right: right.code,
        compared: comparison.compared,
        sameRate: comparison.sameRate,
        oppositeRate: comparison.oppositeRate,
        edge: round(Math.max(comparison.sameRate, comparison.oppositeRate) - 0.5, 4)
      });
    }
  }
  const adjacent = [];
  for (let index = 1; index < TARGET_CODES.length; index += 1) {
    const left = tableByCode(items, TARGET_CODES[index - 1]);
    const right = tableByCode(items, TARGET_CODES[index]);
    if (!left || !right) continue;
    const comparison = compareSequences(normalizeSequence(roundsByCode.get(left.code) || []), normalizeSequence(roundsByCode.get(right.code) || []));
    adjacent.push({
      pair: `${left.code}-${right.code}`,
      compared: comparison.compared,
      sameRate: comparison.sameRate,
      oppositeRate: comparison.oppositeRate
    });
  }
  return {
    sameDirection: [...pairs].sort((left, right) => right.sameRate - left.sameRate).slice(0, 15),
    oppositeDirection: [...pairs].sort((left, right) => right.oppositeRate - left.oppositeRate).slice(0, 15),
    adjacent
  };
}

function countResults(rounds) {
  const counts = { banker: 0, player: 0, tie: 0, bankerPair: 0, playerPair: 0, luckySix: 0 };
  for (const round of rounds) {
    if (round.result === "banker") counts.banker += 1;
    if (round.result === "player") counts.player += 1;
    if (round.result === "tie") counts.tie += 1;
    if (round.bankerPair) counts.bankerPair += 1;
    if (round.playerPair) counts.playerPair += 1;
    if (round.luckySix) counts.luckySix += 1;
  }
  return counts;
}

function currentStreak(nonTieRounds) {
  const last = nonTieRounds.at(-1);
  if (!last) return { side: "", length: 0 };
  let length = 0;
  for (let index = nonTieRounds.length - 1; index >= 0; index -= 1) {
    if (nonTieRounds[index].result !== last.result) break;
    length += 1;
  }
  return { side: last.result, length };
}

function calcAlternationRate(nonTieRounds) {
  if (nonTieRounds.length < 2) return 0;
  let changes = 0;
  for (let index = 1; index < nonTieRounds.length; index += 1) {
    if (nonTieRounds[index].result !== nonTieRounds[index - 1].result) changes += 1;
  }
  return round(changes / (nonTieRounds.length - 1), 4);
}

function splitBias(rounds) {
  const midpoint = Math.floor(rounds.length / 2);
  const front = countResults(rounds.slice(0, midpoint));
  const back = countResults(rounds.slice(midpoint));
  return {
    frontBias: bias(front),
    backBias: bias(back),
    shift: round(bias(back) - bias(front), 4)
  };
}

function calcFiveElements(rounds) {
  const scores = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  for (const round of rounds) {
    if (round.result === "banker") scores.fire += 1;
    if (round.result === "player") scores.water += 1;
    if (round.result === "tie") scores.earth += 1.5;
    if (round.bankerPair || round.playerPair) scores.wood += 1;
    if (round.luckySix) scores.metal += 1.2;
  }
  const dominant = Object.entries(scores).sort((left, right) => right[1] - left[1])[0]?.[0] || "none";
  return {
    scores: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, round(value, 2)])),
    dominant,
    read: elementRead(dominant)
  };
}

function calcBagua(nonTieRounds) {
  const bits = nonTieRounds.slice(-6).map((round) => round.result === "banker" ? "1" : "0");
  while (bits.length < 6) bits.unshift("0");
  const lower = bits.slice(0, 3).join("");
  const upper = bits.slice(3).join("");
  return {
    bits: bits.join(""),
    lower: trigram(lower),
    upper: trigram(upper),
    hexagram: `${trigram(upper)}上${trigram(lower)}下`
  };
}

function classifyPattern(input) {
  if (input.current.length >= 5) return `${labelResult(input.current.side)}長龍`;
  if (input.shortAlternationRate >= 0.68) return "單跳/跳路偏強";
  if (input.alternationRate >= 0.58) return "震盪互換";
  if (input.shortBias > 0.12) return "短線偏莊";
  if (input.shortBias < -0.12) return "短線偏閒";
  if (Math.abs(input.longBias) < 0.04) return "均衡盤";
  return input.longBias > 0 ? "中線偏莊" : "中線偏閒";
}

function classifyObserveMode(input) {
  if (input.rounds < 40 || input.freshnessMinutes > 240) return "資料偏少/偏舊，暫緩觀察";
  if (input.current.length >= 6) return "長連後觀察斷點";
  if (input.current.length >= 3 && Math.sign(input.shortBias || 0) === (input.current.side === "banker" ? 1 : -1)) return "順勢觀察";
  if (input.shortAlternationRate >= 0.68) return "跳路觀察";
  if (Math.abs(input.shortBias) >= 0.16) return input.shortBias > 0 ? "偏莊觀察" : "偏閒觀察";
  return "均衡觀察";
}

function scoreTrend(input) {
  const sampleScore = Math.min(20, input.rounds / 5);
  const biasScore = Math.min(25, Math.abs(input.shortBias) * 120);
  const shiftScore = Math.min(15, Math.abs(input.shortBias - input.longBias) * 80);
  const streakScore = Math.min(25, input.current.length * 5);
  const roadShapeScore = Math.min(15, Math.abs(input.shortAlternationRate - 0.5) * 60);
  const freshScore = input.freshnessMinutes <= 60 ? 10 : input.freshnessMinutes <= 240 ? 5 : 0;
  const elementScore = input.fiveElements.dominant === "fire" || input.fiveElements.dominant === "water" ? 5 : 2;
  return round(sampleScore + biasScore + shiftScore + streakScore + roadShapeScore + freshScore + elementScore, 2);
}

function normalizeSequence(rounds) {
  return rounds
    .filter((round) => round.result === "banker" || round.result === "player")
    .slice(-80)
    .map((round) => round.result === "banker" ? "B" : "P");
}

function compareSequences(left, right) {
  const compared = Math.min(left.length, right.length);
  if (!compared) return { compared: 0, sameRate: 0, oppositeRate: 0 };
  let same = 0;
  for (let index = 0; index < compared; index += 1) {
    if (left[left.length - compared + index] === right[right.length - compared + index]) same += 1;
  }
  return {
    compared,
    sameRate: round(same / compared, 4),
    oppositeRate: round((compared - same) / compared, 4)
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# Baijia 36桌牌路交叉分析`);
  lines.push("");
  lines.push(`生成時間：${report.generatedAt}`);
  lines.push(`分析窗口：每桌最近 ${report.window} 局；短線窗口 ${report.shortWindow} 局。`);
  lines.push("");
  lines.push(`> 提醒：百家樂結果具有不確定性，本報告只做歷史牌路、交叉比對與象徵權重觀察，不是保證命中的下注方法。`);
  lines.push("");
  lines.push(`## 完整性`);
  lines.push(`- 分析桌數：${report.completeness.analyzedTables}/${report.completeness.targetTables}`);
  lines.push(`- 總牌路：${report.completeness.totalRounds}`);
  lines.push(`- 0局桌：${report.completeness.zeroRoundTables.length ? report.completeness.zeroRoundTables.join(", ") : "無"}`);
  lines.push("");
  lines.push(`## 趨勢優先觀察`);
  lines.push(`|桌|分數|型態|觀察模式|最新訊號|五行|卦象|短線莊偏|跳路率|`);
  lines.push(`|---|---:|---|---|---|---|---|---:|---:|`);
  for (const item of report.topTrend.slice(0, 12)) {
    lines.push(`|${item.code}|${item.trendScore}|${item.pattern}|${item.observeMode}|${item.lastSignal}|${item.fiveElements.dominant}|${item.bagua.hexagram}|${item.shortBias}|${item.shortAlternationRate}|`);
  }
  lines.push("");
  lines.push(`## 群組`);
  lines.push(`|群|桌數|平均分數|莊率|閒率|和率|平均跳路率|`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const group of report.groups) {
    lines.push(`|${group.group}|${group.tables}|${group.averageTrendScore}|${group.bankerRate}|${group.playerRate}|${group.tieRate}|${group.averageAlternationRate}|`);
  }
  lines.push("");
  lines.push(`## 跨桌同向`);
  lines.push(`|桌組|比對局數|同向率|反向率|`);
  lines.push(`|---|---:|---:|---:|`);
  for (const pair of report.cross.sameDirection.slice(0, 10)) {
    lines.push(`|${pair.pair}|${pair.compared}|${pair.sameRate}|${pair.oppositeRate}|`);
  }
  lines.push("");
  lines.push(`## 跨桌反向`);
  lines.push(`|桌組|比對局數|同向率|反向率|`);
  lines.push(`|---|---:|---:|---:|`);
  for (const pair of report.cross.oppositeDirection.slice(0, 10)) {
    lines.push(`|${pair.pair}|${pair.compared}|${pair.sameRate}|${pair.oppositeRate}|`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function bias(counts) {
  const total = counts.banker + counts.player;
  return total ? round((counts.banker - counts.player) / total, 4) : 0;
}

function rate(value, total) {
  return total ? round(value / total, 4) : 0;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function labelResult(result) {
  return result === "banker" ? "莊" : result === "player" ? "閒" : "和";
}

function resultChar(result) {
  return result === "banker" ? "B" : result === "player" ? "P" : "T";
}

function normalizeCode(value) {
  return String(value || "").toUpperCase().match(/\b(?:IB\d{3}|[BQCV]\d{3})\b/)?.[0] || "";
}

function ageMinutes(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 60000)) : 999999;
}

function elementRead(value) {
  return {
    wood: "木旺：對子/旁支訊號偏多，宜看分岔與轉折",
    fire: "火旺：莊勢訊號偏強，宜看順勢是否延續",
    earth: "土旺：和局/停頓訊號偏多，宜保守觀察",
    metal: "金旺：Lucky6/特殊訊號偏多，宜看突發點",
    water: "水旺：閒勢訊號偏強，宜看反向壓力"
  }[value] || "無明顯五行";
}

function trigram(bits) {
  return {
    "111": "乾",
    "000": "坤",
    "010": "坎",
    "101": "離",
    "001": "震",
    "110": "巽",
    "100": "艮",
    "011": "兌"
  }[bits] || "坤";
}

function tableByCode(items, code) {
  return items.find((item) => item.code === code);
}

function fileTimestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
