import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Write a tauri.release.conf.json with release-only overrides.
//
// Tauri's --config flag merges the provided JSON on top of the base
// tauri.conf.json, so this file must contain ONLY the delta fields —
// not a copy of the base config.
//
// Let Cook release builds (self-build, no CI):
// 1. bundle.macOS.minimumSystemVersion = "10.15"
// 2. bundle.createUpdaterArtifacts = true so Tauri produces .app.tar.gz /
//    installer signatures (.sig) when TAURI_SIGNING_PRIVATE_KEY is set.
// 3. plugins.updater with pubkey + GitHub Releases endpoint.
// 4. bundle.externalBin when a cook sidecar was staged for this platform.
//
// Apple code signing / notarization is out of scope — macOS builds use
// --no-sign for codesign. Updater signing is separate (minisign keys).

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputConfigPath = resolve(
  process.env.COOK_RELEASE_CONFIG_OUT || resolve(packageRoot, "src-tauri/tauri.release.conf.json"),
);
const pubkeyPath = resolve(
  process.env.COOK_UPDATER_PUBKEY_FILE || resolve(packageRoot, "src-tauri/updater.pubkey"),
);

function readPubkey() {
  const fromEnv = process.env.COOK_UPDATER_PUBLIC_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(pubkeyPath)) return readFileSync(pubkeyPath, "utf8").trim();
  return "";
}

const updaterPubkey = readPubkey();
const updaterEndpoint =
  process.env.COOK_UPDATER_ENDPOINT?.trim() ||
  "https://download.letcook.dev/latest.json";
const requireUpdater = process.env.COOK_REQUIRE_UPDATER === "1";
const sidecar = process.env.COOK_DESKTOP_SIDECAR === "1";

if (requireUpdater) {
  const missing = [];
  if (!updaterPubkey) missing.push("COOK_UPDATER_PUBLIC_KEY or src-tauri/updater.pubkey");
  if (!updaterEndpoint) missing.push("COOK_UPDATER_ENDPOINT");
  if (missing.length > 0) {
    console.error(`Error: required environment variable(s) missing: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const releaseConfig = {
  bundle: {
    macOS: {
      minimumSystemVersion: "10.15",
    },
  },
};

if (updaterPubkey && updaterEndpoint) {
  releaseConfig.bundle.createUpdaterArtifacts = true;
  releaseConfig.plugins = {
    updater: {
      pubkey: updaterPubkey,
      endpoints: [updaterEndpoint],
    },
  };
  console.log(`Updater enabled -> ${updaterEndpoint}`);
} else {
  console.log("Release config: no updater pubkey — updater artifacts off (local/dev)");
}

if (sidecar) {
  releaseConfig.bundle.externalBin = ["binaries/cook"];
  console.log("Sidecar enabled -> bundle.externalBin binaries/cook");
}

writeFileSync(outputConfigPath, `${JSON.stringify(releaseConfig, null, 2)}\n`);
console.log(`Wrote ${outputConfigPath}`);
