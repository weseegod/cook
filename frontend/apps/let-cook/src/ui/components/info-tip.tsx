import { Info } from "lucide-react";
import type { ReactNode } from "react";

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="info-tip">
      <span className="info-tip-trigger" role="img" tabIndex={0} aria-label={`More info: ${label}`}>
        <Info size={13} />
      </span>
      <span className="info-tip-content" role="tooltip">{children}</span>
    </span>
  );
}
