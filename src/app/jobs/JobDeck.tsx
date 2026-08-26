"use client";

import { useState } from "react";
import type { LifecycleThresholds } from "@/lib/jobLifecycle";
import type { ListMatchSummary } from "@/lib/rank/jobsList";
import { EmptyState } from "./EmptyState";
import { JobSwipeCard } from "./JobSwipeCard";
import { approveForTailoring, setJobNotInterested } from "./jobActions";
import type { CardJob } from "./JobCardPresentation";

export interface DeckEntry {
  job: CardJob;
  summary: ListMatchSummary | undefined;
}

/**
 * UI-J — the mobile focused-card triage deck. One interactive card in front, one lower-plane peek
 * behind it for orientation (Part 12's "current card + next card, not a five-card fan"). Swiping
 * through the deck only ever ADVANCES a local pointer — it never refilters or reorders `items` — so
 * a card a person just acted on simply will not be shown again this session, the same outcome as
 * removing it, without the array-mutation bookkeeping that would need.
 */
export function JobDeck({
  items,
  candidateId,
  thresholds,
  onOpen,
  onSavedChange,
}: {
  items: DeckEntry[];
  candidateId: number;
  thresholds: LifecycleThresholds;
  onOpen: (id: number) => void;
  onSavedChange?: (jobId: number, saved: boolean) => void;
}) {
  const signature = items.map((i) => i.job.id).join(",");
  const [state, setState] = useState({ signature, index: 0 });
  const index = state.signature === signature ? state.index : 0;
  if (state.signature !== signature) setState({ signature, index: 0 });

  function advance() {
    setState((s) => ({ signature: s.signature, index: s.index + 1 }));
  }

  if (items.length === 0) return null; // caller already renders its own empty state

  const current = items[index];
  const next = items[index + 1];

  if (!current) {
    return (
      <EmptyState
        title="You're through today's list"
        body="Nothing left to review right now. Widen your filters, or check back after the next scan."
      />
    );
  }

  return (
    <div className="relative">
      {next && (
        <div aria-hidden="true" className="absolute inset-x-3 top-4 -z-10 opacity-60">
          <JobSwipeCard
            job={next.job}
            candidateId={candidateId}
            thresholds={thresholds}
            summary={next.summary}
            interactive={false}
            onOpen={onOpen}
            onApprove={async () => false}
            onReject={async () => false}
          />
        </div>
      )}

      <JobSwipeCard
        key={current.job.id}
        job={current.job}
        candidateId={candidateId}
        thresholds={thresholds}
        summary={current.summary}
        interactive
        onOpen={onOpen}
        onSavedChange={onSavedChange}
        onApprove={async () => {
          if (!current.summary) return false;
          const result = await approveForTailoring({ candidateId, jobId: current.job.id, decision: current.summary.decision });
          if (result.ok) advance();
          return result.ok;
        }}
        onReject={async () => {
          const result = await setJobNotInterested({ candidateId, jobId: current.job.id, notInterested: true });
          if (result.ok) advance();
          return result.ok;
        }}
      />
    </div>
  );
}
