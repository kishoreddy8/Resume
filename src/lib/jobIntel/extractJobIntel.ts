import { parseDescriptionSections } from "@/lib/parseSections";
import type { JobIntelInput, StructuredJobIntel } from "./types";
import { extractSkills } from "./skills";
import { extractExperience } from "./experience";
import { extractEducation } from "./education";
import { extractCertifications } from "./certifications";
import { extractSeniority, extractSeniorityFromBody } from "./seniority";
import { extractLocation } from "./location";
import { normalizeEmploymentType } from "./employmentType";
import { parseCompensation } from "./compensation";
import { extractClearance } from "./clearance";
import { extractQualitySignals } from "./qualitySignals";
import { extractDomain } from "./domain";
import { toExtractedSections } from "./sections";

/** Bumped whenever extraction logic changes in a way that should trigger re-extraction of already-
 *  processed jobs (scripts/extract-job-intel.ts can compare this against jobs.structured_extraction_version).
 *
 *  Also folded into src/lib/match/matchKnowledgeHash.ts, so bumping it invalidates every cached
 *  job_match_results row too — see that module for why extraction output is part of the match cache
 *  identity even though it never appears in jdContentHash.
 *
 *  v2 (Stage 24C): skills.ts's groupAlternatives now collapses 3+ item OR lists ("Databricks,
 *  Snowflake, or Redshift") into a single alternative group instead of splitting every item before
 *  the final "or" into an independent Required skill. Already-extracted jobs carry the old, wrong
 *  grouping in job_skills.alternative_group_id until re-extracted with `npm run extract-job-intel`.
 *
 *  v3 (Stage 25A): src/lib/parseSections.ts's SECTION_RULES fixes two section-routing defects found
 *  by auditing the real 18,065-job corpus — "Preferred Qualifications" headings were routed to the
 *  REQUIRED bucket (2,452 jobs), and "Required …" headings matched no rule at all so their content
 *  was discarded (+1,211 jobs). Both change which requirement_level a skill is stored under and
 *  whether it is stored at all, so every already-extracted job carries the old classification in
 *  job_skills until re-extracted with `npm run extract-job-intel`. */
export const EXTRACTION_VERSION = 3;

/**
 * Orchestrates every extractor over one job's already-stored data. Pure function — no DB access,
 * no network. Reuses parseDescriptionSections (src/lib/parseSections.ts) rather than re-deriving
 * section structure, and takes the sponsorship polarity/snippet as input rather than recomputing
 * scanSponsorshipLanguage (src/lib/h1b/keywordScan.ts) a second time.
 */
export function extractJobIntel(input: JobIntelInput): StructuredJobIntel {
  const sections = parseDescriptionSections(input.descriptionHtml);

  const skills = extractSkills({
    descriptionText: input.descriptionText,
    descriptionHtml: input.descriptionHtml,
    sections,
  });

  const certifications = extractCertifications(input.descriptionHtml, input.descriptionText);
  const experience = extractExperience(input.descriptionHtml, input.descriptionText);
  const education = extractEducation(input.descriptionHtml, input.descriptionText);

  let seniority = extractSeniority(input.title);
  if (seniority.level === "Unknown") {
    seniority = extractSeniorityFromBody(input.descriptionText);
  }

  const employmentType = normalizeEmploymentType(input.employmentTypeNative, input.descriptionText);
  const location = extractLocation({
    locationNative: input.locationNative,
    workplaceTypeNative: input.workplaceTypeNative,
    descriptionText: input.descriptionText,
  });
  const compensation = parseCompensation(input.salaryTextNative, input.descriptionText);
  const clearance = extractClearance(input.descriptionText);
  const domain = extractDomain(input.descriptionText);

  const qualityFlags = extractQualitySignals({
    descriptionText: input.descriptionText,
    clearanceRequired: clearance.required === "Required",
    sponsorshipPolarity: input.sponsorshipPolarity,
  });

  return {
    seniority,
    employmentType,
    location,
    experience,
    education,
    compensation,
    clearance,
    domain,
    qualityFlags,
    skills,
    certifications,
    sections: toExtractedSections(sections),
    extractionVersion: EXTRACTION_VERSION,
  };
}
