"use client";

import { useState } from "react";
import { TailoringPlanPanel } from "./TailoringPlanPanel";
import { useTailoringPlan } from "./useTailoringPlan";

/**
 * The Tailoring Intelligence section of the job command center.
 *
 * WHY IT LIVES HERE rather than on its own route. The decision it informs — whether to approve
 * tailoring for THIS job — is made on this page, next to the verdict, the requirements and the
 * action dock. A separate screen would have meant loading the same job, the same match result and
 * the same queue again, and would have put the reasoning somewhere you had to remember to visit.
 *
 * IT IS COLLAPSED BY DEFAULT AND FETCHES NOTHING UNTIL OPENED. The job page already issues several
 * requests on selection and this is the deepest layer of detail on it, so it must not add to the
 * cost of simply arrowing through the queue.
 */
export function TailoringIntelligence({ candidateId, jobId }: { candidateId: number; jobId: number }) {
  const [open, setOpen] = useState(false);
  const plan = useTailoringPlan(candidateId, jobId, open);

  return (
    <details
      className="group"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-[13px] font-medium text-secondary transition-colors duration-150 ease-out hover:text-primary [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="inline-block text-[10px] leading-none text-tertiary transition-transform duration-150 ease-out group-open:rotate-90"
        >
          ▶
        </span>
        Tailoring plan
        <span className="ml-auto text-[11px] font-normal text-tertiary">
          what will be emphasized, and what must not be claimed
        </span>
      </summary>

      <div className="mt-2.5">
        {plan.state === "loading" && (
          <p role="status" className="text-[12px] text-tertiary">
            Reading this job&rsquo;s evaluation…
          </p>
        )}
        {plan.state === "not_evaluated" && (
          <p className="text-[12px] text-tertiary">
            This job has not been evaluated against your profile yet, so there is no evidence to plan
            from. Evaluate it first — nothing here is guessed in the meantime.
          </p>
        )}
        {plan.state === "error" && (
          <p className="text-[12px] text-tertiary">The tailoring plan could not be loaded.</p>
        )}
        {plan.state === "ready" && <TailoringPlanPanel plan={plan.plan} />}
      </div>
    </details>
  );
}
