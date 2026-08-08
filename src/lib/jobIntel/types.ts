import type {
  EmploymentTypeNormalized,
  RequirementLevel,
  RequirementTriState,
  Seniority,
  SkillCategory,
  WorkplaceTypeNormalized,
} from "@/types";

/**
 * Working types for the extraction pipeline itself — distinct from the persisted DB-row shapes in
 * src/types/index.ts (which src/db/queries/jobIntel.ts's upsertJobIntel maps these onto).
 */

export interface SkillMatch {
  skillName: string;
  category: SkillCategory;
  requirementLevel: RequirementLevel;
  /** Shared across every skill in an "AWS or Azure"-style alternative; null if not alternated. */
  alternativeGroupId: string | null;
  evidenceSnippet: string | null;
}

export interface CertificationMatch {
  name: string;
  requirementLevel: RequirementLevel;
  evidenceSnippet: string | null;
}

export interface ExperienceByTech {
  technology: string;
  years: number;
}

export interface ExtractedExperience {
  minYears: number | null;
  preferredYears: number | null;
  byTech: ExperienceByTech[];
  evidence: string | null;
}

export interface ExtractedEducation {
  level: string | null;
  field: string | null;
  requirement: RequirementLevel | "Unknown";
  equivalentExperienceAllowed: boolean;
  evidence: string | null;
}

export interface LocationEntry {
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface ExtractedLocation {
  workplaceType: WorkplaceTypeNormalized;
  officeDays: string | null;
  primary: LocationEntry;
  locations: LocationEntry[];
  relocation: string | null;
  travelPct: string | null;
}

export interface ExtractedEmploymentType {
  type: EmploymentTypeNormalized;
  evidence: string | null;
}

export interface ExtractedCompensation {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "annual" | "hourly" | null;
  bonus: string | null;
  commission: string | null;
  equity: string | null;
}

export interface ExtractedClearance {
  required: RequirementTriState;
  level: string | null;
  citizenshipRequired: RequirementTriState;
  workAuthorizationRequired: RequirementTriState;
  evidence: string | null;
}

export interface ExtractedSeniority {
  level: Seniority;
  evidence: string | null;
}

export interface ExtractedDomain {
  domain: string | null;
  evidence: string | null;
}

export interface ExtractedSections {
  responsibilities: string | null;
  requiredQualifications: string | null;
  preferredQualifications: string | null;
  benefits: string | null;
}

export interface StructuredJobIntel {
  seniority: ExtractedSeniority;
  employmentType: ExtractedEmploymentType;
  location: ExtractedLocation;
  experience: ExtractedExperience;
  education: ExtractedEducation;
  compensation: ExtractedCompensation;
  clearance: ExtractedClearance;
  domain: ExtractedDomain;
  qualityFlags: string[];
  skills: SkillMatch[];
  certifications: CertificationMatch[];
  sections: ExtractedSections;
  extractionVersion: number;
}

/** Everything extractJobIntel needs, pulled from an already-scanned job row — no re-fetching, no
 *  re-scanning the ATS. Sponsorship fields are passed through from the already-computed
 *  scanSponsorshipLanguage() result (src/lib/h1b/keywordScan.ts) rather than recomputed here. */
export interface JobIntelInput {
  title: string;
  descriptionText: string | null;
  descriptionHtml: string | null;
  /** job.employment_type — ATS-native or connector-level regex fallback; tier-1 input. */
  employmentTypeNative: string | null;
  /** job.workplace_type — ATS-native; tier-1 input. */
  workplaceTypeNative: string | null;
  /** job.location — ATS-native free text (e.g. "Austin, TX", "Multiple Locations", "Remote"). */
  locationNative: string | null;
  /** job.salary_text — already extracted raw substring (src/lib/extractSalary.ts); parsed further
   *  here, never re-scanned from scratch. */
  salaryTextNative: string | null;
  sponsorshipPolarity: "positive" | "negative" | "none";
  sponsorshipSnippet: string | null;
}
