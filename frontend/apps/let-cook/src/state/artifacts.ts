import { create } from "zustand";

export type ArtifactKind = "html" | "mermaid" | "image" | "diff";

export interface Artifact {
  kind: ArtifactKind;
  title: string;
  /** HTML source, mermaid text, image data-URL, or unified/full-file diff. */
  content: string;
}

interface ArtifactState {
  artifact: Artifact | null;
  /** Bumped when an artifact opens so the utility panel can switch to Preview. */
  openEpoch: number;
  openArtifact: (artifact: Artifact) => void;
  clearArtifact: () => void;
}

export const useArtifactStore = create<ArtifactState>((set) => ({
  artifact: null,
  openEpoch: 0,
  openArtifact: (artifact) => set((state) => ({ artifact, openEpoch: state.openEpoch + 1 })),
  clearArtifact: () => set({ artifact: null }),
}));

/** Custom event name for N-git → Review refresh (no store coupling). */
export const GIT_HEAD_CHANGED_EVENT = "cook:git-head-changed";

export function emitGitHeadChanged(): void {
  window.dispatchEvent(new CustomEvent(GIT_HEAD_CHANGED_EVENT));
}
