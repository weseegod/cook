import { ChevronDown, CornerDownLeft, FileText, Folder, LoaderCircle, Mic, Minimize2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { attachmentFromFile, attachmentFromPath, isImage, readAsDataUrl, type Attachment } from "../../acp/attachments";
import { onFileDrop, pickFiles, pickFolder, readFilePayload } from "../../acp/host";
import { groupByProvider } from "../../acp/xai";
import { useCatalogStore, useModelSelection } from "../../state/catalog";
import { useSessionStore } from "../../state/session";
import {
  clientCommand,
  matchSlashCommands,
  parseSlash,
  slashEntries,
  type SlashCommandHost,
  type SlashEntry,
} from "./slash-commands";

/** The window's own half of the slash commands; the agent's half arrives as an ordinary prompt. */
const SLASH_HOST: SlashCommandHost = {
  setPlanMode: (enabled) => acpClient.setPlanMode(enabled),
  setModel: (modelId) => acpClient.setModel(modelId),
  setYolo: (enabled) => acpClient.setYolo(enabled),
  newSession: async () => {
    await acpClient.newSession();
  },
  sendPrompt: (text) => acpClient.prompt(text),
  sessionInfo: () => acpClient.sessionInfo(),
};

export function Composer() {
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [menuClosed, setMenuClosed] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [active, setActive] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const contextMenu = useRef<HTMLDivElement>(null);
  const text = useSessionStore((state) => state.composerDraft);
  const setText = useSessionStore((state) => state.setComposerDraft);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const interactionPending = useSessionStore((state) => Boolean(state.pendingPermission || state.pendingQuestion));
  const sessionId = useSessionStore((state) => state.sessionId);
  const cwd = useSessionStore((state) => state.cwd);
  const planMode = useSessionStore((state) => state.planMode);
  const alwaysApprove = useSessionStore((state) => state.alwaysApprove);
  const usage = useSessionStore((state) => state.usage);
  const modelId = useSessionStore((state) => state.modelId);
  const commands = useCatalogStore((state) => state.commands);
  const models = useCatalogStore((state) => state.models);
  const { id: selectedModel, known: selectedModelKnown } = useModelSelection();
  const imagesAllowed = acpClient.imageAttachEnabled();
  // The name is still being typed while no space follows it; after that the text is arguments.
  const slashPrefix = /^\/([^\s/\\]*)(\s[\s\S]*)?$/.exec(text.trimStart());
  const typedName = slashPrefix ? slashPrefix[1].toLowerCase() : null;
  const typedArgs = Boolean(slashPrefix?.[2]);
  const matching = useMemo(
    () => (typedName === null || typedArgs || menuClosed ? [] : matchSlashCommands(slashEntries(commands), typedName)),
    [typedName, typedArgs, commands, menuClosed],
  );
  useEffect(() => setActive(0), [typedName]);

  useEffect(() => {
    if (!contextMenuOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && !contextMenu.current?.contains(event.target)) setContextMenuOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [contextMenuOpen]);

  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 56), 180)}px`;
  }, [text]);

  // Native drops arrive as paths from the Tauri webview, not as HTML5 events.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void onFileDrop((paths, phase) => {
      setDragging(phase === "over");
      if (phase === "drop") void addPaths(paths);
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  async function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const allowsImages = acpClient.imageAttachEnabled();
    const next: Attachment[] = [];
    const refused: string[] = [];
    for (const file of Array.from(files)) {
      // A text-only model has no image input: refuse here instead of sending a part the
      // provider would reject with a 400.
      if (!allowsImages && isImage(file)) {
        refused.push(file.name);
        continue;
      }
      const dataUrl = await readAsDataUrl(file);
      next.push(attachmentFromFile(file, dataUrl, (file as File & { path?: string }).path));
    }
    if (next.length > 0) setAttachments((current) => [...current, ...next]);
    reportRefused(refused);
  }

  /** Attach real paths (native picker, OS drop): images are read inline, everything else travels as a path. */
  async function addPaths(paths: string[]) {
    if (paths.length === 0) return;
    const allowsImages = acpClient.imageAttachEnabled();
    const next: Attachment[] = [];
    const refused: string[] = [];
    const failed: string[] = [];
    for (const path of paths) {
      const image = isImage({ name: path });
      if (!allowsImages && image) {
        refused.push(path.split(/[\\/]/).pop() ?? path);
        continue;
      }
      let payload: { data: string; mediaType: string; size: number } | null = null;
      if (image && allowsImages) {
        try {
          payload = await readFilePayload(path);
        } catch {
          failed.push(path);
        }
      }
      next.push(attachmentFromPath(path, payload));
    }
    if (next.length > 0) setAttachments((current) => [...current, ...next]);
    reportRefused(refused);
    if (failed.length > 0) {
      useSessionStore.getState().set({ error: `${failed.join(", ")}: could not read the file` });
    }
  }

  function reportRefused(refused: string[]) {
    if (refused.length > 0) {
      useSessionStore.getState().set({
        error: `${refused.join(", ")}: the selected model cannot read images`,
      });
    }
  }

  async function openPicker() {
    const paths = await pickFiles();
    // No native picker (a plain browser): the hidden input is the only way to get the bytes.
    if (paths === null) filePicker.current?.click();
    else await addPaths(paths);
  }

  async function chooseWorkspace() {
    if (folderBusy || interactionPending) return;
    setFolderBusy(true);
    try {
      const selected = await pickFolder();
      if (selected && selected !== cwd) await acpClient.connect(selected);
    } catch (error) {
      reportError(error);
    } finally {
      setFolderBusy(false);
    }
  }

  async function compactConversation() {
    if (compacting || interactionPending) return;
    setContextMenuOpen(false);
    setCompacting(true);
    setText("");
    useSessionStore.getState().set({ notice: null, error: null });
    try {
      if (useSessionStore.getState().turnRunning) acpClient.queuePrompt("/compact");
      else await acpClient.prompt("/compact");
    } catch (error) {
      reportError(error);
    } finally {
      setCompacting(false);
      textarea.current?.focus();
    }
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
    if ((!prompt && attachments.length === 0) || busy || interactionPending) return;
    const slash = parseSlash(prompt);
    const command = slash && attachments.length === 0 ? clientCommand(slash.name) : undefined;
    setBusy(true);
    const sending = attachments;
    setText("");
    setAttachments([]);
    setMenuClosed(false);
    useSessionStore.getState().set({ notice: null, error: null });
    try {
      if (command && slash) {
        const message = await command.run(
          SLASH_HOST,
          { sessionId, modelId, planMode, alwaysApprove, usage, models },
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
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  }

  function accept(entry: SlashEntry) {
    setText(`/${entry.name} `);
    setMenuClosed(true);
    textarea.current?.focus();
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // A partial name completes first; a name that already matches a command runs.
      const complete = matching.some((entry) => entry.name.toLowerCase() === typedName);
      if (matching.length > 0 && !complete) accept(matching[Math.min(active, matching.length - 1)]);
      else void submit();
    }
  }

  function reportError(error: unknown) {
    useSessionStore.getState().set({ error: error instanceof Error ? error.message : String(error) });
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
      <div className="composer-contextbar">
        <button
          type="button"
          className="composer-folder"
          onClick={() => void chooseWorkspace()}
          disabled={folderBusy || interactionPending}
          title={cwd ?? "Choose a workspace folder"}
          aria-label="Choose workspace folder"
        >
          {folderBusy ? <LoaderCircle className="spin" size={13} /> : <Folder size={13} />}
          <span>{cwd || "Choose folder"}</span>
        </button>
        <div className="composer-context" ref={contextMenu}>
          <button
            type="button"
            className="composer-context-trigger"
            onClick={() => setContextMenuOpen((open) => !open)}
            disabled={interactionPending}
            aria-expanded={contextMenuOpen}
            aria-haspopup="menu"
            aria-label="Context status"
            title="Context window usage"
          >
            <span>Context</span>
            <span className="composer-context-usage">{tokenSummary(usage)}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {contextMenuOpen && (
            <div className="composer-context-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void compactConversation()} disabled={compacting || interactionPending}>
                {compacting ? <LoaderCircle className="spin" size={13} /> : <Minimize2 size={13} />}
                <span><strong>/compact</strong><small>Compress conversation history</small></span>
              </button>
            </div>
          )}
        </div>
      </div>
      <div
        className={`composer ${dragging ? "dragging" : ""}`}
        data-testid="composer-drop"
          onDragOver={(event) => { if (interactionPending) return; event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            if (interactionPending) return;
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
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length > 0) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={onComposerKeyDown}
          placeholder={interactionPending ? "Waiting for your decision…" : turnRunning ? "Queue another prompt…" : "Ask Thanh anything…"}
          aria-label="Message"
          rows={1}
          disabled={interactionPending}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              data-testid="attach-button"
              onClick={() => void openPicker()}
              disabled={interactionPending}
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
            <span
              className="composer-hint"
              title={imagesAllowed ? "Enter sends · Shift+Enter adds a line · / opens commands" : "Images are unavailable for this text-only model"}
            >
              <kbd>↵</kbd> Send <kbd>⇧↵</kbd> New line <kbd>/</kbd> Commands
            </span>
          </div>
          <div className="composer-submit">
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
              <span className="composer-model-effort">High</span>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
            <button type="button" className="composer-voice" aria-label="Voice input" title="Voice input is not available yet" disabled><Mic size={14} /></button>
            {turnRunning ? (
              <button type="button" className="send-button" disabled={interactionPending || (!text.trim() && attachments.length === 0) || busy} onClick={() => void submit()}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Queue
              </button>
            ) : (
              <button type="button" className="send-button" disabled={interactionPending || (!text.trim() && attachments.length === 0) || busy} onClick={() => void submit()} data-testid="send-button">
                {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function tokenSummary(usage: Record<string, unknown> | null): string {
  const used = Number(usage?.used ?? usage?.totalTokens ?? 0);
  if (!Number.isFinite(used) || used <= 0) return "—";
  const size = Number(usage?.size ?? 0);
  const count = new Intl.NumberFormat(undefined, { notation: used > 9999 ? "compact" : "standard" }).format(used);
  if (!Number.isFinite(size) || size <= 0) return `${count} tokens`;
  const percent = Math.min(100, Math.round((used / size) * 100));
  return `${count} / ${new Intl.NumberFormat(undefined, { notation: "compact" }).format(size)} tokens (${percent}%)`;
}
