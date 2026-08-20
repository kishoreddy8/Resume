import { getDb } from "@/db";
import type { AppSettings } from "@/lib/settings";

/**
 * Phase 2.5 candidate_settings — one row per candidate, split into two use cases enforced at the
 * TYPE level (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record §10), not by separate tables:
 *
 *   MATCH-AFFECTING (MatchAffectingCandidateSettings): consumed by src/lib/match/eligibility.ts and
 *   hashed into job_match_results.candidate_settings_hash via computeCandidateSettingsHash. Changing
 *   one of these legitimately invalidates cached Phase 2 match results — that's correct, not a bug.
 *
 *   RANKING-ONLY (CandidateRankingPreferences): consumed ONLY by the For You ranking layer
 *   (src/lib/rank/forYou.ts). NEVER pass this shape to computeCandidateSettingsHash or
 *   evaluateEligibility — changing a target-role preference must never invalidate a Phase 2 match
 *   result. getMatchAffectingSettings() and getRankingPreferences() are the only two read functions;
 *   there is deliberately no single "getEverything" function that would make it easy to accidentally
 *   pass the wrong shape into the wrong downstream consumer.
 */

// Identical shape to AppSettings["candidate"] on purpose — evaluateEligibility/
// computeCandidateSettingsHash need no changes at all, only a different data source.
export type MatchAffectingCandidateSettings = AppSettings["candidate"];

export interface CandidateRankingPreferences {
  primaryTargetRole: string | null;
  secondaryTargetRoles: string[];
  locationPreference: string | null;
  workplacePreference: string[];
  employmentTypePreference: string | null;
}

interface CandidateSettingsRow {
  candidate_id: number;
  requires_sponsorship: 0 | 1;
  us_citizen: 0 | 1;
  work_authorized_us: 0 | 1;
  clearance_level: string;
  primary_target_role: string | null;
  secondary_target_roles: string | null;
  location_preference: string | null;
  workplace_preference: string | null;
  employment_type_preference: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_location: string | null;
  contact_linkedin: string | null;
  contact_github: string | null;
}

function getRow(candidateId: number): CandidateSettingsRow | undefined {
  return getDb().prepare("SELECT * FROM candidate_settings WHERE candidate_id = ?").get(candidateId) as CandidateSettingsRow | undefined;
}

/** Falls back to the same conservative defaults as the legacy global settings.candidate group
 *  (requiresSponsorship: true) if a candidate somehow has no settings row yet — never assumes an
 *  unconfigured candidate has no eligibility constraints. */
export function getMatchAffectingSettings(candidateId: number): MatchAffectingCandidateSettings {
  const row = getRow(candidateId);
  if (!row) {
    return { requiresSponsorship: true, usCitizen: false, workAuthorizedUS: false, clearanceLevel: "None" };
  }
  return {
    requiresSponsorship: Boolean(row.requires_sponsorship),
    usCitizen: Boolean(row.us_citizen),
    workAuthorizedUS: Boolean(row.work_authorized_us),
    clearanceLevel: row.clearance_level as MatchAffectingCandidateSettings["clearanceLevel"],
  };
}

export function getRankingPreferences(candidateId: number): CandidateRankingPreferences {
  const row = getRow(candidateId);
  if (!row) {
    return { primaryTargetRole: null, secondaryTargetRoles: [], locationPreference: null, workplacePreference: [], employmentTypePreference: null };
  }
  return {
    primaryTargetRole: row.primary_target_role,
    secondaryTargetRoles: row.secondary_target_roles ? JSON.parse(row.secondary_target_roles) : [],
    locationPreference: row.location_preference,
    workplacePreference: row.workplace_preference ? JSON.parse(row.workplace_preference) : [],
    employmentTypePreference: row.employment_type_preference,
  };
}

/**
 * Stage 26B — the candidate's real contact details. A THIRD bucket, deliberately separate from
 * matchAffecting and preferences and following that same enforced-boundary discipline: contact
 * details are read by neither getMatchAffectingSettings nor getRankingPreferences, so changing them
 * can never invalidate a match cache or alter ranking. Every field is nullable — "not configured yet"
 * must be representable, and is never silently replaced with a plausible default.
 */
export interface CandidateContact {
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
  /* Optional in the TYPE as well as in the data. Every other contact field predates this one,
   * so requiring it would force a null into call sites that have nothing to say about GitHub — and
   * "not mentioned" and "explicitly none" are the same thing for a field that is opt-in anyway. */
  github?: string | null;
}

export function getCandidateContact(candidateId: number): CandidateContact {
  const row = getRow(candidateId);
  if (!row) return { email: null, phone: null, location: null, linkedin: null, github: null };
  return {
    email: row.contact_email ?? null,
    phone: row.contact_phone ?? null,
    location: row.contact_location ?? null,
    linkedin: row.contact_linkedin ?? null,
    github: row.contact_github ?? null,
  };
}

/** Writes only the contact columns, leaving every match-affecting and ranking field untouched. */
export function updateCandidateContact(candidateId: number, input: Partial<CandidateContact>): void {
  const current = { ...getCandidateContact(candidateId), ...input };
  const trim = (v: string | null) => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t : null;
  };
  getDb()
    .prepare(
      `INSERT INTO candidate_settings (candidate_id, contact_email, contact_phone, contact_location, contact_linkedin, contact_github, updated_at)
       VALUES (@candidateId, @email, @phone, @location, @linkedin, @github, datetime('now'))
       ON CONFLICT(candidate_id) DO UPDATE SET
         contact_email = excluded.contact_email,
         contact_phone = excluded.contact_phone,
         contact_location = excluded.contact_location,
         contact_linkedin = excluded.contact_linkedin,
         contact_github = excluded.contact_github,
         updated_at = excluded.updated_at`
    )
    .run({
      candidateId,
      email: trim(current.email),
      phone: trim(current.phone),
      location: trim(current.location),
      linkedin: trim(current.linkedin),
      github: trim(current.github ?? null),
    });
}

export interface UpdateCandidateSettingsInput {
  matchAffecting?: Partial<MatchAffectingCandidateSettings>;
  preferences?: Partial<CandidateRankingPreferences>;
}

export function updateCandidateSettings(candidateId: number, input: UpdateCandidateSettingsInput): void {
  const current = { ...getMatchAffectingSettings(candidateId), ...input.matchAffecting };
  const currentPrefs = { ...getRankingPreferences(candidateId), ...input.preferences };
  getDb()
    .prepare(
      `INSERT INTO candidate_settings
        (candidate_id, requires_sponsorship, us_citizen, work_authorized_us, clearance_level,
         primary_target_role, secondary_target_roles, location_preference, workplace_preference,
         employment_type_preference, updated_at)
       VALUES (@candidateId, @requiresSponsorship, @usCitizen, @workAuthorizedUS, @clearanceLevel,
               @primaryTargetRole, @secondaryTargetRoles, @locationPreference, @workplacePreference,
               @employmentTypePreference, datetime('now'))
       ON CONFLICT(candidate_id) DO UPDATE SET
         requires_sponsorship = excluded.requires_sponsorship,
         us_citizen = excluded.us_citizen,
         work_authorized_us = excluded.work_authorized_us,
         clearance_level = excluded.clearance_level,
         primary_target_role = excluded.primary_target_role,
         secondary_target_roles = excluded.secondary_target_roles,
         location_preference = excluded.location_preference,
         workplace_preference = excluded.workplace_preference,
         employment_type_preference = excluded.employment_type_preference,
         updated_at = datetime('now')`
    )
    .run({
      candidateId,
      requiresSponsorship: current.requiresSponsorship ? 1 : 0,
      usCitizen: current.usCitizen ? 1 : 0,
      workAuthorizedUS: current.workAuthorizedUS ? 1 : 0,
      clearanceLevel: current.clearanceLevel,
      primaryTargetRole: currentPrefs.primaryTargetRole,
      secondaryTargetRoles: JSON.stringify(currentPrefs.secondaryTargetRoles),
      locationPreference: currentPrefs.locationPreference,
      workplacePreference: JSON.stringify(currentPrefs.workplacePreference),
      employmentTypePreference: currentPrefs.employmentTypePreference,
    });
}
