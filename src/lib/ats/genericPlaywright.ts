import { chromium } from "playwright";
import { extractJsonLdJobPostings, stripHtmlTags, validateJobCandidate } from "@/lib/ats/jobValidation";
import { ScanConnectorError } from "@/lib/scan/errors";
import { isUrlSafeForNavigation } from "@/lib/net/safeFetch";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import type { NormalizedJob } from "@/types";

const JOB_CONTAINER_SELECTOR =
  '[class*="job" i] a, [class*="posting" i] a, [class*="career" i] a, [class*="opening" i] a, [class*="position" i] a';

// The container an anchor's surrounding listing-row/card text is pulled from — feeds jobValidation's
// location/apply-action context signals. Falls back to the anchor's own parentElement.
const LINK_CONTAINER_SELECTOR =
  '[class*="job" i], [class*="posting" i], [class*="opening" i], [class*="position" i], [class*="listing" i], [class*="card" i], li, tr';

const ATS_URL_PATTERNS: { pattern: RegExp; source: string }[] = [
  { pattern: /boards\.greenhouse\.io\/([^/?#]+)/i, source: "greenhouse" },
  { pattern: /jobs\.lever\.co\/([^/?#]+)/i, source: "lever" },
  { pattern: /jobs\.ashbyhq\.com\/([^/?#]+)/i, source: "ashby" },
  { pattern: /(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/i, source: "smartrecruiters" },
];

export interface ScrapeResult {
  jobs: NormalizedJob[];
  /** Evidence strength used by source validation. None of these values prove list completeness;
   * generic pages remain additive-only even when their individual postings are well structured. */
  extractorType: "JSON_LD" | "EMBEDDED_SUPPORTED_ATS" | "HTML_LINK_HEURISTIC";
  /** If most links pointed at a single ATS board, surfaces it so the UI can suggest converting. */
  detectedAts?: { source: string; token: string };
}

export interface ScrapeCareerPageOptions {
  /** Test-only — see safeFetch's/discoveryBrowser's identical option. NEVER set true from production call sites. */
  allowPrivateNetworksForTests?: boolean;
}

/** Pulls only an explicit location-bearing line out of the rendered listing card. The full card is
 * never used as a location: that could turn unrelated prose containing a state abbreviation into
 * false evidence. If no individual short line classifies, location remains unknown. */
export function extractLocationEvidence(contextText: string, title: string): string | null {
  const normalizedTitle = title.trim().replace(/\s+/g, " ").toLowerCase();
  const lines = contextText
    .split(/[\r\n|•]+/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length >= 2 && line.length <= 120)
    .filter((line) => line.toLowerCase() !== normalizedTitle)
    .filter((line) => !/^(apply|apply now|view job|view details|learn more)$/i.test(line));
  return lines.find((line) => classifyJobLocation(line) !== "UNKNOWN") ?? null;
}

/**
 * Best-effort scraper for arbitrary company career pages the user adds manually.
 * Many "custom" career pages are actually a themed wrapper around a Greenhouse/Lever/Ashby
 * board — if most collected links point at one, we use those directly (real job URLs, easy to
 * dedupe) and surface the detected board so the UI can suggest converting to a proper ATS entry.
 * Otherwise we fall back to raw link/title heuristics, which is inherently noisy — no per-posting
 * description text in either case, so these jobs fall back to the company-level H1B signal.
 *
 * SSRF safety: this runs a real headless browser against a stored `career_page_url` on every scan
 * (unlike Tier-3 discovery, which only runs once at resolution time) — so it gets the SAME two-part
 * guard as src/lib/ats/discoveryBrowser.ts, reusing the identical isUrlSafeForNavigation check (never
 * a second/duplicate SSRF implementation): the seed URL is checked BEFORE Chromium launches, and
 * every subsequent in-page navigation/redirect is independently re-checked via Playwright request
 * interception (page.route) — a same-origin redirect to a private/loopback/link-local target is
 * blocked exactly like a bad seed URL would be, since page.goto follows redirects transparently and
 * a seed-only check can't see where a redirect actually lands.
 */
export async function scrapeCareerPage(
  careerPageUrl: string,
  options: ScrapeCareerPageOptions = {}
): Promise<NormalizedJob[]> {
  const { jobs } = await scrapeCareerPageDetailed(careerPageUrl, options);
  return jobs;
}

export async function scrapeCareerPageDetailed(
  careerPageUrl: string,
  options: ScrapeCareerPageOptions = {}
): Promise<ScrapeResult> {
  const allowPrivateNetworksForTests = options.allowPrivateNetworksForTests ?? false;

  if (!(await isUrlSafeForNavigation(careerPageUrl, allowPrivateNetworksForTests))) {
    throw new ScanConnectorError(
      `Refused to scan an unsafe career_page_url: ${careerPageUrl}`,
      "unsafe_url",
      0
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });

    // Per-navigation SSRF guard — independent of the seed-URL check above, so a redirect or the
    // page's own JS navigating to a disallowed target is blocked exactly like the seed URL was.
    await page.route("**/*", async (route) => {
      const safe = await isUrlSafeForNavigation(route.request().url(), allowPrivateNetworksForTests);
      if (!safe) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto(careerPageUrl, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {
      // Some career pages never go fully idle (polling/analytics); fall back to whatever loaded.
    });

    // Strongest possible signal first: if the page publishes JobPosting structured data (schema.org,
    // used for search-engine job indexing), it's authoritative — use it directly and skip anchor
    // heuristics entirely. See src/lib/ats/jobValidation.ts's module doc comment.
    const html = await page.content();
    const jsonLdJobs = extractJsonLdJobPostings(html);
    if (jsonLdJobs.length > 0) {
      const jobs: NormalizedJob[] = jsonLdJobs.slice(0, 200).map((job) => ({
        externalId: null,
        title: job.title,
        location: job.location,
        department: null,
        url: job.url!,
        descriptionHtml: job.descriptionHtml,
        descriptionText: job.descriptionHtml ? stripHtmlTags(job.descriptionHtml) : null,
        employmentType: null,
        workplaceType: null,
        salaryText: null,
        postedAt: job.datePosted,
        raw: job,
      }));
      return { jobs, extractorType: "JSON_LD" };
    }

    const rawLinks = await page.evaluate(
      ({ linkSelector, containerSelector }) => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(linkSelector));
        const generic = anchors.length > 0 ? anchors : Array.from(document.querySelectorAll("a"));
        return generic
          .map((a) => {
            const container = a.closest(containerSelector) ?? a.parentElement;
            const contextText = (container instanceof HTMLElement ? container.innerText : "").slice(0, 300);
            return { href: a.href, text: a.textContent?.trim() ?? "", contextText };
          })
          .filter((a) => a.href && a.text.length >= 4 && a.text.length <= 120);
      },
      { linkSelector: JOB_CONTAINER_SELECTOR, containerSelector: LINK_CONTAINER_SELECTOR }
    );

    const seen = new Set<string>();
    const deduped: { href: string; text: string; contextText: string }[] = [];
    for (const link of rawLinks) {
      if (seen.has(link.href)) continue;
      if (/^(mailto:|tel:|javascript:)/i.test(link.href)) continue;
      if (/(twitter|linkedin|facebook|instagram)\.com/i.test(link.href)) continue;
      seen.add(link.href);
      deduped.push(link);
    }

    // Check whether most links funnel through a single embedded ATS board.
    const atsCounts = new Map<string, { source: string; token: string; count: number }>();
    for (const link of deduped) {
      for (const { pattern, source } of ATS_URL_PATTERNS) {
        const match = link.href.match(pattern);
        if (match) {
          const key = `${source}:${match[1]}`;
          const existing = atsCounts.get(key);
          if (existing) existing.count++;
          else atsCounts.set(key, { source, token: match[1], count: 1 });
          break;
        }
      }
    }
    const topAts = Array.from(atsCounts.values()).sort((a, b) => b.count - a.count)[0];
    const usesAts = topAts && topAts.count >= 3 && topAts.count >= deduped.length * 0.4;

    // Non-ATS fallback: positive-evidence validation (src/lib/ats/jobValidation.ts), NOT a
    // nav-word blocklist — "when uncertain, ingest nothing" (AGENTS.md §15/§16).
    const candidates = usesAts
      ? deduped.filter((l) =>
          ATS_URL_PATTERNS.some(
            ({ pattern, source }) =>
              source === topAts.source && pattern.test(l.href) && l.href.includes(topAts.token)
          )
        )
      : deduped.filter((l) => validateJobCandidate({ url: l.href, text: l.text, contextText: l.contextText }).valid);

    const jobs: NormalizedJob[] = candidates.slice(0, 200).map((link) => ({
      externalId: null,
      title: link.text,
      location: extractLocationEvidence(link.contextText, link.text),
      department: null,
      url: link.href,
      descriptionHtml: null,
      descriptionText: null,
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: null,
      raw: link,
    }));

    return usesAts
      ? {
          jobs,
          extractorType: "EMBEDDED_SUPPORTED_ATS",
          detectedAts: { source: topAts.source, token: topAts.token },
        }
      : { jobs, extractorType: "HTML_LINK_HEURISTIC" };
  } finally {
    await browser.close();
  }
}
