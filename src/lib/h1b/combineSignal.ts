import type { H1bCompanyConfidence, H1bJobConfidence, SponsorshipPolarity } from "@/types";

export interface H1bJobConfidenceResult {
  confidence: H1bJobConfidence;
  /** True if JD language changed the outcome from the company's plain historical confidence. */
  overridden: boolean;
  /** Human-readable explanation — what src/app/jobs/[id]/page.tsx shows as "JD Override / Reason". */
  reason: string;
}

/**
 * Job Description Override: historical company data must NOT blindly decide sponsorship — this
 * posting's own JD language always wins when present.
 *   - Negative JD language ("Will not sponsor", "No visa sponsorship", "No H1B", "Must be
 *     authorized now and in the future") is a hard override to "Not Sponsoring", regardless of how
 *     strong the company's historical record is.
 *   - Positive JD language ("Visa sponsorship available", "H1B transfers supported") is treated as
 *     the strongest possible evidence — direct, role-specific, and more current than a company-wide
 *     historical aggregate — and overrides up to "Very High".
 *   - No JD language either way: falls back to the company's historical confidence untouched.
 * The exact matched phrase is preserved separately as sponsorship_snippet (see keywordScan.ts) —
 * this function only decides the resulting confidence + why.
 */
export function combineH1bConfidence(
  companyConfidence: H1bCompanyConfidence,
  polarity: SponsorshipPolarity
): H1bJobConfidenceResult {
  if (polarity === "negative") {
    return {
      confidence: "Not Sponsoring",
      overridden: true,
      reason:
        "The job description explicitly states no visa sponsorship for this role — this overrides the company's historical sponsorship record.",
    };
  }
  if (polarity === "positive") {
    return {
      confidence: "Very High",
      overridden: true,
      reason:
        "The job description explicitly offers visa sponsorship for this role — direct, role-specific evidence, treated as the strongest available signal.",
    };
  }
  return {
    confidence: companyConfidence,
    overridden: false,
    reason:
      "No explicit sponsorship language found in this posting — using the company's historical DOL H1B/LCA filing record.",
  };
}
