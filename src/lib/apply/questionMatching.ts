import type { QuestionType } from "./questionTypes";

/**
 * Recognising a question you have already answered.
 *
 * DETERMINISTIC FIRST, AND ONLY. Normalisation then exact match, then a small set of explicit
 * patterns. No fuzzy distance, no embedding, no model. A near-miss here does not produce a slightly
 * wrong label — it produces the wrong ANSWER typed into a real application, and "will you require
 * sponsorship" versus "are you authorized to work" are opposite questions that differ by a few
 * words. When nothing matches confidently the honest result is null, and the user is asked.
 *
 * The raw wording is never overwritten. Every observed variant is stored verbatim alongside its
 * normalised form, so a mapping can always be checked against what was actually on the page.
 */

/** Lowercase, strip punctuation and filler, collapse whitespace. Nothing semantic happens here. */
export function normalizeQuestion(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\((?:optional|required)\)/g, " ")
    .replace(/[*]/g, " ")
    .replace(/[^a-z0-9+#/ ]+/g, " ")
    .replace(/\b(please|kindly|the|a|an|your|you|do|does|did|are|is|will|would|have|has|to|of|for|in|on|at|with|and|or|if|any|this|that)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Rule {
  key: string;
  type: QuestionType;
  /** ALL must appear in the normalised text, as a plain substring. Safe for multi-word phrases
   *  ("current location") which are vanishingly unlikely to occur as an accidental fragment of an
   *  unrelated word; unsafe for a short single token — see `wordBoundary`. */
  all?: string[];
  /** A single token that must appear as a WHOLE WORD, not merely a substring — required for a short
   *  token that could otherwise match inside an unrelated word (e.g. plain substring "city" would
   *  also match inside "ethnicity", silently reclassifying a protected demographic question as an
   *  ordinary contact one). May be combined with `all` — both must hold. */
  wordBoundary?: string;
  /** NONE may appear — the guard that keeps opposite questions apart. */
  none?: string[];
}

/**
 * Explicit rules only, each written to exclude its own opposite.
 *
 * The `none` lists are the important half. Sponsorship and work authorisation share almost all
 * their vocabulary, and matching on shared words alone would map "are you authorized to work
 * without sponsorship" to the sponsorship question and answer it backwards.
 */
const RULES: Rule[] = [
  { key: "sponsorship_required", type: "sponsorship", all: ["sponsorship"], none: ["authorized", "authorised", "eligible"] },
  { key: "sponsorship_required", type: "sponsorship", all: ["visa"], none: ["authorized", "authorised"] },
  { key: "work_authorization_us", type: "work_authorization", all: ["authorized", "work"], none: ["sponsorship"] },
  { key: "work_authorization_us", type: "work_authorization", all: ["authorised", "work"], none: ["sponsorship"] },
  { key: "work_authorization_us", type: "work_authorization", all: ["legally", "work"], none: ["sponsorship"] },

  { key: "full_name", type: "identity", all: ["full name"] },
  { key: "first_name", type: "identity", all: ["first name"] },
  { key: "last_name", type: "identity", all: ["last name"] },
  { key: "email", type: "contact", all: ["email"] },
  /* PHASE 9E.2 — the `none` guard is what keeps a phone SUB-FIELD from collecting the phone
   * NUMBER. Observed on a real Workday form, which renders "Phone Device Type", "Country Phone
   * Code", "Phone Number" and "Phone Extension" as four separate controls: the unguarded ["phone"]
   * rule matched every one of them, so the candidate's number was written into the country-code and
   * extension fields of a live application. Same discipline as the sponsorship/authorization rules
   * — a broad token needs an explicit exclusion list wherever a more specific sibling exists. */
  { key: "phone", type: "contact", all: ["phone"], none: ["country", "code", "extension", "device", "type"] },
  { key: "location_current", type: "contact", all: ["current location"] },
  // "relocat" (stem, not "relocate" alone) excludes both "relocate" and "relocation" — a relocation
  // question is about a DIFFERENT city than the one the candidate lives in now, never answered with
  // the current-location value.
  { key: "location_city", type: "contact", all: ["location"], wordBoundary: "city", none: ["relocat"] },
  { key: "location_city", type: "contact", wordBoundary: "city", none: ["relocat"] },
  // "Country code" / "Phone country" is a phone dial-code control, not residency.
  { key: "phone_country_code", type: "contact", all: ["phone", "country"] },
  { key: "phone_country_code", type: "contact", all: ["dial", "code"] },
  { key: "phone_country_code", type: "contact", all: ["dialing", "code"] },
  { key: "phone_country_code", type: "contact", all: ["calling", "code"] },
  { key: "phone_country_code", type: "contact", all: ["country", "code"] },
  // Country of residence / residency is distinct from the phone dial-code control.
  { key: "country_of_residence", type: "contact", all: ["country", "residence"] },
  { key: "country", type: "contact", all: ["country"], none: ["code", "phone", "dial", "calling"] },
  { key: "linkedin_url", type: "contact", all: ["linkedin"] },
  { key: "github_url", type: "contact", all: ["github"] },
  { key: "portfolio_url", type: "contact", all: ["portfolio"] },
  { key: "website_url", type: "contact", all: ["website"] },

  { key: "desired_salary", type: "salary", all: ["salary"] },
  { key: "desired_salary", type: "salary", all: ["compensation"], none: ["equity"] },
  { key: "willing_to_relocate", type: "relocation", all: ["relocate"] },
  { key: "notice_period", type: "availability", all: ["notice period"] },
  { key: "start_date", type: "availability", all: ["start date"] },
  { key: "highest_education", type: "education", all: ["degree"] },
  { key: "security_clearance", type: "security_clearance", all: ["clearance"] },
  // PHASE 9D — flat single-field employment/education questions only (see planFields.ts's
  // employmentValueFor/educationValueFor). Full multi-entry repeatable sections are out of scope.
  { key: "current_employer", type: "employment_history", all: ["current employer"] },
  { key: "current_job_title", type: "employment_history", all: ["current job title"] },
  { key: "field_of_study", type: "education", all: ["field of study"] },
  { key: "institution_name", type: "education", all: ["school name"] },
  { key: "institution_name", type: "education", all: ["university name"] },
  // PHASE 9D — conservative, single-purpose patterns only. Both map to "other" (never auto-filled
  // unattended; the user confirms each use) rather than a new QuestionType, since neither is a
  // stable fact worth a dedicated reuse policy — "how did you hear about us" legitimately varies by
  // posting, and "have you worked here before" is specific enough that a wrong guess would be a
  // false statement about the candidate's own history.
  { key: "referral_source", type: "other", all: ["how", "hear", "about"] },
  { key: "previously_employed", type: "other", all: ["previously", "employ"] },

  { key: "why_interested", type: "open_ended", all: ["why", "interested"] },
  { key: "why_interested", type: "open_ended", all: ["why", "want", "work"] },
  { key: "relevant_experience", type: "open_ended", all: ["describe", "experience"] },

  { key: "gender", type: "voluntary_demographic", all: ["gender"] },
  { key: "race_ethnicity", type: "voluntary_demographic", all: ["race"] },
  { key: "race_ethnicity", type: "voluntary_demographic", all: ["ethnicity"] },
  { key: "veteran_status", type: "voluntary_demographic", all: ["veteran"] },
  { key: "disability_status", type: "voluntary_demographic", all: ["disability"] },
];

export interface QuestionMatch {
  canonicalKey: string;
  type: QuestionType;
  /** How the mapping was reached — shown to the user so a wrong one is visible, not silent. */
  via: "exact_variant" | "pattern";
}

/**
 * Classify one question.
 *
 * `knownVariants` maps an already-observed normalised wording to its canonical key. An exact match
 * against something the user has genuinely seen before always wins over a pattern.
 */
export function matchQuestion(
  rawQuestion: string,
  knownVariants: Map<string, { canonicalKey: string; type: QuestionType }>
): QuestionMatch | null {
  const normalized = normalizeQuestion(rawQuestion);
  if (normalized.length === 0) return null;

  const seen = knownVariants.get(normalized);
  if (seen) return { canonicalKey: seen.canonicalKey, type: seen.type, via: "exact_variant" };

  for (const rule of RULES) {
    if (rule.all && !rule.all.every((t) => normalized.includes(t))) continue;
    if (rule.wordBoundary && !new RegExp(`\\b${rule.wordBoundary}\\b`).test(normalized)) continue;
    if (rule.none?.some((t) => normalized.includes(t))) continue;
    return { canonicalKey: rule.key, type: rule.type, via: "pattern" };
  }

  /* No confident mapping. Returning null sends this to the user, which is the correct outcome —
   * guessing here means a real answer typed into a real application. */
  return null;
}
