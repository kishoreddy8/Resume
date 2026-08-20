import type { JobMatchResult, RequirementMatch } from "@/lib/match/types";
import type { CandidateProfile } from "@/lib/match/types";
import { buildEmployerEvidenceMap } from "@/lib/resumeQuality/employerEvidence";

/**
 * The Tailoring Intelligence plan: why this resume is being tailored the way it will be.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS MODULE COMPUTES NO EVIDENCE. It reads.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Every evidence judgement here comes from the persisted JobMatchResult — the deterministic Phase 2
 * engine's own output, already stored and already the thing the rest of the UI trusts. There is
 * deliberately a SINGLE source of evidence truth: a second evaluator re-deriving strength from the
 * candidate profile could disagree with the first, and then the plan would tell the user one thing
 * while the decision that gates tailoring said another. The one and only thing this file derives is
 * arithmetic over that output — counting how many of THIS job's evidenced requirements each
 * employer already supports. Counting is not scoring, and it invents no relevance.
 *
 * WHAT IT IS NOT. It is not a second matching engine, not an AI call, and not an authority. The
 * plan is guidance handed to the existing tailoring engine and resume writer, which decide the
 * final wording, and to the existing deterministic validators, which decide whether the result may
 * be delivered at all. If this plan and a validator ever disagree, the validator wins — that
 * ordering is the whole point of having validators.
 *
 * NO FABRICATION IS POSSIBLE FROM HERE. The plan cannot introduce an employer, skill, year, project
 * or certification, because it only ever names things already present in the match result or the
 * validated candidate profile. Its "do not claim" list exists precisely to push the writer AWAY
 * from unsupported ground.
 */

/**
 * The evidence vocabulary, fixed to the states the deterministic engine actually distinguishes.
 *
 * Deliberately absent: "missing skill", "weak candidate", "low probability", "not qualified". The
 * engine publishes none of those judgements, and a UI that invents them turns an absence of data
 * into a verdict about a person.
 */
export type EvidenceState =
  /** Attributed to a named employer in the candidate's own resume. */
  | "STRONG"
  /** Transferable from adjacent evidence — the engine says so, with a reason. */
  | "PARTIAL"
  /** Present in the Skills Inventory but attributed to no employer. */
  | "MENTIONED"
  /** The engine looked and found nothing. */
  | "NONE"
  /** The engine could not resolve this requirement either way. */
  | "UNKNOWN";

export const EVIDENCE_STATE_LABEL: Record<EvidenceState, string> = {
  STRONG: "Strong evidence",
  PARTIAL: "Partial evidence",
  MENTIONED: "Mentioned",
  NONE: "No evidence found",
  UNKNOWN: "Unknown",
};

export interface PlanRequirement {
  label: string;
  state: EvidenceState;
  requirementLevel: "Required" | "Preferred";
  criticality: string;
  /** Where the evidence comes from. Empty unless the engine recorded a source. */
  employers: string[];
  yearsStated: number | null;
  /** The engine's own words for a transferable match. Never paraphrased. */
  transferableReason: string | null;
  /** True when the only evidence is inventory-level, with no employer behind it. */
  inventoryOnly: boolean;
  /**
   * Where this evidence comes from, named. Both candidate documents are first-class sources: the
   * Master Skills Inventory is a declaration of technologies genuinely worked with, not a keyword
   * list, so a requirement it covers says "Master Skills Inventory" rather than being reported as
   * a thinner kind of evidence.
   */
  sources: string[];
}

export interface EmployerEmphasis {
  employer: string;
  title: string;
  /** Requirements of THIS job this role can support — written here OR available under the MSI rule. */
  overlapping: string[];
  /** The subset already written under this employer in the Master Resume. */
  alreadyWritten: string[];
  /** The subset usable here because the Master Skills Inventory declares them without restriction. */
  viaMsi: string[];
  /** Technologies the MSI explicitly limits to other clients — the only real mis-attribution risk. */
  prohibitedHere: string[];
}

export interface TailoringPlan {
  candidateId: number;
  jobId: number;
  /** Mirrors the engine's decision. The plan never overrides or reinterprets it. */
  decision: JobMatchResult["decision"];
  /** True when the engine flagged the posting as too thin to score — the UI must say so. */
  insufficientJdSignal: boolean;

  requirements: PlanRequirement[];

  /** What the writer should lead with: requirements this candidate can genuinely evidence. */
  emphasize: PlanRequirement[];
  /** What must not be claimed: requirements with no evidence behind them. */
  doNotClaim: PlanRequirement[];

  /** Employers ordered by how much of THIS job they actually evidence. Ties keep profile order. */
  employerEmphasis: EmployerEmphasis[];

  /** Resume sections the emphasis above would touch. Named, not guessed at a count. */
  sectionsAffected: string[];

  /** Skills with no employer attribution anywhere — listable, never presentable as work performed. */
  inventoryOnlyCount: number;
}

const LEVEL: Record<string, "Required" | "Preferred"> = { Required: "Required", Preferred: "Preferred" };

function toPlanRequirement(match: RequirementMatch, state: EvidenceState): PlanRequirement {
  const employers = match.evidence?.employers ?? [];
  const inventoryOnly = match.evidence?.source === "inventory_only";

  /* Named sources, never a count. An empty list means the engine recorded no source, which is
   * itself the honest answer for a missing or unresolved requirement. */
  const sources: string[] = [];
  if (employers.length > 0) sources.push(`Master Resume — ${employers.join(", ")}`);
  if (inventoryOnly || match.evidence?.rawSkillName) sources.push("Master Skills Inventory");
  if (match.transferable) {
    sources.push(`Transferable from ${match.transferable.fromRawSkillName}`);
  }

  return {
    sources: [...new Set(sources)],
    label: match.requirement.label,
    state,
    requirementLevel: LEVEL[match.requirement.requirementLevel] ?? "Required",
    criticality: match.requirement.criticality,
    employers,
    yearsStated: typeof match.evidence?.yearsStated === "number" ? match.evidence.yearsStated : null,
    transferableReason: match.transferable?.reason ?? null,
    inventoryOnly,
  };
}

/**
 * Assemble the plan.
 *
 * `profile` may be absent — a job can be evaluated before a candidate profile exists. The plan then
 * carries requirements and evidence but no employer emphasis, because employer emphasis has no
 * honest basis without the profile. It is omitted rather than approximated.
 */
export function buildTailoringPlan(
  result: JobMatchResult,
  profile: CandidateProfile | null
): TailoringPlan {
  const requirements: PlanRequirement[] = [
    ...result.employerEvidencedMatches.map((m) => toPlanRequirement(m, "STRONG")),
    ...result.inventoryOnlyMatches.map((m) => toPlanRequirement(m, "MENTIONED")),
    ...result.transferableMatches.map((m) => toPlanRequirement(m, "PARTIAL")),
    ...result.missingRequirements.map((m) => toPlanRequirement(m, "NONE")),
    ...result.unresolvedRequirements.map((m) => toPlanRequirement(m, "UNKNOWN")),
  ];

  /* Emphasis is evidence-led, then criticality-led. Required before Preferred, because a Preferred
   * requirement the candidate happens to be strong on must never outrank a Required one. */
  const stateRank: Record<EvidenceState, number> = { STRONG: 0, PARTIAL: 1, MENTIONED: 2, NONE: 3, UNKNOWN: 4 };
  const emphasize = requirements
    .filter((r) => r.state === "STRONG" || r.state === "PARTIAL" || r.state === "MENTIONED")
    .sort(
      (a, b) =>
        (a.requirementLevel === b.requirementLevel ? 0 : a.requirementLevel === "Required" ? -1 : 1) ||
        stateRank[a.state] - stateRank[b.state] ||
        a.label.localeCompare(b.label)
    );

  const doNotClaim = requirements
    .filter((r) => r.state === "NONE" || r.state === "UNKNOWN")
    .sort((a, b) => (a.requirementLevel === b.requirementLevel ? 0 : a.requirementLevel === "Required" ? -1 : 1));

  /* Employer emphasis: real overlap between what this job asks for and what each employer's own
   * evidence supports. Case-insensitive matching against the employer's supported technologies,
   * because requirement labels and profile skill names are both free text from different documents. */
  let employerEmphasis: EmployerEmphasis[] = [];
  let inventoryOnlyCount = 0;

  if (profile) {
    const map = buildEmployerEvidenceMap(profile);
    inventoryOnlyCount = map.inventoryOnlyCount;

    /* MENTIONED is included deliberately. It means the Master Skills Inventory declares the skill
     * with no employer attribution — and the inventory is a statement of technologies genuinely
     * worked with, not a keyword list. Excluding it made MSI-only evidence count for nothing when
     * choosing which roles to emphasise, which is the interpretation the MSI contract replaces. */
    const evidencedLabels = requirements.filter(
      (r) => r.state === "STRONG" || r.state === "PARTIAL" || r.state === "MENTIONED"
    );

    employerEmphasis = map.employers
      .map((e) => {
        const written = new Set(e.supported.map((s) => s.trim().toLowerCase()));
        const msi = new Set(e.availableViaMsi.map((s) => s.trim().toLowerCase()));
        const here = e.employer.trim().toLowerCase();

        const alreadyWritten: string[] = [];
        const viaMsi: string[] = [];

        for (const r of evidencedLabels) {
          const label = r.label.trim().toLowerCase();
          if (r.employers.some((emp) => emp.trim().toLowerCase() === here) || written.has(label)) {
            alreadyWritten.push(r.label);
          } else if (msi.has(label)) {
            /* The Master Skills Inventory is candidate-declared evidence, so a requirement it
             * covers is genuinely supportable at this client even though the compressed Master
             * Resume does not happen to show it here. Counting only what is already written
             * understated every role and would have ranked the emphasis wrongly. */
            viaMsi.push(r.label);
          }
        }

        const dedupe = (xs: string[]) => [...new Set(xs)];
        return {
          employer: e.employer,
          title: e.title,
          overlapping: dedupe([...alreadyWritten, ...viaMsi]),
          alreadyWritten: dedupe(alreadyWritten),
          viaMsi: dedupe(viaMsi),
          prohibitedHere: e.prohibitedHere,
        };
      })
      /* Written evidence ranks first, then total supportable.
       *
       * Ordering on the total alone let a role with NO written evidence outrank one with plenty,
       * purely because the inventory is global and therefore available everywhere. Observed on real
       * data: an electrical-machines manufacturing traineeship surfaced seven "available" cloud
       * data-engineering requirements and zero written ones. The MSI contract genuinely permits
       * using declared skills at a listed client, but only where it is technically plausible — a
       * judgement nothing here can compute. Sorting on what is actually written keeps the
       * recommendation grounded in evidence the resume already carries, and leaves the plausibility
       * call where the canonical rule puts it: with the writer, under conditions it must satisfy.
       *
       * A stable sort keeps the profile's own order for equal counts, so the ranking never appears
       * to encode a judgement it does not have. */
      .sort((a, b) => b.alreadyWritten.length - a.alreadyWritten.length || b.overlapping.length - a.overlapping.length);
  }

  /* Named from what the emphasis would actually touch, never a fabricated count of "changes". */
  const sectionsAffected: string[] = [];
  if (emphasize.length > 0) {
    sectionsAffected.push("Professional Summary", "Technical Skills");
    for (const e of employerEmphasis) {
      if (e.overlapping.length > 0) sectionsAffected.push(`${e.employer} bullets`);
    }
  }

  return {
    candidateId: result.candidateId,
    jobId: result.jobId,
    decision: result.decision,
    insufficientJdSignal: result.insufficientJdSignal,
    requirements,
    emphasize,
    doNotClaim,
    employerEmphasis,
    sectionsAffected,
    inventoryOnlyCount,
  };
}
