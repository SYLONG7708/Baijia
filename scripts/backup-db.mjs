import { createRequire } from "node:module";

const { backupDatabase, maybeRunDailyBackup } = createRequire(import.meta.url)("../src/backup");

const args = process.argv.slice(2);
const dailyOnly = args.includes("--daily");
const reason = args.find((arg) => !arg.startsWith("--")) || (dailyOnly ? "daily" : "manual");
const manifest = dailyOnly ? maybeRunDailyBackup(reason) : backupDatabase(reason);
console.log(JSON.stringify(manifest || { skipped: true, reason, dailyOnly }, null, 2));
