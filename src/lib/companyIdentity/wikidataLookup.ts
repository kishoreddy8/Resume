import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { ScanConnectorError } from "@/lib/scan/errors";

/**
 * Layer 1 of the domain-resolution waterfall (see resolveDomain.ts): confidently-disambiguated
 * Wikidata entity lookup for an official website (P856). Never "search label -> first result ->
 * P856" — see disambiguateEntities below, which requires either exactly one distinct organization
 * entity, or multiple entities that all agree on the same website, before returning a domain at
 * all. Multiple entities with DIFFERING websites is AMBIGUOUS, never a guess.
 *
 * IMPLEMENTATION NOTE (found via this phase's own live-validation step, not assumed): a single raw
 * SPARQL query combining a label-text FILTER with an instance-of-organization check is a well-known
 * WDQS anti-pattern — FILTER(LCASE(STR(?label)) = ...) forces a full unindexed scan across every
 * label triple in Wikidata, which timed out repeatedly against the real endpoint during live
 * testing (30s+, hitting both WIKIDATA_QUERY_TIMEOUT_MS attempts). This module instead uses
 * Wikidata's actual search index via two small, fast, indexed calls:
 *   1. `wbsearchentities` (MediaWiki Action API) — real text search, sub-second, returns a bounded
 *      candidate QID list.
 *   2. `wbgetentities` — batched, indexed lookup of those specific QIDs' claims (P31/P856), also
 *      sub-second regardless of the size of Wikidata as a whole.
 * Entities are then filtered to organization-shaped P31 values and disambiguated exactly as
 * before. Both calls together are still one bounded "lookup" from the caller's perspective and
 * still respect the same low-concurrency/cache/backoff posture described below.
 *
 * Rate-limit posture (corrected against Wikidata's actual documented behavior — a hard ~60s
 * per-query timeout and a 5-parallel-queries-per-IP cap, NOT a cumulative per-minute budget):
 * small bounded requests, a short client-side timeout well under any server-side deadline, at most
 * one retry per call (never aggressive), and a process-local cache so the same employer is never
 * queried twice in one run. Concurrency across employers is the CALLER's responsibility (see
 * src/lib/discovery/batch.ts's WIKIDATA_CONCURRENCY) — this module issues one lookup at a time.
 */

const WIKIDATA_SEARCH_ENDPOINT = "https://www.wikidata.org/w/api.php";
const WIKIDATA_TIMEOUT_MS = 8_000; // both calls are indexed lookups — should finish in well under a second
const WIKIDATA_MAX_ATTEMPTS = 2; // 1 initial + 1 retry — deliberately not aggressive
const WIKIDATA_USER_AGENT = "CareerOpsDiscoveryBot/1.0 (local personal job-search tool)";
const SEARCH_CANDIDATE_LIMIT = 5; // small, bounded — this is a disambiguation aid, not a survey

// Organization-shaped P31 (instance of) values, checked by DIRECT equality — deliberately NOT a
// wdt:P279* transitive "subclass of organization" walk (that's the exact slow pattern described
// above). A small, explicit VALUES-style set is both fast and sufficient to exclude a same-named
// person/place/legal-case/publication from the candidate set: business (Q4830453), company
// (Q783794), enterprise (Q6881511), organization (Q43229), public company (Q891723), corporation
// (Q1616075/Q1058914 — both used in practice across different entities).
const ORGANIZATION_TYPE_QIDS = new Set(["Q4830453", "Q783794", "Q6881511", "Q43229", "Q891723", "Q1616075", "Q1058914"]);

export interface WikidataEntity {
  qid: string;
  label: string;
  website: string | null;
}

export type WikidataLookupStatus = "single_match" | "ambiguous" | "no_match" | "error";

export interface WikidataLookupResult {
  status: WikidataLookupStatus;
  /** Only set when status is "single_match" AND the matched entity/entities have a website. */
  domain: string | null;
  entities: WikidataEntity[];
}

interface SearchEntityResult {
  id: string;
  display?: { label?: { value: string } };
  match?: { type: string; text: string };
}

interface SearchResponse {
  search: SearchEntityResult[];
}

/** Pure — keeps only candidates whose match text is an exact (case-insensitive) label/alias match
 *  for the query, discarding fuzzy/description/partial matches (e.g. "Microsoft Knowledge Base"
 *  fuzzy-matching a search for "Microsoft Corporation"). */
export function filterExactSearchMatches(results: SearchEntityResult[], normalizedQuery: string): { qid: string; label: string }[] {
  const seen = new Set<string>();
  const out: { qid: string; label: string }[] = [];
  for (const r of results) {
    if (seen.has(r.id)) continue;
    const matchType = r.match?.type;
    const matchText = r.match?.text;
    if ((matchType !== "label" && matchType !== "alias") || !matchText) continue;
    if (matchText.trim().toLowerCase() !== normalizedQuery) continue;
    seen.add(r.id);
    out.push({ qid: r.id, label: r.display?.label?.value ?? r.id });
  }
  return out;
}

interface EntityClaims {
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>;
}

interface GetEntitiesResponse {
  entities: Record<string, EntityClaims>;
}

/** Pure — extracts P31 QIDs and the first P856 (website) string from a wbgetentities claims
 *  block, defensively (any missing/malformed field is simply absent, never throws). */
export function extractP31AndWebsite(entity: EntityClaims): { p31: string[]; website: string | null } {
  const p31Claims = entity.claims?.P31 ?? [];
  const p31 = p31Claims
    .map((c) => {
      const v = c.mainsnak?.datavalue?.value;
      return v && typeof v === "object" && "id" in v ? String((v as { id: unknown }).id) : null;
    })
    .filter((v): v is string => v !== null);

  const p856Claims = entity.claims?.P856 ?? [];
  const website = p856Claims.length > 0 && typeof p856Claims[0].mainsnak?.datavalue?.value === "string"
    ? (p856Claims[0].mainsnak!.datavalue!.value as string)
    : null;

  return { p31, website };
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Pure — the disambiguation rule. Zero entities -> no_match. Entities with no website at all ->
 * no_match (nothing to resolve, but not a conflict either). Entities whose websites disagree ->
 * ambiguous, never a guess. Otherwise (one entity, or several that all agree on the same website)
 * -> single_match.
 */
export function disambiguateEntities(entities: WikidataEntity[]): WikidataLookupResult {
  if (entities.length === 0) {
    return { status: "no_match", domain: null, entities };
  }

  const domains = new Set(
    entities
      .map((e) => (e.website ? extractDomain(e.website) : null))
      .filter((d): d is string => d !== null)
  );

  if (domains.size === 0) {
    return { status: "no_match", domain: null, entities };
  }
  if (domains.size > 1) {
    return { status: "ambiguous", domain: null, entities };
  }
  return { status: "single_match", domain: Array.from(domains)[0], entities };
}

const lookupCache = new Map<string, WikidataLookupResult>();

export function clearWikidataLookupCache(): void {
  lookupCache.clear();
}

export interface LookupWikidataOptions {
  /** Testing-only: overrides the https://www.wikidata.org/w/api.php endpoint so tests can point at
   *  a local HTTP server instead of the real MediaWiki API — same pattern as every ATS connector's
   *  own hostOverride option. Production callers never pass this. */
  endpointOverride?: string;
}

async function callWikidataApi<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = `${endpoint}?${new URLSearchParams({ ...params, format: "json" }).toString()}`;
  const res = await fetchWithRetry(
    url,
    { headers: { Accept: "application/json", "User-Agent": WIKIDATA_USER_AGENT } },
    { maxAttempts: WIKIDATA_MAX_ATTEMPTS, timeoutMs: WIKIDATA_TIMEOUT_MS }
  );
  return parseJsonOrThrow<T>(res, url);
}

/**
 * Network-calling orchestration: search -> batched entity-claims fetch -> filter to
 * organization-shaped types -> disambiguate. Never throws — any request failure (timeout, network
 * error, non-2xx, malformed body) resolves to status "error" so the waterfall simply falls through
 * to the next layer, exactly like discovery.ts's own "never fabricate, never crash" posture.
 * Successful results (including no_match/ambiguous) are cached per-process so the same employer is
 * never queried twice within one run.
 */
export async function lookupWikidataEntity(normalizedName: string, options: LookupWikidataOptions = {}): Promise<WikidataLookupResult> {
  const cached = lookupCache.get(normalizedName);
  if (cached) return cached;

  const endpoint = options.endpointOverride ?? WIKIDATA_SEARCH_ENDPOINT;
  const normalizedQuery = normalizedName.trim().toLowerCase();

  let result: WikidataLookupResult;
  try {
    const searchRes = await callWikidataApi<SearchResponse>(endpoint, {
      action: "wbsearchentities",
      search: normalizedName,
      language: "en",
      type: "item",
      limit: String(SEARCH_CANDIDATE_LIMIT),
    });
    const exactCandidates = filterExactSearchMatches(searchRes.search ?? [], normalizedQuery);

    if (exactCandidates.length === 0) {
      result = { status: "no_match", domain: null, entities: [] };
    } else {
      const detailsRes = await callWikidataApi<GetEntitiesResponse>(endpoint, {
        action: "wbgetentities",
        ids: exactCandidates.map((c) => c.qid).join("|"),
        props: "claims",
      });
      const entities: WikidataEntity[] = [];
      for (const candidate of exactCandidates) {
        const entity = detailsRes.entities?.[candidate.qid];
        if (!entity) continue;
        const { p31, website } = extractP31AndWebsite(entity);
        if (!p31.some((t) => ORGANIZATION_TYPE_QIDS.has(t))) continue; // not organization-shaped
        entities.push({ qid: candidate.qid, label: candidate.label, website });
      }
      result = disambiguateEntities(entities);
    }
  } catch (err) {
    if (!(err instanceof ScanConnectorError) && !(err instanceof Error)) throw err;
    result = { status: "error", domain: null, entities: [] };
  }

  lookupCache.set(normalizedName, result);
  return result;
}
