import { ChevronDown, ChevronRight } from "lucide-react";
import { ToggleSwitch } from "../components/toggle-switch";

/**
 * A section of Settings rows that can be flipped as a unit.
 *
 * `count` is every row in the section (what the header prints). `eligible` is the subset the switch
 * may change: policy-blocked servers stay out of it, so a section holding only blocked rows passes
 * `eligible: 0` and renders a disabled switch next to its real count.
 */
export function SettingsGroupHeader({
  label,
  count,
  eligible,
  enabledCount,
  expanded,
  onToggleExpanded,
  onToggleEnabled,
  busy = false,
  testId,
}: {
  label: string;
  count: number;
  eligible: number;
  enabledCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  busy?: boolean;
  testId?: string;
}) {
  const mixed = enabledCount > 0 && enabledCount < eligible;

  return (
    <div className="settings-group-header" data-testid={testId}>
      <button type="button" className="settings-group-disclosure" aria-expanded={expanded} onClick={onToggleExpanded}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="settings-group-label">{label} ({count})</span>
      </button>
      {mixed && <span className="settings-group-enable-count">{enabledCount} on</span>}
      <ToggleSwitch
        checked={eligible > 0 && enabledCount === eligible}
        indeterminate={mixed}
        ariaLabel={`Toggle all ${label}`}
        disabled={busy || eligible === 0}
        onChange={onToggleEnabled}
      />
    </div>
  );
}
