import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { acpClient } from "../../../acp/client";
import {
  attachmentFromFile,
  attachmentFromPath,
  isImage,
  readAsDataUrl,
  type Attachment,
} from "../../../acp/attachments";
import { onFileDrop, pickFiles, readFilePayload } from "../../../acp/host";
import { useSessionStore } from "../../../state/session";

interface ComposerAttachments {
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  dragging: boolean;
  setDragging: Dispatch<SetStateAction<boolean>>;
  filePicker: RefObject<HTMLInputElement | null>;
  addFiles: (files: FileList | File[] | null) => Promise<void>;
  openPicker: () => Promise<void>;
}

/** File attachments for the composer: picker, native drops, paste, and the browser drag overlay. */
export function useComposerAttachments(blocked: boolean): ComposerAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);

  // Native drops arrive as paths from the Tauri webview, not as HTML5 events.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void onFileDrop((paths, phase) => {
      if (blocked) {
        setDragging(false);
        return;
      }
      setDragging(phase === "over");
      if (phase === "drop") void addPaths(paths);
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, [blocked]);

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

  return { attachments, setAttachments, dragging, setDragging, filePicker, addFiles, openPicker };
}
