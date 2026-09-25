import { useEffect, useState } from "react";
import {
  checkForAppUpdates,
  installAppUpdate,
  type UpdateCheckResult,
} from "../updater";

/** One-shot update notice in the chat column. Shares `updater.ts` with Settings → About; no shared state. */
export function UpdateBanner() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkForAppUpdates().then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || result?.status !== "available") return null;

  async function onInstall() {
    setBusy(true);
    setInstallError(null);
    try {
      const installed = await installAppUpdate();
      if (installed.status === "error") setInstallError(installed.message);
      if (installed.status === "up-to-date") setResult({ status: "up-to-date" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="update-banner" data-testid="update-banner" role="status">
      <p className="update-banner-copy">
        Update available: <strong>{result.version}</strong>
      </p>
      {installError && <p className="update-banner-error">{installError}</p>}
      <div className="update-banner-actions">
        <button type="button" className="ghost-button" disabled={busy} onClick={() => void onInstall()}>
          {busy ? "Installing…" : "Install and update"}
        </button>
        <button type="button" className="ghost-button" disabled={busy} onClick={() => setDismissed(true)}>
          Dismiss update
        </button>
      </div>
    </div>
  );
}
