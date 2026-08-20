"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { JobMatchResult, RequirementMatch } from "@/lib/match/types";

/**
 * What the job expects, against what the candidate can actually evidence.
 *
 * Every row here is a RequirementMatch the match engine already produced and already ships in the
 * match payload — no new request, no re-scoring, no reinterpretation. The engine's own five buckets
 * map straight onto the five states, and the mapping is the whole component:
 *
 *   employerEvidencedMatches  → STRONG   evidence attributed to a real employer
 *   inventoryOnlyMatches      → PARTIAL  claimed in the skills inventory, no employer attribution
 *   transferableMatches       → PARTIAL  credited from a related skill, never as a direct match
 *   missingRequirements       → MISSING  no candidate evidence found
 *   unresolvedRequirements    → UNKNOWN  the engine could not resolve this requirement at all
 *
 * The distinction that matters most: UNKNOWN is never folded into MISSING. "We could not resolve
 * this" and "you do not have this" are different statements, and collapsing them would overstate
 * the gap in exactly the direction that costs the candidate a real application.
 *
 * Requirement level (Required / Preferred) is passed through from the requirement unit; it is not
 * inferred from criticality or from position.
 */

type State = "strong" | "partial" | "missing" | "unknown";

const STATE_LABEL: Record<State, string> = {
  strong: "Strong",
  partial: "Partial",
  missing: "Not found",
  unknown: "Unknown",
};

// Never colour alone: each state has a distinct glyph shape AND a word.
const STATE_DOT: Record<State, string> = {
  strong: "bg-[var(--success)] shadow-[0_0_7px_var(--success)]",
  partial: "bg-[var(--warning)]",
  missing: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
  unknown: "bg-transparent ring-1 ring-dashed ring-[var(--border)]",
};

const STATE_TEXT: Record<State, string> = {
  strong: "text-[var(--success)]",
  partial: "text-[var(--warning)]",
  missing: "text-tertiary",
  unknown: "text-tertiary",
};

interface Row {
  id: string;
  label: string;
  level: string;
  kind: string;
  state: State;
  /** Why this row is partial rather than strong — the engine's own distinction, in its words. */
  qualifier: string | null;
  jobEvidence: string[];
  candidateEvidence: string | null;
}

function toRows(result: JobMatchResult): Row[] {
  const rows: Row[] = [];
  const push = (m: RequirementMatch, state: State, qualifier: string | null, i: number, bucket: string) => {
    const ev = m.evidence;
    const employers = ev?.employers ?? [];
    rows.push({
      id: `${bucket}-${i}`,
      label: m.requirement.label,
      level: m.requirement.requirementLevel,
      kind: m.requirement.kind,
      state,
      qualifier,
      jobEvidence: m.requirement.evidenceSnippets ?? [],
      candidateEvidence: ev
        ? [
            ev.rawSkillName,
            employers.length > 0 ? `at ${employers.join(", ")}` : null,
            typeof ev.yearsStated === "number" ? `${ev.yearsStated}y stated` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : m.transferable
          ? `Credited from ${m.transferable.fromRawSkillName} (${m.transferable.strength})`
          : null,
    });
  };

  (result.employerEvidencedMatches ?? []).forEach((m, i) => push(m, "strong", null, i, "emp"));
  (result.inventoryOnlyMatches ?? []).forEach((m, i) => push(m, "partial", "Inventory only — no employer attribution", i, "inv"));
  (result.transferableMatches ?? []).forEach((m, i) => push(m, "partial", "Transferable, not a direct match", i, "tra"));
  (result.missingRequirements ?? []).forEach((m, i) => push(m, "missing", null, i, "mis"));
  (result.unresolvedRequirements ?? []).forEach((m, i) => push(m, "unknown", "Engine could not resolve this requirement", i, "unr"));

  // Required before Preferred, then strongest evidence first — the order a reader needs, not the
  // order the buckets happen to arrive in.
  const levelRank = (l: string) => (l === "Required" ? 0 : 1);
  const stateRank: Record<State, number> = { strong: 0, partial: 1, missing: 2, unknown: 3 };
  return rows.sort((a, b) => levelRank(a.level) - levelRank(b.level) || stateRank[a.state] - stateRank[b.state]);
}

function Disclosure({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const hasEvidence = row.jobEvidence.length > 0 || row.candidateEvidence !== null;

  return (
    <div className="border-b border-[var(--separator)] last:border-b-0">
      <div className="flex items-center gap-2.5 py-[7px]">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[row.state]}`} />

        <span className="min-w-0 flex-1 truncate text-[12.5px] text-primary">
          {row.label}
          {row.kind !== "skill" && row.kind !== "skill_group" && (
            <span className="ml-1.5 text-[10px] uppercase tracking-[0.07em] text-tertiary">{row.kind}</span>
          )}
        </span>

        {/* Requirement level is quiet metadata, not a badge competing with the state. */}
        <span className="shrink-0 text-[10.5px] uppercase tracking-[0.07em] text-tertiary">{row.level}</span>

        <span className={`w-[4.5rem] shrink-0 text-right text-[11.5px] font-medium ${STATE_TEXT[row.state]}`}>
          {STATE_LABEL[row.state]}
        </span>

        {hasEvidence ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} evidence for ${row.label}`}
            className="shrink-0 rounded px-1 text-[11px] text-tertiary transition-colors duration-150 ease-out hover:text-primary active:scale-[0.97]"
          >
            <span aria-hidden="true">{open ? "−" : "+"}</span>
          </button>
        ) : (
          <span className="w-[1.35rem] shrink-0" />
        )}
      </div>

      {open && (
        <div className="mb-2 space-y-1.5 rounded-[var(--radius-md)] bg-[var(--z0-bg)] px-3 py-2.5">
          {row.qualifier && <p className="text-[11px] italic text-tertiary">{row.qualifier}</p>}
          {row.jobEvidence.length > 0 && (
            <div>
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-tertiary">Job evidence</div>
              {row.jobEvidence.slice(0, 2).map((snip, i) => (
                <p key={i} className="mt-0.5 text-[11.5px] leading-relaxed text-secondary">
                  {snip}
                </p>
              ))}
            </div>
          )}
          <div>
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-tertiary">Your evidence</div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-secondary">
              {row.candidateEvidence ?? "None recorded for this requirement."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function SkillAlignment({
  result,
  limit,
  onSeeAll,
}: {
  result: JobMatchResult;
  /** Hero mode shows the summary plus the first few rows; the Skills section below shows all of
   *  them. Same component, same ordering — the hero must not become the whole matrix or the
   *  workflow status underneath it falls below the fold. */
  limit?: number;
  onSeeAll?: () => void;
}) {
  const reduced = useReducedMotion() ?? false;
  const rows = toRows(result);

  if (rows.length === 0) {
    return (
      <p className="text-[12px] leading-relaxed text-tertiary">
        This posting did not yield structured requirements, so there is nothing to align against. That is a gap in the
        posting, not a gap in your profile.
      </p>
    );
  }

  // Counts are array lengths, not estimates. Unknown is reported separately from missing.
  const counts = {
    strong: rows.filter((r) => r.state === "strong").length,
    partial: rows.filter((r) => r.state === "partial").length,
    missing: rows.filter((r) => r.state === "missing").length,
    unknown: rows.filter((r) => r.state === "unknown").length,
  };

  return (
    // One grouped region, one animation. Thirty skills do not stagger individually.
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0.12 } : { type: "spring", duration: 0.3, bounce: 0 }}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11.5px]">
        <span className="text-secondary">
          <span className="font-semibold tabular-nums text-primary">{rows.length}</span> expected
        </span>
        {/* A zero is not a semantic state — it goes quiet rather than colouring an absence. */}
        <span className={counts.strong > 0 ? "text-[var(--success)]" : "text-tertiary"}>
          <span className="font-semibold tabular-nums">{counts.strong}</span> strong
        </span>
        <span className={counts.partial > 0 ? "text-[var(--warning)]" : "text-tertiary"}>
          <span className="font-semibold tabular-nums">{counts.partial}</span> partial
        </span>
        <span className="text-tertiary">
          <span className="font-semibold tabular-nums">{counts.missing}</span> not found
        </span>
        {counts.unknown > 0 && (
          <span className="text-tertiary">
            <span className="font-semibold tabular-nums">{counts.unknown}</span> unknown
          </span>
        )}
      </div>

      <div className="mt-2.5">
        {(limit ? rows.slice(0, limit) : rows).map((row) => (
          <Disclosure key={row.id} row={row} />
        ))}
      </div>

      {limit !== undefined && rows.length > limit && (
        <button
          type="button"
          onClick={onSeeAll}
          className="mt-2 rounded px-1 py-0.5 text-[11.5px] text-secondary transition-colors duration-150 ease-out hover:text-primary active:scale-[0.98]"
        >
          All {rows.length} requirements ↓
        </button>
      )}
    </motion.div>
  );
}
