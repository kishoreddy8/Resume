"use client";

import { useState } from "react";

/**
 * Ask a question about this job's evaluation.
 *
 * NOTHING HAPPENS UNTIL YOU ASK. No request on mount, no polling, no warm-up. Opening the job, the
 * plan, or this panel costs nothing — the only way a model runs is pressing Ask, which is the
 * difference between a feature that uses your Claude subscription and one that spends it.
 *
 * IT EXPLAINS, IT DOES NOT DECIDE. Answers are built from the evaluation already on record. The
 * assistant cannot change a stage, edit evidence, approve tailoring or write a resume, and the
 * panel says the engine remains the authority — an explanation that reads like a verdict would
 * invite trusting it over the deterministic decision it is describing.
 *
 * IT DEGRADES QUIETLY. With no CLI installed, or the environment guard set, this reports that
 * plainly and everything else on the page keeps working.
 */

const SUGGESTED = [
  "Why does this job need review?",
  "Where does my evidence for these skills come from?",
  "What should the tailoring plan emphasize?",
  "Which of my roles can support this job, and why not the others?",
];

type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "answer"; text: string }
  | { kind: "unavailable"; message: string };

export function AskAboutJob({ candidateId, jobId }: { candidateId: number; jobId: number }) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function ask(q: string) {
    const text = q.trim();
    if (text.length < 3) return;
    setState({ kind: "working" });
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, jobId, question: text }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setState({ kind: "unavailable", message: "The assistant could not be reached." });
        return;
      }
      if (body.status === "ok") setState({ kind: "answer", text: body.answer });
      else setState({ kind: "unavailable", message: body.message ?? "The assistant is unavailable." });
    } catch {
      setState({ kind: "unavailable", message: "The assistant could not be reached." });
    }
  }

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-[13px] font-medium text-secondary transition-colors duration-150 ease-out hover:text-primary [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="inline-block text-[10px] leading-none text-tertiary transition-transform duration-150 ease-out group-open:rotate-90"
        >
          ▶
        </span>
        Ask about this evaluation
        <span className="ml-auto text-[11px] font-normal text-tertiary">uses your local Claude CLI</span>
      </summary>

      <div className="mt-2.5">
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuestion(s);
                ask(s);
              }}
              disabled={state.kind === "working"}
              className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11.5px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <label className="min-w-[16rem] flex-1">
            <span className="sr-only">Your question about this job</span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") ask(question);
              }}
              placeholder="Ask about this job's evaluation…"
              className="w-full rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[16px] text-primary outline-none transition-colors duration-150 ease-out hover:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] sm:text-[13px]"
            />
          </label>
          <button
            type="button"
            onClick={() => ask(question)}
            disabled={state.kind === "working" || question.trim().length < 3}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.kind === "working" ? "Working…" : "Ask"}
          </button>
        </div>

        <div aria-live="polite">
          {state.kind === "working" && (
            <p className="mt-2 text-[12px] text-tertiary">Reading this job&rsquo;s recorded evaluation…</p>
          )}
          {state.kind === "answer" && (
            <div className="mt-2.5 rounded-[var(--radius-lg)] border border-[var(--border)] px-3.5 py-3">
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-secondary">{state.text}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
                Built from this job&rsquo;s recorded evaluation and your candidate profile. The engine&rsquo;s
                decision and the deterministic validators remain the authority — this only explains them.
              </p>
            </div>
          )}
          {state.kind === "unavailable" && (
            <p className="mt-2 text-[12px] leading-relaxed text-tertiary">
              {state.message} Everything else on this page works without it.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}
