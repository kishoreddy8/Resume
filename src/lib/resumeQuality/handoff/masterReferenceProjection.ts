import type { CandidateProfile } from "@/lib/match/types";
import type { RepairPlan } from "../repairScope";

/**
 * TARGETED_REPAIR MASTER-REFERENCE SCOPING (2026-08-23)
 *
 * WHY THIS EXISTS. master_resume_reference.json is the single largest file the writer reads during
 * TARGETED_REPAIR: 25-51 KB, of which the `skills` array (per-skill attribution data for 165-535
 * skills) accounts for 79-86%. That same per-employer evidence is ALREADY rendered into the writer
 * prompt inline by renderEmployerEvidenceSection (employerEvidence.ts) — the writer receives
 * "Already written", "Available under MSI rule", and "EXPLICITLY SCOPED TO OTHER CLIENTS" for every
 * touched employer, and is explicitly forbidden from re-tailoring frozen content during repair.
 *
 * WHAT THIS MODULE DOES. Builds a compact writer-facing projection of CandidateProfile: for
 * TARGETED_REPAIR, omitting the giant `skills` array and reducing untouched employer records to
 * identity stubs (buildRepairScopedMasterReference); for INITIAL_GENERATION (2026-08-23 addition,
 * see buildInitialGenerationMasterReference below), omitting `skills` unconditionally, since
 * INITIAL_GENERATION's own employer-evidence section is never scoped and always covers every
 * employer's technologies in full regardless.
 *
 * WHAT THIS MODULE DOES NOT CHANGE. The projection is writer-facing context only. The deterministic
 * reviewer (deterministicReviewer.ts), repairPreservation.ts, and every validation gate continue to
 * receive and validate against the FULL authoritative CandidateProfile. Nothing here alters what
 * CareerOps knows or verifies; it only changes what the writer has to read.
 *
 * SOURCE IMMUTABILITY. The input CandidateProfile is NEVER mutated. Every returned object is a fresh
 * projection built from copied values.
 */

/** The compact projection shape. Uses the same field names as CandidateProfile where fields are
 *  preserved, so the writer prompt's references to master_resume_reference.json fields remain valid.
 *  The `skills` array is absent entirely. Untouched employers carry a `preservation` marker instead
 *  of `technologies`. */
export interface RepairScopedMasterReference {
  schemaVersion: number;
  experience: RepairScopedExperienceEntry[];
  education: CandidateProfile["education"];
  certifications: CandidateProfile["certifications"];
  totalYearsExperience: number | null;
}

/** A touched employer retains all fields the writer needs for truthful repair. An untouched employer
 *  keeps only hard-fact identity fields plus a preservation marker so the writer sees the complete
 *  career timeline without the full technology dump. */
export type RepairScopedExperienceEntry =
  | {
      employer: string;
      title: string;
      startDate: string | null;
      endDate: string | null;
      technologies: string[];
    }
  | {
      employer: string;
      title: string;
      startDate: string | null;
      endDate: string | null;
      preservation: "UNCHANGED";
    };

/**
 * Returns true when the repair plan is undefined, lacks editable paths, or contains unattributed
 * findings that prevent determining a safe repair scope. Conservative: ambiguity fails toward broader context.
 * Global sections (summary, tagline, skillGroups, education, certifications) are now safely handled by
 * compact projections (omitting the giant raw skills array) rather than falling back to the 51KB raw profile.
 */
export function shouldUseFullMasterReferenceForRepair(repairPlan: RepairPlan | undefined): boolean {
  if (!repairPlan) return true;
  if (!repairPlan.editablePaths || repairPlan.editablePaths.length === 0) return true;
  if (repairPlan.unattributedFindings && repairPlan.unattributedFindings.length > 0) return true;

  return false;
}

/**
 * Builds a compact, writer-facing projection of CandidateProfile for TARGETED_REPAIR.
 *
 * - Omits the `skills` array entirely (already rendered inline by employer evidence section)
 * - Omits `sourceHashes` and `builtAt` (bookkeeping, not writer-relevant)
 * - Retains hard-fact identity for ALL employers (employer, title, dates)
 * - Retains `technologies` only for touched employers
 * - Retains `education`, `certifications`, `totalYearsExperience`
 *
 * NEVER mutates the input profile.
 */
export function buildRepairScopedMasterReference(
  profile: CandidateProfile,
  touchedEmployers: ReadonlySet<string>,
): RepairScopedMasterReference {
  return {
    schemaVersion: profile.schemaVersion,
    experience: profile.experience.map((entry) => {
      if (touchedEmployers.has(entry.employer)) {
        return {
          employer: entry.employer,
          title: entry.title,
          startDate: entry.startDate,
          endDate: entry.endDate,
          technologies: [...entry.technologies],
        };
      }
      return {
        employer: entry.employer,
        title: entry.title,
        startDate: entry.startDate,
        endDate: entry.endDate,
        preservation: "UNCHANGED" as const,
      };
    }),
    education: profile.education.map((e) => ({ ...e })),
    certifications: profile.certifications.map((c) => ({ ...c })),
    totalYearsExperience: profile.totalYearsExperience,
  };
}

/**
 * INITIAL_GENERATION MASTER-REFERENCE PROJECTION (2026-08-23) — same rationale as the repair-scoped
 * projection above, applied to INITIAL_GENERATION, which previously always received the full profile
 * unconditionally.
 *
 * WHY THIS IS SAFE WITHOUT A FALLBACK CONDITION, UNLIKE THE REPAIR VERSION ABOVE. The repair-scoped
 * projection needs shouldUseFullMasterReferenceForRepair because a repair's employer-evidence section
 * is SCOPED to only the touched employers (repairEmployerScope can be a narrow set) — so a repair
 * touching a global section needs the full profile as a safety net. INITIAL_GENERATION's own
 * employer-evidence section is NEVER scoped: exportExternalWriterPackage computes
 * `repairEmployerScope = isTargetedRepair ? employerScopeForRepair(...) : null`, and `null` means "no
 * filter" — filterEmployerEvidenceMap returns every employer's full supported/availableViaMsi/
 * prohibitedHere breakdown unconditionally whenever a master profile exists at all. That is exactly
 * the same condition under which master_resume_reference.json itself gets written
 * (`writerInput.masterProfile` truthy), so there is no scenario where this projection's omissions
 * (`skills`, and each experience entry's own `technologies`) are not ALREADY fully covered elsewhere
 * in the same handoff package. No ambiguity dimension exists for this case, so no fallback is needed.
 *
 * WHAT IS OMITTED AND WHY IT IS PROVABLY REDUNDANT, NOT MERELY SMALLER:
 *   - `skills` (the ~79-86% giant array): every entry is either attributed to a real employer, in
 *     which case buildEmployerEvidenceMap folds it into that employer's `supported` (if the role's
 *     own `technologies` names it) or the MSI-derived `availableViaMsi`/`prohibitedHere` buckets — or
 *     it carries no attribution at all, in which case `evidenceForEmployer`'s MSI classification is
 *     the SAME logic that already decides which employers' `availableViaMsi` lists include it. There
 *     is no skill whose only writer-visible representation was the raw `skills` array.
 *   - each experience entry's own `technologies`: this is literally the same array
 *     buildEmployerEvidenceMap reads to build that employer's `supported` list (see
 *     buildEmployerEvidenceMap's own `for (const tech of entry.technologies)` loop) — an exact,
 *     byte-for-byte duplicate of PER-EMPLOYER EVIDENCE's "Already written here" line for that
 *     employer, not an approximation of it.
 *   - `schemaVersion`, `sourceHashes`, `builtAt`: bookkeeping/provenance metadata with no bearing on
 *     what the writer should write.
 *
 * WHAT IS RETAINED AND WHY: `employer`/`title`/`startDate`/`endDate` for every role (the writer's ONLY
 * source for the literal date strings it must reproduce — PER-EMPLOYER EVIDENCE never renders dates),
 * `education`, `certifications` (never rendered as full text anywhere else in the prompt), and
 * `totalYearsExperience` (the professional-identity section states it in prose when available, but
 * the raw value stays here too as a zero-cost safety net for the rare case that section is absent).
 *
 * NEVER mutates the input profile.
 */
export function buildInitialGenerationMasterReference(profile: CandidateProfile): RepairScopedMasterReference {
  return {
    schemaVersion: profile.schemaVersion,
    experience: profile.experience.map((entry) => ({
      employer: entry.employer,
      title: entry.title,
      startDate: entry.startDate,
      endDate: entry.endDate,
      preservation: "UNCHANGED" as const,
    })),
    education: profile.education.map((e) => ({ ...e })),
    certifications: profile.certifications.map((c) => ({ ...c })),
    totalYearsExperience: profile.totalYearsExperience,
  };
}
