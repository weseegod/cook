import { HelpCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { acpClient } from "../../acp/client";
import { useSessionStore, type PendingQuestion } from "../../state/session";
import { Markdown } from "../chat/markdown";
import { InfoTip } from "../components/info-tip";
import { StopTurnButton } from "../chat/stop-turn-button";
import { elicitContent, elicitFields, elicitFormComplete } from "./elicit-fields";

/** TUI option jump keys: `1`–`9` then `a`–`f` (`option_index_for_key`). */
function optionKeyLabel(index: number): string {
  if (index < 9) return String(index + 1);
  if (index < 15) return String.fromCharCode("a".charCodeAt(0) + (index - 9));
  return String(index + 1);
}

function optionIndexForKey(key: string): number | null {
  if (key.length !== 1) return null;
  if (key >= "1" && key <= "9") return key.charCodeAt(0) - "1".charCodeAt(0);
  if (key >= "a" && key <= "f") return 9 + (key.charCodeAt(0) - "a".charCodeAt(0));
  if (key >= "A" && key <= "F") return 9 + (key.charCodeAt(0) - "A".charCodeAt(0));
  return null;
}

function questionAnswered(answers: (string[] | undefined)[], notes: (string | undefined)[], index: number): boolean {
  return (answers[index]?.length ?? 0) > 0 || (notes[index]?.trim() ?? "") !== "";
}

/** Wire payload matching TUI `build_accepted_response`. */
function buildAcceptedPayload(
  questions: PendingQuestion["questions"],
  answers: (string[] | undefined)[],
  notes: (string | undefined)[],
): { outcome: "accepted"; answers: Record<string, string[]>; annotations?: Record<string, { notes: string }> } {
  const wireAnswers: Record<string, string[]> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (let i = 0; i < questions.length; i++) {
    const labels = answers[i] ?? [];
    const freeform = notes[i]?.trim() ?? "";
    const hasFreeform = freeform.length > 0;
    if (labels.length === 0 && !hasFreeform) continue;
    const key = questions[i].question;
    wireAnswers[key] = labels.length === 0 && hasFreeform ? ["Other"] : labels;
    if (hasFreeform) annotations[key] = { notes: freeform };
  }
  return {
    outcome: "accepted",
    answers: wireAnswers,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

export function InteractionModal() {
  const pending = useSessionStore((state) => state.pendingQuestion);
  const turnRunning = useSessionStore((state) => state.turnRunning);
  const [answers, setAnswers] = useState<(string[] | undefined)[]>([]);
  const [notes, setNotes] = useState<(string | undefined)[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const elicitSchema = pending?.kind === "elicit" ? pending.raw.requestedSchema : undefined;
  const fields = useMemo(() => elicitFields(elicitSchema), [elicitSchema]);

  useEffect(() => {
    const n = pending?.questions.length ?? 0;
    setAnswers(Array.from({ length: n }, () => undefined));
    setNotes(Array.from({ length: n }, () => undefined));
    setActiveTab(0);
    setValues(Object.fromEntries(elicitFields(pending?.raw.requestedSchema).map((field) => [field.name, field.default ?? ""])));
  }, [pending?.rpcId, pending?.raw.requestedSchema, pending?.questions.length]);

  useEffect(() => {
    if (!pending || pending.kind === "plan") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")) {
        event.preventDefault();
        void cancelPending(pending.kind);
        return;
      }
      if (pending.kind !== "question") return;
      const target = event.target as HTMLElement | null;
      const inFreeform = target?.closest?.(".other-option") != null || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === "ArrowLeft" || event.key === "[" || event.key.toLowerCase() === "h") {
        if (inFreeform) return;
        event.preventDefault();
        setActiveTab((tab) => Math.max(0, tab - 1));
        return;
      }
      if (event.key === "ArrowRight" || event.key === "]" || event.key.toLowerCase() === "l") {
        if (inFreeform) return;
        event.preventDefault();
        setActiveTab((tab) => Math.min(pending.questions.length - 1, tab + 1));
        return;
      }
      if (inFreeform) return;
      const optionIdx = optionIndexForKey(event.key);
      if (optionIdx == null) return;
      const question = pending.questions[activeTab];
      if (!question || optionIdx >= question.options.length) return;
      event.preventDefault();
      choose(activeTab, question.options[optionIdx].label, question.multiSelect ?? false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, activeTab]);

  // Plan review verdicts live on the transcript pane + shared composer — no second inline card.
  if (!pending || pending.kind === "plan") return null;
  const activePending = pending;
  const questionCount = pending.questions.length;
  const answeredCount = pending.kind === "question"
    ? pending.questions.reduce((count, _, index) => count + (questionAnswered(answers, notes, index) ? 1 : 0), 0)
    : 0;
  const canSubmitQuestions = pending.kind === "question" && questionCount > 0 && answeredCount === questionCount;

  function choose(questionIndex: number, label: string, multi: boolean) {
    setAnswers((current) => {
      const next = current.slice();
      while (next.length <= questionIndex) next.push(undefined);
      const existing = next[questionIndex] ?? [];
      if (multi) {
        next[questionIndex] = existing.includes(label)
          ? existing.filter((item) => item !== label)
          : [...existing, label];
      } else {
        // Single-select allows deselect (TUI parity).
        next[questionIndex] = existing.length === 1 && existing[0] === label ? [] : [label];
      }
      return next;
    });
  }

  async function submitQuestions() {
    if (activePending.kind !== "question") return;
    await acpClient.answerQuestion(buildAcceptedPayload(activePending.questions, answers, notes));
    setAnswers([]);
    setNotes([]);
    setActiveTab(0);
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

  const activeQuestion = pending.kind === "question" ? pending.questions[Math.min(activeTab, Math.max(0, questionCount - 1))] : null;

  return (
    <section className={`inline-interaction interaction-${pending.kind}`} data-testid="inline-interaction" aria-live="polite">
      {pending.title && (
        <header className="inline-interaction-header">
          <div className={`inline-interaction-icon ${pending.kind === "trust" ? "safe" : ""}`}>
            {pending.kind === "trust" ? <ShieldCheck size={16} /> : <HelpCircle size={16} />}
          </div>
          <div>
            <strong>{pending.title}</strong>
            <span>
              Waiting for your input
              {pending.kind === "question" && questionCount > 1 && (
                <span className="question-tab-counter" data-testid="question-tab-counter"> {activeTab + 1} / {questionCount}</span>
              )}
            </span>
          </div>
          <button className="icon-button" data-testid="interaction-close" onClick={() => void cancelPending(pending.kind)} aria-label="Cancel interaction"><X size={15} /></button>
        </header>
      )}

      {pending.kind === "question" && activeQuestion && (
        <div className="question-body" data-testid="question-body">
          {questionCount > 1 && (
            <div className="question-tabs" role="tablist" aria-label="Questions" data-testid="question-tabs">
              {pending.questions.map((question, index) => (
                <button
                  key={question.index}
                  type="button"
                  role="tab"
                  aria-selected={index === activeTab}
                  className={index === activeTab ? "active" : ""}
                  data-testid={`question-tab-${index + 1}`}
                  onClick={() => setActiveTab(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          )}
          <div className="question-fieldset" data-testid={`question-panel-${activeQuestion.index + 1}`}>
            <div className="question-label" data-testid="question-label">
              <Markdown text={activeQuestion.label} />
            </div>
            {activeQuestion.description && (
              <div className="question-description" data-testid="question-description">
                <Markdown text={activeQuestion.description} />
              </div>
            )}
            <div className="question-options">
              {activeQuestion.options.map((option, index) => {
                const selected = (answers[activeQuestion.index] ?? []).includes(option.label);
                const multi = activeQuestion.multiSelect ?? false;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={selected ? "selected" : ""}
                    data-testid={`question-option-${activeQuestion.index}-${option.id}`}
                    onClick={() => choose(activeQuestion.index, option.label, multi)}
                  >
                    <span className="question-option-top">
                      <kbd>{optionKeyLabel(index)}</kbd>
                      <span className="question-option-marker" aria-hidden="true">{multi ? (selected ? "[✓]" : "[ ]") : (selected ? "(●)" : "( )")}</span>
                      <strong>{option.label}</strong>
                    </span>
                    {option.description && <span className="question-option-desc">{option.description}</span>}
                  </button>
                );
              })}
              <label className="other-option">
                <span>Other</span>
                <input
                  data-testid={`question-other-${activeQuestion.index}`}
                  value={notes[activeQuestion.index] ?? ""}
                  placeholder="Type your answer"
                  onChange={(event) => {
                    const value = event.target.value;
                    setNotes((current) => {
                      const next = current.slice();
                      while (next.length <= activeQuestion.index) next.push(undefined);
                      next[activeQuestion.index] = value;
                      return next;
                    });
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {pending.kind !== "question" && pending.questions.map((question) => (
        <fieldset key={question.index} className="question-fieldset">
          <legend>{question.question}</legend>
          <div className="question-options">
            {question.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                onClick={() => void pickSpecial(option.id)}
              >
                <kbd>{index + 1}</kbd>
                <strong>{option.label}</strong>
                {option.description && <InfoTip label={option.label}>{option.description}</InfoTip>}
              </button>
            ))}
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
              {questionCount > 1 && (
                <span className="question-answered-hint" data-testid="question-answered-hint">{answeredCount} / {questionCount} answered</span>
              )}
              <button className="ghost-button" onClick={() => void cancelPending(pending.kind)}>Cancel</button>
              <button className="primary-button" data-testid="question-submit" onClick={() => void submitQuestions()} disabled={!canSubmitQuestions}>Submit answers</button>
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
