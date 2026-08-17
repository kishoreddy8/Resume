import {
  findCompanyIdByAtsBoardIdentity,
  findCompanyIdByVerifiedDomain,
  findCompanyIdsByAliasName,
  findCompanyIdsByAliasPrefix,
} from "@/db/queries/organizationRegistry";
import { normalizeOrganizationDomain } from "@/db/organizationRegistryCore";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import type { CompanyMatchResult, NormalizedExternalJob } from "./types";

/**
 * Phase 5/6 (Stage 7) + Stage 12 identity hierarchy — resolve an external listing's employer to an
 * existing CareerOps company, using the SAME identity primitives the rest of the registry already
 * writes through (organization_domains, organization_aliases, companies.ats_board_token). Strongest
 * evidence first, never a fuzzy/similarity guess:
 *
 *   1. VERIFIED DOMAIN      — apply/direct-employer URL's domain is a VERIFIED organization domain.
 *   2. ATS BOARD IDENTITY   — apply URL's detected ATS provider+board token already uniquely belongs
 *                             to an existing company (idx_companies_ats is a UNIQUE index).
 *   3. ORGANIZATION ALIAS   — exact match against a stored alias (covers the company's own primary
 *                             name too, since syncLegacyCompanyToOrganizationRegistry aliases it).
 *   4. SAFE LEGAL-NAME NORMALIZATION — a deterministic, single-suffix-stripped comparison (e.g.
 *                             "Pfizer" == "Pfizer Inc."), used ONLY when corroborated by independent
 *                             ATS/apply-URL evidence (Stage 12's "multi-signal" requirement) and never
 *                             for a short/generic residual name.
 *
 * Every tier either returns a unique companyId or falls through — multiple candidates at any tier is
 * always AMBIGUOUS, never auto-resolved. This never merges a brand/subsidiary onto a parent company
 * unless that relationship is already curated as a real organization_aliases row — no parent/child
 * inference of any kind lives here.
 */
export function matchCompanyForObservation(job: NormalizedExternalJob): CompanyMatchResult {
  // Tier 1: verified employer domain, from whichever field looks like an employer's own domain
  // rather than an aggregator's (directEmployerUrl first, since employerName never carries a URL).
  // ATS vendor domains (e.g. greenhouse.io, icims.com, myworkdayjobs.com) are skipped here — they
  // prove ATS identity in Tier 2, never company.verified_domain.
  for (const candidateUrl of [job.directEmployerUrl, job.applyUrl]) {
    if (!candidateUrl) continue;
    if (detectAtsFromUrlString(candidateUrl)) continue;
    const domain = safeDomainFromUrl(candidateUrl);
    if (!domain) continue;
    const companyId = findCompanyIdByVerifiedDomain(domain);
    if (companyId) return { companyId, confidence: "DOMAIN", reason: `Verified domain match on ${domain}` };
  }

  // Tier 2: existing ATS board/token identity — the apply URL resolves to a recognized ATS board that
  // an existing CareerOps company already has on file (companies.source_type + ats_board_token).
  for (const candidateUrl of [job.directEmployerUrl, job.applyUrl]) {
    if (!candidateUrl) continue;
    const detection = detectAtsFromUrlString(candidateUrl);
    if (!detection) continue;
    const companyId = findCompanyIdByAtsBoardIdentity(detection.sourceType, detection.atsBoardToken);
    if (companyId) {
      return {
        companyId,
        confidence: "ATS_BOARD",
        reason: `Existing ${detection.sourceType} board/token match (${detection.atsBoardToken})`,
      };
    }
  }

  const employerName = job.employerName.trim();
  if (!employerName) return { companyId: null, confidence: "UNMATCHED", reason: "No employer name on the listing" };

  // Tier 3: organization alias (covers both a distinct legal alias and the company's own primary
  // name, since both live in organization_aliases).
  const aliasMatches = findCompanyIdsByAliasName(employerName);
  if (aliasMatches.length === 1) {
    return { companyId: aliasMatches[0], confidence: "ALIAS", reason: `Alias/name match on "${employerName}"` };
  }
  if (aliasMatches.length > 1) {
    return { companyId: null, confidence: "AMBIGUOUS", reason: `"${employerName}" matches ${aliasMatches.length} distinct companies — not auto-resolved` };
  }

  // Tier 4: safe legal-name normalization, combined with independent corroborating ATS/apply-URL
  // evidence (Stage 12's multi-signal requirement — a normalized-name match ALONE never proceeds).
  const observed = normalizeForLegalNameMatch(employerName);
  if (observed.safe) {
    // The SQL narrowing prefix must match the LITERAL bytes stored in alias_normalized (which only
    // applies NFKC/whitespace/case — it keeps "&" and punctuation as-is), so it is derived from just
    // the first word, NOT from `observed.stripped` (which has already turned "&" into "AND" and
    // dropped punctuation and could therefore never byte-match a stored alias like "X & Co."). The
    // final match decision below still requires exact equality of the fully-stripped forms on both
    // sides — this prefix only narrows which rows get fetched from the DB.
    const candidates = findCompanyIdsByAliasPrefix(firstWordPrefix(employerName));
    const matchedCompanyIds = new Set<number>();
    for (const candidate of candidates) {
      const aliasNormalized = normalizeForLegalNameMatch(candidate.alias);
      if (aliasNormalized.safe && aliasNormalized.stripped === observed.stripped) {
        matchedCompanyIds.add(candidate.companyId);
      }
    }
    if (matchedCompanyIds.size > 1) {
      return {
        companyId: null,
        confidence: "AMBIGUOUS",
        reason: `"${employerName}" (normalized "${observed.stripped}") matches ${matchedCompanyIds.size} distinct companies after legal-name normalization — not auto-resolved`,
      };
    }
    if (matchedCompanyIds.size === 1) {
      const candidateUrl = job.directEmployerUrl ?? job.applyUrl;
      const hasCorroboratingEvidence = candidateUrl ? (detectAtsFromUrlString(candidateUrl) !== null || safeDomainFromUrl(candidateUrl) !== null) : false;
      if (hasCorroboratingEvidence) {
        const [companyId] = matchedCompanyIds;
        return {
          companyId,
          confidence: "NAME",
          reason: `Legal-name-normalized match on "${observed.stripped}", corroborated by apply URL evidence`,
        };
      }
      // A normalized-name match with no independent corroborating evidence is not confident enough
      // to auto-proceed — stays UNMATCHED (evidence-only), never guessed from name alone.
    }
  }

  return { companyId: null, confidence: "UNMATCHED", reason: `No CareerOps company matches "${employerName}"` };
}

function safeDomainFromUrl(url: string): string | null {
  try {
    const normalized = normalizeOrganizationDomain(url);
    return normalized || null;
  } catch {
    return null;
  }
}

/** Deliberately conservative: strips exactly ONE leading "THE" article and ONE trailing legal-suffix
 *  token (never chained — see Stage 12's own audit note on why "X Holdings Group" must not collapse
 *  to just "X"), and only after normalizing "&"/"and" equivalence and stripping punctuation. `safe` is
 *  false for anything that would resolve to a short or generically-named residual — Stage 12's
 *  explicit "GM must never become General Motors" / "United", "Global", "First" must never be
 *  guessed requirement. */
const LEGAL_SUFFIX_TOKENS = new Set([
  "INCORPORATED", "INC", "LLC", "LLP", "LTD", "LIMITED", "CORPORATION", "CORP",
  "COMPANY", "CO", "HOLDINGS", "GROUP",
]);

const GENERIC_NAME_BLOCKLIST = new Set([
  "ABC", "UNITED", "GLOBAL", "FIRST", "GENERAL", "NATIONAL", "AMERICAN",
  "INTERNATIONAL", "HOLDINGS", "GROUP", "PARENT", "COMPANY",
]);

const MIN_SAFE_LEGAL_NAME_LENGTH = 4;

function normalizeForLegalNameMatch(value: string): { stripped: string; safe: boolean } {
  let s = value.normalize("NFKC").toUpperCase();
  s = s.replace(/&/g, " AND ");
  s = s.replace(/[.,]/g, "");
  s = s.replace(/[^A-Z0-9 ]/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  const tokens = s.split(" ").filter(Boolean);
  if (tokens.length > 1 && tokens[0] === "THE") {
    tokens.shift();
  }
  if (tokens.length > 1 && LEGAL_SUFFIX_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const stripped = tokens.join(" ");
  const safe = stripped.length >= MIN_SAFE_LEGAL_NAME_LENGTH && !GENERIC_NAME_BLOCKLIST.has(stripped);
  return { stripped, safe };
}

/** SQL-prefix-search key ONLY (see the call site above) — applies exactly the same normalization the
 *  stored alias_normalized column itself uses (NFKC/whitespace/case, via normalizeOrganizationAlias),
 *  and nothing more, so the prefix always byte-matches what is actually stored. Never used for the
 *  final match decision, which always goes through normalizeForLegalNameMatch on both sides. */
function firstWordPrefix(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  const words = normalized.split(" ").filter(Boolean);
  if (words.length > 1 && words[0] === "THE") {
    return words[1];
  }
  return words[0] ?? "";
}
