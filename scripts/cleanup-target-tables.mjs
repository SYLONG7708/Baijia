import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { backupDatabase } = require("../src/backup");
const store = require("../src/store");

const backup = backupDatabase("before-target-table-cleanup");
const cleanup = store.cleanupAllbetTablePollution();

console.log(JSON.stringify({ backup, cleanup }, null, 2));
