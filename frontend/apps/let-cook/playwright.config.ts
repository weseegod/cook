import { defineConfig } from "@playwright/test";

/**
 * The suites run the renderer over the recording mock transport, so the dev server they talk to
 * must be started with `VITE_MOCK_ACP=1`. `COOK_E2E_PORT` moves that server off 1420 when a
 * `pnpm tauri dev` session already holds it — reusing *that* server would leave the mock inactive
 * and fail every test for a reason that has nothing to do with the code under test.
 */
const port = Number(process.env.COOK_E2E_PORT ?? 1420);

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  // PW_CAPTURE=1 keeps a screenshot plus a trace (DOM snapshots and console log) for every test.
  outputDir: process.env.PW_OUTPUT_DIR ?? "test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: process.env.PW_CAPTURE === "1" ? "on" : "retain-on-failure",
    screenshot: process.env.PW_CAPTURE === "1" ? "on" : "only-on-failure",
  },
  webServer: {
    command: `VITE_MOCK_ACP=1 pnpm dev --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
