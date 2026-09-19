import { useEffect, useRef, type ChangeEvent, type MouseEvent } from "react";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  /**
   * Group switch with some members on and some off. Pair with `checked={false}` so a click reports
   * `true`, which the group handler reads as "enable the rest".
   */
  indeterminate?: boolean;
}

export function ToggleSwitch({ checked, onChange, ariaLabel, disabled = false, className = "", indeterminate = false }: ToggleSwitchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // `indeterminate` is a DOM property with no HTML attribute, so React cannot set it declaratively.
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.disabled || indeterminate) return;
    onChange(event.target.checked);
  }

  // WKWebView sometimes skips `change` for indeterminate checkboxes; drive mixed clicks from `click`.
  function handleClick(event: MouseEvent<HTMLInputElement>) {
    if (event.currentTarget.disabled || !indeterminate) return;
    event.preventDefault();
    onChange(true);
  }

  return (
    <span className={`toggle-switch ${indeterminate ? "mixed" : ""} ${className}`.trim()}>
      <input
        ref={inputRef}
        className="toggle-switch-input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-checked={indeterminate ? "mixed" : checked}
        onChange={handleChange}
        onClick={handleClick}
      />
      <span className="toggle-switch-track" aria-hidden="true">
        <span className="toggle-switch-thumb" />
      </span>
    </span>
  );
}
