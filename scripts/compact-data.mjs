import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const dbPath = join(process.cwd(), "data", "baijia-db.json");

if (!existsSync(dbPath)) {
  console.log("No local data file found.");
  process.exit(0);
}

const backupPath = `${dbPath}.pre-compact-${Date.now()}`;
copyFileSync(dbPath, backupPath);

const db = JSON.parse(readFileSync(dbPath, "utf8"));

db.snapshots = (db.snapshots || []).map((snapshot) => ({
  id: snapshot.id,
  createdAt: snapshot.createdAt,
  source: snapshot.source,
  url: snapshot.url,
  tableCandidates: snapshot.tableCandidates,
  sample: (snapshot.sample || []).map(compactTable),
  details: (snapshot.details || []).map((detail) => ({
    name: detail.name,
    roomRound: detail.roomRound,
    stats: detail.stats || {},
    roadImages: (detail.roadImages || [])
      .filter((image) => image && !String(image.src || "").startsWith("data:image"))
      .map((image) => ({ width: image.width, height: image.height, path: image.path }))
  }))
})).slice(-50);

db.tables = (db.tables || []).map((table) => ({
  ...table,
  summary: table.summary || null,
  lastDetail: table.lastDetail || null,
  lastDetailText: "",
  lastRoadImages: (table.lastRoadImages || [])
    .filter((image) => image && !String(image.src || "").startsWith("data:image"))
    .map((image) => ({ width: image.width, height: image.height, path: image.path }))
}));

db.rounds = (db.rounds || []).map((round) => ({
  id: round.id,
  tableId: round.tableId,
  shoe: round.shoe || "",
  handNumber: round.handNumber || null,
  result: round.result,
  bankerPair: Boolean(round.bankerPair),
  playerPair: Boolean(round.playerPair),
  luckySix: Boolean(round.luckySix),
  bankerPoints: round.bankerPoints ?? null,
  playerPoints: round.playerPoints ?? null,
  bankerCards: round.bankerCards || [],
  playerCards: round.playerCards || [],
  cardText: round.cardText || "",
  source: round.source || "",
  observedAt: round.observedAt || round.createdAt || "",
  externalKey: round.externalKey || ""
}));

db.updatedAt = new Date().toISOString();
writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");

const before = readFileSync(backupPath).length;
const after = readFileSync(dbPath).length;
console.log(JSON.stringify({ backupPath, before, after, saved: before - after }, null, 2));

function compactTable(table) {
  return {
    name: table.name,
    roomId: table.roomId,
    gameType: table.gameType,
    dealer: table.dealer,
    summary: table.summary || null,
    roadImageCount: table.roadImageCount || 0
  };
}
