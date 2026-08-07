import { encodeWorkdayToken } from "@/lib/ats/workday";
import type { SourceType } from "@/types";

export interface AtsDetection {
  sourceType: Exclude<SourceType, "career_link">;
  atsBoardToken: string;
}

const LOCALE_SEGMENT = /^[a-z]{2}-[A-Z]{2}$/;

function detectWorkday(url: string): AtsDetection | null {
  const match = url.match(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/([^?#]*)/i);
  if (!match) return null;
  const [, tenant, host, rest] = match;
  const segments = rest.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const site = LOCALE_SEGMENT.test(segments[0]) ? segments[1] : segments[0];
  if (!site) return null;
  return {
    sourceType: "workday",
    atsBoardToken: encodeWorkdayToken({ tenant: tenant.toLowerCase(), host: host.toLowerCase(), site }),
  };
}

// Order matters only in that each pattern is tried in turn; a URL should never match more than one.
const SIMPLE_PATTERNS: { sourceType: Exclude<SourceType, "career_link" | "workday">; pattern: RegExp }[] = [
  { sourceType: "greenhouse", pattern: /(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)/i },
  { sourceType: "ashby", pattern: /jobs\.ashbyhq\.com\/([^/?#]+)/i },
  { sourceType: "lever", pattern: /jobs\.lever\.co\/([^/?#]+)/i },
];

/** Tier 1: cheap, no network — matches known ATS domain patterns directly in a URL string. */
export function detectAtsFromUrlString(url: string): AtsDetection | null {
  const workday = detectWorkday(url);
  if (workday) return workday;

  for (const { sourceType, pattern } of SIMPLE_PATTERNS) {
    const match = url.match(pattern);
    if (match) return { sourceType, atsBoardToken: match[1] };
  }
  return null;
}

const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * Tier 2: for a custom domain (e.g. careers.company.com) that isn't itself an ATS URL but proxies
 * or redirects to one. Follows redirects and, failing that, scans the raw HTML for an embedded ATS
 * link (iframe/script src, "apply" links) — the same signal genericPlaywright.ts looks for when
 * suggesting a career_link-to-ATS upgrade after the fact, just applied proactively at add-time.
 */
export async function detectAtsFromUrl(url: string): Promise<AtsDetection | null> {
  const direct = detectAtsFromUrlString(url);
  if (direct) return direct;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: controller.signal,
    });

    const finalUrlMatch = detectAtsFromUrlString(res.url);
    if (finalUrlMatch) return finalUrlMatch;

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) return null;

    const html = await res.text();
    return detectAtsFromUrlString(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
