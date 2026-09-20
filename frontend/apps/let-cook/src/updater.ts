import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { normalizeError } from "./acp/errors";

/**
 * Release builds set `VITE_COOK_UPDATER=1` (see `scripts/desktop_release.sh`).
 * Dev/`pnpm tauri dev` keeps this false so empty endpoints in `tauri.conf.json`
 * never produce a confusing error. The updater refreshes the app binary only —
 * never `~/.cook/bin/cook`.
 */
export const UPDATER_CONFIGURED = import.meta.env.VITE_COOK_UPDATER === "1";

export type UpdateCheckResult =
  | { status: "disabled" }
  | { status: "up-to-date" }
  | { status: "available"; version: string; notes?: string }
  | { status: "error"; message: string };

export type UpdateInstallResult =
  | { status: "disabled" }
  | { status: "up-to-date" }
  | { status: "installed" }
  | { status: "error"; message: string };

/** Call Tauri `check()`; graceful when unconfigured or the endpoint is missing. */
export async function checkForAppUpdates(): Promise<UpdateCheckResult> {
  if (!UPDATER_CONFIGURED) return { status: "disabled" };
  try {
    const update = await check();
    if (!update) return { status: "up-to-date" };
    return { status: "available", version: update.version, notes: update.body };
  } catch (error) {
    const message = normalizeError(error, "Could not check for updates");
    return { status: "error", message };
  }
}

/** Download + install the available shell update, then relaunch. Never writes the CLI. */
export async function installAppUpdate(): Promise<UpdateInstallResult> {
  if (!UPDATER_CONFIGURED) return { status: "disabled" };
  try {
    const update = await check();
    if (!update) return { status: "up-to-date" };
    await update.downloadAndInstall();
    await relaunch();
    return { status: "installed" };
  } catch (error) {
    const message = normalizeError(error, "Could not install the update");
    return { status: "error", message };
  }
}
