import { useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";

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
            if (streaming) return <pre className="streaming-code"><code>{value}</code></pre>;
            if (language === "mermaid") return <Mermaid source={value} />;
            return <HighlightedCode code={value} language={language} />;
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
