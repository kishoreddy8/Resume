"use client";

import type { ReactNode } from "react";
import type { JobMatchResult } from "@/lib/match/types";
import type { JobWithCompany } from "@/types";
import { getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";

/**
 * The three supporting tiles beside the score ring.
 *
 * Each answers a different question the ring cannot: can I be sponsored, is this
 * still live, and does a resume exist yet. Four tiles including the ring is the
 * ceiling — beyond that the hero stops being a verdict and becomes a dashboard.
 *
 * Every value is read, never derived. Where the underlying data is genuinely
 * absent the tile says so in words and renders its indicator hollow, because an
 * unknown drawn as a filled dot is a fabricated fact. That is also why there is
 * no confidence meter or evidence-distribution bar here: the engine does not
 * publish those numbers, and inventing a geometry for them would be worse than
 * showing nothing.
 */

type Tone = "ready" | "review" | "blocked" | "neutral" | "unknown";

const DOT: Record<Tone, string> = {
  ready: "bg-[var(--success)] shadow-[0_0_8px_var(--success)]",
  review: "bg-[var(--warning)] shadow-[0_0_8px_var(--warning)]",
  blocked: "bg-[var(--error)] shadow-[0_0_8px_var(--error)]",
  neutral: "bg-[var(--accent)] shadow-[0_0_8px_var(--accent-soft)]",
  // Hollow: an absent signal must not look like a weak positive.
  unknown: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
};

function Tile({
  label,
  value,
  detail,
  tone,
  graphic,
  tint,
}: {
  label: string;
  value: string;
  detail?: string;
  tone: Tone;
  graphic?: ReactNode;
  /** Family identity, carried as a 3-5% wash. Never encodes state — state is the dot and the word. */
  tint: "match" | "info" | "neutral" | "craft" | "alert";
}) {
  return (
    <div className={`tile tint-${tint} group relative overflow-hidden rounded-[var(--radius-lg)] px-3 py-2.5`}>
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
        <span className="text-[9px] font-semibold uppercase tracking-[0.11em] text-tertiary">{label}</span>
      </div>
      <div className="mt-1.5 truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-primary">
        {value}
      </div>
      {detail && <div className="mt-0.5 truncate text-[11px] text-tertiary">{detail}</div>}
      {graphic}
    </div>
  );
}

/** A four-bar step meter. Only ever driven by a value the engine actually published. */
function StepMeter({ filled, tone }: { filled: number; tone: Tone }) {
  const colour =
    tone === "ready"
      ? "bg-[var(--success)]"
      : tone === "review"
        ? "bg-[var(--warning)]"
        : tone === "blocked"
          ? "bg-[var(--error)]"
          : "bg-[var(--border)]";
  return (
    <div aria-hidden="true" className="mt-2 flex gap-1">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`h-[3px] flex-1 rounded-full ${i < filled ? colour : "bg-[var(--separator)]"}`}
        />
      ))}
    </div>
  );
}

/** Sponsorship confidence is a closed enum, so the meter maps values, not a computed score. */
const SPONSORSHIP_STEPS: Record<string, { steps: number; tone: Tone }> = {
  "Very High": { steps: 4, tone: "ready" },
  High: { steps: 3, tone: "ready" },
  Medium: { steps: 2, tone: "review" },
  Low: { steps: 1, tone: "review" },
  "Not Sponsoring": { steps: 0, tone: "blocked" },
  Unknown: { steps: 0, tone: "unknown" },
};

export function HeroTiles({
  job,
  result,
  thresholds,
  generatedFileCount,
}: {
  job: JobWithCompany;
  result: JobMatchResult | null;
  thresholds: LifecycleThresholds;
  generatedFileCount: number;
}) {
  const conf = job.h1b_combined_confidence;
  const sponsorship = SPONSORSHIP_STEPS[conf] ?? { steps: 0, tone: "unknown" as Tone };

  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const dated = Boolean(job.posted_at);
  const freshTone: Tone =
    !dated ? "unknown" : ageDays <= thresholds.freshMaxDays ? "ready" : ageDays <= 20 ? "neutral" : "review";

  const marked = job.marked_for_tailoring === 1;
  const resumeValue = generatedFileCount > 0 ? "Generated" : marked ? "Approved" : "Not started";
  const resumeDetail =
    generatedFileCount > 0
      ? `${generatedFileCount} file${generatedFileCount === 1 ? "" : "s"}`
      : marked
        ? "Writer off — run the skill"
        : "No tailoring approved";

  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile
        tint="info"
        label="Sponsorship"
        value={conf}
        detail={conf === "Unknown" ? "No signal in this posting" : undefined}
        tone={sponsorship.tone}
        graphic={<StepMeter filled={sponsorship.steps} tone={sponsorship.tone} />}
      />
      <Tile
        tint="neutral"
        label="Freshness"
        value={dated ? `${ageDays}d old` : "Date unknown"}
        detail={dated ? new Date(job.posted_at as string).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined}
        tone={freshTone}
      />
      <Tile
        tint="craft"
        label="Resume"
        value={resumeValue}
        detail={resumeDetail}
        tone={generatedFileCount > 0 ? "ready" : marked ? "neutral" : "unknown"}
      />
      {result === null && (
        <div className="col-span-3 text-[11px] text-tertiary">
          Tiles reflect posting facts only — this job has not been evaluated yet.
        </div>
      )}
    </div>
  );
}
