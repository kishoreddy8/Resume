"use client";

import { useState } from "react";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { useJobMatch } from "./[id]/useJobMatch";
import { SkillAlignment } from "./[id]/SkillAlignment";

/**
 * UI-J — "Why this match?" for the mobile card. Reuses the exact same per-job fetch (useJobMatch)
 * and the exact same evidence component (SkillAlignment) the job detail page already renders — no
 * new evidence model, no new copy for Strong/Partial/Not found/Unknown.
 *
 * The sheet itself is always mounted (BottomSheet needs to see open flip true→false to run its own
 * exit animation and to call the native dialog's close() at the right time — unmounting it outright
 * the instant `open` goes false would skip that and silently violate the reduced-motion/close
 * contract BottomSheet already guarantees). Only the FETCHING content inside is deferred: it mounts
 * the first time the sheet opens and then stays mounted, so this never adds a per-card request to
 * the list — only one on-demand request, the first time a person actually asks.
 */
export function WhyThisMatch({
  jobId,
  jobTitle,
  candidateId,
  trigger,
}: {
  jobId: number;
  jobTitle: string;
  candidateId: number | null;
  /** Render prop so the caller controls the trigger's exact appearance (button vs. link, size). */
  trigger: (onOpen: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);

  return (
    <>
      {trigger(() => {
        setEverOpened(true);
        setOpen(true);
      })}
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Why this match?" description={jobTitle}>
        {everOpened ? <WhyThisMatchContent jobId={jobId} candidateId={candidateId} /> : null}
      </BottomSheet>
    </>
  );
}

function WhyThisMatchContent({ jobId, candidateId }: { jobId: number; candidateId: number | null }) {
  const match = useJobMatch(jobId, candidateId);

  if (match.state === "loading" || match.state === "idle") {
    return <p className="text-[13px] text-tertiary">Loading your evaluation for this job…</p>;
  }
  if (match.state === "none") {
    return (
      <p className="text-[13px] leading-relaxed text-tertiary">
        This job hasn&apos;t been evaluated against your profile yet — evidence appears here once it has.
      </p>
    );
  }
  if (match.state === "error" || !match.result) {
    return <p className="text-[13px] leading-relaxed text-tertiary">Couldn&apos;t load your evaluation. Try again from the job.</p>;
  }
  return <SkillAlignment result={match.result} />;
}
