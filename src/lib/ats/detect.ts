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

// Tier 2 (multi-hop, network-based detection for a custom domain that proxies/redirects to an ATS)
// used to live here as detectAtsFromUrl(), calling raw fetch() with no SSRF protection, no response
// size cap, and only ever following ONE hop. It has been replaced by the bounded, SSRF-safe
// discovery chain in src/lib/ats/discovery.ts (discoverCompanySource), which reuses
// detectAtsFromUrlString above at every hop instead of duplicating this logic. See AGENTS.md §9-14.
