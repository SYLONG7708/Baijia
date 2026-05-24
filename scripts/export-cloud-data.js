const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "dist", "cloud-backups");

function stamp() {
  const now = new Date();
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function vacuumInto(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.rmSync(target, { force: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqlQuote(target)}`);
  } finally {
    db.close();
  }
  return true;
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.copyFileSync(source, target);
  return true;
}

function dbStats(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const stats = { file: path.basename(filePath), bytes: fs.statSync(filePath).size, tables: {} };
    for (const table of tables) {
      const name = table.name;
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
      try {
        stats.tables[name] = db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count;
      } catch {
        stats.tables[name] = null;
      }
    }
    return stats;
  } finally {
    db.close();
  }
}

function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const backupDir = path.join(OUT_ROOT, `baijia-data-${stamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const files = [];
  const mainDb = path.join(backupDir, "baijia.sqlite");
  const trainingDb = path.join(backupDir, "training.sqlite");
  if (vacuumInto(path.join(DATA_DIR, "baijia.sqlite"), mainDb)) files.push("baijia.sqlite");
  if (vacuumInto(path.join(DATA_DIR, "training.sqlite"), trainingDb)) files.push("training.sqlite");
  if (copyIfExists(path.join(DATA_DIR, "monitor-reports.jsonl"), path.join(backupDir, "monitor-reports.jsonl"))) {
    files.push("monitor-reports.jsonl");
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    sourceRoot: ROOT,
    files,
    notes: [
      "SQLite files were exported with VACUUM INTO for a consistent snapshot.",
      "Environment secrets are not included. Configure /etc/baijia/baijia.env on the cloud VM."
    ],
    stats: {
      baijia: dbStats(mainDb),
      training: dbStats(trainingDb)
    }
  };
  fs.writeFileSync(path.join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ backupDir, manifest }, null, 2)}\n`);
}

main();
