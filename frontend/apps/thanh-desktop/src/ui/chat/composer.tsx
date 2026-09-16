import { CornerDownLeft, LoaderCircle, Square, WandSparkles } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { acpClient } from "../../acp/client";
import { useCatalogStore } from "../../state/catalog";
import { useSessionStore } from "../../state/session";

export function Composer() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const commands = useCatalogStore((state) => state.commands);
  const commandQuery = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0].toLowerCase() : null;
  const matching = useMemo(
    () => commandQuery === null ? [] : commands.filter((command) => command.name.toLowerCase().includes(commandQuery)).slice(0, 8),
    [commandQuery, commands],
  );

  async function submit() {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setText("");
    try {
      if (turnRunning) {
        acpClient.queuePrompt(prompt);
      } else {
        await acpClient.prompt(prompt);
      }
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
      <div className="composer">
        <textarea
          ref={textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
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
          <span><WandSparkles size={13} /> Shift+Enter for a new line</span>
          {turnRunning ? (
            <div className="composer-running">
              <button className="stop-button" onClick={() => void acpClient.cancel()}><Square size={13} /> Stop</button>
              <button className="send-button" disabled={!text.trim() || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Queue</button>
            </div>
          ) : (
            <button className="send-button" disabled={!text.trim() || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={15} /> : <CornerDownLeft size={15} />} Send</button>
          )}
        </div>
      </div>
    </div>
  );
}
