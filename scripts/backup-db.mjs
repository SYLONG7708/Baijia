import { createRequire } from "node:module";

const { backupDatabase } = createRequire(import.meta.url)("../src/backup");

const reason = process.argv[2] || "manual";
const manifest = backupDatabase(reason);
console.log(JSON.stringify(manifest, null, 2));
