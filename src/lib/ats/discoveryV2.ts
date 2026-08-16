import { chromium } from "playwright";
import {
  BROWSER_DISCOVERY_TIMEOUT_MS,
  BROWSER_PAGE_TIMEOUT_MS,
  MAX_V2_OBSERVED_REQUESTS,
  MAX_V2_REDIRECT_CHAIN,
} from "@/lib/ats/discoveryConfig";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { detectUnsupportedAts, findEmbeddedAtsUrl, findEmbeddedUnsupportedAtsUrl, scoreCareersLink } from "@/lib/ats/discovery";
import type { SupportedProvider } from "@/lib/ats/pendingConnectorValidation";
import { validateJobSample } from "@/lib/ats/pendingConnectorValidation";
import { fetchJobsForCompany } from "@/lib/normalize";
import { isUrlSafeForNavigation } from "@/lib/net/safeFetch";
import { categorizeThrownError } from "@/lib/scan/errors";
import type { Company, SourceType } from "@/types";

/**
 * Discovery V2 — shadow-mode, multi-signal browser discovery. NOT a competing discovery engine:
 * every ATS/unsupported-ATS detection call is the exact same detectAtsFromUrlString/
 * detectUnsupportedAts/findEmbeddedAtsUrl/findEmbeddedUnsupportedAtsUrl functions Tier 1/2/3
 * (discovery.ts/discoveryBrowser.ts) already use — this module adds no new provider-signature
 * registry. What it adds on top of Tier 3: it does not stop at the first signal found. It collects
 * EVERY signal from ONE rendered page load — static HTML, rendered anchors/iframes/script/form
 * URLs (via findEmbeddedAtsUrl over the rendered document, which already scans every attribute),
 * same-origin and cross-origin iframe documents (page.frames()), every network request the page
 * issued (React/XHR-loaded ATS endpoints invisible to any HTML-based scan), and the full client-side
 * redirect chain — then deduplicates by (provider, board identity) into candidates, validates each
 * with a real bounded sample fetch, and assigns deterministic confidence. Still only ever visits ONE
 * page — never follows a link, exactly like Tier 3's "read-only-first, at most one bounded click"
 * design, just deeper per page instead of wider across pages.
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
  | "NAVIGATION_FAILED";

export interface DiscoveryV2Candidate {
  provider: Exclude<SourceType, "career_link">;
  boardToken: string;
  canonicalUrl: string | null;
  evidenceTypes: EvidenceType[];
  evidenceUrls: string[];
  validationStatus: ValidationStatus;
  jobsSeen: number;
  confidence: ConfidenceLevel;
  recommendation: DiscoveryV2Recommendation;
}

export interface DiscoveryV2Result {
  companyId: number | null;
  seedUrl: string;
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

const SUPPORTED_PROVIDERS = new Set<SupportedProvider>([
  "greenhouse", "lever", "ashby", "workday", "smartrecruiters", "adp_wfn", "adp_rm", "eightfold",
  "cornerstone", "avature", "paylocity", "icims", "ukg_pro", "bamboohr", "oracle_recruiting_cloud",
  "workable", "rippling", "paycom", "jazzhr", "jobvite", "breezy", "teamtailor", "applicantpro",
  "pinpoint", "clearcompany", "personio", "applicantstack", "comeet", "cats", "gohire", "newton",
  "silkroad", "jobdiva", "taleo", "phenom", "successfactors",
]);

function candidateKey(sourceType: Exclude<SourceType, "career_link">, boardToken: string): string {
  return `${sourceType}:${boardToken}`;
}

interface RawSignal {
  sourceType: Exclude<SourceType, "career_link">;
  boardToken: string;
  canonicalUrl: string | null;
  evidenceType: EvidenceType;
  evidenceUrl: string;
}

/** Deduplicates raw signals into candidates keyed by (provider, board identity), never by raw URL —
 *  see this module's doc comment's Greenhouse iframe/XHR/script-src example. Preserves every distinct
 *  evidence type/URL a candidate was seen through. */
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

export async function discoverCompanySourceV2(
  company: Company,
  seedUrl: string,
  options: DiscoverCompanySourceV2Options = {}
): Promise<DiscoveryV2Result> {
  const allowPrivateNetworksForTests = options.allowPrivateNetworksForTests ?? false;
  const validator = options.validator ?? validateCandidate;
  const startedAt = Date.now();
  // Unlike Tier 3, V2 does real per-CANDIDATE validation fetches (up to 15s each) on top of the page
  // render — with several candidates found on one page, that can add up well past a single page's
  // own timeout, so the same overall wall-clock budget Tier 3 enforces across multiple page loads is
  // enforced here across the validation loop instead.
  const budgetExceeded = () => Date.now() - startedAt > BROWSER_DISCOVERY_TIMEOUT_MS;

  if (!(await isUrlSafeForNavigation(seedUrl, allowPrivateNetworksForTests))) {
    return {
      companyId: company.id, seedUrl, finalUrl: null, candidates: [], bestGenericJobsUrl: null,
      suspectedUnsupportedAts: null,
      durationMs: Date.now() - startedAt, observedRequestCount: 0, redirectChain: [],
      outcome: "SECURITY_REJECTED", reason: `Refused to launch Discovery V2 against an unsafe seed URL: ${seedUrl}`,
    };
  }

  const browser = await chromium.launch({ headless: true });
  const signals: RawSignal[] = [];
  const observedRequestUrls = new Set<string>();
  const redirectChain: string[] = [];

  function pushDetection(detection: ReturnType<typeof detectAtsFromUrlString>, evidenceType: EvidenceType, evidenceUrl: string) {
    if (!detection) return;
    signals.push({
      sourceType: detection.sourceType,
      boardToken: detection.atsBoardToken,
      canonicalUrl: detection.canonicalSourceUrl ?? null,
      evidenceType,
      evidenceUrl,
    });
  }

  try {
    const page = await browser.newPage({ userAgent: V2_USER_AGENT });

    // Network-request sniffer (Phase 3) + the same per-navigation SSRF gate Tier 3 uses — a single
    // route handler does both: every request is safety-checked before it's ever allowed through, and
    // (bounded) its URL is inspected for an ATS signature regardless of whether it ever touches the
    // DOM. Response bodies are never read here — URL inspection only.
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      const safe = await isUrlSafeForNavigation(url, allowPrivateNetworksForTests);
      if (!safe) {
        await route.abort();
        return;
      }
      if (observedRequestUrls.size < MAX_V2_OBSERVED_REQUESTS && !observedRequestUrls.has(url)) {
        observedRequestUrls.add(url);
        pushDetection(detectAtsFromUrlString(url), "NETWORK_REQUEST", url);
      }
      await route.continue();
    });

    // Client-side redirect chain (Phase 6) — every top-frame navigation during this one page load,
    // bounded so a pathological self-redirecting page can't grow this unboundedly.
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      if (redirectChain.length >= MAX_V2_REDIRECT_CHAIN) return;
      const url = frame.url();
      if (redirectChain[redirectChain.length - 1] === url) return;
      redirectChain.push(url);
      pushDetection(detectAtsFromUrlString(url), "REDIRECT_TARGET", url);
    });

    try {
      await page.goto(seedUrl, { waitUntil: "networkidle", timeout: BROWSER_PAGE_TIMEOUT_MS });
    } catch {
      return {
        companyId: company.id, seedUrl, finalUrl: null, candidates: [], bestGenericJobsUrl: null,
        suspectedUnsupportedAts: null,
        durationMs: Date.now() - startedAt, observedRequestCount: observedRequestUrls.size, redirectChain,
        outcome: "NAVIGATION_FAILED", reason: `Browser navigation failed for ${seedUrl}`,
      };
    }

    const finalUrl = page.url();
    pushDetection(detectAtsFromUrlString(finalUrl), "REDIRECT_TARGET", finalUrl);

    // Rendered DOM (Phase 4) — findEmbeddedAtsUrl scans the WHOLE rendered document text for any
    // http(s) token, which already covers <a href>, <script src>, <form action>, and same-document
    // iframe src attributes — reused as-is, not reimplemented.
    const html = await page.content();
    const embedded = findEmbeddedAtsUrl(html);
    if (embedded) pushDetection({ sourceType: embedded.sourceType, atsBoardToken: embedded.atsBoardToken, canonicalSourceUrl: embedded.url }, "STATIC_HTML", embedded.url);
    let unsupportedName: string | null = null;
    let unsupportedUrl: string | null = null;
    const embeddedUnsupported = findEmbeddedUnsupportedAtsUrl(html);
    if (embeddedUnsupported) {
      unsupportedName = embeddedUnsupported.name;
      unsupportedUrl = embeddedUnsupported.url;
    }
    const finalUnsupported = detectUnsupportedAts(finalUrl);
    if (finalUnsupported && !unsupportedName) {
      unsupportedName = finalUnsupported;
      unsupportedUrl = finalUrl;
    }

    // Frames/iframes (Phase 5) — same-origin and cross-origin frame documents the main-document scan
    // above cannot see into. A detected ATS here is still just a candidate, never auto-trusted.
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const frameUrl = frame.url();
      pushDetection(detectAtsFromUrlString(frameUrl), "IFRAME", frameUrl);
      try {
        const frameHtml = await frame.content();
        const frameEmbedded = findEmbeddedAtsUrl(frameHtml);
        if (frameEmbedded) {
          pushDetection(
            { sourceType: frameEmbedded.sourceType, atsBoardToken: frameEmbedded.atsBoardToken, canonicalSourceUrl: frameEmbedded.url },
            "IFRAME",
            frameEmbedded.url
          );
        }
      } catch {
        // Cross-origin/detached frame content occasionally throws — evidence from the frame's own
        // URL (already captured above) is still retained; this is not a fatal error for the attempt.
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

    // Same "does this URL itself look jobs-shaped" gate Tier 1/2/3 use before treating a reachable
    // page as a generic-scrape candidate — a page that merely LOADED (e.g. an unrelated homepage
    // with no careers signal at all) must resolve NO_SOURCE_FOUND, not be silently promoted to
    // GENERIC_ONLY just because it rendered successfully.
    const looksLikeJobsUrl = scoreCareersLink({ url: finalUrl, text: "" }) > 0;
    const bestGenericJobsUrl = candidates.length === 0 && unsupportedName === null && looksLikeJobsUrl ? finalUrl : null;

    let outcome: DiscoveryV2Outcome;
    let reason: string;
    if (candidates.length > 0) {
      outcome = "STRUCTURED_CANDIDATE_FOUND";
      reason = `Found ${candidates.length} deduplicated ATS candidate(s) from ${signals.length} raw signal(s) across static HTML, network requests, frames, and redirects.`;
    } else if (unsupportedName) {
      outcome = "GENERIC_ONLY";
      reason = `Recognized-but-unsupported ATS platform detected: ${unsupportedName} at ${unsupportedUrl}`;
    } else if (bestGenericJobsUrl) {
      outcome = "GENERIC_ONLY";
      reason = `No known ATS signature found across any signal; rendered page reached at ${bestGenericJobsUrl}`;
    } else {
      outcome = "NO_SOURCE_FOUND";
      reason = `Rendered ${seedUrl} but found no ATS signature in static HTML, network requests, frames, or the redirect chain.`;
    }

    return {
      companyId: company.id, seedUrl, finalUrl, candidates, bestGenericJobsUrl,
      suspectedUnsupportedAts: unsupportedName,
      durationMs: Date.now() - startedAt, observedRequestCount: observedRequestUrls.size, redirectChain,
      outcome, reason,
    };
  } finally {
    await browser.close();
  }
}
