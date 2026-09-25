import { RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  checkForAppUpdates,
  installAppUpdate,
  type UpdateCheckResult,
} from "../updater";

/** One-shot update notice above the sidebar Settings button. Shares `updater.ts` with Settings → About; no shared state. */
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
      <div className="update-banner-header">
        <p className="update-banner-copy">
          Update available: <strong>{result.version}</strong>
        </p>
        <button
          type="button"
          className="update-banner-close"
          aria-label="Dismiss update"
          disabled={busy}
          onClick={() => setDismissed(true)}
        >
          <X size={14} />
        </button>
      </div>
      {installError && <p className="update-banner-error">{installError}</p>}
      <button type="button" className="update-banner-install" disabled={busy} onClick={() => void onInstall()}>
        <RefreshCw size={14} aria-hidden="true" />
        <span>{busy ? "Installing…" : "Install and Update"}</span>
      </button>
    </div>
  );
}
