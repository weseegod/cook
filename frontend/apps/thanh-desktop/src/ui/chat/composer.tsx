import { CornerDownLeft, FileText, LoaderCircle, Paperclip, Square, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { attachmentFromFile, attachmentFromPath, isImage, readAsDataUrl, type Attachment } from "../../acp/attachments";
import { onFileDrop, pickFiles, readFilePayload } from "../../acp/host";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";

export function Composer() {
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const text = useSessionStore((state) => state.composerDraft);
  const setText = useSessionStore((state) => state.setComposerDraft);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const modelId = useSessionStore((state) => state.modelId);
  const models = useCatalogStore((state) => state.models);
  const commands = useCatalogStore((state) => state.commands);
  const imagesAllowed = acpClient.imageAttachEnabled();
  const commandQuery = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0].toLowerCase() : null;
  const matching = useMemo(
    () => commandQuery === null ? [] : commands.filter((command) => command.name.toLowerCase().includes(commandQuery)).slice(0, 8),
    [commandQuery, commands],
  );

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

  async function submit() {
    const prompt = text.trim();
    if ((!prompt && attachments.length === 0) || busy) return;
    setBusy(true);
    const sending = attachments;
    setText("");
    setAttachments([]);
    try {
      if (turnRunning) acpClient.queuePrompt(prompt, sending);
      else await acpClient.prompt(prompt, sending);
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  }

  return (
    <div className="composer-wrap">
      {matching.length > 0 && (
        <div className="command-palette">
          {matching.map((command) => (
            <button key={command.name} onClick={() => setText(`/${command.name} `)}>
              <span>/{command.name}</span><small>{command.description}</small>
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
                <button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length > 0) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={turnRunning ? "Queue another prompt…" : "Ask Thanh anything…"}
          rows={1}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button
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
            <span className="composer-hint">
              <WandSparkles size={13} /> Shift+Enter for a new line
              {imagesAllowed ? "" : " · this model is text-only"}
            </span>
          </div>
          {turnRunning ? (
            <div className="composer-running">
              <button className="stop-button" onClick={() => void acpClient.cancel()}><Square size={13} /> Stop</button>
              <button className="send-button" disabled={(!text.trim() && attachments.length === 0) || busy} onClick={() => void submit()}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Queue
              </button>
            </div>
          ) : (
            <button className="send-button" disabled={(!text.trim() && attachments.length === 0) || busy} onClick={() => void submit()} data-testid="send-button">
              {busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
