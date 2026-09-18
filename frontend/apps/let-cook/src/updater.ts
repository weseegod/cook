import { check } from "@tauri-apps/plugin-updater";
import { normalizeError } from "./acp/errors";

/**
 * Flip to `true` only after `plugins.updater` in `tauri.conf.json` has a real
 * minisign pubkey (`pnpm tauri signer generate`) and at least one HTTPS
 * endpoint. Until then Settings → About keeps "Check for updates" disabled so
 * empty endpoints / placeholder pubkey never produce a confusing error.
 *
 * The updater refreshes the app binary only — never `~/.cook/bin/cook`.
 */
export const UPDATER_CONFIGURED = false;

export type UpdateCheckResult =
  | { status: "disabled" }
  | { status: "up-to-date" }
  | { status: "available"; version: string; notes?: string }
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
