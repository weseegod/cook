import { AlertTriangle, Inbox } from "lucide-react";
import { BRAILLE_FRAMES } from "../chat/turn-activity";
import { useSpinFrame } from "../chat/use-spin-frame";

/**
 * Settings/async panels use a JS braille spinner instead of CSS `transform` rotation.
 * `prefers-reduced-motion` zeroes `animation-duration`, which made the old LoaderCircle
 * look frozen — exactly when a long Connectors/Skills/Models fetch needs a live cue.
 */
export function LoadingState({ label = "Loading" }: { label?: string }) {
  const frame = useSpinFrame(true);
  return (
    <div className="async-state async-state-loading" role="status" aria-live="polite" data-testid="settings-loading">
      <span className="async-state-spinner" aria-hidden="true">
        {BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length]}
      </span>
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="async-state async-state-empty">
      <Inbox size={16} />
      <strong>{label}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

export function ErrorState({ label }: { label: string }) {
  return (
    <div className="async-state async-state-error" role="alert">
      <AlertTriangle size={15} />
      <span>{label}</span>
    </div>
  );
}
