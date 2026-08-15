import { getJobCertifications, getJobSkills } from "@/db/queries/jobIntel";
import type { DescriptionSections, JobWithCompany } from "@/types";
import type { EvaluateJobMatchInput } from "./evaluateJobMatch";

/**
 * The existing job-requirement loading pipeline every evaluateJobMatch() caller uses to turn a
 * JobWithCompany row into its input shape — extracted (Phase 4 Stage 2) from what was previously
 * duplicated verbatim between src/app/api/jobs/[id]/match/route.ts and
 * src/app/api/jobs/match/batch/route.ts, so a third caller (src/lib/match/incrementalMatch.ts)
 * reuses it instead of copy-pasting a third time. Pure mapping only — no behavior change from the
 * pre-extraction versions; both existing routes now import this instead of defining it locally.
 */

export function parseDescriptionSections(json: string | null): DescriptionSections | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as DescriptionSections) : null;
  } catch {
    return null;
  }
}

export function buildEvaluateJobMatchInput(job: JobWithCompany): EvaluateJobMatchInput {
  return {
    jobId: job.id,
    dedupeKey: job.dedupe_key,
    jobTitle: job.title,
    descriptionText: job.description_text,
    descriptionSections: parseDescriptionSections(job.description_sections),
    skills: getJobSkills(job.id),
    certifications: getJobCertifications(job.id),
    education: {
      level: job.education_level,
      field: job.education_field,
      requirement: job.education_requirement,
      equivalentExperienceAllowed: job.education_equivalent_experience_allowed === 1,
      evidence: job.education_evidence,
    },
    sponsorshipPolarity: job.sponsorship_polarity,
    companyH1bConfidence: job.company_h1b_confidence,
    clearanceRequired: job.clearance_required,
    clearanceLevel: job.clearance_level,
    citizenshipRequired: job.citizenship_required,
    workAuthorizationRequired: job.work_authorization_required,
    jobSeniority: job.seniority ?? "Unknown",
    experienceMinYears: job.experience_min_years,
  };
}
