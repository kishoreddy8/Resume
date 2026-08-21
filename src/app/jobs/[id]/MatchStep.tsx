"use client";

import type { JobMatchResult, RequirementMatch } from "@/lib/match/types";
import { BulletRow, Chip, EmptyNote, EvidenceRow, StepSectionHeading, WsCard } from "./WorkspaceUI";

/**
 * Step 1 — Match, as five columns read across.
 *
 * NOTHING HERE IS COMPUTED. Every card reads a bucket the matching engine already produced and
 * persisted: employer-evidenced, inventory-only, transferable, missing and unresolved. Counting the
 * rows in a bucket is not scoring, and no card re-derives a strength, a percentage or a ranking.
 * The engine's own `overallScore` and `decision` are shown verbatim.
 *
 * THE STRENGTH WORDS ARE THE MODEL'S, NOT ADJECTIVES. "Strong evidence" means the requirement was
 * attributed to a named employer. "Supported by MSI" means the Master Skills Inventory carries it
 * but no employer line does — which is real evidence under the approved policy, and is labelled as
 * what it is rather than flattened into the same word. "Transferable" is the engine's own bucket.
 * There is no "expert" or "advanced" anywhere, because the model does not grade skills.
 *
 * WHAT IS NOT EVIDENCED IS NEVER CALLED MISSING. A requirement with no evidence is shown as a plain
 * chip among the requirements — it is a thing the posting asked for, not an accusation.
 */

/** The engine's decision in a candidate's words. Mirrors the identity header's mapping. */
function decisionWords(decision: string | null): string {
  if (decision === "READY_FOR_TAILORING") return "Ready to tailor";
  if (decision === "NEEDS_REVIEW") return "Needs review";
  if (decision === "BLOCKED") return "Blocked";
  return "Not evaluated";
}

interface Row {
  label: string;
  strength: string;
  tone: "strong" | "partial" | "none";
}

/** Best-supported first, so the six rows shown are the six most useful. */
function evidenceRows(result: JobMatchResult): Row[] {
  const employer = (result.employerEvidencedMatches ?? []).map((m) => ({
    label: m.requirement.label,
    strength: "Strong evidence",
    tone: "strong" as const,
  }));
  const inventory = (result.inventoryOnlyMatches ?? []).map((m) => ({
    label: m.requirement.label,
    strength: "Supported by MSI",
    tone: "partial" as const,
  }));
  const transferable = (result.transferableMatches ?? []).map((m) => ({
    label: m.requirement.label,
    strength: "Transferable",
    tone: "partial" as const,
  }));
  return [...employer, ...inventory, ...transferable];
}

/**
 * Strengths, each one a count or a stated figure the engine already holds.
 *
 * A strength is omitted rather than softened when the number behind it does not exist — there is no
 * "strong project alignment" here, because nothing in the model measures that.
 */
function strengths(result: JobMatchResult): string[] {
  const out: string[] = [];
  const employer = result.employerEvidencedMatches ?? [];
  const inventory = result.inventoryOnlyMatches ?? [];
  const transferable = result.transferableMatches ?? [];
  const total =
    employer.length +
    inventory.length +
    transferable.length +
    (result.missingRequirements ?? []).length +
    (result.unresolvedRequirements ?? []).length;

  if (total > 0) out.push(`${employer.length + inventory.length} of ${total} requirements evidenced`);
  if (employer.length > 0) out.push(`${employer.length} backed by a named employer`);

  /* Years only when the candidate's own evidence states them. Never inferred from dates. */
  const years = [...employer, ...inventory]
    .map((m) => m.evidence?.yearsStated)
    .filter((y): y is number => typeof y === "number" && y > 0);
  if (years.length > 0) out.push(`${Math.max(...years)} years stated on the strongest match`);

  const employers = new Set(employer.flatMap((m) => m.evidence?.employers ?? []));
  if (employers.size > 0) out.push(`Evidence drawn from ${employers.size} employer${employers.size === 1 ? "" : "s"}`);

  if (transferable.length > 0) out.push(`${transferable.length} transferable from adjacent skills`);
  return out.slice(0, 5);
}

/** Every requirement the posting stated, split the way the posting split them. */
function requirementChips(result: JobMatchResult) {
  const evidenced = new Set(
    [...(result.employerEvidencedMatches ?? []), ...(result.inventoryOnlyMatches ?? [])].map(
      (m) => m.requirement.label
    )
  );
  const all: RequirementMatch[] = [
    ...(result.employerEvidencedMatches ?? []),
    ...(result.inventoryOnlyMatches ?? []),
    ...(result.transferableMatches ?? []),
    ...(result.missingRequirements ?? []),
    ...(result.unresolvedRequirements ?? []),
  ];
  const seen = new Set<string>();
  const required: { label: string; evidenced: boolean }[] = [];
  const preferred: { label: string; evidenced: boolean }[] = [];
  for (const m of all) {
    const label = m.requirement.label;
    if (seen.has(label)) continue;
    seen.add(label);
    const row = { label, evidenced: evidenced.has(label) };
    if (m.requirement.requirementLevel === "Required") required.push(row);
    else preferred.push(row);
  }
  return { required, preferred };
}

/** Which of the candidate's own records the evidence came from, and how much came from each. */
function evidenceSources(result: JobMatchResult): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of result.employerEvidencedMatches ?? []) {
    for (const employer of m.evidence?.employers ?? []) {
      counts.set(employer, (counts.get(employer) ?? 0) + 1);
    }
  }
  const msi = (result.inventoryOnlyMatches ?? []).length;
  const rows = [...counts.entries()].map(([name, count]) => ({ name, count }));
  rows.sort((a, b) => b.count - a.count);
  if (msi > 0) rows.push({ name: "Master Skills Inventory", count: msi });
  return rows.slice(0, 6);
}

export function MatchStep({ result }: { result: JobMatchResult }) {
  const rows = evidenceRows(result);
  const strong = strengths(result);
  const { required, preferred } = requirementChips(result);
  const sources = evidenceSources(result);
  const score = typeof result.overallScore === "number" ? Math.round(result.overallScore) : null;

  return (
    <div>
      <StepSectionHeading title="Match intelligence" blurb="Why this posting fits the evidence you already have." />

      {/* Five columns at desktop, proportioned as the reference: score is narrow, requirements wide.
       *  They collapse to three, then two, then one rather than compressing into unreadable slivers. */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:[grid-template-columns:15fr_20fr_21fr_25fr_19fr]">
        {/* 1 — overall match */}
        <WsCard title="Overall match">
          {score === null ? (
            <EmptyNote>Not scored.</EmptyNote>
          ) : (
            <div>
              <div className="text-[34px] font-bold leading-none tabular-nums tracking-[-0.02em] text-primary">
                {score}
              </div>
              <div className="mt-2 text-[12.5px] font-semibold text-[var(--pill-success-fg)]">
                {decisionWords(result.decision ?? null)}
              </div>
              {result.insufficientJdSignal && (
                <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--pill-amber-fg)]">
                  This posting carried too little detail to evaluate reliably.
                </p>
              )}
            </div>
          )}
        </WsCard>

        {/* 2 — top matching skills */}
        <WsCard title="Top matching skills">
          {rows.length === 0 ? (
            <EmptyNote>No requirement was matched to your evidence.</EmptyNote>
          ) : (
            <ul className="divide-y divide-[#F2F3F7] dark:divide-[var(--separator)]">
              {rows.slice(0, 6).map((r) => (
                <EvidenceRow key={r.label} label={r.label} strength={r.strength} tone={r.tone} />
              ))}
            </ul>
          )}
        </WsCard>

        {/* 3 — key strengths */}
        <WsCard title="Key strengths">
          {strong.length === 0 ? (
            <EmptyNote>Nothing measurable to report for this posting.</EmptyNote>
          ) : (
            <ul>
              {strong.map((s) => (
                <BulletRow key={s}>{s}</BulletRow>
              ))}
            </ul>
          )}
        </WsCard>

        {/* 4 — role requirements */}
        <WsCard title="Role requirements">
          {required.length === 0 && preferred.length === 0 ? (
            <EmptyNote>This posting produced no extractable requirements.</EmptyNote>
          ) : (
            <div className="flex flex-col gap-3">
              {required.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-tertiary">
                    Required
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {required.slice(0, 10).map((r) => (
                      <Chip key={r.label} tone={r.evidenced ? "evidence" : "neutral"}>
                        {r.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
              {preferred.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-tertiary">
                    Nice to have
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {preferred.slice(0, 8).map((r) => (
                      <Chip key={r.label} tone={r.evidenced ? "evidence" : "neutral"}>
                        {r.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-tertiary">
                Green means your records already evidence it.
              </p>
            </div>
          )}
        </WsCard>

        {/* 5 — evidence sources */}
        <WsCard title="Evidence sources">
          {sources.length === 0 ? (
            <EmptyNote>No source carried evidence for this posting.</EmptyNote>
          ) : (
            <ul className="divide-y divide-[#F2F3F7] dark:divide-[var(--separator)]">
              {sources.map((s) => (
                <li key={s.name} className="flex items-baseline justify-between gap-2 py-[5px]">
                  <span className="truncate text-[12.5px] text-primary">{s.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-tertiary">
                    {s.count} {s.count === 1 ? "skill" : "skills"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </WsCard>
      </div>
    </div>
  );
}
