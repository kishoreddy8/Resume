/**
 * The three payloads Profile reads, as the shapes they actually arrive in.
 *
 * Kept in their own module so the page and its panels share one description of the data rather than
 * each re-declaring the fields it happens to touch. Every field here exists on the wire today; none
 * is aspirational. Where the API can return null it is typed null, because "the candidate has not
 * set this" is a state Profile renders explicitly rather than a case to fall through.
 */

export interface CandidateRecord {
  id: number;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  is_owner: number;
  has_pin: number;
}

/** Evidence built from the master resume and the skills inventory. Read-only on this page: it is
 *  derived from uploaded documents, so it is corrected by replacing a document, never by typing. */
export interface EvidenceProfile {
  builtAt: string;
  totalYearsExperience: number | null;
  skills: {
    rawSkillName: string;
    /** 'employer' means an employer in your history is attached to it; 'inventory_only' means it
     *  comes from the Master Skills Inventory alone. These are the only two values on the wire. */
    source: string;
    attributedTo?: { employer?: string }[];
  }[];
  experience: {
    employer: string;
    title: string;
    startDate: string | null;
    endDate: string | null;
    technologies?: string[];
  }[];
  education: { level?: string; field?: string; institution?: string }[];
  certifications: { name: string; issuer?: string; date?: string }[];
}

export interface ContactValues {
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
  github: string | null;
}

export interface PreferenceValues {
  primaryTargetRole: string | null;
  secondaryTargetRoles: string[];
  locationPreference: string | null;
  workplacePreference: string[];
  employmentTypePreference: string | null;
}

/** The candidate's own authorization facts. Explicitly provided, never inferred — see the panel. */
export interface WorkAuthValues {
  requiresSponsorship: boolean;
  usCitizen: boolean;
  workAuthorizedUS: boolean;
  clearanceLevel: string;
}

export interface CandidateSettingsPayload {
  matchAffecting: WorkAuthValues;
  preferences: PreferenceValues;
  contact: ContactValues;
  contactStatus?: { isComplete: boolean; problems: string[] };
}

export const WORKPLACE_OPTIONS = ["Onsite", "Hybrid", "Remote"] as const;
export const EMPLOYMENT_OPTIONS = ["Full-Time", "Part-Time", "Contract", "Internship"] as const;
export const CLEARANCE_OPTIONS = ["None", "Public Trust", "Secret", "Top Secret", "TS/SCI"] as const;

/** "2025-02" -> "Feb 2025". Returns null for anything it cannot parse rather than guessing, so a
 *  malformed date shows as absent instead of as a wrong month. */
export function formatMonth(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return value.trim() || null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return value.trim();
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1];
  return `${name} ${year}`;
}

/** A role's span. An absent end date means the role is current — the profile builder's own
 *  convention — so it reads "Present" rather than being left blank. */
export function formatSpan(start: string | null | undefined, end: string | null | undefined): string | null {
  const from = formatMonth(start);
  if (!from) return null;
  return `${from} — ${formatMonth(end) ?? "Present"}`;
}
