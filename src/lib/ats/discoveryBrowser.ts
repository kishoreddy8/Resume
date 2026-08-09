import { chromium } from "playwright";
import {
  BROWSER_DISCOVERY_TIMEOUT_MS,
  BROWSER_PAGE_TIMEOUT_MS,
  MAX_BROWSER_DISCOVERY_DEPTH,
  MAX_BROWSER_DISCOVERY_PAGES,
} from "@/lib/ats/discoveryConfig";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import {
  detectUnsupportedAts,
  discoverCompanySource,
  findBestCareersLink,
  findEmbeddedAtsUrl,
  findEmbeddedUnsupportedAtsUrl,
  scoreCareersLink,
  type DiscoverCompanySourceOptions,
  type DiscoveryResult,
} from "@/lib/ats/discovery";
import { isUrlSafeForNavigation } from "@/lib/net/safeFetch";
import type { SourceType } from "@/types";

/**
 * Tier 3 — bounded, browser-rendered discovery fallback. ONLY invoked by discoverCompanySource
 * (discovery.ts) when Tier 1/2 (direct pattern match + bounded safeFetch HTML discovery) resolve
 * UNRESOLVED — never the default path, never run in parallel with Tier 1/2, never a replacement
 * for safeFetch anywhere else in this project.
 *
 * Root-cause fix for the one limitation Tier 1/2 cannot address: safeFetch reads HTML exactly as
 * the server delivers it, before any client-side JS runs — a career site whose "Search Jobs" link
 * (or the ATS URL itself) only appears after JS execution is structurally invisible to Tier 1/2.
 * This module renders the page with a real (headless) browser and applies the EXACT SAME
 * detection functions Tier 2 already uses (detectAtsFromUrlString, detectUnsupportedAts,
 * findEmbeddedAtsUrl, findEmbeddedUnsupportedAtsUrl, findBestCareersLink/scoreCareersLink — all
 * imported from discovery.ts, never duplicated) against the RENDERED HTML instead of the raw
 * response body. Resolves to the identical DiscoveryResult shape Tier 1/2 produce, so
 * recordDiscoveryResult needs no changes to accept its output.
 *
 * READ-ONLY FIRST, bounded click: inspects the final URL (post any client-side redirect), every
 * rendered anchor/iframe-src/embedded-config URL (findEmbeddedAtsUrl already scans the WHOLE
 * rendered document for any http(s) token, which naturally covers iframe src and inline script
 * config, not just <a href>), before ever following a link. If nothing resolves it, AT MOST ONE
 * bounded "click" is taken — never a DOM click on an arbitrary element, always a direct navigation
 * to the single highest-scoring careers/jobs-shaped link (the same deterministic scoring Tier 2
 * uses). Never: submits forms, logs in, solves CAPTCHAs, fills applications, uploads files, or
 * clicks anything else. See MAX_BROWSER_DISCOVERY_PAGES/DEPTH in discoveryConfig.ts for the exact
 * bounds (deliberately tighter than Tier 1/2's — Playwright costs far more per page).
 *
 * SSRF safety: the seed URL is validated via isUrlSafeForNavigation (the SAME private-IP/loopback/
 * link-local/DNS-rebinding/scheme check safeFetch itself uses, exported for exactly this reuse)
 * BEFORE Chromium ever launches. Every subsequent in-browser navigation is independently validated
 * the same way via Playwright's request interception (page.route), which aborts any request whose
 * target fails the check — Tier 3 can never become an SSRF bypass around safeFetch's protections,
 * regardless of what a rendered page's JS tries to navigate to.
 */

export interface DiscoverCompanySourceBrowserOptions {
  /** Test-only — see safeFetch's identical option. NEVER set true from production call sites. */
  allowPrivateNetworksForTests?: boolean;
}

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 CareerOpsDiscoveryBot";

function unresolved(reason: string): DiscoveryResult {
  return { status: "UNRESOLVED", sourceType: null, atsBoardToken: null, discoveredJobsUrl: null, reason, suspectedAts: null };
}

function verified(sourceType: Exclude<SourceType, "career_link">, atsBoardToken: string, discoveredJobsUrl: string, reason: string): DiscoveryResult {
  return { status: "VERIFIED", sourceType, atsBoardToken, discoveredJobsUrl, reason, suspectedAts: null };
}

function needsAdapter(name: string, discoveredJobsUrl: string, reason: string): DiscoveryResult {
  return { status: "NEEDS_ADAPTER", sourceType: null, atsBoardToken: null, discoveredJobsUrl, reason, suspectedAts: name };
}

function genericSupported(discoveredJobsUrl: string, reason: string): DiscoveryResult {
  return { status: "GENERIC_SUPPORTED", sourceType: null, atsBoardToken: null, discoveredJobsUrl, reason, suspectedAts: null };
}

export async function discoverCompanySourceBrowser(inputUrl: string, options: DiscoverCompanySourceBrowserOptions = {}): Promise<DiscoveryResult> {
  const allowPrivateNetworksForTests = options.allowPrivateNetworksForTests ?? false;

  // Seed URL safety check BEFORE launching Chromium at all.
  if (!(await isUrlSafeForNavigation(inputUrl, allowPrivateNetworksForTests))) {
    return unresolved(`Refused to launch browser discovery against an unsafe URL: ${inputUrl}`);
  }

  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > BROWSER_DISCOVERY_TIMEOUT_MS;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: BROWSER_USER_AGENT });

    // Per-navigation SSRF guard — independent of the seed-URL check above, so a page's own JS
    // redirecting or navigating to a disallowed target is blocked exactly like the seed URL was.
    await page.route("**/*", async (route) => {
      const safe = await isUrlSafeForNavigation(route.request().url(), allowPrivateNetworksForTests);
      if (!safe) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    let currentUrl = inputUrl;
    let pagesVisited = 0;
    let bestKnownJobsUrl: string | null = null;

    for (let depth = 0; depth <= MAX_BROWSER_DISCOVERY_DEPTH; depth++) {
      if (pagesVisited >= MAX_BROWSER_DISCOVERY_PAGES || budgetExceeded()) break;

      try {
        await page.goto(currentUrl, { waitUntil: "networkidle", timeout: BROWSER_PAGE_TIMEOUT_MS });
      } catch {
        if (depth === 0) return unresolved(`Browser navigation failed for ${currentUrl}`);
        break; // a deeper hop failing just stops here with whatever was already found
      }
      pagesVisited++;

      const finalUrl = page.url();
      const html = await page.content();

      const finalMatch = detectAtsFromUrlString(finalUrl);
      if (finalMatch) return verified(finalMatch.sourceType, finalMatch.atsBoardToken, finalUrl, `[Browser] Final URL after client-side navigation is a known ATS (${finalMatch.sourceType})`);

      const finalUnsupported = detectUnsupportedAts(finalUrl);
      if (finalUnsupported) return needsAdapter(finalUnsupported, finalUrl, `[Browser] Final URL after client-side navigation matches a recognized-but-unsupported ATS: ${finalUnsupported}`);

      const embeddedAts = findEmbeddedAtsUrl(html);
      if (embeddedAts) return verified(embeddedAts.sourceType, embeddedAts.atsBoardToken, embeddedAts.url, `[Browser] Found an embedded ${embeddedAts.sourceType} link on ${finalUrl} (rendered HTML)`);

      const embeddedUnsupported = findEmbeddedUnsupportedAtsUrl(html);
      if (embeddedUnsupported) {
        return needsAdapter(embeddedUnsupported.name, embeddedUnsupported.url, `[Browser] Found an embedded ${embeddedUnsupported.name} link on ${finalUrl} (rendered HTML) — no connector yet`);
      }

      const looksLikeJobsUrl = depth > 0 || scoreCareersLink({ url: finalUrl, text: "" }) > 0;
      if (looksLikeJobsUrl) bestKnownJobsUrl = finalUrl;

      if (depth >= MAX_BROWSER_DISCOVERY_DEPTH || pagesVisited >= MAX_BROWSER_DISCOVERY_PAGES || budgetExceeded()) break;

      // The ONE bounded "click": a direct navigation to the highest-scoring careers/jobs link
      // found in the RENDERED DOM — never a DOM click event on an arbitrary element.
      const nextLink = findBestCareersLink(html, finalUrl, finalUrl);
      if (!nextLink) break;
      currentUrl = nextLink;
    }

    if (bestKnownJobsUrl) {
      return genericSupported(bestKnownJobsUrl, `[Browser] No known ATS detected after JS rendering; best candidate jobs page: ${bestKnownJobsUrl}`);
    }
    return unresolved(`[Browser] Rendered ${inputUrl} but found no ATS link or careers/jobs page within Tier-3 bounds`);
  } finally {
    await browser.close();
  }
}

/**
 * The full three-tier chain: Tier 1/2 (discoverCompanySource, completely UNMODIFIED by this
 * phase — its own 9 existing tests stay green, unmodified) first; Tier 3 (browser-rendered,
 * above) ONLY when Tier 1/2 resolves UNRESOLVED. A NEEDS_ADAPTER/FAILED_TEMPORARY/VERIFIED/
 * GENERIC_SUPPORTED result from Tier 1/2 is returned as-is — Tier 3 never runs "just in case,"
 * only to fill the specific gap Tier 1/2 cannot: a source hidden behind client-side JS that
 * genuinely produced no findable ATS/careers signal in the raw, pre-render HTML.
 *
 * This is a THIN COMPOSING WRAPPER, not a modification of discoverCompanySource itself — kept in
 * this file (which already depends on discovery.ts) specifically to avoid discovery.ts having to
 * import discoveryBrowser.ts back (Playwright is a much heavier dependency than anything Tier 1/2
 * needs, and discovery.ts's own tests must never require launching a browser).
 */
export async function discoverCompanySourceWithBrowserFallback(
  inputUrl: string,
  options: DiscoverCompanySourceOptions & DiscoverCompanySourceBrowserOptions = {}
): Promise<DiscoveryResult> {
  const httpResult = await discoverCompanySource(inputUrl, { allowPrivateNetworksForTests: options.allowPrivateNetworksForTests });
  if (httpResult.status !== "UNRESOLVED") return httpResult;
  return discoverCompanySourceBrowser(inputUrl, { allowPrivateNetworksForTests: options.allowPrivateNetworksForTests });
}
