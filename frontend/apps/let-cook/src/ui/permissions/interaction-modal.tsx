import { HelpCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";
import { InfoTip } from "../components/info-tip";
import { StopTurnButton } from "../chat/stop-turn-button";
import { elicitContent, elicitFields, elicitFormComplete } from "./elicit-fields";

export function InteractionModal() {
  const pending = useSessionStore((state) => state.pendingQuestion);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const elicitSchema = pending?.kind === "elicit" ? pending.raw.requestedSchema : undefined;
  const fields = useMemo(() => elicitFields(elicitSchema), [elicitSchema]);

  useEffect(() => {
    setAnswers({});
    setNotes({});
    setValues(Object.fromEntries(elicitFields(pending?.raw.requestedSchema).map((field) => [field.name, field.default ?? ""])));
  }, [pending?.rpcId, pending?.raw.requestedSchema]);

  useEffect(() => {
    if (!pending || pending.kind === "plan") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")) {
        event.preventDefault();
        void cancelPending(pending.kind);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending]);

  // Plan review verdicts live on the transcript pane + shared composer — no second inline card.
  if (!pending || pending.kind === "plan") return null;
  const activePending = pending;

  function choose(question: string, label: string, multi: boolean) {
    setAnswers((current) => {
      const existing = current[question] ?? [];
      return {
        ...current,
        [question]: multi
          ? existing.includes(label) ? existing.filter((item) => item !== label) : [...existing, label]
          : [label],
      };
    });
  }

  async function submitQuestions() {
    const annotations = Object.fromEntries(
      Object.entries(notes).filter(([, note]) => note.trim()).map(([question, note]) => [question, { notes: note.trim() }]),
    );
    await acpClient.answerQuestion({
      outcome: "accepted",
      answers,
      ...(Object.keys(annotations).length ? { annotations } : {}),
    });
    setAnswers({});
    setNotes({});
  }

  async function pickSpecial(id: string) {
    if (activePending.kind === "trust") return acpClient.answerQuestion({ outcome: id });
    if (activePending.kind === "elicit") {
      if (id === "decline") return acpClient.answerQuestion({ outcome: "decline" });
      const url = activePending.raw.url;
      if (typeof url === "string" && url.startsWith("http")) window.open(url, "_blank", "noopener");
      const content = elicitContent(fields, values);
      return acpClient.answerQuestion({ outcome: "accept", ...(Object.keys(content).length ? { content } : {}) });
    }
  }

  return (
    <section className={`inline-interaction interaction-${pending.kind}`} data-testid="inline-interaction" aria-live="polite">
      {pending.title && (
        <header className="inline-interaction-header">
          <div className={`inline-interaction-icon ${pending.kind === "trust" ? "safe" : ""}`}>
            {pending.kind === "trust" ? <ShieldCheck size={16} /> : <HelpCircle size={16} />}
          </div>
          <div>
            <strong>{pending.title}</strong>
            <span>Waiting for your input</span>
          </div>
          <button className="icon-button" data-testid="interaction-close" onClick={() => void cancelPending(pending.kind)} aria-label="Cancel interaction"><X size={15} /></button>
        </header>
      )}
      {pending.questions.map((question) => (
        <fieldset key={question.question} className="question-fieldset">
          <legend>{question.question}</legend>
          <div className="question-options">
            {question.options.map((option, index) => {
              const selected = (answers[question.question] ?? []).includes(option.label);
              return (
                <button
                  key={option.id}
                  className={selected ? "selected" : ""}
                  onClick={() => pending.kind === "question" ? choose(question.question, option.label, question.multiSelect ?? false) : void pickSpecial(option.id)}
                >
                  <kbd>{index + 1}</kbd>
                  <strong>{option.label}</strong>
                  {option.description && <InfoTip label={option.label}>{option.description}</InfoTip>}
                </button>
              );
            })}
            {pending.kind === "question" && (
              <label className="other-option">
                <span>Other</span>
                <input
                  value={notes[question.question] ?? ""}
                  placeholder="Type your answer"
                  onChange={(event) => {
                    setNotes((current) => ({ ...current, [question.question]: event.target.value }));
                    if (event.target.value) choose(question.question, "Other", question.multiSelect ?? false);
                  }}
                />
              </label>
            )}
          </div>
        </fieldset>
      ))}
      {pending.kind === "elicit" && fields.length > 0 && (
        <div className="elicit-fields" data-testid="elicit-fields">
          {fields.map((field) => (
            <label key={field.name} className="elicit-field">
              <span>{field.label}{field.required && <em aria-hidden="true"> *</em>}{field.description && <InfoTip label={field.label}>{field.description}</InfoTip>}</span>
              {field.options ? (
                <select data-testid={`elicit-${field.name}`} value={values[field.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}>
                  <option value="">Choose…</option>
                  {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : field.type === "boolean" ? (
                <select data-testid={`elicit-${field.name}`} value={values[field.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}>
                  <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
                </select>
              ) : (
                <input data-testid={`elicit-${field.name}`} type={field.type === "number" ? "number" : "text"} value={values[field.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />
              )}
            </label>
          ))}
        </div>
      )}
      {(pending.kind === "elicit" || pending.kind === "question" || turnRunning) && (
        <div className="inline-interaction-actions">
          {pending.kind === "elicit" && (
            <>
              <button className="ghost-button" data-testid="elicit-decline" onClick={() => void pickSpecial("decline")}>Decline</button>
              <button className="primary-button" data-testid="elicit-accept" onClick={() => void pickSpecial("accept")} disabled={!elicitFormComplete(fields, values)}>{typeof pending.raw.url === "string" ? "Open and continue" : "Send to connector"}</button>
            </>
          )}
          {pending.kind === "question" && (
            <>
              <button className="ghost-button" onClick={() => void cancelPending(pending.kind)}>Cancel</button>
              <button className="primary-button" onClick={() => void submitQuestions()} disabled={Object.keys(answers).length === 0}>Submit answers</button>
            </>
          )}
          {turnRunning && <StopTurnButton />}
        </div>
      )}
    </section>
  );
}

async function cancelPending(kind: string) {
  if (kind === "trust") return acpClient.answerQuestion({ outcome: "reject" });
  if (kind === "elicit") return acpClient.answerQuestion({ outcome: "cancel" });
  return acpClient.answerQuestion({ outcome: "cancelled" });
}
