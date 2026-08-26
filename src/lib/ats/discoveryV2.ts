import { chromium, type Page } from "playwright";
import {
  BROWSER_PAGE_TIMEOUT_MS,
  MAX_V2_OBSERVED_REQUESTS,
  MAX_V2_PAGES,
  MAX_V2_REDIRECT_CHAIN,
  MAX_V2_TOTAL_BUDGET_MS,
  V2_CONTENT_READ_TIMEOUT_MS,
  V2_RENDER_GRACE_MS,
  V2_SAFETY_CHECK_TIMEOUT_MS,
} from "@/lib/ats/discoveryConfig";
import { DISCOVERY_CONNECTOR_PROVIDERS } from "@/lib/ats/scannableProviders";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { detectUnsupportedAts, findBestCareersLink, findEmbeddedAtsUrl, findEmbeddedUnsupportedAtsUrl, scoreCareersLink } from "@/lib/ats/discovery";
import type { SupportedProvider } from "@/lib/ats/pendingConnectorValidation";
import { validateJobSample } from "@/lib/ats/pendingConnectorValidation";
import { hostnameOf, sameRegistrableDomain } from "@/lib/ats/sourceRediscovery";
import { fetchJobsForCompany } from "@/lib/normalize";
import { isUrlSafeForNavigation } from "@/lib/net/safeFetch";
import { categorizeThrownError } from "@/lib/scan/errors";
import type { Company, SourceType } from "@/types";

/**
 * Discovery V2, Stage 2 — adds exactly ONE bounded careers-link follow on top of Stage 1's
 * multi-signal single-page inspection. NOT a competing discovery engine: careers-link selection
 * reuses findBestCareersLink/scoreCareersLink from discovery.ts (the exact same scorer Tier 1/2/3
 * already use), never a second scoring implementation. The flow:
 *
 *   seed page -> full signal collection -> candidate found? stop here.
 *                                        -> none found? pick the single best first-party
 *                                           careers/jobs link (if any) -> follow it (max once,
 *                                           never recursive) -> full signal collection again.
 *
 * Every bound (observed requests, redirect chain, candidate validations, overall wall-clock budget)
 * applies across the WHOLE company attempt, both pages combined — never reset or doubled per page.
 *
 * SHADOW MODE: this module never writes to companies/job_sources/jobs or any other production
 * table. Its output is a report, not an action.
 */

export type EvidenceType =
  | "STATIC_HTML"
  | "RENDERED_ANCHOR"
  | "SCRIPT_SRC"
  | "IFRAME"
  | "NETWORK_REQUEST"
  | "REDIRECT_TARGET"
  | "FORM_ACTION";

export type ValidationStatus =
  | "VALIDATED_JOBS"
  | "VALIDATED_ZERO_JOBS"
  | "VALIDATION_FAILED"
  | "SECURITY_REJECTED"
  | "UNSUPPORTED"
  | "NOT_ATTEMPTED";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export type DiscoveryV2Recommendation = "AUTO_REPLACE_CANDIDATE" | "NEEDS_SOURCE_REVIEW" | "NO_REPLACEMENT_FOUND";

export type DiscoveryV2Outcome =
  | "STRUCTURED_CANDIDATE_FOUND"
  | "GENERIC_ONLY"
  | "NO_SOURCE_FOUND"
  | "SECURITY_REJECTED"
  | "NAVIGATION_FAILED"
  | "INVALID_SEED_RESOURCE";

export type DiscoveryV2Page = "seed" | "followed";

export interface DiscoveryV2Candidate {
  provider: Exclude<SourceType, "career_link">;
  boardToken: string;
  canonicalUrl: string | null;
  evidenceTypes: EvidenceType[];
  evidenceUrls: string[];
  /** Which page first produced a signal for this candidate — "seed" if found without ever needing
   *  to follow the careers link, "followed" if only the second page revealed it. */
  foundOnPage: DiscoveryV2Page;
  validationStatus: ValidationStatus;
  jobsSeen: number;
  confidence: ConfidenceLevel;
  recommendation: DiscoveryV2Recommendation;
}

export interface DiscoveryV2Result {
  companyId: number | null;
  seedUrl: string;
  seedFinalUrl: string | null;
  /** The single careers/jobs link Discovery V2 chose to follow, if any — null when a candidate was
   *  already found on the seed page (no follow needed) or no qualifying link existed. */
  followedCareersUrl: string | null;
  followedFinalUrl: string | null;
  /** The score findBestCareersLink's own scoreCareersLink assigned the followed link, when one was
   *  followed — exposes the exact same deterministic scoring Tier 1/2/3 use, not a new metric. */
  careersLinkScore: number | null;
  pagesVisited: number;
  /** @deprecated kept for Stage 1 caller compatibility — equals seedFinalUrl unless a page was
   *  followed, in which case it equals followedFinalUrl (the "final" page of the whole attempt). */
  finalUrl: string | null;
  candidates: DiscoveryV2Candidate[];
  bestGenericJobsUrl: string | null;
  /** A recognized-but-unsupported ATS platform name (see discovery.ts's detectUnsupportedAts) found
   *  through any signal — distinct from candidates[], which only ever holds providers CareerOps
   *  already supports. Never null alongside a non-empty candidates[] in practice. */
  suspectedUnsupportedAts: string | null;
  durationMs: number;
  observedRequestCount: number;
  redirectChain: string[];
  outcome: DiscoveryV2Outcome;
  reason: string;
}

/* ADMIN-OPS-3.2.1 — derived, not restated. This was an eighth hand-written copy of the 37-provider
 * connector list, identical in membership to the authority but requiring lockstep edits with it; the
 * comment below already asserted the two were "built from the same provider set", which is now true
 * by construction rather than by convention. Membership is unchanged. */
const SUPPORTED_PROVIDERS = new Set<SupportedProvider>(
  DISCOVERY_CONNECTOR_PROVIDERS as readonly SupportedProvider[]
);

// Recognized non-HTML resource extensions — a career_page_url pointing at one of these (e.g. a PDF
// EEO notice, seen for real in Stage 1 production testing) can never contain a rendered careers DOM;
// launching Playwright against it wastes the whole page-timeout budget for a guaranteed failure.
const NON_HTML_EXTENSION_RE = /\.(pdf|docx?|jpe?g|png|gif|svg|zip|rar|7z|mp4|mp3|csv|xlsx?)(?:[?#]|$)/i;

function isLikelyNonHtmlResource(url: string): boolean {
  try {
    return NON_HTML_EXTENSION_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * isUrlSafeForNavigation, bounded (see V2_SAFETY_CHECK_TIMEOUT_MS's own doc comment for the real
 * production hang this fixes: a DNS lookup with no timeout of its own, run on every request a busy
 * page fires). A timeout is treated as "unsafe" — this can only make the check MORE conservative,
 * never less, since the caller's fallback for `false` is always "abort/refuse," matching exactly
 * what a genuine safety failure would do.
 */
async function isUrlSafeForNavigationBounded(url: string, allowPrivateNetworksForTests: boolean): Promise<boolean> {
  return Promise.race([
    isUrlSafeForNavigation(url, allowPrivateNetworksForTests),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), V2_SAFETY_CHECK_TIMEOUT_MS)),
  ]);
}

/**
 * page.content()/frame.content(), bounded (see V2_CONTENT_READ_TIMEOUT_MS's own doc comment for the
 * real production hang this fixes — a cross-origin iframe whose execution context never settles).
 * Returns null on timeout rather than throwing, matching how the existing try/catch around frame
 * inspection already treats a genuinely-thrown content() failure: the frame's own URL (captured
 * separately) is still retained as evidence even when its document content can't be read.
 */
export async function readContentBounded(target: { content: () => Promise<string> }): Promise<string | null> {
  return Promise.race([
    target.content(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), V2_CONTENT_READ_TIMEOUT_MS)),
  ]);
}

function candidateKey(sourceType: Exclude<SourceType, "career_link">, boardToken: string): string {
  return `${sourceType}:${boardToken}`;
}

interface RawSignal {
  sourceType: Exclude<SourceType, "career_link">;
  boardToken: string;
  canonicalUrl: string | null;
  evidenceType: EvidenceType;
  evidenceUrl: string;
  page: DiscoveryV2Page;
}

/** Deduplicates raw signals into candidates keyed by (provider, board identity), never by raw URL —
 *  see this module's doc comment's Greenhouse iframe/XHR/script-src example. Preserves every distinct
 *  evidence type/URL a candidate was seen through, and the FIRST page it was seen on. */
function dedupeSignals(signals: RawSignal[]): Map<string, DiscoveryV2Candidate> {
  const byKey = new Map<string, DiscoveryV2Candidate>();
  for (const signal of signals) {
    const key = candidateKey(signal.sourceType, signal.boardToken);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.evidenceTypes.includes(signal.evidenceType)) existing.evidenceTypes.push(signal.evidenceType);
      if (!existing.evidenceUrls.includes(signal.evidenceUrl)) existing.evidenceUrls.push(signal.evidenceUrl);
      if (!existing.canonicalUrl && signal.canonicalUrl) existing.canonicalUrl = signal.canonicalUrl;
    } else {
      byKey.set(key, {
        provider: signal.sourceType,
        boardToken: signal.boardToken,
        canonicalUrl: signal.canonicalUrl,
        evidenceTypes: [signal.evidenceType],
        evidenceUrls: [signal.evidenceUrl],
        foundOnPage: signal.page,
        validationStatus: "NOT_ATTEMPTED",
        jobsSeen: 0,
        confidence: "LOW",
        recommendation: "NEEDS_SOURCE_REVIEW",
      });
    }
  }
  return byKey;
}

/** Exported for direct unit testing of the UNSUPPORTED branch — every real ATS URL
 *  detectAtsFromUrlString can currently produce already has a matching entry in SUPPORTED_PROVIDERS
 *  (they're built from the same provider set), so that branch is unreachable through a real browser
 *  round-trip today; it exists defensively for a future SourceType added to detect.ts before its
 *  fetchJobsForCompany wiring lands. */
export async function validateCandidate(
  baseCompany: Company,
  candidate: DiscoveryV2Candidate
): Promise<{ status: ValidationStatus; jobsSeen: number }> {
  if (!SUPPORTED_PROVIDERS.has(candidate.provider as SupportedProvider)) {
    return { status: "UNSUPPORTED", jobsSeen: 0 };
  }
  const ephemeral: Company = { ...baseCompany, source_type: candidate.provider, ats_board_token: candidate.boardToken };
  try {
    const jobs = await fetchJobsForCompany(ephemeral, { maxJobs: 3, usOnly: true, maxAttempts: 2, timeoutMs: 15_000 });
    if (jobs.length === 0) return { status: "VALIDATED_ZERO_JOBS", jobsSeen: 0 };
    const sampleError = validateJobSample(jobs);
    return sampleError ? { status: "VALIDATION_FAILED", jobsSeen: jobs.length } : { status: "VALIDATED_JOBS", jobsSeen: jobs.length };
  } catch (err) {
    const category = categorizeThrownError(err);
    return { status: category === "blocked" ? "SECURITY_REJECTED" : "VALIDATION_FAILED", jobsSeen: 0 };
  }
}

/** Deterministic confidence — no numeric/AI scoring, an explicit rule set matching this module's
 *  own doc comment and the task's Phase 9 rules exactly. */
function deriveConfidence(candidate: DiscoveryV2Candidate): ConfidenceLevel {
  if (candidate.validationStatus === "SECURITY_REJECTED" || candidate.validationStatus === "UNSUPPORTED") return "LOW";
  if (candidate.validationStatus === "VALIDATION_FAILED" || candidate.validationStatus === "NOT_ATTEMPTED") return "LOW";
  if (candidate.validationStatus === "VALIDATED_JOBS") return "HIGH";
  // VALIDATED_ZERO_JOBS: a real, reachable, structurally valid board with nothing currently posted —
  // genuine positive evidence, just weaker than at least one real validated job.
  return "MEDIUM";
}

function deriveRecommendation(confidence: ConfidenceLevel): DiscoveryV2Recommendation {
  if (confidence === "HIGH") return "AUTO_REPLACE_CANDIDATE";
  if (confidence === "MEDIUM") return "NEEDS_SOURCE_REVIEW";
  return "NO_REPLACEMENT_FOUND";
}

export interface DiscoverCompanySourceV2Options {
  /** Test-only — see safeFetch's identical option. NEVER set true from production call sites. */
  allowPrivateNetworksForTests?: boolean;
  /** Test-only — skip real sample-fetch validation network calls; caller supplies validation results. */
  validator?: typeof validateCandidate;
}

const V2_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 CareerOpsDiscoveryV2Bot";

interface PageInspection {
  finalUrl: string;
  html: string;
}

export async function discoverCompanySourceV2(
  company: Company,
  seedUrl: string,
  options: DiscoverCompanySourceV2Options = {}
): Promise<DiscoveryV2Result> {
  const allowPrivateNetworksForTests = options.allowPrivateNetworksForTests ?? false;
  const validator = options.validator ?? validateCandidate;
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > MAX_V2_TOTAL_BUDGET_MS;

  const empty = (outcome: DiscoveryV2Outcome, reason: string, pagesVisited = 0): DiscoveryV2Result => ({
    companyId: company.id, seedUrl, seedFinalUrl: null, followedCareersUrl: null, followedFinalUrl: null,
    careersLinkScore: null, pagesVisited, finalUrl: null, candidates: [], bestGenericJobsUrl: null,
    suspectedUnsupportedAts: null, durationMs: Date.now() - startedAt, observedRequestCount: 0,
    redirectChain: [], outcome, reason,
  });

  // Phase 4: non-HTML seed handling — never launch a browser expecting a careers DOM from a PDF/
  // image/archive URL. No fallback URL is invented; CareerOps already has no other verified URL to
  // try here (the caller is responsible for passing a better seed, e.g. a homepage, if one exists).
  if (isLikelyNonHtmlResource(seedUrl)) {
    return empty("INVALID_SEED_RESOURCE", `Seed URL looks like a non-HTML resource, not a careers page: ${seedUrl}`);
  }

  if (!(await isUrlSafeForNavigationBounded(seedUrl, allowPrivateNetworksForTests))) {
    return empty("SECURITY_REJECTED", `Refused to launch Discovery V2 against an unsafe seed URL: ${seedUrl}`);
  }

  // Explicit launch timeout — defense in depth alongside the safety-check bound above, so a
  // resource-starved environment can't silently hang the whole attempt before a single page is
  // even opened (Playwright defaults to 30s if unset; making it explicit here keeps every bound in
  // this module visibly accounted for in one place, discoveryConfig.ts).
  const browser = await chromium.launch({ headless: true, timeout: MAX_V2_TOTAL_BUDGET_MS });
  // Shared across BOTH pages of this one company attempt — every bound applies to the whole
  // attempt, never reset per page (Phase 6).
  const signals: RawSignal[] = [];
  const observedRequestUrls = new Set<string>();
  const redirectChain: string[] = [];
  let pagesVisited = 0;
  // Set the MOMENT navigation to a page starts (not after it resolves) — an inline <script> tag runs
  // synchronously during HTML parsing and can fire a fetch() before page.goto()'s own promise
  // settles, so gating this label on a post-navigation counter mislabels early in-page requests as
  // belonging to the PREVIOUS page. Route/redirect listeners read this directly instead.
  let currentPageLabel: DiscoveryV2Page = "seed";

  function pushDetection(
    detection: ReturnType<typeof detectAtsFromUrlString>,
    evidenceType: EvidenceType,
    evidenceUrl: string,
    page: DiscoveryV2Page
  ) {
    if (!detection) return;
    signals.push({
      sourceType: detection.sourceType,
      boardToken: detection.atsBoardToken,
      canonicalUrl: detection.canonicalSourceUrl ?? null,
      evidenceType,
      evidenceUrl,
      page,
    });
  }

  /** Navigates one page and collects every V2 signal from it — the single per-page inspection
   *  routine both the seed page and (at most one) followed careers page call identically. Returns
   *  null on navigation failure. Route/redirect listeners write into the SHARED collections above,
   *  so bounds naturally apply across both invocations. */
  async function inspectPage(page: Page, url: string, label: DiscoveryV2Page): Promise<PageInspection | null> {
    currentPageLabel = label;
    try {
      // Timeout hardening (Phase 7, evidence-based — see V2_RENDER_GRACE_MS's own doc comment):
      // domcontentloaded is the hard requirement (fast and reliable even for continuously-polling
      // corporate SPAs), then a separately-bounded, non-fatal best-effort attempt at networkidle
      // captures whatever additional client-side rendering happens to settle within the grace
      // window — never blocking the whole attempt if the page never truly goes idle.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_PAGE_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: V2_RENDER_GRACE_MS }).catch(() => {});
    } catch {
      return null;
    }
    pagesVisited++;

    const finalUrl = page.url();
    pushDetection(detectAtsFromUrlString(finalUrl), "REDIRECT_TARGET", finalUrl, label);

    const html = (await readContentBounded(page)) ?? "";
    const embedded = findEmbeddedAtsUrl(html);
    if (embedded) {
      pushDetection(
        { sourceType: embedded.sourceType, atsBoardToken: embedded.atsBoardToken, canonicalSourceUrl: embedded.url },
        "STATIC_HTML",
        embedded.url,
        label
      );
    }

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const frameUrl = frame.url();
      pushDetection(detectAtsFromUrlString(frameUrl), "IFRAME", frameUrl, label);
      try {
        const frameHtml = await readContentBounded(frame);
        const frameEmbedded = frameHtml ? findEmbeddedAtsUrl(frameHtml) : null;
        if (frameEmbedded) {
          pushDetection(
            { sourceType: frameEmbedded.sourceType, atsBoardToken: frameEmbedded.atsBoardToken, canonicalSourceUrl: frameEmbedded.url },
            "IFRAME",
            frameEmbedded.url,
            label
          );
        }
      } catch {
        // Cross-origin/detached frame content occasionally throws — evidence from the frame's own
        // URL (already captured above) is still retained; this is not a fatal error for the attempt.
      }
    }

    return { finalUrl, html };
  }

  try {
    const page = await browser.newPage({ userAgent: V2_USER_AGENT });

    // Network-request sniffer (Stage 1, unchanged) + the same per-navigation SSRF gate Tier 3 uses —
    // one route handler does both, shared across both page loads of this attempt.
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      const safe = await isUrlSafeForNavigationBounded(url, allowPrivateNetworksForTests);
      if (!safe) {
        await route.abort();
        return;
      }
      if (observedRequestUrls.size < MAX_V2_OBSERVED_REQUESTS && !observedRequestUrls.has(url)) {
        observedRequestUrls.add(url);
        // Labeled by whichever page has been visited most recently when this request fires — good
        // enough for evidence purposes; a request straddling the exact moment of navigation is rare
        // and, either way, gets attributed to a real page in this attempt, never a phantom one.
        pushDetection(detectAtsFromUrlString(url), "NETWORK_REQUEST", url, currentPageLabel);
      }
      await route.continue();
    });

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      if (redirectChain.length >= MAX_V2_REDIRECT_CHAIN) return;
      const url = frame.url();
      if (redirectChain[redirectChain.length - 1] === url) return;
      redirectChain.push(url);
      pushDetection(detectAtsFromUrlString(url), "REDIRECT_TARGET", url, currentPageLabel);
    });

    const seedInspection = await inspectPage(page, seedUrl, "seed");
    if (!seedInspection) {
      return { ...empty("NAVIGATION_FAILED", `Browser navigation failed for ${seedUrl}`, pagesVisited), observedRequestCount: observedRequestUrls.size, redirectChain };
    }
    const seedFinalUrl = seedInspection.finalUrl;

    let unsupportedName: string | null = null;
    let unsupportedUrl: string | null = null;
    const seedEmbeddedUnsupported = findEmbeddedUnsupportedAtsUrl(seedInspection.html);
    if (seedEmbeddedUnsupported) {
      unsupportedName = seedEmbeddedUnsupported.name;
      unsupportedUrl = seedEmbeddedUnsupported.url;
    }
    const seedFinalUnsupported = detectUnsupportedAts(seedFinalUrl);
    if (seedFinalUnsupported && !unsupportedName) {
      unsupportedName = seedFinalUnsupported;
      unsupportedUrl = seedFinalUrl;
    }

    let followedCareersUrl: string | null = null;
    let followedFinalUrl: string | null = null;
    let careersLinkScore: number | null = null;

    // Phase 2: only follow a link when the seed page alone produced NO structured candidate — never
    // "just in case." Phase 6: never exceed MAX_V2_PAGES or the overall budget.
    const seedHasCandidate = dedupeSignals(signals).size > 0;
    if (!seedHasCandidate && !unsupportedName && pagesVisited < MAX_V2_PAGES && !budgetExceeded()) {
      const bestLink = findBestCareersLink(seedInspection.html, seedFinalUrl, seedFinalUrl);
      if (bestLink) {
        const score = scoreCareersLink({ url: bestLink, text: "" });
        // Phase 3: first-party safety. A link that's ITSELF already a recognized ATS URL is treated
        // as evidence directly by the seed-page scan above (findEmbeddedAtsUrl already covers every
        // href) and never needs a follow at all — this branch only ever fires for a same-company
        // careers/jobs page, not a third-party destination.
        const sameDomain = sameRegistrableDomain(hostnameOf(bestLink), hostnameOf(seedFinalUrl));
        if (sameDomain && (await isUrlSafeForNavigationBounded(bestLink, allowPrivateNetworksForTests))) {
          const followedInspection = await inspectPage(page, bestLink, "followed");
          followedCareersUrl = bestLink;
          careersLinkScore = score;
          if (followedInspection) {
            followedFinalUrl = followedInspection.finalUrl;
            const followedEmbeddedUnsupported = findEmbeddedUnsupportedAtsUrl(followedInspection.html);
            if (followedEmbeddedUnsupported && !unsupportedName) {
              unsupportedName = followedEmbeddedUnsupported.name;
              unsupportedUrl = followedEmbeddedUnsupported.url;
            }
            const followedFinalUnsupported = detectUnsupportedAts(followedInspection.finalUrl);
            if (followedFinalUnsupported && !unsupportedName) {
              unsupportedName = followedFinalUnsupported;
              unsupportedUrl = followedInspection.finalUrl;
            }
          }
        }
        // A cross-domain "best" link (e.g. a parent-company portal or aggregator) is deliberately
        // NOT followed — it remains unfollowed, review-only evidence per Phase 3; no signal is lost
        // since scoreCareersLink's own output isn't itself an ATS detection.
      }
    }

    const candidateMap = dedupeSignals(signals);
    const candidates = Array.from(candidateMap.values());

    for (const candidate of candidates) {
      if (budgetExceeded()) break; // remaining candidates stay NOT_ATTEMPTED/LOW rather than run unbounded
      const result = await validator(company, candidate);
      candidate.validationStatus = result.status;
      candidate.jobsSeen = result.jobsSeen;
      candidate.confidence = deriveConfidence(candidate);
      candidate.recommendation = deriveRecommendation(candidate.confidence);
    }

    const lastVisitedUrl = followedFinalUrl ?? seedFinalUrl;
    // Same "does this URL itself look jobs-shaped" gate Tier 1/2/3 use before treating a reachable
    // page as a generic-scrape candidate.
    const looksLikeJobsUrl = scoreCareersLink({ url: lastVisitedUrl, text: "" }) > 0;
    const bestGenericJobsUrl = candidates.length === 0 && unsupportedName === null && looksLikeJobsUrl ? lastVisitedUrl : null;

    let outcome: DiscoveryV2Outcome;
    let reason: string;
    if (candidates.length > 0) {
      outcome = "STRUCTURED_CANDIDATE_FOUND";
      reason = `Found ${candidates.length} deduplicated ATS candidate(s) from ${signals.length} raw signal(s) across ${pagesVisited} page(s) (static HTML, network requests, frames, redirects).`;
    } else if (unsupportedName) {
      outcome = "GENERIC_ONLY";
      reason = `Recognized-but-unsupported ATS platform detected: ${unsupportedName} at ${unsupportedUrl}`;
    } else if (bestGenericJobsUrl) {
      outcome = "GENERIC_ONLY";
      reason = `No known ATS signature found across any signal; rendered page reached at ${bestGenericJobsUrl}`;
    } else {
      outcome = "NO_SOURCE_FOUND";
      reason = `Rendered ${pagesVisited} page(s) from ${seedUrl} but found no ATS signature in static HTML, network requests, frames, or the redirect chain.`;
    }

    return {
      companyId: company.id, seedUrl, seedFinalUrl, followedCareersUrl, followedFinalUrl, careersLinkScore,
      pagesVisited, finalUrl: lastVisitedUrl, candidates, bestGenericJobsUrl, suspectedUnsupportedAts: unsupportedName,
      durationMs: Date.now() - startedAt, observedRequestCount: observedRequestUrls.size, redirectChain,
      outcome, reason,
    };
  } finally {
    await browser.close();
  }
}
