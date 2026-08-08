import type { WorkplaceTypeNormalized } from "@/types";
import type { ExtractedLocation, LocationEntry } from "./types";

function normalizeWorkplaceType(raw: string | null): WorkplaceTypeNormalized | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/remote/.test(s)) return "Remote";
  if (/hybrid/.test(s)) return "Hybrid";
  if (/on[\s-]?site|in[\s-]?office|on[\s-]?location/.test(s)) return "Onsite";
  return null;
}

const OFFICE_DAYS_PATTERN = /(\d+)\s*days?\s*(?:a|per|\/)\s*week\s*(?:in|onsite|in[\s-]office|in the office)?|in[\s-]office\s*(\d+)\s*days?\s*(?:a|per|\/)\s*week/i;
const RELOCATION_PATTERN = /relocation assistance|willing to relocate|relocation required|no relocation (?:assistance|support)?/i;
const TRAVEL_PATTERN = /(up to\s*)?(\d{1,3})\s*%\s*travel|travel(?:\s+required)?\s*(?:up to\s*)?(\d{1,3})\s*%/i;

const US_STATE_ABBR = /\b([A-Z]{2})\b/;

/** Parses a single "City, ST" / "City, State, Country" / "Remote" style location fragment. */
function parseLocationFragment(fragment: string): LocationEntry {
  const trimmed = fragment.trim();
  if (!trimmed || /^remote$/i.test(trimmed)) return { city: null, state: null, country: null };
  const parts = trimmed.split(",").map((p) => p.trim());
  if (parts.length >= 2) {
    const stateMatch = parts[1].match(US_STATE_ABBR);
    return {
      city: parts[0] || null,
      state: stateMatch ? stateMatch[1] : parts[1] || null,
      country: parts[2] || null,
    };
  }
  return { city: null, state: null, country: parts[0] || null };
}

export interface ExtractLocationInput {
  locationNative: string | null;
  workplaceTypeNative: string | null;
  descriptionText: string | null;
}

export function extractLocation(input: ExtractLocationInput): ExtractedLocation {
  const { locationNative, workplaceTypeNative, descriptionText } = input;

  // Tier 1: native ATS field. Tier 3: JD text fallback when native is absent/unrecognized.
  const workplaceType: WorkplaceTypeNormalized =
    normalizeWorkplaceType(workplaceTypeNative) ??
    normalizeWorkplaceType(locationNative) ??
    (descriptionText && /\bremote\b/i.test(descriptionText)
      ? "Remote"
      : descriptionText && /\bhybrid\b/i.test(descriptionText)
        ? "Hybrid"
        : null) ??
    "Unknown";

  let locations: LocationEntry[] = [];
  if (locationNative) {
    const isMultiple = /multiple locations|various locations/i.test(locationNative);
    const fragments = isMultiple
      ? []
      : locationNative
          .split(/;| or |\//)
          .map((f) => f.trim())
          .filter(Boolean);
    locations = fragments.map(parseLocationFragment).filter((l) => l.city || l.state || l.country);
  }

  const officeDaysMatch = descriptionText?.match(OFFICE_DAYS_PATTERN) ?? null;
  const officeDays = officeDaysMatch ? officeDaysMatch[0].trim() : null;

  const relocationMatch = descriptionText?.match(RELOCATION_PATTERN) ?? null;
  const travelMatch = descriptionText?.match(TRAVEL_PATTERN) ?? null;

  return {
    workplaceType,
    officeDays,
    primary: locations[0] ?? { city: null, state: null, country: null },
    locations,
    relocation: relocationMatch ? relocationMatch[0].trim() : null,
    travelPct: travelMatch ? travelMatch[0].trim() : null,
  };
}
