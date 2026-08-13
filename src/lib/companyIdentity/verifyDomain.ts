import { safeFetch, SafeFetchError, type SafeFetchErrorReason } from "@/lib/net/safeFetch";
import { normalizeEmployerLegalName } from "@/lib/h1b/normalizeEmployerName";
import type {
  DomainEvidenceChannelResult,
  DomainIdentityChannelsChecked,
  DomainIdentityResult,
} from "@/types";

/**
 * Domain Verification Gate — answers ONLY "is this the official public company domain?", never
 * "can we also find its careers page?" (see resolveDomain.ts / schema.sql's CRITICAL BOUNDARY
 * comment). Careers/ATS discovery is attached to a result afterward as purely additive
 * `careersEvidence` by the CALLER (resolveDomain.ts) — this module never calls
 * discoverCompanySource and never lets its outcome affect status/confidence below.
 *
 * Two paths to VERIFIED:
 *   PATH A (externally corroborated) — a confidently-disambiguated Wikidata P856 hit, SEC EDGAR
 *     corroboration, or a strong same-entity redirect COMBINED with >=1 matching first-party
 *     channel. External metadata is never self-sufficient because it can be stale or incorrect.
 *   PATH B (multi-signal first-party) — for real private employers with no Wikidata/SEC record:
 *     >=2 of four independently-checked first-party channels (CH1 JSON-LD Organization,
 *     CH2 footer/copyright, CH3 About page, CH4 Terms/Privacy page) agree on the same normalized
 *     identity, drawn from >=2 DISTINCT channels (never the same rendered page double-counted
 *     under two names — see the finalUrl dedup below), with no conflicting channel.
 *
 * DNS success alone, HTTP 200 alone, and name-similarity alone are each explicitly insufficient —
 * neither appears anywhere in the VERIFIED decision below on its own.
 */

const PARKING_PAGE_PATTERNS: RegExp[] = [
  /domain\s+(is\s+)?for\s+sale/i,
  /buy\s+this\s+domain/i,
  /this\s+domain\s+is\s+parked/i,
  /godaddy\.com\/domainfind/i,
  /sedo\.com/i,
  /hugedomains\.com/i,
  /dan\.com/i,
  /parkingcrew/i,
];

// dns_hostname_not_found (the resolver authoritatively reports no such host — e.g. a generated
// domain candidate that was simply never real) is deliberately EXCLUDED here — it must resolve to
// UNRESOLVED, not FAILED_TEMPORARY, since retrying the identical wrong hostname will never succeed.
// See safeFetch.ts's classifyDnsLookupError for the transient/hard distinction.
const TRANSIENT_REASONS = new Set<SafeFetchErrorReason>(["timeout", "network_error", "dns_resolution_failed"]);

const ABOUT_PATHS = ["/about", "/about-us", "/company", "/who-we-are"];
const TERMS_PRIVACY_PATHS = ["/terms", "/terms-of-service", "/privacy", "/privacy-policy", "/legal"];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extracts an Organization/Corporation JSON-LD block's legalName or name, if present. Mirrors
 *  jobValidation.ts's JSON-LD parsing approach (script-tag regex + @graph/itemListElement nesting)
 *  but looks for an organization type instead of JobPosting. */
function extractJsonLdOrganizationName(html: string): string | null {
  const scriptRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const found = findOrganizationName(parsed);
    if (found) return found;
  }
  return null;
}

function findOrganizationName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findOrganizationName(child);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const isOrg =
    type === "Organization" ||
    type === "Corporation" ||
    (Array.isArray(type) && type.some((t) => t === "Organization" || t === "Corporation"));
  if (isOrg) {
    const legalName = typeof obj.legalName === "string" ? obj.legalName : null;
    const name = typeof obj.name === "string" ? obj.name : null;
    if (legalName || name) return legalName ?? name;
  }
  if (Array.isArray(obj["@graph"])) {
    const found = findOrganizationName(obj["@graph"]);
    if (found) return found;
  }
  return null;
}

/** "© 2026 Acme Technologies, Inc. All rights reserved" -> "Acme Technologies, Inc." */
function extractCopyrightStatement(text: string): string | null {
  const match = text.match(
    /©\s*(?:\d{4}(?:\s*[-–]\s*\d{2,4})?\s*)?([A-Z][A-Za-z0-9&.,'’\-\s]{2,80}?)(?:\.\s|,\s|\s+All\s+rights\s+reserved|\s*$)/
  );
  return match ? match[1].trim() : null;
}

/** Finds a "<Name Phrase> <legal suffix>" statement anywhere in the text — e.g. "Acme
 *  Technologies, Inc." or "a subsidiary of Acme Technologies LLC" — without assuming the target
 *  name in advance, so the caller can compare what was actually stated against the target and
 *  detect a genuine conflict (a different company's legal name stated on the page). */
function extractLegalSuffixStatement(text: string): string | null {
  const match = text.match(
    /\b((?:[A-Z][A-Za-z0-9&'.]*\s+){1,6})(Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Ltd\.?|LLP|PLLC|Limited|Co\.)\b/
  );
  if (!match) return null;
  return `${match[1].trim()} ${match[2]}`.trim();
}

/** Tries JSON-LD first (strongest, structured), then copyright, then a bare legal-suffix
 *  statement — first one found wins. Used by CH1 (JSON-LD only, per spec) directly via
 *  extractJsonLdOrganizationName, and by CH2/CH3/CH4 via this combined extractor. */
function extractStatedIdentity(html: string): string | null {
  const text = stripTags(html);
  return extractCopyrightStatement(text) ?? extractLegalSuffixStatement(text);
}

interface ChannelClassification {
  result: DomainEvidenceChannelResult;
  extractedIdentity: string | null;
}

/** `null` html means the page was never reached (not_checked). Otherwise: no statement found at
 *  all -> no_match; a statement found that normalizes to the target -> match; a statement found
 *  that normalizes to something else -> conflict (this page explicitly claims a different legal
 *  identity than the one being verified). */
function classify(html: string | null, extractor: (html: string) => string | null, targetNormalized: string): ChannelClassification {
  if (html === null) return { result: "not_checked", extractedIdentity: null };
  const extracted = extractor(html);
  if (!extracted) return { result: "no_match", extractedIdentity: null };
  const extractedNormalized = normalizeEmployerLegalName(extracted);
  if (!extractedNormalized) return { result: "no_match", extractedIdentity: extracted };
  if (extractedNormalized === targetNormalized) return { result: "match", extractedIdentity: extracted };
  return { result: "conflict", extractedIdentity: extracted };
}

export interface AuthoritativeSignals {
  /** A confidently-disambiguated Wikidata entity (see wikidataLookup.ts) already confirmed this
   *  exact domain via P856. */
  wikidataConfirmed?: boolean;
  /** SEC EDGAR corroborated the legal-entity name (see secLookup.ts) — corroboration only, per
   *  its own module doc comment; combined here with the baseline reachability/branding checks. */
  secConfirmed?: boolean;
  /** A known alternate-spelling candidate for the SAME employer independently redirected to this
   *  domain (see resolveDomain.ts's redirect-corroboration check across its own candidate set). */
  redirectConfirmed?: boolean;
}

export interface VerifyDomainOptions {
  domain: string;
  employerNameRaw: string;
  authoritative?: AuthoritativeSignals;
  /** Test-only — see safeFetch's identical option. NEVER set true from production call sites. */
  allowPrivateNetworksForTests?: boolean;
  /** Testing-only: overrides the `https://{domain}/` root URL this function fetches — same
   *  hostOverride pattern every ATS connector already uses to point at a local HTTP server instead
   *  of the real internet. `options.domain` is still what gets recorded as the verified domain;
   *  this only changes where the actual bytes are fetched from. Production callers never pass this. */
  rootUrlOverride?: string;
}

function notCheckedChannels(): DomainIdentityChannelsChecked {
  return { jsonLd: "not_checked", footer: "not_checked", aboutPage: "not_checked", termsPrivacyPage: "not_checked" };
}

function unresolvedResult(evidence: string[] = []): DomainIdentityResult {
  return { status: "UNRESOLVED", domain: null, method: "unresolved", confidence: null, evidence, channelsChecked: notCheckedChannels(), careersEvidence: null };
}

function failedTemporaryResult(): DomainIdentityResult {
  return { status: "FAILED_TEMPORARY", domain: null, method: "unresolved", confidence: null, evidence: [], channelsChecked: notCheckedChannels(), careersEvidence: null };
}

async function fetchOptionalPage(baseUrl: string, paths: string[], allowPrivateNetworksForTests: boolean): Promise<{ html: string; finalUrl: string } | null> {
  for (const path of paths) {
    try {
      const res = await safeFetch(new URL(path, baseUrl).toString(), {
        timeoutMs: 8_000,
        maxResponseBytes: 1_000_000,
        allowPrivateNetworksForTests,
      });
      if (res.status >= 200 && res.status < 300) return { html: res.bodyText, finalUrl: res.finalUrl };
    } catch {
      // This exact path 404'd/failed — try the next candidate path; only "none of them worked"
      // means not_checked for that channel, handled by the caller returning null.
      continue;
    }
  }
  return null;
}

export async function verifyDomainIdentity(options: VerifyDomainOptions): Promise<DomainIdentityResult> {
  const allowPrivateNetworksForTests = options.allowPrivateNetworksForTests ?? false;
  const targetNormalized = normalizeEmployerLegalName(options.employerNameRaw);
  const rootUrl = options.rootUrlOverride ?? `https://${options.domain}/`;

  // Step B1 — reachability.
  let homepage;
  try {
    homepage = await safeFetch(rootUrl, { timeoutMs: 10_000, maxResponseBytes: 2_000_000, allowPrivateNetworksForTests });
  } catch (err) {
    if (!(err instanceof SafeFetchError)) throw err;
    return TRANSIENT_REASONS.has(err.reason) ? failedTemporaryResult() : unresolvedResult();
  }

  // Step B2 — not a parking/placeholder page.
  if (PARKING_PAGE_PATTERNS.some((p) => p.test(homepage.bodyText))) {
    return unresolvedResult(["parking_page_detected"]);
  }

  // Step C — gather CH1-CH4. CH1/CH2 read the already-fetched homepage; CH3/CH4 need their own
  // fetch of a same-domain About/Terms-Privacy path.
  const ch1 = classify(homepage.bodyText, extractJsonLdOrganizationName, targetNormalized);
  const ch2 = classify(homepage.bodyText, extractStatedIdentity, targetNormalized);

  const aboutPage = await fetchOptionalPage(rootUrl, ABOUT_PATHS, allowPrivateNetworksForTests);
  const termsPage = await fetchOptionalPage(rootUrl, TERMS_PRIVACY_PATHS, allowPrivateNetworksForTests);

  const ch3 = classify(aboutPage?.html ?? null, extractStatedIdentity, targetNormalized);
  let ch4 = classify(termsPage?.html ?? null, extractStatedIdentity, targetNormalized);

  // Dedup: if About and Terms/Privacy resolved to the identical page (same site redirecting both
  // paths to one URL), that is ONE channel of evidence, not two — force ch4 out of the countable
  // set so Path B's ">=2 DISTINCT channels" threshold can't be gamed by one page under two names.
  const sameUnderlyingPage = aboutPage && termsPage && aboutPage.finalUrl === termsPage.finalUrl;
  if (sameUnderlyingPage && ch4.result === "match") {
    ch4 = { result: "no_match", extractedIdentity: ch4.extractedIdentity };
  }

  const channelsChecked: DomainIdentityChannelsChecked = {
    jsonLd: ch1.result,
    footer: ch2.result,
    aboutPage: ch3.result,
    termsPrivacyPage: ch4.result,
  };

  const anyConflict = [ch1, ch2, ch3, ch4].some((c) => c.result === "conflict");

  const evidence: string[] = [];
  if (ch1.result === "match") evidence.push("jsonld_legalname_match");
  if (ch2.result === "match") evidence.push("footer_copyright_match");
  if (ch3.result === "match") evidence.push("about_page_match");
  if (ch4.result === "match") evidence.push("terms_privacy_page_match");
  if (ch1.result === "conflict") evidence.push("jsonld_conflict");
  if (ch2.result === "conflict") evidence.push("footer_conflict");
  if (ch3.result === "conflict") evidence.push("about_page_conflict");
  if (ch4.result === "conflict") evidence.push("terms_privacy_page_conflict");

  // Step D — decision.
  if (anyConflict) {
    return { status: "AMBIGUOUS", domain: null, method: "unresolved", confidence: null, evidence, channelsChecked, careersEvidence: null };
  }

  const authoritative = options.authoritative ?? {};
  const matchingChannelCount = [ch1, ch2, ch3, ch4].filter((c) => c.result === "match").length;

  // External corroboration is never self-sufficient: the live canary found a real Wikidata P856
  // claim pointing Qualcomm at an unrelated consumer-rights wiki. Require at least one independent
  // first-party identity channel to bind ANY external domain assertion to this employer.
  if ((authoritative.wikidataConfirmed || authoritative.redirectConfirmed) && matchingChannelCount >= 1) {
    const method = authoritative.wikidataConfirmed ? "wikidata" : "redirect_corroborated";
    if (authoritative.wikidataConfirmed) evidence.push("wikidata_p856_confirmed");
    if (authoritative.redirectConfirmed) evidence.push("same_entity_redirect_confirmed");
    return { status: "VERIFIED", domain: options.domain, method, confidence: "high", evidence, channelsChecked, careersEvidence: null };
  }
  if (authoritative.secConfirmed && matchingChannelCount >= 1) {
    evidence.push("sec_edgar_corroborated");
    return { status: "VERIFIED", domain: options.domain, method: "sec_corroborated", confidence: "high", evidence, channelsChecked, careersEvidence: null };
  }

  if (matchingChannelCount >= 2) {
    return {
      status: "VERIFIED",
      domain: options.domain,
      method: "generated_verified_multisignal",
      confidence: "medium",
      evidence,
      channelsChecked,
      careersEvidence: null,
    };
  }

  return { status: "UNRESOLVED", domain: null, method: "unresolved", confidence: null, evidence, channelsChecked, careersEvidence: null };
}
