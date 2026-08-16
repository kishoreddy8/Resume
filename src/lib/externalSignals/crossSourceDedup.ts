import { normalizeOrganizationDomain } from "@/db/organizationRegistryCore";
import type { CrossSourceMatchConfidence, ExternalHiringObservationRow } from "./types";

/**
 * Phase 8 — conservative cross-source job identity. Two observations (possibly from different
 * providers) are compared; only EXACT/HIGH may ever be treated as "the same real-world requisition."
 * POSSIBLE is real signal (surface it) but must never auto-merge/suppress data — same company + same
 * title alone is NOT enough, since a company can legitimately have multiple openings with the same
 * title.
 */
export function compareCrossSourceIdentity(a: ExternalHiringObservationRow, b: ExternalHiringObservationRow): CrossSourceMatchConfidence {
  if (a.matched_company_id === null || a.matched_company_id !== b.matched_company_id) return "DISTINCT";

  // EXACT: the exact same direct ATS/apply destination — canonicalized so tracking-parameter
  // variants of the same link still match.
  const urlA = canonicalize(a.direct_apply_url ?? a.direct_employer_url);
  const urlB = canonicalize(b.direct_apply_url ?? b.direct_employer_url);
  if (urlA && urlB && urlA === urlB) return "EXACT";

  const sameTitle = normalizeTitle(a.observed_title) === normalizeTitle(b.observed_title);
  const sameLocation = normalizeLocation(a.observed_location) === normalizeLocation(b.observed_location);

  // HIGH: same detected ATS board (provider+token) plus same normalized title and location — strong
  // enough to be confident even without a byte-identical URL (query params, tracking IDs differ).
  if (a.detected_ats_provider && a.detected_ats_provider === b.detected_ats_provider && a.detected_ats_board_token === b.detected_ats_board_token) {
    if (sameTitle && sameLocation) return "HIGH";
  }

  // POSSIBLE: same company + same normalized title, but missing/mismatched location or board
  // evidence — real signal, never auto-merged.
  if (sameTitle) return "POSSIBLE";

  return "DISTINCT";
}

function canonicalize(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const stripped = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
      if (!/^(utm_|gclid|fbclid|ref|source|src)/i.test(key)) stripped.set(key, value);
    }
    const query = stripped.toString();
    return `${normalizeOrganizationDomain(url)}${parsed.pathname.replace(/\/$/, "")}${query ? `?${query}` : ""}`.toLowerCase();
  } catch {
    return url.toLowerCase().trim();
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeLocation(location: string | null): string {
  return (location ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
