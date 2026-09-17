import { AlertTriangle, Inbox, LoaderCircle } from "lucide-react";

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="async-state async-state-loading" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={15} />
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
