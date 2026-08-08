import type { DescriptionSections } from "@/types";
import type { ExtractedSections } from "./types";

/**
 * Relabels the existing parseDescriptionSections() output (src/lib/parseSections.ts, already
 * computed at scan time into jobs.description_sections) to the spec's terminology — qualifications
 * -> Required Qualifications, niceToHave -> Preferred Qualifications. No new section-parsing logic;
 * this is purely a mapping so the UI can show the labels the spec asks for without re-deriving
 * anything parseDescriptionSections already did.
 */
export function toExtractedSections(sections: DescriptionSections | null): ExtractedSections {
  return {
    responsibilities: sections?.responsibilities ?? null,
    requiredQualifications: sections?.qualifications ?? null,
    preferredQualifications: sections?.niceToHave ?? null,
    benefits: sections?.benefits ?? null,
  };
}
