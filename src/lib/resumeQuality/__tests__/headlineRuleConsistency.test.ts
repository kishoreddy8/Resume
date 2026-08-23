import assert from "node:assert/strict";
import { test } from "node:test";
import { renderProfessionalIdentitySection } from "../professionalIdentity";
import { renderPresentationStandardSection } from "../presentationStructure";
import type { CandidateProfile } from "@/lib/match/types";

/**
 * INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — regression test for a real, live contradiction
 * this pass found and fixed: renderProfessionalIdentitySection said the resume headline carries
 * "professional ROLE IDENTITIES ONLY... Never put technologies in it", while
 * renderPresentationStandardSection's own "Headline." rule said the opposite — "leading with the
 * candidate's own professional identity, then the specialization this JD needs, then the defining
 * technologies." A writer reading both sections back to back (as every real handoff does — see
 * exporter.ts's render order) had no way to know which rule to follow.
 *
 * These two sections are ALWAYS rendered together, in this order, whenever a master profile with at
 * least one experience entry exists (see exporter.ts:
 * `${professionalIdentitySection}${presentationStandardSection}`), so this test builds the actual
 * combined text a writer would see and checks it for the specific contradiction pattern that existed.
 */

function profile(): CandidateProfile {
  return {
    schemaVersion: 1,
    sourceHashes: { resume: "h1", skills: "h2" },
    builtAt: "2026-01-01T00:00:00Z",
    skills: [],
    experience: [
      { employer: "Acme Corp", title: "Data Engineer", startDate: "2022-01", endDate: null, technologies: ["Python"] },
    ],
    education: [],
    certifications: [],
    totalYearsExperience: 3,
  };
}

test("1. the headline rule never says both 'never technologies' and 'then the defining technologies'", () => {
  const identitySection = renderProfessionalIdentitySection(
    { identity: "Data Engineer", evidenceTitles: ["Data Engineer"] },
    3
  );
  const presentationSection = renderPresentationStandardSection(profile());
  const combined = identitySection + presentationSection;

  assert.match(combined, /Never put technologies in it/, "the authoritative role-identities-only rule must be present");
  assert.doesNotMatch(
    combined,
    /then the defining technologies/,
    "the old contradictory headline wording ('...then the defining technologies') must not reappear"
  );
});

test("2. RESUME PRESENTATION STANDARD's own Headline rule states role-identities-only directly (self-contained, no dangling cross-reference)", () => {
  const presentationSection = renderPresentationStandardSection(profile());
  const headlineParagraph = presentationSection.split("**Headline.**")[1]?.split("\n\n")[0] ?? "";
  assert.match(headlineParagraph, /never technologies/i);
});

test("3. PROFESSIONAL IDENTITY's headline rule and RESUME PRESENTATION STANDARD's headline rule agree: neither ever instructs including technologies in the headline", () => {
  const identitySection = renderProfessionalIdentitySection(
    { identity: "Data Engineer", evidenceTitles: ["Data Engineer"] },
    3
  );
  const presentationSection = renderPresentationStandardSection(profile());
  for (const section of [identitySection, presentationSection]) {
    const headlineText = section.match(/\*\*Headline[^*]*\*\*[\s\S]{0,600}?\n\n/)?.[0] ?? "";
    assert.doesNotMatch(headlineText, /\bthen\b.{0,40}\btechnolog/i, "no headline paragraph may instruct adding technologies");
  }
});
