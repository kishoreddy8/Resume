"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Starting an application from the job it is for.
 *
 * NOTHING HAPPENS UNTIL THIS IS CLICKED. This is the only control in Career-Ops that can reach the
 * execution engine, and therefore the only thing that can open a browser. Rendering it costs
 * nothing — no preflight request, no readiness poll.
 *
 * THE SERVER DECIDES WHETHER IT CAN RUN, and every refusal is specific: no adapter for this ATS, no
 * validated resume, incomplete contact details, the agent switched off. Each one is checked BEFORE a
 * browser opens, so a refusal is instant and says what to fix rather than failing two minutes in.
 */

type Outcome =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "refused"; message: string; href?: string; hrefLabel?: string }
  | { kind: "started"; runId: number; status: string };

export function StartApplication({ candidateId, jobId }: { candidateId: number; jobId: number }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function start() {
    setOutcome({ kind: "starting" });
    try {
      const res = await fetch(`/api/candidates/${candidateId}/application-runs/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", jobId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setOutcome({ kind: "refused", message: body?.error ?? "The application could not be started." });
        return;
      }

      switch (body.status) {
        case "resume_required":
          setOutcome({ kind: "refused", message: body.message, href: `/jobs/${jobId}#job-resume`, hrefLabel: "Open Resume Studio" });
          return;
        case "contact_required":
          setOutcome({ kind: "refused", message: body.message, href: "/onboarding", hrefLabel: "Complete your details" });
          return;
        case "unsupported_ats":
        case "agent_disabled":
          setOutcome({ kind: "refused", message: body.message });
          return;
        default:
          setOutcome({ kind: "started", runId: body.run.id, status: body.status });
          /* Straight to the run: whatever happened next — a pause, a question, a review — is there
           * and not here. */
          router.push(`/applications/${body.run.id}`);
      }
    } catch {
      setOutcome({ kind: "refused", message: "The application could not be started." });
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={outcome.kind === "starting"}
        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] disabled:opacity-50"
      >
        {outcome.kind === "starting" ? "Starting…" : "Start application"}
      </button>

      <div aria-live="polite">
        {outcome.kind === "starting" && (
          <p className="mt-1.5 text-[11.5px] text-tertiary">
            Opening the application and filling what Career-Ops can evidence…
          </p>
        )}
        {outcome.kind === "refused" && (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-tertiary">
            {outcome.message}
            {outcome.href && (
              <>
                {" "}
                <Link href={outcome.href} className="text-secondary underline-offset-2 hover:underline">
                  {outcome.hrefLabel}
                </Link>
              </>
            )}
          </p>
        )}
        {outcome.kind === "started" && (
          <p className="mt-1.5 text-[11.5px] text-tertiary">
            Started.{" "}
            <Link href={`/applications/${outcome.runId}`} className="text-secondary underline-offset-2 hover:underline">
              Open the run
            </Link>
          </p>
        )}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-tertiary">
        Career-Ops fills only what your evidence supports, stops for anything it cannot answer, and
        never submits without your explicit approval.
      </p>
    </div>
  );
}
