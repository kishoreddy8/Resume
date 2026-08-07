import { chromium } from "playwright";
import type { NormalizedJob } from "@/types";

const JOB_CONTAINER_SELECTOR =
  '[class*="job" i] a, [class*="posting" i] a, [class*="career" i] a, [class*="opening" i] a, [class*="position" i] a';

const NAV_TEXT_BLOCKLIST = /^(home|about|contact|privacy|terms|login|sign in|careers|jobs|apply|search)$/i;

const ATS_URL_PATTERNS: { pattern: RegExp; source: string }[] = [
  { pattern: /boards\.greenhouse\.io\/([^/?#]+)/i, source: "greenhouse" },
  { pattern: /jobs\.lever\.co\/([^/?#]+)/i, source: "lever" },
  { pattern: /jobs\.ashbyhq\.com\/([^/?#]+)/i, source: "ashby" },
];

export interface ScrapeResult {
  jobs: NormalizedJob[];
  /** If most links pointed at a single ATS board, surfaces it so the UI can suggest converting. */
  detectedAts?: { source: string; token: string };
}

/**
 * Best-effort scraper for arbitrary company career pages the user adds manually.
 * Many "custom" career pages are actually a themed wrapper around a Greenhouse/Lever/Ashby
 * board — if most collected links point at one, we use those directly (real job URLs, easy to
 * dedupe) and surface the detected board so the UI can suggest converting to a proper ATS entry.
 * Otherwise we fall back to raw link/title heuristics, which is inherently noisy — no per-posting
 * description text in either case, so these jobs fall back to the company-level H1B signal.
 */
export async function scrapeCareerPage(careerPageUrl: string): Promise<NormalizedJob[]> {
  const { jobs } = await scrapeCareerPageDetailed(careerPageUrl);
  return jobs;
}

export async function scrapeCareerPageDetailed(careerPageUrl: string): Promise<ScrapeResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });
    await page.goto(careerPageUrl, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {
      // Some career pages never go fully idle (polling/analytics); fall back to whatever loaded.
    });

    const rawLinks = await page.evaluate((selector) => {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector));
      const generic = anchors.length > 0 ? anchors : Array.from(document.querySelectorAll("a"));
      return generic
        .map((a) => ({ href: a.href, text: a.textContent?.trim() ?? "" }))
        .filter((a) => a.href && a.text.length >= 4 && a.text.length <= 120);
    }, JOB_CONTAINER_SELECTOR);

    const seen = new Set<string>();
    const deduped: { href: string; text: string }[] = [];
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

    const candidates = usesAts
      ? deduped.filter((l) =>
          ATS_URL_PATTERNS.some(
            ({ pattern, source }) =>
              source === topAts.source && pattern.test(l.href) && l.href.includes(topAts.token)
          )
        )
      : deduped.filter((l) => !NAV_TEXT_BLOCKLIST.test(l.text));

    const jobs: NormalizedJob[] = candidates.slice(0, 200).map((link) => ({
      externalId: null,
      title: link.text,
      location: null,
      department: null,
      url: link.href,
      descriptionHtml: null,
      descriptionText: null,
      postedAt: null,
      raw: link,
    }));

    return usesAts
      ? { jobs, detectedAts: { source: topAts.source, token: topAts.token } }
      : { jobs };
  } finally {
    await browser.close();
  }
}
