import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  // PW_CAPTURE=1 keeps a screenshot plus a trace (DOM snapshots and console log) for every test.
  outputDir: process.env.PW_OUTPUT_DIR ?? "test-results",
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: process.env.PW_CAPTURE === "1" ? "on" : "retain-on-failure",
    screenshot: process.env.PW_CAPTURE === "1" ? "on" : "only-on-failure",
  },
  webServer: {
    command: "VITE_MOCK_ACP=1 pnpm dev --host 127.0.0.1",
    port: 1420,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
