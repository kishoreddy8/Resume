import type { SponsorshipPolarity } from "@/types";
import { extractVendorFlags } from "./employmentType";

/**
 * Evidence-based flags only — a flag is set only from explicit positive textual evidence, never
 * from the absence of evidence. E.g. "Direct Employer" is never asserted (there's no reliable
 * positive text pattern for "this is definitely not a staffing agency"); "Staffing/Vendor" and
 * "Third-Party Recruiter" only fire on explicit language.
 */
const STAFFING_VENDOR_PATTERN = /on behalf of our client|our client is seeking|staffing agency|recruiting agency/i;
const NO_THIRD_PARTY_PATTERN = /no third[\s-]party|no agencies|no recruiters please|agencies please do not/i;
const THIRD_PARTY_RECRUITER_PATTERN = /third[\s-]party recruiters? welcome|open to (?:third[\s-]party )?agencies/i;
const CONFIDENTIAL_CLIENT_PATTERN = /confidential client|undisclosed client|client name withheld/i;
const CONTRACT_ONLY_PATTERN = /contract[\s-]only|1099 only|w-?2 not available/i;

export interface QualitySignalInput {
  descriptionText: string | null;
  clearanceRequired: boolean;
  sponsorshipPolarity: SponsorshipPolarity;
}

export function extractQualitySignals(input: QualitySignalInput): string[] {
  const { descriptionText, clearanceRequired, sponsorshipPolarity } = input;
  const flags = new Set<string>();

  if (descriptionText) {
    if (STAFFING_VENDOR_PATTERN.test(descriptionText)) flags.add("Staffing/Vendor");
    if (NO_THIRD_PARTY_PATTERN.test(descriptionText)) flags.add("No Third-Party Recruiters");
    else if (THIRD_PARTY_RECRUITER_PATTERN.test(descriptionText)) flags.add("Third-Party Recruiter");
    if (CONFIDENTIAL_CLIENT_PATTERN.test(descriptionText)) flags.add("Confidential Client");
    if (CONTRACT_ONLY_PATTERN.test(descriptionText)) flags.add("Contract Only");
    for (const vendorFlag of extractVendorFlags(descriptionText)) flags.add(vendorFlag);
  }
  if (clearanceRequired) flags.add("Clearance Required");
  if (sponsorshipPolarity === "negative") flags.add("Sponsorship Restriction");

  return Array.from(flags);
}
