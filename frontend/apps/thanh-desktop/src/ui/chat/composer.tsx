import { CornerDownLeft, FileText, LoaderCircle, Paperclip, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { attachmentFromFile, attachmentFromPath, isImage, readAsDataUrl, type Attachment } from "../../acp/attachments";
import { onFileDrop, pickFiles, readFilePayload } from "../../acp/host";
import { useCatalogStore } from "../../state/catalog";
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
  const [active, setActive] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const text = useSessionStore((state) => state.composerDraft);
  const setText = useSessionStore((state) => state.setComposerDraft);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const sessionId = useSessionStore((state) => state.sessionId);
  const planMode = useSessionStore((state) => state.planMode);
  const alwaysApprove = useSessionStore((state) => state.alwaysApprove);
  const usage = useSessionStore((state) => state.usage);
  const modelId = useSessionStore((state) => state.modelId);
  const commands = useCatalogStore((state) => state.commands);
  const models = useCatalogStore((state) => state.models);
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
    if ((!prompt && attachments.length === 0) || busy) return;
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
      <div
        className={`composer ${dragging ? "dragging" : ""}`}
        data-testid="composer-drop"
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
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
          placeholder={turnRunning ? "Queue another prompt…" : "Ask Thanh anything…"}
          aria-label="Message"
          rows={1}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              data-testid="attach-button"
              onClick={() => void openPicker()}
            >
              <Paperclip size={15} />
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
          {turnRunning ? (
            <div className="composer-running">
              <button type="button" className="stop-button" onClick={() => void acpClient.cancel()}><Square size={13} /> Stop</button>
              <button type="button" className="send-button" disabled={(!text.trim() && attachments.length === 0) || busy} onClick={() => void submit()}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Queue
              </button>
            </div>
          ) : (
            <button type="button" className="send-button" disabled={(!text.trim() && attachments.length === 0) || busy} onClick={() => void submit()} data-testid="send-button">
              {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
