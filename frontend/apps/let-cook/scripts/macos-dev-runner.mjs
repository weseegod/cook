#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = join(packageRoot, "src-tauri");
const args = process.argv.slice(2);

if (args[0] !== "run") {
  const result = spawnSync("cargo", args, { cwd: tauriRoot, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const separatorIndex = args.indexOf("--");
const cargoArgs = args.slice(1, separatorIndex === -1 ? args.length : separatorIndex);
const appArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
const profile = cargoArgs.includes("--release") ? "release" : "debug";

const build = spawnSync("cargo", ["build", ...cargoArgs], {
  cwd: tauriRoot,
  stdio: "inherit",
});
if (build.error) {
  console.error(`Unable to build the Tauri app: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const builtExecutable = join(tauriRoot, "target", profile, "let-cook");
const appBundle = join(tauriRoot, "target", profile, "Let Cook Dev.app");
const appExecutable = join(appBundle, "Contents", "MacOS", "let-cook");
const appResources = join(appBundle, "Contents", "Resources");

rmSync(appBundle, { recursive: true, force: true });
mkdirSync(dirname(appExecutable), { recursive: true });
mkdirSync(appResources, { recursive: true });
copyFileSync(builtExecutable, appExecutable);
chmodSync(appExecutable, 0o755);
copyFileSync(join(tauriRoot, "icons", "icon.icns"), join(appResources, "icon.icns"));

writeFileSync(
  join(appBundle, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Let Cook</string>
  <key>CFBundleExecutable</key>
  <string>let-cook</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>dev.letcook.desktop.dev</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Let Cook</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.36</string>
  <key>CFBundleVersion</key>
  <string>1.0.36</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`,
);

const app = spawn(appExecutable, appArgs, {
  cwd: tauriRoot,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => app.kill(signal));
}

app.on("error", (error) => {
  console.error(`Unable to launch the Let Cook dev app: ${error.message}`);
  process.exit(1);
});
app.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
