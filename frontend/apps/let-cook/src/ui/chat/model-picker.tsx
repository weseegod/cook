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
  const submenuRef = useRef<HTMLDivElement>(null);
  const focusSubmenuRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
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
  const hoveredModel = models.find((model) => model.id === hoveredModelId);
  const hoveredOptions = reasoningEffortOptions(hoveredModel);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target) && !submenuRef.current?.contains(target)) {
        setOpen(false);
        setHoveredModelId(null);
        focusSubmenuRef.current = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setHoveredModelId(null);
      focusSubmenuRef.current = false;
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
  }, [open, models.length, selectedModelKnown]);

  // The reasoning submenu is portaled (fixed) so a scrolling model list cannot clip it. Anchor it
  // to the hovered row and flip left when the window cannot hold it on the right.
  useLayoutEffect(() => {
    if (!open || !hoveredModelId) {
      setSubmenuPosition(null);
      return;
    }

    const updateSubmenuPosition = () => {
      const row = menuRef.current?.querySelector<HTMLElement>(
        `[data-model-picker-row="${CSS.escape(hoveredModelId)}"]`,
      );
      const submenu = submenuRef.current;
      if (!row || !submenu) return;

      const rowRect = row.getBoundingClientRect();
      const submenuRect = submenu.getBoundingClientRect();
      const gutter = 6;
      const width = Math.min(submenuRect.width, window.innerWidth - gutter * 2);
      const preferLeft = rowRect.right + 3 + width > window.innerWidth - gutter;
      const left = preferLeft
        ? Math.max(gutter, rowRect.left - 3 - width)
        : Math.min(rowRect.right + 3, window.innerWidth - gutter - width);
      const top = Math.min(
        Math.max(gutter, rowRect.top - 4),
        Math.max(gutter, window.innerHeight - submenuRect.height - gutter),
      );
      setSubmenuPosition({ top, left });
    };

    updateSubmenuPosition();
    window.addEventListener("resize", updateSubmenuPosition);
    window.addEventListener("scroll", updateSubmenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSubmenuPosition);
      window.removeEventListener("scroll", updateSubmenuPosition, true);
    };
  }, [open, hoveredModelId, menuPosition]);

  function toggle() {
    if (disabled || busy) return;
    setOpen((current) => !current);
    setHoveredModelId(null);
    focusSubmenuRef.current = false;
  }

  async function choose(model: ModelSummary, effort?: ReasoningEffortOption) {
    if (busy) return;
    setBusy(true);
    try {
      await onSelect(model.id, effort?.value);
      setOpen(false);
      setHoveredModelId(null);
      focusSubmenuRef.current = false;
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
    const items = [...(submenu?.querySelectorAll<HTMLElement>("[data-model-picker-effort-item]") ?? [])];
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
      focusSubmenuRef.current = true;
      setHoveredModelId(model.id);
      // Hover may already have opened this submenu, in which case no layout effect will rerun.
      if (hoveredModelId === model.id && submenuPosition) {
        focusSubmenuRef.current = false;
        submenuRef.current?.querySelector<HTMLElement>("[data-model-picker-effort-item]")?.focus();
      }
    }
  }

  // ArrowRight opens the portaled submenu; focus lands once that portal is positioned and visible.
  useLayoutEffect(() => {
    if (!focusSubmenuRef.current || !submenuRef.current || !submenuPosition) return;
    const first = submenuRef.current.querySelector<HTMLElement>("[data-model-picker-effort-item]");
    if (!first) return;
    focusSubmenuRef.current = false;
    first.focus();
  }, [hoveredModelId, submenuPosition]);

  function effortKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, options: ReasoningEffortOption[]) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusEffortItem(event.key === "ArrowDown" ? 1 : -1, event.currentTarget, options);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const id = event.currentTarget.closest("[data-model-picker-submenu]")?.getAttribute("data-model-picker-submenu");
      menuRef.current
        ?.querySelector<HTMLElement>(`[data-model-picker-row="${CSS.escape(id ?? "")}"] [data-model-picker-item]`)
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
          <div className="composer-model-picker-list">
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
                      data-model-picker-row={model.id}
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
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {!selectedModelKnown && selectedModel && (
            <div className="composer-model-picker-unknown">Current: {selectedModel}</div>
          )}
        </div>,
        document.body,
      )}
      {open && hoveredModel && (
        createPortal(
          <div
            ref={submenuRef}
            className="composer-model-picker-submenu"
            role="menu"
            data-model-picker-submenu={hoveredModel.id}
            aria-label={`${hoveredModel.name ?? hoveredModel.id} reasoning levels`}
            style={{
              top: submenuPosition?.top ?? 0,
              left: submenuPosition?.left ?? 0,
              visibility: submenuPosition ? "visible" : "hidden",
            }}
          >
            <div className="composer-model-picker-group-label">Reasoning</div>
            {hoveredOptions.map((option) => {
              const isSelected = hoveredModel.id === selectedModel && activeEffort === option.value;
              return (
                <button
                  key={`${hoveredModel.id}:${option.id}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  data-model-picker-effort-item
                  className={isSelected ? "selected" : ""}
                  title={option.description}
                  onClick={() => void choose(hoveredModel, option)}
                  onKeyDown={(event) => effortKeyDown(event, hoveredOptions)}
                >
                  <span>{option.label}</span>
                  {isSelected && <Check size={13} aria-hidden="true" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      )}
    </div>
  );
}
