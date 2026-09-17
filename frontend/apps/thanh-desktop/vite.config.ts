import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Playwright streams trace artifacts (including `.html` snapshots) under `test-results*/`
    // while a spec runs; Vite treats any `.html` write as a full page reload, which would reload
    // the app mid-test and fail the whole run.
    watch: { ignored: ["**/src-tauri/**", "**/test-results*/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: ["es2021", "chrome100", "safari13"] },
});
