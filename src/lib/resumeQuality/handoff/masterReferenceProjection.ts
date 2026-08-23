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
 * WHAT THIS MODULE DOES. Builds a compact writer-facing projection of CandidateProfile for
 * TARGETED_REPAIR only, omitting the giant `skills` array and reducing untouched employer records
 * to identity stubs. INITIAL_GENERATION always receives the full profile, unchanged.
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

/** Editable-path prefixes that indicate the repair touches a global section — one whose evidence
 *  requirements cannot be determined from employer scope alone. When ANY editable path starts with
 *  one of these, the compact projection is unsafe and the full profile must be sent. */
const GLOBAL_SECTION_PATH_PREFIXES = [
  "resume.summary",
  "resume.tagline",
  "resume.skillGroups",
  "resume.education",
  "resume.certifications",
];

/**
 * Returns true when the repair plan touches a global section that may require the full skills array
 * or other broad profile context the compact projection omits. Conservative: any ambiguity returns
 * true (fail toward full context).
 */
export function shouldUseFullMasterReferenceForRepair(repairPlan: RepairPlan | undefined): boolean {
  if (!repairPlan) return true;
  if (!repairPlan.editablePaths || repairPlan.editablePaths.length === 0) return true;
  if (repairPlan.unattributedFindings && repairPlan.unattributedFindings.length > 0) return true;

  return repairPlan.editablePaths.some((path) =>
    GLOBAL_SECTION_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "[") || path.startsWith(prefix + "."))
  );
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
