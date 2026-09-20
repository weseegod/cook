import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildManifest } from "./generate-latest-json.mjs";

function sigFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "let-cook-sig-"));
  const path = join(dir, "artifact.sig");
  writeFileSync(path, `${body}\n`);
  return path;
}

test("builds a linux-only latest.json for a single-platform self-build", () => {
  const sig = sigFile("linux-sig");
  const manifest = buildManifest(
    {
      version: "1.0.37",
      baseUrl: "https://download.letcook.dev/v1.0.37",
      notes: "Let Cook 1.0.37",
      platforms: [`linux-x86_64:${sig}:let-cook-1.0.37-linux-x86_64.AppImage`],
      installers: [
        `linux:${sig}:let-cook-1.0.37-linux-x86_64.deb`,
        "linux-appimage:let-cook-1.0.37-linux-x86_64.AppImage",
      ],
    },
    { now: new Date("2026-09-20T12:00:00.000Z") },
  );
  assert.equal(manifest.version, "1.0.37");
  assert.deepEqual(manifest.platforms["linux-x86_64"], {
    signature: "linux-sig",
    url: "https://download.letcook.dev/v1.0.37/let-cook-1.0.37-linux-x86_64.AppImage",
  });
  assert.equal(manifest.installers.linux.signature, "linux-sig");
  assert.equal(
    manifest.installers["linux-appimage"].url,
    "https://download.letcook.dev/v1.0.37/let-cook-1.0.37-linux-x86_64.AppImage",
  );
  assert.equal(manifest.platforms["linux-x86_64"].url.endsWith(".deb"), false);
});

test("merges a second platform into the same version", () => {
  const linuxSig = sigFile("linux-sig");
  const macSig = sigFile("mac-sig");
  const dir = mkdtempSync(join(tmpdir(), "let-cook-latest-"));
  const previousPath = join(dir, "latest.json");
  const previous = buildManifest({
    version: "1.0.37",
    baseUrl: "https://download.letcook.dev/v1.0.37",
    platforms: [`linux-x86_64:${linuxSig}:let-cook-1.0.37-linux-x86_64.AppImage`],
    installers: ["linux-appimage:let-cook-1.0.37-linux-x86_64.AppImage"],
  });
  writeFileSync(previousPath, JSON.stringify(previous));
  const merged = buildManifest({
    version: "1.0.37",
    baseUrl: "https://download.letcook.dev/v1.0.37",
    merge: previousPath,
    platforms: [`darwin-aarch64:${macSig}:let-cook-1.0.37-macos-aarch64.app.tar.gz`],
    installers: ["mac-arm:let-cook-1.0.37-macos-aarch64.dmg"],
  });
  assert.ok(merged.platforms["linux-x86_64"]);
  assert.ok(merged.platforms["darwin-aarch64"]);
  assert.ok(merged.installers["linux-appimage"]);
  assert.ok(merged.installers["mac-arm"]);
});

test("a new version discards the previous manifest instead of mixing URLs", () => {
  const oldSig = sigFile("old-sig");
  const newSig = sigFile("new-sig");
  const dir = mkdtempSync(join(tmpdir(), "let-cook-latest-"));
  const previousPath = join(dir, "latest.json");
  writeFileSync(
    previousPath,
    JSON.stringify(
      buildManifest({
        version: "1.0.36",
        baseUrl: "https://download.letcook.dev/v1.0.36",
        platforms: [`linux-x86_64:${oldSig}:let-cook-1.0.36-linux-x86_64.AppImage`],
        installers: [],
      }),
    ),
  );
  const next = buildManifest({
    version: "1.0.37",
    baseUrl: "https://download.letcook.dev/v1.0.37",
    merge: previousPath,
    platforms: [`linux-x86_64:${newSig}:let-cook-1.0.37-linux-x86_64.AppImage`],
    installers: [],
  });
  assert.equal(next.version, "1.0.37");
  assert.equal(next.platforms["linux-x86_64"].signature, "new-sig");
  assert.match(next.platforms["linux-x86_64"].url, /v1\.0\.37/);
});

test("four-platform R2 manifest includes Windows NSIS", () => {
  const linuxSig = sigFile("linux-sig");
  const macArmSig = sigFile("mac-arm-sig");
  const macIntelSig = sigFile("mac-intel-sig");
  const winSig = sigFile("win-sig");
  const manifest = buildManifest({
    version: "1.0.37",
    baseUrl: "https://download.letcook.dev/v1.0.37",
    platforms: [
      `linux-x86_64:${linuxSig}:let-cook-1.0.37-linux-x86_64.AppImage`,
      `darwin-aarch64:${macArmSig}:let-cook-1.0.37-macos-aarch64.app.tar.gz`,
      `darwin-x86_64:${macIntelSig}:let-cook-1.0.37-macos-x86_64.app.tar.gz`,
      `windows-x86_64:${winSig}:let-cook-1.0.37-windows-x86_64-setup.exe`,
    ],
    installers: [
      "linux-appimage:let-cook-1.0.37-linux-x86_64.AppImage",
      "mac-arm:let-cook-1.0.37-macos-aarch64.dmg",
      "mac-intel:let-cook-1.0.37-macos-x86_64.dmg",
      "windows:let-cook-1.0.37-windows-x86_64-setup.exe",
    ],
  });
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    "https://download.letcook.dev/v1.0.37/let-cook-1.0.37-windows-x86_64-setup.exe",
  );
  assert.equal(manifest.installers.windows.name, "let-cook-1.0.37-windows-x86_64-setup.exe");
});

test("refuses to put a .deb on platforms.*", () => {
  const sig = sigFile("deb-sig");
  assert.throws(
    () =>
      buildManifest({
        version: "1.0.37",
        baseUrl: "https://download.letcook.dev/v1.0.37",
        platforms: [`linux-x86_64:${sig}:let-cook-1.0.37-linux-x86_64.deb`],
        installers: [],
      }),
    /do not put a \.deb/,
  );
});
