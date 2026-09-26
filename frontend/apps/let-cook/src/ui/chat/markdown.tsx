import { Check, Copy, Eye } from "lucide-react";
import { createContext, memo, useContext, useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useArtifactStore } from "../../state/artifacts";
import { copyText } from "./clipboard";

const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_MODE = createContext<"streaming" | "finished">("finished");

type ShikiHighlighter = {
  getLoadedLanguages: () => string[];
  loadLanguage: (...languages: never[]) => Promise<void>;
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
};

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
const highlightedCache = new Map<string, string>();
const highlightedInFlight = new Map<string, Promise<string>>();
const MAX_HIGHLIGHT_CACHE_CHARS = 4_000_000;
let highlightedCacheChars = 0;
let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;

/**
 * Keep the stable prefix in its own memoized ReactMarkdown tree. ACP chunks append to the tail,
 * so the prefix is parsed once per checkpoint instead of once per token.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (!streaming) {
    return (
      <div className="markdown">
        <MarkdownDocument text={text} mode="finished" />
      </div>
    );
  }

  const checkpoint = splitStreamingMarkdown(text);
  return (
    <div className="markdown">
      {checkpoint.prefix && <MarkdownCheckpoint key={`checkpoint-${checkpoint.prefix.length}`} text={checkpoint.prefix} />}
      {/* Tail keeps prose metrics (see `.markdown .streaming-tail`) so checkpoint promotion is not a height cliff. */}
      {checkpoint.tail && <pre className="streaming-tail">{checkpoint.tail}</pre>}
    </div>
  );
}

export function splitStreamingMarkdown(text: string): { prefix: string; tail: string } {
  const boundaries: number[] = [];
  let blankLine = text.indexOf("\n\n");
  while (blankLine >= 0) {
    boundaries.push(blankLine + 2);
    blankLine = text.indexOf("\n\n", blankLine + 2);
  }

  // A closed fence is another safe checkpoint even when the assistant has not started its next
  // paragraph yet. The streaming mode still renders it as plain code; highlighting waits for the
  // finished render.
  const fences = /(?:^|\n)```[^\n]*\n[\s\S]*?\n```(?=\n|$)/g;
  let fence: RegExpExecArray | null;
  while ((fence = fences.exec(text)) !== null) {
    boundaries.push(fence.index + fence[0].length);
  }

  const boundary = Math.max(0, ...boundaries);
  return { prefix: text.slice(0, boundary), tail: text.slice(boundary) };
}

const MarkdownCheckpoint = memo(function MarkdownCheckpoint({ text }: { text: string }) {
  return <MarkdownDocument text={text} mode="streaming" />;
});

const MarkdownDocument = memo(function MarkdownDocument({ text, mode }: { text: string; mode: "streaming" | "finished" }) {
  return (
    <MARKDOWN_MODE.Provider value={mode}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
    </MARKDOWN_MODE.Provider>
  );
});

const MARKDOWN_COMPONENTS: Components = {
  code: MarkdownCode,
  img: MarkdownImage,
  a: MarkdownLink,
};

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const mode = useContext(MARKDOWN_MODE);
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
  const value = String(children).replace(/\n$/, "");
  if (!language) return <code>{children}</code>;
  if (mode === "streaming") return <CodeBlock code={value} streaming />;
  if (language === "mermaid") return <Mermaid source={value} />;
  if (language === "html" || language === "htm") {
    return <CodeBlock code={value} language={language} openPreview={() => useArtifactStore.getState().openArtifact({ kind: "html", title: "HTML preview", content: value })} />;
  }
  return <CodeBlock code={value} language={language} />;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
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
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
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
            <button type="button" className="chat-action-button" onClick={openPreview}>
              <Eye size={12} /> Preview
            </button>
          )}
          <button type="button" className="chat-action-button" onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}</button>
        </div>
      </div>
      {streaming ? <pre className="streaming-code"><code>{code}</code></pre> : <HighlightedCode code={code} language={language ?? "text"} />}
    </div>
  );
}

async function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= import("shiki").then(({ createHighlighter }) => createHighlighter({
    themes: ["github-dark-default"],
    langs: ["text"],
  }) as unknown as Promise<ShikiHighlighter>);
  return highlighterPromise;
}

async function highlightCode(code: string, language: string): Promise<string> {
  const cacheKey = `${language}\0${code}`;
  const cached = highlightedCache.get(cacheKey);
  if (cached) {
    // Keep recently viewed blocks warm as a long conversation is scrolled back and forth.
    highlightedCache.delete(cacheKey);
    highlightedCache.set(cacheKey, cached);
    return cached;
  }
  const running = highlightedInFlight.get(cacheKey);
  if (running) return running;

  const promise = getHighlighter().then(async (highlighter) => {
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await (highlighter.loadLanguage as unknown as (lang: string) => Promise<void>)(language);
    }
    const html = highlighter.codeToHtml(code, { lang: language, theme: "github-dark-default" });
    if (html.length <= MAX_HIGHLIGHT_CACHE_CHARS) {
      while (highlightedCacheChars + html.length > MAX_HIGHLIGHT_CACHE_CHARS) {
        const oldestKey = highlightedCache.keys().next().value;
        if (oldestKey === undefined) break;
        highlightedCacheChars -= highlightedCache.get(oldestKey)?.length ?? 0;
        highlightedCache.delete(oldestKey);
      }
      highlightedCache.set(cacheKey, html);
      highlightedCacheChars += html.length;
    }
    return html;
  });
  highlightedInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    highlightedInFlight.delete(cacheKey);
  }
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const cacheKey = `${language}\0${code}`;
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(() => {
    const html = highlightedCache.get(cacheKey);
    return html ? { key: cacheKey, html } : null;
  });
  useEffect(() => {
    let active = true;
    void highlightCode(code, language)
      .then((value) => active && setHighlighted({ key: cacheKey, html: value }))
      .catch(() => active && setHighlighted(null));
    return () => { active = false; };
  }, [cacheKey, code, language]);
  const html = highlighted?.key === cacheKey ? highlighted.html : highlightedCache.get(cacheKey);
  return html ? <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code>{code}</code></pre>;
}

async function getMermaid() {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    return mermaid;
  });
  return mermaidPromise;
}

function Mermaid({ source }: { source: string }) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [content, setContent] = useState<ReactNode>(<pre><code>{source}</code></pre>);
  useEffect(() => {
    let active = true;
    void getMermaid().then(async (mermaid) => {
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
          className="chat-action-button"
          onClick={() => useArtifactStore.getState().openArtifact({ kind: "mermaid", title: "Mermaid diagram", content: source })}
        >
          <Eye size={12} /> Open
        </button>
      </div>
      {content}
    </div>
  );
}
