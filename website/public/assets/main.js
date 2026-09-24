/* Cook landing — download links, the Windows switch, and copy buttons.

   The markup ships static links, so the page works without JavaScript. When
   latest.json can be read, the version and the installer URLs are refreshed
   from it; if the read is blocked, the static links stay. */

const PUBLIC_BASE = "https://download.letcook.dev";
const FALLBACK_VERSION = "1.0.37";
const LATEST_JSON = `${PUBLIC_BASE}/latest.json`;

/** Card key -> file name inside the immutable release directory (v<version>/). */
const DESKTOP_ASSETS = {
  "mac-arm": (v) => `let-cook-${v}-macos-aarch64.dmg`,
  "mac-intel": (v) => `let-cook-${v}-macos-x86_64.dmg`,
  "linux-appimage": (v) => `let-cook-${v}-linux-x86_64.AppImage`,
  linux: (v) => `let-cook-${v}-linux-x86_64.deb`,
  windows: (v) => `let-cook-${v}-windows-x86_64-setup.exe`,
};

/** Keys in latest.json `installers` that map onto a link on the page. */
const INSTALLER_KEYS = ["mac-arm", "mac-intel", "linux-appimage", "linux", "windows"];

const releaseUrl = (version, name) => `${PUBLIC_BASE}/v${version}/${name}`;
const cliUrl = (version, platform) => `${PUBLIC_BASE}/cook-${version}-${platform}`;

function installerUrls(manifest) {
  const out = {};
  for (const key of INSTALLER_KEYS) {
    const url = manifest?.installers?.[key]?.url;
    if (typeof url === "string" && url.startsWith("https://")) out[key] = url;
  }
  return out;
}

/** Published installer URL first, path built from the version second. */
function assetHref(version, key, urls) {
  if (urls[key]) return urls[key];
  const builder = DESKTOP_ASSETS[key];
  return builder ? releaseUrl(version, builder(version)) : null;
}

function userAgentString() {
  return [navigator.userAgentData?.platform, navigator.platform, navigator.userAgent]
    .filter(Boolean)
    .join(" ");
}

/** `windows` when the visitor is on Windows, otherwise null. */
function detectOs() {
  return /Win/i.test(userAgentString()) ? "windows" : null;
}

function cliPlatform(os) {
  if (os === "windows") return "windows-x86_64";
  if (/Android|Linux|X11|CrOS/i.test(userAgentString())) return "linux-x86_64";
  return "macos-aarch64";
}

function render(version, os, urls = {}) {
  for (const node of document.querySelectorAll("[data-asset]")) {
    const key = node.dataset.asset;
    if (key === "cli") {
      node.href = cliUrl(version, cliPlatform(os));
      continue;
    }
    const href = assetHref(version, key, urls);
    if (href) node.href = href;
  }

  const cliName = document.querySelector("[data-cli-platform]");
  if (cliName) cliName.textContent = cliPlatform(os);

  // The curl installer refuses to run on Windows, so offer the download there.
  if (os === "windows") {
    const curl = document.querySelector("[data-curl-cta]");
    const win = document.querySelector("[data-windows-cta]");
    if (curl) curl.hidden = true;
    if (win) win.hidden = false;
  }
}

/** Progressive enhancement: R2 may or may not allow cross-origin reads. */
async function refreshFromLatest(os) {
  let manifest;
  try {
    const response = await fetch(LATEST_JSON, { cache: "no-store" });
    if (!response.ok) return;
    manifest = await response.json();
  } catch {
    return; // Offline, blocked, or not published yet: keep the static links.
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return;
  render(version, os, installerUrls(manifest));
}

/* ---------- copy buttons ---------- */

let toastTimer = null;

function showToast(message) {
  const toast = document.querySelector("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The Clipboard API needs a secure context; fall back to a selection copy.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function wireCopyButtons() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const text =
        button.dataset.copyText ?? button.parentElement?.querySelector("code")?.innerText ?? "";
      if (!text.trim()) return;
      const ok = await copyText(text);
      const original = button.textContent;
      button.classList.toggle("copied", ok);
      button.textContent = ok ? "Copied" : "Select manually";
      showToast(
        ok ? `Copied ${button.dataset.copyLabel ?? "command"}` : "Copy blocked by the browser",
      );
      setTimeout(() => {
        button.classList.remove("copied");
        button.textContent = original;
      }, 1600);
    });
  }
}

/* ---------- boot ---------- */

function boot() {
  const year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());

  wireCopyButtons();

  const os = detectOs();
  render(FALLBACK_VERSION, os);
  refreshFromLatest(os);
}

boot();
