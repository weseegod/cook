import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { normalizeError } from "../../acp/errors";
import {
  groupByProvider,
  providerDisplayName,
  reasoningEffortOptions,
  type ModelSummary,
  type ReasoningEffortOption,
} from "../../acp/xai";
import { useSessionStore } from "../../state/session";
import { preferredReasoningEffort } from "../../acp/client/requests";

interface ModelPickerProps {
  models: ModelSummary[];
  selectedModel: string;
  selectedModelKnown: boolean;
  disabled?: boolean;
  onSelect: (modelId: string, reasoningEffort?: string) => Promise<void>;
}

export function ModelPicker({
  models,
  selectedModel,
  selectedModelKnown,
  disabled = false,
  onSelect,
}: ModelPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const sessionEffort = useSessionStore((state) => state.reasoningEffort);
  const selected = models.find((model) => model.id === selectedModel) ?? null;
  const selectedOptions = reasoningEffortOptions(selected);
  const activeEffort = sessionEffort
    ?? preferredReasoningEffort(selectedModel)
    ?? selected?.reasoningEffort
    ?? selectedOptions.find((option) => option.default)?.value
    ?? selectedOptions[0]?.value
    ?? null;

  const groups = useMemo(() => groupByProvider(models), [models]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
        setHoveredModelId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setHoveredModelId(null);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const gutter = 6;
      const left = Math.min(
        Math.max(gutter, triggerRect.left),
        Math.max(gutter, window.innerWidth - menuRect.width - gutter),
      );
      const top = Math.max(gutter, triggerRect.top - menuRect.height - 4);
      setMenuPosition({ top, left });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, models.length, selectedModelKnown, hoveredModelId]);

  function toggle() {
    if (disabled || busy) return;
    setOpen((current) => !current);
    setHoveredModelId(null);
  }

  async function choose(model: ModelSummary, effort?: ReasoningEffortOption) {
    if (busy) return;
    setBusy(true);
    try {
      await onSelect(model.id, effort?.value);
      setOpen(false);
      setHoveredModelId(null);
    } catch (error) {
      useSessionStore.getState().set({ error: normalizeError(error, "Could not switch model") });
    } finally {
      setBusy(false);
    }
  }

  function focusModelItem(offset: number, current: HTMLElement) {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-model-picker-item]") ?? [])];
    const index = items.indexOf(current);
    items[(index + offset + items.length) % items.length]?.focus();
  }

  function focusEffortItem(offset: number, current: HTMLElement, options: ReasoningEffortOption[]) {
    const submenu = current.closest("[data-model-picker-submenu]");
    const items = [...(submenu?.querySelectorAll<HTMLElement>("[data-model-picker-effort-item]") ?? [])]
      .filter((item) => item.closest("[data-model-picker-submenu]")?.getAttribute("data-model-picker-submenu") === current.closest("[data-model-picker-submenu]")?.getAttribute("data-model-picker-submenu"));
    const index = items.indexOf(current);
    if (options.length === 0) return;
    items[(index + offset + items.length) % items.length]?.focus();
  }

  function modelKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, model: ModelSummary, options: ReasoningEffortOption[]) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusModelItem(event.key === "ArrowDown" ? 1 : -1, event.currentTarget);
      return;
    }
    if (event.key === "ArrowRight" && options.length > 0) {
      event.preventDefault();
      setHoveredModelId(model.id);
      requestAnimationFrame(() => {
        const submenu = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-model-picker-submenu]") ?? [])]
          .find((entry) => entry.dataset.modelPickerSubmenu === model.id);
        submenu?.querySelector<HTMLElement>("[data-model-picker-effort-item]")?.focus();
      });
    }
  }

  function effortKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, options: ReasoningEffortOption[]) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusEffortItem(event.key === "ArrowDown" ? 1 : -1, event.currentTarget, options);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.currentTarget
        .closest(".composer-model-picker-item")
        ?.querySelector<HTMLButtonElement>(":scope > [data-model-picker-item]")
        ?.focus();
    }
  }

  const triggerLabel = (selected?.name ?? selectedModel) || (models.length === 0 ? "Loading models…" : "Select model");

  return (
    <div className="composer-model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-model-trigger"
        title={selectedModel || "Select model"}
        aria-label="Model"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy || models.length === 0}
        onClick={toggle}
      >
        <span className="composer-model-name">{triggerLabel}</span>
        {activeEffort && selectedOptions.length > 0 && (
          <span className="composer-model-effort">· {activeEffort}</span>
        )}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="composer-model-picker-menu"
          role="menu"
          aria-label="Models"
          style={{
            top: menuPosition?.top ?? 0,
            left: menuPosition?.left ?? 0,
            visibility: menuPosition ? "visible" : "hidden",
          }}
        >
          {groups.map(([provider, entries]) => (
            <div key={provider} className="composer-model-picker-group">
              <div className="composer-model-picker-group-label">{providerDisplayName(provider)}</div>
              {entries.map((model) => {
                const options = reasoningEffortOptions(model);
                const isSelected = model.id === selectedModel;
                const isHovered = model.id === hoveredModelId;
                return (
                  <div
                    key={model.id}
                    className={`composer-model-picker-item${isHovered ? " hovered" : ""}`}
                    onMouseEnter={() => setHoveredModelId(options.length > 0 ? model.id : null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={0}
                      data-model-picker-item
                      className={isSelected ? "selected" : ""}
                      aria-haspopup={options.length > 0 ? "menu" : undefined}
                      aria-expanded={options.length > 0 ? isHovered : undefined}
                      onFocus={() => setHoveredModelId(options.length > 0 ? model.id : null)}
                      onClick={() => void choose(model)}
                      onKeyDown={(event) => modelKeyDown(event, model, options)}
                    >
                      <span>{model.name ?? model.id}</span>
                      {isSelected && <Check size={13} aria-label="Selected" />}
                      {options.length > 0 && <ChevronRight size={13} aria-hidden="true" />}
                    </button>
                    {isHovered && options.length > 0 && (
                      <div
                        className="composer-model-picker-submenu"
                        role="menu"
                        data-model-picker-submenu={model.id}
                        aria-label={`${model.name ?? model.id} reasoning levels`}
                      >
                        <div className="composer-model-picker-group-label">Reasoning</div>
                        {options.map((option) => (
                          <button
                            key={`${model.id}:${option.id}`}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isSelected && activeEffort === option.value}
                            data-model-picker-effort-item
                            className={isSelected && activeEffort === option.value ? "selected" : ""}
                            title={option.description}
                            onClick={() => void choose(model, option)}
                            onKeyDown={(event) => effortKeyDown(event, options)}
                          >
                            <span>{option.label}</span>
                            {isSelected && activeEffort === option.value && <Check size={13} aria-hidden="true" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {!selectedModelKnown && selectedModel && (
            <div className="composer-model-picker-unknown">Current: {selectedModel}</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
