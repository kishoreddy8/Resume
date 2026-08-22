import type { JobMatchResult, RequirementMatch } from "@/lib/match/types";
import type { CandidateProfile } from "@/lib/match/types";
import { buildEmployerEvidenceMap } from "@/lib/resumeQuality/employerEvidence";
import { classifyForEmployer } from "@/lib/resumeQuality/msiEvidence";

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
  /** True when the JD's own evidence text for this requirement carried an explicit hands-on/
   *  production-experience cue (handsOnCues.ts) OR an explicit technology-specific years figure
   *  (technologyDuration.ts, requestedYears below) — either is independently sufficient. Used below
   *  as the honest signal for "this requirement asks for real depth", never as a substitute for an
   *  actual years claim. */
  depthRequested: boolean;
  /** The JD's own explicitly-stated technology-specific years figure (e.g. "4+ years Databricks" ->
   *  4), or null when none is stated. TARGET evidence only — what the JD asked for, never a claim
   *  about what the candidate has. Distinct from `yearsStated` above, which is candidate-side. */
  requestedYears: number | null;
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
  /** False when this role is outside the candidate's technical domain, so the inventory does not
   *  reach it. Its emphasis then rests solely on what is already written under it. */
  inventoryReachesRole: boolean;
}

/**
 * Where one technology may actually be used, employer by employer.
 *
 * The UI must never imply an inventory skill was written under a client when it was not, and it
 * must never leave "why not here" unexplained. Both halves are stated explicitly.
 */
export interface MsiEligibility {
  technology: string;
  /** Employers where it is already written in the Master Resume. */
  writtenAt: string[];
  /** Employers where the inventory makes it usable, though it is not written there. */
  eligibleViaMsi: string[];
  /** Employers where it may NOT be used, each with the deterministic reason. */
  excluded: { employer: string; reason: string }[];
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

  /**
   * Per-technology, per-employer eligibility for the requirements this candidate can evidence.
   * Empty when no profile is loaded — eligibility has no honest basis without one.
   */
  msiEligibility: MsiEligibility[];

  /**
   * Guidance for JD requirements that ask for genuine depth and that this candidate can genuinely
   * evidence across more than one compatible employer. Empty whenever there is no profile, no
   * depth-requested requirement, or no requirement with more than one compatible employer — never
   * padded to appear non-empty.
   */
  distributedEvidence: DistributedEvidenceGuidance[];
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
    depthRequested: match.requirement.experienceDepthRequired === true,
    requestedYears: match.requirement.requestedYears,
  };
}

/**
 * Guidance for distributing a genuinely depth-requested, genuinely evidenced technology across more
 * than one compatible employer — never a mandate, and never evidence of its own. Every employer named
 * here already passed `classifyForEmployer`'s role-compatibility gate (via the `msiEligibility` this
 * plan already computes) before it can appear.
 */
export interface DistributedEvidenceGuidance {
  technology: string;
  /** Always true for entries in this list — kept explicit so a render function never needs to
   *  re-derive why a technology was selected. */
  depthRequested: boolean;
  /** The JD's own explicitly-stated technology-specific years figure, when it stated one (e.g. "4+
   *  years Databricks" -> 4) — null when the depth signal was qualitative (a hands-on/production-
   *  experience cue) rather than numeric. TARGET evidence only, never a candidate-years claim. */
  requestedYears: number | null;
  /** Every employer where this technology is genuinely usable: already written, or eligible under
   *  the MSI rule at a role the compatibility check accepts. The full set — never trimmed here. */
  compatibleEmployers: string[];
  /** A conservative subset of `compatibleEmployers` (at most 3, most-recent-first — profile order)
   *  worth considering for distribution. Still just a suggestion: the writer must still satisfy
   *  cross-employer differentiation, bullet caps, and every other existing rule at each one. */
  suggestedEmployers: string[];
}

const MAX_DISTRIBUTED_EVIDENCE_TECHNOLOGIES = 4;
const MAX_SUGGESTED_EMPLOYERS_PER_TECHNOLOGY = 3;

/**
 * Built from `requirements` + `msiEligibility` only — both already computed above from the same
 * persisted match result and validated profile. This function invents nothing: a technology only
 * appears here if it is already evidenced (STRONG/PARTIAL/MENTIONED) and the JD already asked for
 * real depth (`depthRequested`), and every employer named for it already cleared the existing
 * `classifyForEmployer` compatibility gate. Capped to the highest-criticality requirements so
 * multiple depth-requested skills never all compete for the same bullet budget at once.
 */
function buildDistributedEvidence(requirements: PlanRequirement[], msiEligibility: MsiEligibility[]): DistributedEvidenceGuidance[] {
  const eligibilityByTech = new Map(msiEligibility.map((e) => [e.technology.trim().toLowerCase(), e]));
  const criticalityRank: Record<string, number> = { CRITICAL: 0, REQUIRED: 1, PREFERRED: 2, OPTIONAL: 3 };

  const candidates = requirements
    .filter((r) => r.depthRequested && (r.state === "STRONG" || r.state === "PARTIAL" || r.state === "MENTIONED"))
    .map((r) => {
      const eligibility = eligibilityByTech.get(r.label.trim().toLowerCase());
      if (!eligibility) return null;
      const compatibleEmployers = [...new Set([...eligibility.writtenAt, ...eligibility.eligibleViaMsi])];
      if (compatibleEmployers.length < 2) return null; // nothing to "distribute" with only one home
      return {
        technology: r.label,
        depthRequested: true,
        requestedYears: r.requestedYears,
        compatibleEmployers,
        suggestedEmployers: compatibleEmployers.slice(0, MAX_SUGGESTED_EMPLOYERS_PER_TECHNOLOGY),
        criticality: r.criticality,
      };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null)
    .sort((a, b) => (criticalityRank[a.criticality] ?? 4) - (criticalityRank[b.criticality] ?? 4))
    .slice(0, MAX_DISTRIBUTED_EVIDENCE_TECHNOLOGIES);

  return candidates.map(({ technology, depthRequested, requestedYears, compatibleEmployers, suggestedEmployers }) => ({
    technology,
    depthRequested,
    requestedYears,
    compatibleEmployers,
    suggestedEmployers,
  }));
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
          inventoryReachesRole: e.inventoryReachesRole,
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

  /* Built only for requirements the candidate can actually evidence: an unsupported technology has
   * no eligibility question to answer, and listing one would suggest it were a candidate for use. */
  const msiEligibility: MsiEligibility[] = [];
  if (profile) {
    for (const r of requirements) {
      if (r.state !== "STRONG" && r.state !== "PARTIAL" && r.state !== "MENTIONED") continue;

      const writtenAt: string[] = [];
      const eligibleViaMsi: string[] = [];
      const excluded: { employer: string; reason: string }[] = [];

      for (const role of profile.experience) {
        switch (classifyForEmployer(profile, r.label, role.employer)) {
          case "EXPLICIT_RESUME_EVIDENCE":
            writtenAt.push(role.employer);
            break;
          case "MSI_EVIDENCE":
            eligibleViaMsi.push(role.employer);
            break;
          case "CLIENT_SCOPED_ELSEWHERE":
            excluded.push({ employer: role.employer, reason: "Skills Inventory scopes this to other clients" });
            break;
          case "ROLE_OUT_OF_SCOPE":
            excluded.push({ employer: role.employer, reason: "role outside technical domain" });
            break;
          default:
            excluded.push({ employer: role.employer, reason: "no evidence for this role" });
            break;
        }
      }

      if (writtenAt.length > 0 || eligibleViaMsi.length > 0) {
        msiEligibility.push({ technology: r.label, writtenAt, eligibleViaMsi, excluded });
      }
    }
  }

  const distributedEvidence = buildDistributedEvidence(requirements, msiEligibility);

  return {
    msiEligibility,
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
    distributedEvidence,
  };
}
