import type { ExtractedDomain } from "./types";

// Job-level only, JD-text-evidence only — never inferred from the company name.
const DOMAIN_KEYWORDS: { domain: string; regex: RegExp }[] = [
  { domain: "Banking", regex: /\bbanking\b/i },
  { domain: "FinTech", regex: /\bfin[\s-]?tech\b/i },
  { domain: "Healthcare", regex: /\bhealthcare\b|\bhealth care\b/i },
  // Excludes the "medical, dental, vision, and life insurance plans" benefits-boilerplate pattern —
  // found via real-JD auditing to false-positive on the vast majority of a live, non-insurance
  // dataset (every posting mentioning standard employee benefits). Genuine industry mentions read
  // as "insurance company/industry/carrier/broker", never "<benefit type> insurance plan(s)".
  {
    domain: "Insurance",
    regex: /(?<!\b(?:life|health|dental|vision|medical)\s)\binsurance\b(?!\s+plans?\b)(?!\s+polic(?:y|ies)\b)/i,
  },
  { domain: "Manufacturing", regex: /\bmanufacturing\b/i },
  { domain: "Retail", regex: /\bretail\b/i },
  { domain: "Supply Chain", regex: /\bsupply chain\b/i },
  { domain: "E-commerce", regex: /\be-?commerce\b/i },
  { domain: "Telecommunications", regex: /\btelecom(?:munications)?\b/i },
  { domain: "Government", regex: /\bgovernment\b|\bpublic sector\b/i },
  { domain: "Education", regex: /\bedtech\b|\beducation(?:al)? (?:technology|sector|institution)\b/i },
  { domain: "Media & Entertainment", regex: /\bmedia\b.{0,20}\bentertainment\b|\bstreaming\b/i },
  { domain: "Automotive", regex: /\bautomotive\b/i },
  { domain: "Energy", regex: /\benergy sector\b|\butilities\b/i },
];

export function extractDomain(descriptionText: string | null): ExtractedDomain {
  if (!descriptionText) return { domain: null, evidence: null };
  for (const { domain, regex } of DOMAIN_KEYWORDS) {
    const m = descriptionText.match(regex);
    if (m) return { domain, evidence: m[0] };
  }
  return { domain: null, evidence: null };
}
