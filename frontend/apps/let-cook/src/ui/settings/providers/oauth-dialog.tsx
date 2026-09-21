import { ExternalLink, KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cancelProviderOauth,
  openExternalUrl,
  pollProviderOauth,
  startProviderOauth,
  submitProviderOauthCode,
  type OauthStart,
} from "../../../acp/provider-oauth";
import { normalizeError } from "../../../acp/errors";
import type { ProviderPreset } from "../../../acp/providers";
import { Dialog, DialogActions } from "../../components/dialog";
import { oauthProviderName, ProviderLogo } from "./provider-logo";

interface OauthDialogProps {
  preset: ProviderPreset;
  onClose: () => void;
  onConnected: () => void;
  onUseApiKey: () => void;
}

/**
 * Sign-in for ChatGPT (device code), Claude (paste the callback code), and Grok
 * (agent `authenticate` / device or loopback). Copied from Quac's Connect UX.
 */
export function OauthDialog({ preset, onClose, onConnected, onUseApiKey }: OauthDialogProps) {
  const name = oauthProviderName(preset.id);
  const [start, setStart] = useState<OauthStart | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const closed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await startProviderOauth(preset.id);
        if (cancelled) {
          await cancelProviderOauth(preset.id);
          return;
        }
        setStart(next);
        setBusy(false);
        if (next.authorizeUrl) void openExternalUrl(next.authorizeUrl);
      } catch (caught) {
        if (!cancelled) {
          setError(normalizeError(caught, `Could not start ${name} login`));
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (!closed.current) void cancelProviderOauth(preset.id);
    };
  }, [name, preset.id]);

  useEffect(() => {
    if (!start || start.needsCode) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await pollProviderOauth(preset.id);
        if (cancelled) return;
        if (status.status === "connected") {
          closed.current = true;
          onConnected();
          return;
        }
        if (status.status === "error") {
          setError(status.error ?? `${name} login failed`);
          return;
        }
        window.setTimeout(() => {
          if (!cancelled) void tick();
        }, 900);
      } catch (caught) {
        if (!cancelled) setError(normalizeError(caught, `${name} login failed`));
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [name, onConnected, preset.id, start]);

  async function submitCode() {
    setBusy(true);
    setError(null);
    try {
      const status = await submitProviderOauthCode(preset.id, code);
      if (status.status === "connected") {
        closed.current = true;
        onConnected();
        return;
      }
      if (status.status === "error") setError(status.error ?? `${name} login failed`);
    } catch (caught) {
      setError(normalizeError(caught, `${name} login failed`));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    closed.current = true;
    void cancelProviderOauth(preset.id);
    onClose();
  }

  return (
    <Dialog
      title={`Connect ${name}`}
      description={`Sign in with your ${name} account. No API key required.`}
      size="sm"
      onClose={close}
    >
      <div className="oauth-connect" data-testid={`oauth-dialog-${preset.id}`}>
        <ProviderLogo id={preset.id} size={36} label={name} />
        {start?.userCode && (
          <p className="oauth-user-code">
            <span>Enter this code</span>
            <code data-testid="oauth-user-code">{start.userCode}</code>
          </p>
        )}
        {start?.needsCode && (
          <label className="field">
            <span>Authorization code</span>
            <input
              value={code}
              autoFocus
              aria-label="Authorization code"
              data-testid="oauth-code"
              placeholder="Paste the code from the browser"
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
        )}
        {!start && busy && (
          <p className="oauth-waiting">
            <LoaderCircle className="spin" size={15} /> Starting {name} login…
          </p>
        )}
        {start && !start.needsCode && !error && (
          <p className="oauth-waiting">
            <LoaderCircle className="spin" size={15} /> Waiting for approval in the browser…
          </p>
        )}
        {start?.authorizeUrl && (
          <button type="button" className="ghost-button" onClick={() => void openExternalUrl(start.authorizeUrl)}>
            <ExternalLink size={14} /> Open browser
          </button>
        )}
        {error && <div className="settings-note security-warning" role="alert">{error}</div>}
      </div>
      <DialogActions>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            closed.current = true;
            void cancelProviderOauth(preset.id);
            onUseApiKey();
          }}
          data-testid="oauth-use-api-key"
        >
          <KeyRound size={14} /> Use API key instead
        </button>
        {start?.needsCode ? (
          <button
            type="button"
            className="primary-button"
            disabled={busy || !code.trim()}
            data-testid="oauth-submit"
            onClick={() => void submitCode()}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />} Continue
          </button>
        ) : (
          <button type="button" className="ghost-button" onClick={close}>Cancel</button>
        )}
      </DialogActions>
    </Dialog>
  );
}
