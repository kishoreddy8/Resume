import { getDb } from "@/db";
import type { StructuredJobIntel } from "@/lib/jobIntel/types";
import type { JobCertification, JobSkill } from "@/types";

function toJsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Writes a job's structured intelligence in one transaction: scalar columns on `jobs`, plus a
 * delete+reinsert of job_skills/job_certifications for that job_id — this is what makes
 * re-extraction idempotent (no duplicate rows when a JD changes) without needing per-row diffing.
 *
 * Deliberately a separate function from upsertJob() in src/db/queries/jobs.ts, never calling into
 * or modifying it — that function's tested, load-bearing dedupe/lifecycle-preserving behavior is
 * untouched. Only the new structured-intel columns/tables are ever written here, so
 * pipeline_status/notes/tags/pinned/application history/H1B fields/generated-file associations are
 * never touched by re-extraction — there's nothing to special-case to "preserve" them.
 */
export function upsertJobIntel(jobId: number, intel: StructuredJobIntel): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE jobs SET
        seniority = @seniority,
        seniority_evidence = @seniorityEvidence,
        employment_type_normalized = @employmentTypeNormalized,
        workplace_type_normalized = @workplaceTypeNormalized,
        workplace_office_days = @workplaceOfficeDays,
        location_city = @locationCity,
        location_state = @locationState,
        location_country = @locationCountry,
        location_list_json = @locationListJson,
        location_relocation = @locationRelocation,
        location_travel_pct = @locationTravelPct,
        experience_min_years = @experienceMinYears,
        experience_preferred_years = @experiencePreferredYears,
        experience_by_tech_json = @experienceByTechJson,
        experience_evidence = @experienceEvidence,
        education_level = @educationLevel,
        education_field = @educationField,
        education_requirement = @educationRequirement,
        education_equivalent_experience_allowed = @educationEquivalentExperienceAllowed,
        education_evidence = @educationEvidence,
        salary_min = @salaryMin,
        salary_max = @salaryMax,
        salary_currency = @salaryCurrency,
        salary_period = @salaryPeriod,
        salary_bonus = @salaryBonus,
        salary_commission = @salaryCommission,
        salary_equity = @salaryEquity,
        clearance_required = @clearanceRequired,
        clearance_level = @clearanceLevel,
        citizenship_required = @citizenshipRequired,
        work_authorization_required = @workAuthorizationRequired,
        clearance_evidence = @clearanceEvidence,
        industry_domain = @industryDomain,
        industry_domain_evidence = @industryDomainEvidence,
        job_quality_flags = @jobQualityFlags,
        structured_extraction_version = @structuredExtractionVersion,
        structured_extracted_at = datetime('now')
      WHERE id = @jobId`
    ).run({
      jobId,
      seniority: intel.seniority.level === "Unknown" ? null : intel.seniority.level,
      seniorityEvidence: intel.seniority.evidence,
      employmentTypeNormalized: intel.employmentType.type === "Unknown" ? null : intel.employmentType.type,
      workplaceTypeNormalized: intel.location.workplaceType === "Unknown" ? null : intel.location.workplaceType,
      workplaceOfficeDays: intel.location.officeDays,
      locationCity: intel.location.primary.city,
      locationState: intel.location.primary.state,
      locationCountry: intel.location.primary.country,
      locationListJson: toJsonOrNull(intel.location.locations.length > 0 ? intel.location.locations : null),
      locationRelocation: intel.location.relocation,
      locationTravelPct: intel.location.travelPct,
      experienceMinYears: intel.experience.minYears,
      experiencePreferredYears: intel.experience.preferredYears,
      experienceByTechJson: toJsonOrNull(intel.experience.byTech.length > 0 ? intel.experience.byTech : null),
      experienceEvidence: intel.experience.evidence,
      educationLevel: intel.education.level,
      educationField: intel.education.field,
      educationRequirement: intel.education.requirement,
      educationEquivalentExperienceAllowed: intel.education.equivalentExperienceAllowed ? 1 : 0,
      educationEvidence: intel.education.evidence,
      salaryMin: intel.compensation.min,
      salaryMax: intel.compensation.max,
      salaryCurrency: intel.compensation.currency,
      salaryPeriod: intel.compensation.period,
      salaryBonus: intel.compensation.bonus,
      salaryCommission: intel.compensation.commission,
      salaryEquity: intel.compensation.equity,
      clearanceRequired: intel.clearance.required,
      clearanceLevel: intel.clearance.level,
      citizenshipRequired: intel.clearance.citizenshipRequired,
      workAuthorizationRequired: intel.clearance.workAuthorizationRequired,
      clearanceEvidence: intel.clearance.evidence,
      industryDomain: intel.domain.domain,
      industryDomainEvidence: intel.domain.evidence,
      jobQualityFlags: toJsonOrNull(intel.qualityFlags.length > 0 ? intel.qualityFlags : null),
      structuredExtractionVersion: intel.extractionVersion,
    });

    db.prepare("DELETE FROM job_skills WHERE job_id = ?").run(jobId);
    const insertSkill = db.prepare(
      `INSERT INTO job_skills (job_id, skill_name, category, requirement_level, alternative_group_id, evidence_snippet)
       VALUES (@jobId, @skillName, @category, @requirementLevel, @alternativeGroupId, @evidenceSnippet)`
    );
    for (const skill of intel.skills) {
      insertSkill.run({
        jobId,
        skillName: skill.skillName,
        category: skill.category,
        requirementLevel: skill.requirementLevel,
        alternativeGroupId: skill.alternativeGroupId,
        evidenceSnippet: skill.evidenceSnippet,
      });
    }

    db.prepare("DELETE FROM job_certifications WHERE job_id = ?").run(jobId);
    const insertCert = db.prepare(
      `INSERT INTO job_certifications (job_id, name, requirement_level, evidence_snippet)
       VALUES (@jobId, @name, @requirementLevel, @evidenceSnippet)`
    );
    for (const cert of intel.certifications) {
      insertCert.run({
        jobId,
        name: cert.name,
        requirementLevel: cert.requirementLevel,
        evidenceSnippet: cert.evidenceSnippet,
      });
    }
  });
  run();
}

export function getJobSkills(jobId: number): JobSkill[] {
  return getDb()
    .prepare("SELECT * FROM job_skills WHERE job_id = ? ORDER BY category, skill_name")
    .all(jobId) as JobSkill[];
}

export function getJobCertifications(jobId: number): JobCertification[] {
  return getDb()
    .prepare("SELECT * FROM job_certifications WHERE job_id = ? ORDER BY name")
    .all(jobId) as JobCertification[];
}
