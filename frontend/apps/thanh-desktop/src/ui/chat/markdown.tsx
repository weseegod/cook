import { Check, Copy, Eye } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
import { useArtifactStore } from "../../state/artifacts";
import { copyText } from "./clipboard";

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
            const value = String(children).replace(/\n$/, "");
            if (!language) return <code>{children}</code>;
            if (streaming) return <CodeBlock code={value} streaming />;
            if (language === "mermaid") return <Mermaid source={value} />;
            if (language === "html" || language === "htm") {
              return <CodeBlock code={value} language={language} openPreview={() => useArtifactStore.getState().openArtifact({ kind: "html", title: "HTML preview", content: value })} />;
            }
            return <CodeBlock code={value} language={language} />;
          },
          img({ src, alt }) {
            if (!src) return null;
            return (
              <button
                type="button"
                className="markdown-image-button"
                onClick={() => useArtifactStore.getState().openArtifact({ kind: "image", title: alt ?? "Image", content: src })}
              >
                <img src={src} alt={alt ?? ""} />
              </button>
            );
          },
          a({ href, children }) {
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({
  code,
  language,
  streaming = false,
  openPreview,
}: {
  code: string;
  language?: string;
  streaming?: boolean;
  openPreview?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await copyText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language ?? "text"}</span>
        <div className="code-toolbar-actions">
          {openPreview && (
            <button type="button" className="text-button" onClick={openPreview}>
              <Eye size={12} /> Preview
            </button>
          )}
          <button type="button" className="text-button" onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}</button>
        </div>
      </div>
      {streaming ? <pre className="streaming-code"><code>{code}</code></pre> : <HighlightedCode code={code} language={language ?? "text"} />}
    </div>
  );
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void codeToHtml(code, { lang: language, theme: "github-dark-default" })
      .then((value) => active && setHtml(value))
      .catch(() => active && setHtml(null));
    return () => { active = false; };
  }, [code, language]);
  return html ? <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code>{code}</code></pre>;
}

function Mermaid({ source }: { source: string }) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
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
  return (
    <div className="mermaid-block">
      <div className="code-toolbar">
        <span>mermaid</span>
        <button
          type="button"
          className="text-button"
          onClick={() => useArtifactStore.getState().openArtifact({ kind: "mermaid", title: "Mermaid diagram", content: source })}
        >
          <Eye size={12} /> Open
        </button>
      </div>
      {content}
    </div>
  );
}
