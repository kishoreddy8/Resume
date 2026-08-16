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

// --- Discovery V2: shadow-mode, multi-signal browser discovery (src/lib/ats/discoveryV2.ts) -----
// Same bounded-by-design philosophy as Tier 3 above, applied to a richer per-page inspection (network
// requests, iframes, redirect chain). Stage 2 adds exactly ONE bounded careers-link follow (mirroring
// Tier 3's own "at most one click" design) — never wider than that, and every bound below applies
// across the WHOLE company attempt (both pages combined), never reset or doubled per page.

/** Cap on how many distinct request URLs one Discovery V2 attempt will retain from network-request
 *  sniffing, ACROSS both the seed page and a followed careers page combined — bounds memory on a
 *  page that fires hundreds of analytics/asset requests; URLs beyond this cap are still
 *  safety-checked (never bypass isUrlSafeForNavigation) but not stored/inspected for ATS signatures
 *  once the cap is reached. Unchanged from Stage 1 — not doubled for the second page. */
export const MAX_V2_OBSERVED_REQUESTS = 200;

/** Cap on distinct top-frame navigation URLs recorded while following client-side redirect chains,
 *  ACROSS both pages combined — protects against a pathological page that navigates itself in a
 *  loop. Unchanged from Stage 1. */
export const MAX_V2_REDIRECT_CHAIN = 10;

/** Max distinct rendered pages for one Discovery V2 attempt: the seed page plus at most ONE followed
 *  careers/jobs-shaped link — exactly Tier 3's own "at most one click" bound, never a recursive
 *  crawl or a second follow. */
export const MAX_V2_PAGES = 2;

/**
 * Page-readiness strategy fix (Stage 2, evidence-based — see this constant's use in
 * discoveryV2.ts): waiting for Playwright's "networkidle" state timed out for continuously-polling
 * corporate SPAs in Stage 1 production testing (Under Armour, Microsoft) — confirmed via direct
 * diagnostic that both sites' DOM was ready in under 1s, but background analytics/chat-widget
 * telemetry kept firing requests indefinitely, so "0 network activity for 500ms" never arrived
 * within the page timeout. The fix is NOT a larger timeout (explicitly out of scope) — it's a better
 * readiness signal: treat "domcontentloaded" as the hard requirement (matches evidence: both sites
 * reached it in under 1s), then make a SEPARATELY-bounded, non-fatal best-effort attempt at
 * networkidle for whatever residual client-side rendering it captures, never blocking the whole
 * attempt if that never arrives.
 */
export const V2_RENDER_GRACE_MS = 5_000;

/** Overall wall-clock budget (ms) for one Discovery V2 attempt, covering browser launch + BOTH page
 *  loads + all inspection + every candidate validation fetch — enforced independently of any
 *  per-page timeout, so a string of individually-fast-but-numerous operations still can't exceed
 *  this. A modest, deliberate increase over Tier 3's single-page 30s budget to accommodate the one
 *  additional bounded page load Stage 2 adds — NOT a doubling of every Stage-1 limit. */
export const MAX_V2_TOTAL_BUDGET_MS = 40_000;

/**
 * Bounded timeout (ms) for the isUrlSafeForNavigation check the network-request route handler runs
 * on EVERY request a page fires. Found via a real production hang (Under Armour, Stage 2 shadow
 * testing): that check does a real DNS lookup (Node's dns.promises.lookup, which has NO built-in
 * timeout of its own) for every unique hostname, and a page with dozens of third-party
 * trackers/ad-network requests can include one whose DNS server never responds — hanging that one
 * request's safety check forever and, with it, the whole attempt (Playwright's own page.goto timeout
 * does not protect against a stuck request handler). A timed-out check fails CLOSED (treated as
 * unsafe, request aborted) — this only ever makes the check faster to give up, never less strict.
 */
export const V2_SAFETY_CHECK_TIMEOUT_MS = 3_000;

/**
 * Bounded timeout (ms) for page.content()/frame.content() calls. Found via a SECOND real production
 * hang (Under Armour again, after the DNS-check fix above resolved the first one): a cross-origin
 * ad/tracking/chat-widget iframe — common on a major e-commerce site — can leave its execution
 * context in a state where frame.content() never resolves (e.g. an ad iframe mid-reload-loop that
 * never settles), and unlike a thrown error, a hanging promise isn't caught by the existing
 * try/catch around frame inspection. Applies to both the main page and every iframe.
 */
export const V2_CONTENT_READ_TIMEOUT_MS = 5_000;
