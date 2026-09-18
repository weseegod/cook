/** Open the `/rewind` picker (`MEM-rew` / `C-rew`). */
import { useSessionStore } from "../../state/session";

export function openRewind(): void {
  useSessionStore.getState().setRewindDialogOpen(true);
}
