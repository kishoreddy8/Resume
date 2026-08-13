import { findDomainOverride } from "@/db/queries/h1bEmployerDomainOverrides";
import { generateDomainCandidates } from "@/lib/companyIdentity/domainCandidates";
import { findSecCorroboration } from "@/lib/companyIdentity/secLookup";
import { verifyDomainIdentity } from "@/lib/companyIdentity/verifyDomain";
import { lookupWikidataEntity } from "@/lib/companyIdentity/wikidataLookup";
import { normalizeEmployerName } from "@/lib/h1b/normalizeEmployerName";
import type { DomainIdentityResult } from "@/types";

/**
 * The full domain-resolution waterfall (see verifyDomain.ts for the verification gate itself):
 *
 *   LAYER 0 — curated override (h1b_employer_domain_overrides) -> instant VERIFIED, no live check.
 *   LAYER 1 — Wikidata entity resolution (disambiguated, see wikidataLookup.ts) -> if it yields a
 *             single confidently-matched domain, require independent first-party verification.
 *   LAYER 2 — a small, conservative set of generated domain candidates (domainCandidates.ts),
 *             each run through the SAME verification gate — SEC corroboration (secLookup.ts,
 *             corroborative only, never self-sufficient) is attempted once and offered to every
 *             candidate; otherwise a candidate must clear Path B's independent multi-signal bar.
 *
 * Never guesses: reaching LAYER 2 only produces UNTRUSTED candidates, and none of them becomes
 * VERIFIED without independently passing verifyDomainIdentity's Step B/C/D gate. SEC and Wikidata
 * failures/no-matches simply fall through to the next layer rather than aborting resolution.
 *
 * Redirect corroboration (a known alternate-spelling candidate independently redirecting to
 * another candidate for the SAME employer) is part of AuthoritativeSignals' type surface but is
 * NOT wired up by this implementation — deferred, documented in the final report, not silently
 * dropped. It was never a required signal, only one of several optional authoritative paths.
 */

export interface ResolveDomainOptions {
  /** Test-only — passed straight through to safeFetch calls inside verifyDomainIdentity. */
  allowPrivateNetworksForTests?: boolean;
  /** Test-only — see lookupWikidataEntity's identical option. */
  wikidataEndpointOverride?: string;
  /** Test-only — see findSecCorroboration's identical option. */
  secUrlOverride?: string;
  /** Test-only — overrides the root URL EVERY verifyDomainIdentity call this function makes
   *  actually fetches from (both the Wikidata-sourced domain and every Layer-2 candidate),
   *  regardless of which "domain" string is nominally being checked — same single-fixture-server
   *  pattern verifyDomain.test.ts itself uses. Production callers never pass this. */
  verifyRootUrlOverride?: string;
}

function curatedResult(domain: string): DomainIdentityResult {
  return {
    status: "VERIFIED",
    domain,
    method: "curated",
    confidence: "high",
    evidence: ["curated_override"],
    channelsChecked: { jsonLd: "not_checked", footer: "not_checked", aboutPage: "not_checked", termsPrivacyPage: "not_checked" },
    careersEvidence: null,
  };
}

/** Ranks non-VERIFIED outcomes by how informative they are, so the waterfall's FINAL answer (if
 *  nothing ever verifies) reflects the most useful evidence gathered across all layers rather than
 *  just whichever layer ran last. AMBIGUOUS (a real, specific conflict) is more informative than
 *  FAILED_TEMPORARY (a transient blip, retry-eligible), which is more informative than a bare
 *  UNRESOLVED (nothing found at all). */
function informativeness(result: DomainIdentityResult): number {
  if (result.status === "AMBIGUOUS") return 2;
  if (result.status === "FAILED_TEMPORARY") return 1;
  return 0;
}

export async function resolveDomainIdentity(employerNameRaw: string, options: ResolveDomainOptions = {}): Promise<DomainIdentityResult> {
  const normalized = normalizeEmployerName(employerNameRaw);
  if (!normalized) {
    return {
      status: "UNRESOLVED",
      domain: null,
      method: "unresolved",
      confidence: null,
      evidence: ["empty_normalized_name"],
      channelsChecked: { jsonLd: "not_checked", footer: "not_checked", aboutPage: "not_checked", termsPrivacyPage: "not_checked" },
      careersEvidence: null,
    };
  }

  // LAYER 0 — curated override.
  const override = findDomainOverride(normalized);
  if (override) return curatedResult(override.domain);

  let bestFallback: DomainIdentityResult | null = null;
  const considerFallback = (result: DomainIdentityResult) => {
    if (!bestFallback || informativeness(result) > informativeness(bestFallback)) bestFallback = result;
  };

  // LAYER 1 — Wikidata, disambiguated (see wikidataLookup.ts's own module doc comment for the
  // exact disambiguation rule: single agreed domain -> proceed to verify; multiple conflicting
  // domains -> ambiguous, recorded but never guessed from).
  const wikidata = await lookupWikidataEntity(normalized, { endpointOverride: options.wikidataEndpointOverride });
  if (wikidata.status === "single_match" && wikidata.domain) {
    const verified = await verifyDomainIdentity({
      domain: wikidata.domain,
      employerNameRaw,
      authoritative: { wikidataConfirmed: true },
      allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
      rootUrlOverride: options.verifyRootUrlOverride,
    });
    if (verified.status === "VERIFIED") return verified;
    considerFallback(verified);
  } else if (wikidata.status === "ambiguous") {
    considerFallback({
      status: "AMBIGUOUS",
      domain: null,
      method: "unresolved",
      confidence: null,
      evidence: ["wikidata_multiple_conflicting_entities"],
      channelsChecked: { jsonLd: "not_checked", footer: "not_checked", aboutPage: "not_checked", termsPrivacyPage: "not_checked" },
      careersEvidence: null,
    });
  }

  // SEC corroboration — attempted once, offered to every Layer-2 candidate as a conditional
  // (never self-sufficient) authoritative signal. A no-match here (the common case for private
  // employers) is expected, not an error, and simply means Layer 2 relies on Path B instead.
  const sec = await findSecCorroboration(employerNameRaw, { urlOverride: options.secUrlOverride });

  // LAYER 2 — small, conservative generated-candidate set, each independently verified.
  const candidates = generateDomainCandidates(employerNameRaw);
  for (const candidate of candidates) {
    const verified = await verifyDomainIdentity({
      domain: candidate,
      employerNameRaw,
      authoritative: { secConfirmed: sec.matched },
      allowPrivateNetworksForTests: options.allowPrivateNetworksForTests,
      rootUrlOverride: options.verifyRootUrlOverride,
    });
    if (verified.status === "VERIFIED") return verified;
    considerFallback(verified);
  }

  return (
    bestFallback ?? {
      status: "UNRESOLVED",
      domain: null,
      method: "unresolved",
      confidence: null,
      evidence: ["no_candidates_generated"],
      channelsChecked: { jsonLd: "not_checked", footer: "not_checked", aboutPage: "not_checked", termsPrivacyPage: "not_checked" },
      careersEvidence: null,
    }
  );
}
