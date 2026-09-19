import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const tauriBin = process.platform === "win32" ? "tauri.cmd" : "tauri";

// Icon PNGs/ICNS are committed. Only regenerate when asked — never on `dev`/`build`,
// which used to rewrite every asset and leave a dirty git tree on each run.
if (args[0] === "icons") {
  const iconRefresh = spawnSync(tauriBin, ["icon", "src-tauri/icons/source.svg"], { stdio: "inherit" });
  if (iconRefresh.error) {
    console.error(`Unable to refresh Tauri icons: ${iconRefresh.error.message}`);
    process.exit(1);
  }
  process.exit(iconRefresh.status ?? 1);
}

if (
  process.platform === "darwin" &&
  args[0] === "dev" &&
  !args.includes("--runner") &&
  !args.includes("-r")
) {
  args.push("--runner", "../scripts/macos-dev-runner.mjs");
}

const result = spawnSync(tauriBin, args, { stdio: "inherit" });
if (result.error) {
  console.error(`Unable to run Tauri CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
