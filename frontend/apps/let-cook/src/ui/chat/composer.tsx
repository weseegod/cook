import { ChevronDown, CornerDownLeft, FileText, LoaderCircle, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { normalizeError } from "../../acp/errors";
import { askBtw, interjectPrompt } from "../../acp/turn-ops";
import { groupByProvider } from "../../acp/xai";
import { useCatalogStore, useModelSelection } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import { planFeedback } from "../../state/plan-review";
import {
  clientCommand,
  matchSlashCommands,
  parseSlash,
  slashEntries,
  type SlashEntry,
} from "./slash-commands";
import { hasViewablePlan } from "./view-plan";
import { useTranscriptActions } from "./transcript-context";
import { ContextChip } from "./context-chip";
import { SLASH_HOST } from "./composer/slash-host";
import { useComposerAttachments } from "./composer/use-composer-attachments";
import { useComposerFileSearch } from "./composer/use-composer-file-search";
import { normalizeDisplayPath } from "./at-context";

export function Composer() {
  const [busy, setBusy] = useState(false);
  /** Bumped by every started operation and by every conversation change, to invalidate finishers. */
  const busyToken = useRef(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [active, setActive] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const text = useSessionStore((state) => state.composerDraft);
  const setText = useSessionStore((state) => state.setComposerDraft);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const pendingQuestion = useSessionStore((state) => state.pendingQuestion);
  const interactionPending = useSessionStore((state) => Boolean(state.pendingPermission || state.pendingQuestion));
  const planReview = pendingQuestion?.kind === "plan";
  const reviewBody = useSessionStore((state) => state.planReview?.body ?? null);
  const planComments = useSessionStore((state) => state.planComments);
  const planFocus = useSessionStore((state) => state.planFocus);
  const setPlanFocus = useSessionStore((state) => state.setPlanFocus);
  const savePlanComment = useSessionStore((state) => state.savePlanComment);
  // Permission/question/elicit cards stop input; a parked plan review deliberately does not.
  const blocked = interactionPending && !planReview;
  const sessionId = useSessionStore((state) => state.sessionId);
  // An operation belongs to the conversation that started it: opening another one hands this
  // composer a fresh state, and the old one's finisher must not clear the new one's spinner.
  useEffect(() => {
    busyToken.current += 1;
    setBusy(false);
  }, [sessionId]);
  const planMode = useSessionStore((state) => state.planMode);
  const alwaysApprove = useSessionStore((state) => state.alwaysApprove);
  const modelId = useSessionStore((state) => state.modelId);
  const hasPlan = useSessionStore((state) => hasViewablePlan(state));
  const commands = useCatalogStore((state) => state.commands);
  const models = useCatalogStore((state) => state.models);
  const cancelRewindEnabled = useCatalogStore((state) => state.cancelRewindEnabled);
  const sessionRecapEnabled = useCatalogStore((state) => state.sessionRecapEnabled);
  const { id: selectedModel, known: selectedModelKnown } = useModelSelection();
  const { enableFollow, pageScroll } = useTranscriptActions();
  // The name is still being typed while no space follows it; after that the text is arguments.
  const slashPrefix = /^\/([^\s/\\]*)(\s[\s\S]*)?$/.exec(text.trimStart());
  const typedName = slashPrefix ? slashPrefix[1].toLowerCase() : null;
  const typedArgs = Boolean(slashPrefix?.[2]);
  const matching = useMemo(
    () =>
      typedName === null || typedArgs || menuClosed
        ? []
        : matchSlashCommands(
            slashEntries(commands, { cancelRewindEnabled, sessionRecapEnabled }),
            typedName,
          ),
    [typedName, typedArgs, commands, menuClosed, cancelRewindEnabled, sessionRecapEnabled],
  );
  useEffect(() => setActive(0), [typedName]);

  const fileSearch = useComposerFileSearch({
    text,
    setText,
    textarea,
    slashOpen: matching.length > 0,
    menuClosed,
    setMenuClosed,
  });

  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 56), 180)}px`;
  }, [text]);

  useEffect(() => {
    if (planReview && (planFocus === "prompt" || planFocus === "commenting")) {
      textarea.current?.focus();
    }
  }, [planFocus, planReview]);

  const { attachments, setAttachments, dragging, setDragging, filePicker, addFiles, openPicker } =
    useComposerAttachments(blocked);

  /** Mark an operation in flight; the returned finisher clears it only if nothing newer started. */
  function beginWork(): () => void {
    const token = ++busyToken.current;
    setBusy(true);
    return () => {
      if (busyToken.current === token) setBusy(false);
    };
  }

  /**
   * Run the turn.
   *
   * A leading `/name` the window owns (`/plan`, `/model`, `/new`) is executed here; every other
   * slash text travels as a prompt, which is how the agent's own commands and skills arrive.
   * Commands that produce a line of their own park it in `notice`, since they never reach the
   * agent and so never appear in the transcript.
   */
  async function submit() {
    const prompt = text.trim();
    // A first prompt is still awaiting its response while the turn is already live. Keep that
    // textarea submit path open so Enter can dispatch the second `session/prompt` immediately.
    if ((busy && !turnRunning) || blocked) return;
    if (planFocus === "commenting") {
      // Comments use this same textarea. Empty Enter is intentionally a no-op.
      if (!prompt) return;
      savePlanComment(text);
      setMenuClosed(false);
      textarea.current?.blur();
      return;
    }
    if (planReview) {
      // The TUI's park-time prompt: `Enter` sends the typed text as `request changes`, an empty
      // line does nothing (`empty_enter_on_revise_prompt_does_not_approve`).
      if (!prompt && planComments.length === 0) return;
      enableFollow();
      const finish = beginWork();
      setText("");
      setMenuClosed(false);
      try {
        await acpClient.resolvePlan("cancelled", planFeedback(planComments, prompt, reviewBody));
      } catch (error) {
        reportError(error);
      } finally {
        finish();
        textarea.current?.focus();
      }
      return;
    }
    if (!prompt && attachments.length === 0) return;
    const slash = parseSlash(prompt);
    // Mid-turn `/btw` is a side question (C-btw), not a queued session/prompt.
    if (slash?.name.toLowerCase() === "btw" && turnRunning && attachments.length === 0) {
      if (!sessionId) return;
      const question = slash.args.trim();
      if (!question) {
        useSessionStore.getState().set({ notice: "Usage: /btw <question>" });
        return;
      }
      const finish = beginWork();
      setText("");
      setMenuClosed(false);
      try {
        const result = await askBtw(sessionId, question);
        useSessionStore.getState().set({
          notice: result.answer?.trim() ? `/btw: ${result.answer.trim()}` : "/btw answered.",
        });
      } catch (error) {
        reportError(error);
      } finally {
        finish();
        textarea.current?.focus();
      }
      return;
    }
    const command = slash && attachments.length === 0 ? clientCommand(slash.name) : undefined;
    enableFollow();
    const finish = beginWork();
    const sending = attachments;
    setText("");
    setAttachments([]);
    setMenuClosed(false);
    useSessionStore.getState().set({ notice: null, error: null });
    try {
      if (command && slash) {
        const usage = useSessionStore.getState().usage;
        const message = await command.run(
          SLASH_HOST,
          { sessionId, modelId, planMode, alwaysApprove, usage, models, hasPlan, cancelRewindEnabled, sessionRecapEnabled },
          slash.args,
        );
        if (message) useSessionStore.getState().set({ notice: message });
      } else if (turnRunning) {
        acpClient.queuePrompt(prompt, sending);
      } else {
        await acpClient.prompt(prompt, sending);
      }
    } catch (error) {
      useSessionStore.getState().set({
        error: normalizeError(error, "Could not send the prompt"),
      });
    } finally {
      finish();
      textarea.current?.focus();
    }
  }

  async function interject() {
    const prompt = text.trim();
    if (busy || blocked || !turnRunning || !sessionId || (!prompt && attachments.length === 0)) return;
    enableFollow();
    const finish = beginWork();
    const sending = text;
    setText("");
    setAttachments([]);
    setMenuClosed(false);
    try {
      // Optimistic local echo; N-interject drops the matching broadcast via interjectionId.
      const turnId = useSessionStore.getState().transcriptCursor.turnId ?? `turn-inj-${crypto.randomUUID()}`;
      useSessionStore.getState().set({
        blocks: [
          ...useSessionStore.getState().blocks,
          {
            type: "message",
            id: `inj-local-${crypto.randomUUID()}`,
            turnId,
            role: "user",
            text: sending,
            images: [],
            streaming: false,
          },
        ],
        notice: null,
        error: null,
      });
      await interjectPrompt(sessionId, sending);
    } catch (error) {
      reportError(error);
    } finally {
      finish();
      textarea.current?.focus();
    }
  }

  function accept(entry: SlashEntry) {
    setText(`/${entry.name} `);
    setMenuClosed(true);
    textarea.current?.focus();
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (fileSearch.onKeyDown(event)) return;
    if (matching.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => Math.min(index + 1, matching.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuClosed(true);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        accept(matching[Math.min(active, matching.length - 1)]);
        return;
      }
    }
    if (matching.length === 0 && (event.key === "PageUp" || event.key === "PageDown")) {
      event.preventDefault();
      pageScroll(event.key === "PageUp" ? "up" : "down");
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // A partial name completes first; a name that already matches a command runs.
      const complete = matching.some((entry) => entry.name.toLowerCase() === typedName);
      if (matching.length > 0 && !complete) accept(matching[Math.min(active, matching.length - 1)]);
      else void submit();
    }
  }

  function reportError(error: unknown) {
    useSessionStore.getState().set({ error: normalizeError(error, "Could not run that command") });
  }

  return (
    <div className="composer-wrap">
      {matching.length > 0 && (
        <div className="slash-menu" data-testid="slash-menu">
          {matching.map((command, index) => (
            <button
              type="button"
              key={command.name}
              className={index === active ? "active" : ""}
              title={command.source === "client" ? "Built-in command" : command.description}
              data-testid={`slash-item-${command.name}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => accept(command)}
            >
              <span>
                /{command.name}
                {command.inputHint && <em> {command.inputHint}</em>}
              </span>
            </button>
          ))}
        </div>
      )}
      {fileSearch.visible && (
        <div className="slash-menu file-search-menu" data-testid="file-search-menu">
          {fileSearch.matches.map((match, index) => {
            const label = match.kind === "directory" ? `${normalizeDisplayPath(match.path)}/` : normalizeDisplayPath(match.path);
            return (
              <button
                type="button"
                key={`${match.kind}:${match.path}`}
                className={index === fileSearch.active ? "active" : ""}
                data-testid="file-search-item"
                data-path={match.path}
                title={label}
                onMouseEnter={() => fileSearch.setActive(index)}
                onClick={() => fileSearch.accept(index)}
              >
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}
      <div
        className={`composer${planMode ? " plan-mode" : ""}${dragging ? " dragging" : ""}`}
        data-testid="composer-drop"
        onDragOver={(event) => { if (blocked) return; event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (blocked) return;
          event.preventDefault();
          setDragging(false);
          void addFiles(event.dataTransfer?.files ?? null);
        }}
      >
        {attachments.length > 0 && (
          <ul className="attachment-row" data-testid="attachment-row">
            {attachments.map((attachment) => (
              <li key={attachment.id} className={`attachment-chip attachment-${attachment.kind}`}>
                {attachment.previewUrl
                  ? <img src={attachment.previewUrl} alt={attachment.name} />
                  : <FileText size={14} />}
                <span>{attachment.name}</span>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textarea}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMenuClosed(false);
            fileSearch.onCursor(event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) => {
            fileSearch.onCursor(event.currentTarget.selectionStart ?? 0);
          }}
          onClick={(event) => {
            fileSearch.onCursor(event.currentTarget.selectionStart ?? 0);
          }}
          onKeyUp={(event) => {
            fileSearch.onCursor(event.currentTarget.selectionStart ?? 0);
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length > 0) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={onComposerKeyDown}
          placeholder={planFocus === "commenting" ? "Type your comment…" : planReview ? "Request changes…" : blocked ? "Waiting for your decision…" : turnRunning ? "Queue another prompt…" : "Ask Cook anything…"}
          aria-label="Message"
          data-testid="composer-input"
          rows={1}
          onFocus={() => {
            if (planReview && planFocus === "preview") setPlanFocus("prompt");
          }}
          disabled={blocked}
        />
        <div className="composer-footer">
          <div className="composer-info" data-testid="composer-info">
            <label className="composer-model" title={selectedModel || "Select model"}>
              <select
                value={selectedModel}
                disabled={models.length === 0}
                onChange={(event) => void acpClient.setModel(event.target.value).catch(reportError)}
                aria-label="Model"
              >
                {!selectedModelKnown && <option value={selectedModel} disabled>{models.length === 0 ? "Loading models…" : selectedModel || "Select model"}</option>}
                {groupByProvider(models).map(([provider, entries]) => (
                  <optgroup key={provider} label={provider}>
                    {entries.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
                  </optgroup>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
            {planMode && <span className="composer-flag" data-testid="composer-plan-flag">plan</span>}
            <ContextChip />
          </div>
          <div className="composer-submit">
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              data-testid="attach-button"
              onClick={() => void openPicker()}
              disabled={blocked}
            >
              <Plus size={16} />
            </button>
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            {planFocus === "commenting" ? (
              <button
                type="button"
                className="send-button"
                data-testid="send-button"
                disabled={!text.trim() || busy}
                onClick={() => void submit()}
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Save comment
              </button>
            ) : planReview ? (
              <button
                type="button"
                className="send-button"
                data-testid="send-button"
                disabled={!text.trim() || busy}
                onClick={() => void submit()}
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Request changes
              </button>
            ) : turnRunning ? (
              <>
                <button
                  type="button"
                  className="ghost-button"
                  data-testid="interject-button"
                  disabled={blocked || (!text.trim() && attachments.length === 0) || busy}
                  onClick={() => void interject()}
                >
                  Interject
                </button>
                <button type="button" className="send-button" data-testid="send-button" disabled={blocked || (!text.trim() && attachments.length === 0) || busy} onClick={() => void submit()}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Queue
                </button>
              </>
            ) : (
              <button type="button" className="send-button" disabled={blocked || !text.trim() || busy} onClick={() => void submit()} data-testid="send-button">
                {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
