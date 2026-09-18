import { Copy, PanelRightClose } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useArtifactStore, type Artifact } from "../state/artifacts";
import { copyText } from "./chat/clipboard";

/** Preview dock body: HTML iframe, mermaid, image, or full-file diff (no Monaco/LSP). */
export function ArtifactsPanel() {
  const artifact = useArtifactStore((state) => state.artifact);
  const clearArtifact = useArtifactStore((state) => state.clearArtifact);

  if (!artifact) {
    return (
      <section className="artifacts-view" data-testid="artifacts-view">
        <div className="utility-state">Open a mermaid diagram, HTML block, image, or tall edit diff to preview it here.</div>
      </section>
    );
  }

  return (
    <section className="artifacts-view" data-testid="artifacts-view">
      <div className="utility-view-actions">
        <strong className="utility-path">{artifact.title}</strong>
        <button type="button" className="text-button" onClick={clearArtifact} aria-label="Clear preview">
          <PanelRightClose size={12} /> Close
        </button>
      </div>
      <ArtifactBody artifact={artifact} />
    </section>
  );
}

function ArtifactBody({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === "html") {
    return (
      <iframe
        className="artifact-frame"
        title={artifact.title}
        sandbox=""
        srcDoc={artifact.content}
        data-testid="artifact-html"
      />
    );
  }
  if (artifact.kind === "image") {
    return (
      <div className="artifact-image" data-testid="artifact-image">
        <img src={artifact.content} alt={artifact.title} />
      </div>
    );
  }
  if (artifact.kind === "mermaid") {
    return <MermaidPreview source={artifact.content} />;
  }
  return <DiffBody title={artifact.title} diff={artifact.content} />;
}

function DiffBody({ title, diff }: { title: string; diff: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await copyText(diff);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="utility-preview diff-preview" data-testid="artifact-diff">
      <div className="utility-preview-header">
        <strong>{title}</strong>
        <button type="button" className="text-button" onClick={() => void copy()}>
          <Copy size={12} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        {diff.split("\n").map((line, index) => (
          <span
            key={`${index}-${line}`}
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "diff-add"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "diff-remove"
                  : ""
            }
          >
            {line}{"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

function MermaidPreview({ source }: { source: string }) {
  const rawId = useId();
  const id = `artifact-mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [content, setContent] = useState<ReactNode>(<pre><code>{source}</code></pre>);
  useEffect(() => {
    let active = true;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      const { svg } = await mermaid.render(id, source);
      if (active) setContent(<div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [id, source]);
  return <div className="artifact-mermaid" data-testid="artifact-mermaid">{content}</div>;
}
