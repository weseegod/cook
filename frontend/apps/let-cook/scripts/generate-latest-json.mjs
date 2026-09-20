import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Build / merge a Tauri updater latest.json for Cloudflare R2.
//
// Usage:
//   node scripts/generate-latest-json.mjs \
//     --version 1.0.37 \
//     --base-url https://download.letcook.dev/v1.0.37 \
//     --out latest.json \
//     --platform linux-x86_64:/path/to.sig:let-cook-1.0.37-linux-x86_64.AppImage \
//     --installer linux-appimage:let-cook-1.0.37-linux-x86_64.AppImage \
//     [--merge existing.json] [--notes "Let Cook 1.0.37"]
//
// platforms.* is what tauri-plugin-updater consumes. Do NOT put a .deb on
// platforms.linux-x86_64 (the plugin would treat it as an AppImage).
// installers.* is for landing / install.sh discovery and may include .deb.

const PLATFORM_KEYS = new Set(["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
const INSTALLER_KEYS = new Set(["mac-arm", "mac-intel", "linux", "linux-appimage", "windows"]);

function usage() {
  return `Usage: generate-latest-json.mjs --version X.Y.Z --base-url URL --out FILE [--merge FILE] [--notes TEXT]
         [--platform key:sig-file:filename]... [--installer key[:sig-file]:filename]...`;
}

function parseArgs(argv) {
  const out = {
    version: null,
    baseUrl: null,
    out: null,
    merge: null,
    notes: null,
    platforms: [],
    installers: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(usage());
      return argv[i];
    };
    switch (arg) {
      case "--version":
        out.version = next();
        break;
      case "--base-url":
        out.baseUrl = next();
        break;
      case "--out":
        out.out = next();
        break;
      case "--merge":
        out.merge = next();
        break;
      case "--notes":
        out.notes = next();
        break;
      case "--platform":
        out.platforms.push(next());
        break;
      case "--installer":
        out.installers.push(next());
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  return out;
}

function splitTriple(value, kind) {
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`malformed ${kind} '${value}' (expected key:sig-file-or-empty:filename)`);
  }
  return {
    key: value.slice(0, first),
    sigFile: value.slice(first + 1, second),
    name: value.slice(second + 1),
  };
}

function readSig(path) {
  if (!path) return "";
  return readFileSync(path, "utf8").replace(/[\r\n]/g, "");
}

function urlFor(baseUrl, name) {
  return `${baseUrl.replace(/\/$/, "")}/${name}`;
}

function assertSafeName(name) {
  if (!name || name.includes("/") || name.includes("..")) {
    throw new Error(`invalid artifact name: ${name}`);
  }
}

export function buildManifest(args, { now = new Date() } = {}) {
  if (!args.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args.version)) {
    throw new Error(`invalid version: ${args.version}`);
  }
  if (!args.baseUrl) throw new Error("missing --base-url");

  let previous = null;
  if (args.merge && existsSync(args.merge)) {
    previous = JSON.parse(readFileSync(args.merge, "utf8"));
    if (previous.version !== args.version) previous = null;
  }

  const platforms = { ...(previous?.platforms ?? {}) };
  const installers = { ...(previous?.installers ?? {}) };

  for (const triple of args.platforms) {
    const { key, sigFile, name } = splitTriple(triple, "platform");
    if (!PLATFORM_KEYS.has(key)) throw new Error(`unsupported platform key: ${key}`);
    assertSafeName(name);
    if (name.endsWith(".deb") || name.endsWith(".deb.sig")) {
      throw new Error("do not put a .deb on platforms.* (Tauri would treat it as an AppImage)");
    }
    const signature = readSig(sigFile);
    if (!signature) throw new Error(`missing signature for platform ${key}: ${sigFile}`);
    platforms[key] = { signature, url: urlFor(args.baseUrl, name) };
  }

  for (const spec of args.installers) {
    const colonCount = spec.split(":").length - 1;
    let key;
    let sigFile = "";
    let name;
    if (colonCount === 1) {
      const split = spec.indexOf(":");
      key = spec.slice(0, split);
      name = spec.slice(split + 1);
    } else {
      ({ key, sigFile, name } = splitTriple(spec, "installer"));
    }
    if (!INSTALLER_KEYS.has(key)) throw new Error(`unsupported installer key: ${key}`);
    assertSafeName(name);
    const entry = { name, url: urlFor(args.baseUrl, name) };
    if (sigFile) {
      const signature = readSig(sigFile);
      if (!signature) throw new Error(`missing signature for installer ${key}: ${sigFile}`);
      entry.signature = signature;
    }
    installers[key] = entry;
  }

  if (Object.keys(platforms).length === 0) {
    throw new Error("latest.json needs at least one platforms.* entry");
  }

  return {
    version: args.version,
    notes: args.notes || previous?.notes || `Let Cook ${args.version}`,
    pub_date: previous?.pub_date || now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms,
    installers,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.out) throw new Error(usage());
  const manifest = buildManifest(args);
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${args.out} (${Object.keys(manifest.platforms).join(", ")})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
