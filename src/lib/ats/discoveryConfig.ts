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

// --- Tier 3: bounded browser-rendered discovery fallback (src/lib/ats/discoveryBrowser.ts) -----
// Only ever invoked when Tier 1/2 (above) resolve UNRESOLVED — never the default path. Playwright
// is far more expensive per page than a safeFetch call, so these bounds are deliberately TIGHTER
// than Tier 1/2's, not a copy of them: at most one followed link ("at most 1 deterministic
// discovery click" per the approved design), not up to two hops.

/** Max distinct rendered pages for one Tier-3 attempt: the seed page plus at most ONE followed
 *  careers/jobs-shaped link. Never an arbitrary crawl. */
export const MAX_BROWSER_DISCOVERY_PAGES = 2;

/** Max link-following depth from the seed page — exactly one bounded "click" (a direct navigation
 *  to the highest-scoring careers/jobs link, never a DOM click on an arbitrary element). */
export const MAX_BROWSER_DISCOVERY_DEPTH = 1;

/** Per-page navigation timeout (ms) — mirrors genericPlaywright.ts's own convention, slightly
 *  tighter so two pages comfortably fit inside BROWSER_DISCOVERY_TIMEOUT_MS below. */
export const BROWSER_PAGE_TIMEOUT_MS = 15_000;

/** Overall wall-clock budget (ms) for one Tier-3 attempt, covering browser launch + every
 *  navigation + all inspection — enforced independently of the per-page timeout above, so a
 *  string of individually-fast-but-numerous operations still can't exceed this. */
export const BROWSER_DISCOVERY_TIMEOUT_MS = 30_000;
