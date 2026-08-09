import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { ScanConnectorError } from "@/lib/scan/errors";
import { normalizeEmployerName } from "@/lib/h1b/normalizeEmployerName";

/**
 * SEC EDGAR — CORROBORATION ONLY (see resolveDomain.ts/verifyDomain.ts). This module never answers
 * "employer name -> official website"; SEC's free, no-key company_tickers.json has no website field
 * at all. It only answers "does this legal-entity name correspond to a real SEC-registered filer" —
 * one optional, additive signal inside the Domain Verification Gate, never its own resolution layer
 * and never sufficient on its own to produce a domain.
 *
 * Uses the single static company_tickers.json file (all SEC-registered exchange-listed companies —
 * ticker/title/CIK, no website) rather than a per-employer full-text-search call: this means the
 * ENTIRE lookup surface is fetched and cached once per process, not once per employer, which is by
 * far the most bounded/fair-access-friendly way to use this data (SEC's fair-access policy: a real
 * User-Agent identifying the caller, <=10 req/s — a once-per-process fetch trivially respects that).
 * Coverage is inherently small (SEC-registered public companies only) — most H1B employers
 * (private companies, staffing firms, subsidiaries) will correctly get no_match here, which is
 * expected, not a failure.
 */

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_TIMEOUT_MS = 15_000;
const SEC_MAX_ATTEMPTS = 2;
// SEC's fair-access policy requires a real identifying User-Agent (not a generic browser UA) —
// see https://www.sec.gov/os/webmaster-faq#developers. This is a local, personal, non-commercial
// tool; the contact is the project owner's own address, not a fabricated identity.
const SEC_USER_AGENT = "CareerOpsDiscoveryBot/1.0 (personal local job-search tool; contact iamsaikishorereddy@gmail.com)";

interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface SecCorroborationResult {
  matched: boolean;
  cik: string | null;
  title: string | null;
  ticker: string | null;
}

let tickersCache: Map<string, SecTickerEntry> | null = null; // keyed by normalizeEmployerName(title)
let tickersCachePromise: Promise<Map<string, SecTickerEntry>> | null = null;

export function clearSecTickersCache(): void {
  tickersCache = null;
  tickersCachePromise = null;
}

export interface FindSecCorroborationOptions {
  /** Testing-only: overrides the https://www.sec.gov/files/company_tickers.json URL so tests can
   *  point at a local HTTP server instead of the real SEC host — same pattern as every ATS
   *  connector's own hostOverride option. Production callers never pass this. */
  urlOverride?: string;
}

async function fetchTickers(url: string): Promise<Map<string, SecTickerEntry>> {
  const res = await fetchWithRetry(
    url,
    { headers: { Accept: "application/json", "User-Agent": SEC_USER_AGENT } },
    { maxAttempts: SEC_MAX_ATTEMPTS, timeoutMs: SEC_TIMEOUT_MS }
  );
  const json = await parseJsonOrThrow<Record<string, SecTickerEntry>>(res, url);
  const byNormalizedTitle = new Map<string, SecTickerEntry>();
  for (const entry of Object.values(json)) {
    const normalized = normalizeEmployerName(entry.title);
    if (normalized && !byNormalizedTitle.has(normalized)) byNormalizedTitle.set(normalized, entry);
  }
  return byNormalizedTitle;
}

async function getTickers(url: string): Promise<Map<string, SecTickerEntry>> {
  if (tickersCache) return tickersCache;
  if (!tickersCachePromise) {
    tickersCachePromise = fetchTickers(url).catch((err) => {
      tickersCachePromise = null; // allow a later call to retry rather than caching a failure forever
      throw err;
    });
  }
  tickersCache = await tickersCachePromise;
  return tickersCache;
}

/**
 * Never throws — a fetch failure (network/timeout/parse) resolves to a not-matched result, exactly
 * like wikidataLookup's "error" posture. Matching is exact-normalized-name only (reuses
 * normalizeEmployerName, no fuzzy scoring here) — this is a corroboration signal, not a matcher in
 * its own right, so it deliberately stays conservative rather than reaching for the H1B fuzzy tier.
 */
export async function findSecCorroboration(employerNameRaw: string, options: FindSecCorroborationOptions = {}): Promise<SecCorroborationResult> {
  const normalized = normalizeEmployerName(employerNameRaw);
  if (!normalized) return { matched: false, cik: null, title: null, ticker: null };

  try {
    const tickers = await getTickers(options.urlOverride ?? SEC_TICKERS_URL);
    const entry = tickers.get(normalized);
    if (!entry) return { matched: false, cik: null, title: null, ticker: null };
    return { matched: true, cik: String(entry.cik_str), title: entry.title, ticker: entry.ticker };
  } catch (err) {
    if (!(err instanceof ScanConnectorError) && !(err instanceof Error)) throw err;
    return { matched: false, cik: null, title: null, ticker: null };
  }
}
