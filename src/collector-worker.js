"use strict";

const { loadLocalEnv } = require("./env");
loadLocalEnv();

const { runCollectorLoop } = require("./collector");

runCollectorLoop().catch((error) => {
  console.error(`Collector worker failed: ${error.stack || error.message || String(error)}`);
  process.exit(1);
});
