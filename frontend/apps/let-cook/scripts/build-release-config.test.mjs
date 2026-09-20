import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "build-release-config.mjs");

function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "let-cook-release-config-"));
  const out = join(dir, "tauri.release.conf.json");
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env, COOK_RELEASE_CONFIG_OUT: out },
    encoding: "utf8",
  });
  return { result, out, dir };
}

test("dev/local: no pubkey keeps updater artifacts off", () => {
  const { result, out } = run({
    COOK_UPDATER_PUBLIC_KEY: "",
    COOK_UPDATER_PUBKEY_FILE: join(tmpdir(), "missing-let-cook.pubkey"),
    COOK_REQUIRE_UPDATER: "",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(config.bundle.createUpdaterArtifacts, undefined);
  assert.equal(config.plugins, undefined);
  assert.equal(config.bundle.macOS.minimumSystemVersion, "10.15");
});

test("release: pubkey + endpoint enable updater artifacts", () => {
  const { result, out } = run({
    COOK_UPDATER_PUBLIC_KEY: "test-pubkey",
    COOK_UPDATER_ENDPOINT: "https://example.test/latest.json",
    COOK_REQUIRE_UPDATER: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.plugins.updater, {
    pubkey: "test-pubkey",
    endpoints: ["https://example.test/latest.json"],
  });
  assert.equal(config.bundle.externalBin, undefined);
});

test("release: sidecar flag adds externalBin without clobbering updater", () => {
  const { result, out } = run({
    COOK_UPDATER_PUBLIC_KEY: "test-pubkey",
    COOK_DESKTOP_SIDECAR: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(config.bundle.externalBin, ["binaries/cook"]);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
});

test("require updater fails closed without pubkey", () => {
  const pubkeyFile = join(mkdtempSync(join(tmpdir(), "let-cook-pubkey-")), "missing.pubkey");
  const { result } = run({
    COOK_UPDATER_PUBLIC_KEY: "",
    COOK_UPDATER_PUBKEY_FILE: pubkeyFile,
    COOK_REQUIRE_UPDATER: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /updater\.pubkey/);
});

test("pubkey file is used when env is unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "let-cook-pubkey-file-"));
  const pubkeyFile = join(dir, "updater.pubkey");
  writeFileSync(pubkeyFile, "file-pubkey\n");
  const { result, out } = run({
    COOK_UPDATER_PUBLIC_KEY: "",
    COOK_UPDATER_PUBKEY_FILE: pubkeyFile,
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(config.plugins.updater.pubkey, "file-pubkey");
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://download.letcook.dev/latest.json",
  ]);
});
