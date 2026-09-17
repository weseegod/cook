import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
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
            return <CodeBlock code={value} language={language} />;
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

function CodeBlock({ code, language, streaming = false }: { code: string; language?: string; streaming?: boolean }) {
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
        <button type="button" className="text-button" onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}</button>
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
  return content;
}
