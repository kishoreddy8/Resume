import type { H1bCombinedSignal, H1bSignal, SponsorshipPolarity } from "@/types";

/**
 * A negative sponsorship mention in the posting is a hard override (ignores DOL history —
 * a company can have sponsored in the past and still explicitly exclude this specific role).
 * A positive mention is a soft override upward. Otherwise, fall back to the company's
 * DOL-derived historical signal.
 */
export function combineH1bSignal(
  companySignal: H1bSignal,
  polarity: SponsorshipPolarity
): H1bCombinedSignal {
  if (polarity === "negative") return "Unlikely";
  if (polarity === "positive") return "Likely";
  return companySignal;
}
