// Sandbox-only mutation test — focused, fast, ignores boilerplate static code
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [resolve(__dirname, "src/core/sandbox/**/*.ts")],
  testFiles: [resolve(__dirname, "tests/sandbox.test.ts")],
  vitest: { configFile: resolve(__dirname, "vitest.config.ts") },
  ignoreStatic: true,     // skip module-level boilerplate (Set init, class fields, fallthrough)
  thresholds: { high: 80, low: 60, break: 50 },
  reporters: ["progress", "clear-text", "html", "json"],
  jsonReporter: { fileName: resolve(__dirname, "reports/mutation/sandbox.json") },
  concurrency: 4,
  timeoutMS: 30000,
};
