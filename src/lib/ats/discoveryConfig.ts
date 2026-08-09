/**
 * Bounded constants for the ATS discovery pipeline (src/lib/ats/discovery.ts) and the safeFetch
 * layer it's built on (src/lib/net/safeFetch.ts). Named/exported so every call site references the
 * same approved bounds — never a duplicated magic number. These are deliberately small: discovery
 * runs against a handful of companies at a time (see AGENTS.md's Phase 2.5 scope note — NOT the
 * 44k-employer scale-out), so "fast and safe" wins over "thorough."
 */

/** Max distinct pages fetched during one discovery attempt for one company (homepage, careers page,
 *  search/jobs page, ...). Never an unbounded crawl. */
export const MAX_DISCOVERY_PAGES = 3;

/** Max link-following depth from the input URL (e.g. homepage -> careers -> search jobs = depth 2). */
export const MAX_DISCOVERY_DEPTH = 2;

/** Max HTTP redirects safeFetch will follow for a single page fetch, revalidating every hop. */
export const MAX_REDIRECTS = 5;

/** Max response body size (bytes) safeFetch will buffer before aborting — protects against a
 *  malicious or misbehaving server streaming an unbounded response. */
export const MAX_RESPONSE_BYTES = 2_000_000;

/** Wall-clock budget (ms) for one safeFetch call, covering DNS + connect + all redirect hops + body
 *  read — not a per-hop timeout. */
export const DISCOVERY_TIMEOUT_MS = 10_000;
