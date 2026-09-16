import { Brain, HelpCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";
import { Markdown } from "../chat/markdown";

export function InteractionModal() {
  const pending = useSessionStore((state) => state.pendingQuestion);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    setAnswers({});
    setNotes({});
  }, [pending?.rpcId]);
  if (!pending) return null;

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
    if (pending!.kind === "trust") return acpClient.answerQuestion({ outcome: id });
    if (pending!.kind === "plan") {
      const feedback = id === "cancelled" ? window.prompt("What should Thanh change in the plan?") ?? undefined : undefined;
      return acpClient.answerQuestion({ outcome: id, ...(feedback ? { feedback } : {}) });
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="modal interaction-modal" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={() => void acpClient.answerQuestion(
          pending.kind === "trust" ? { outcome: "reject" } : { outcome: "cancelled" },
        )}><X size={17} /></button>
        <div className={`modal-icon ${pending.kind === "trust" ? "safe" : ""}`}>
          {pending.kind === "plan" ? <Brain size={23} /> : pending.kind === "trust" ? <ShieldCheck size={23} /> : <HelpCircle size={23} />}
        </div>
        <h2>{pending.title}</h2>
        {pending.questions.map((question) => (
          <fieldset key={question.question} className="question-fieldset">
            <legend>{pending.kind === "plan" ? <Markdown text={question.question} /> : question.question}</legend>
            <div className="question-options">
              {question.options.map((option) => {
                const selected = (answers[question.question] ?? []).includes(option.label);
                return (
                  <button
                    key={option.id}
                    className={selected ? "selected" : ""}
                    onClick={() => pending.kind === "question" ? choose(question.question, option.label, question.multiSelect ?? false) : void pickSpecial(option.id)}
                  >
                    <strong>{option.label}</strong>{option.description && <span>{option.description}</span>}
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
        {pending.kind === "question" && (
          <div className="modal-actions">
            <button className="ghost-button" onClick={() => void acpClient.answerQuestion({ outcome: "cancelled" })}>Cancel</button>
            <button className="primary-button" onClick={() => void submitQuestions()} disabled={Object.keys(answers).length === 0}>Submit answers</button>
          </div>
        )}
      </section>
    </div>
  );
}
