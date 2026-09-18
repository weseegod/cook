import type { ChangeEvent } from "react";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

export function ToggleSwitch({ checked, onChange, ariaLabel, disabled = false, className = "" }: ToggleSwitchProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.disabled) return;
    onChange(event.target.checked);
  }

  return (
    <span className={`toggle-switch ${className}`.trim()}>
      <input
        className="toggle-switch-input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={handleChange}
      />
      <span className="toggle-switch-track" aria-hidden="true">
        <span className="toggle-switch-thumb" />
      </span>
    </span>
  );
}
