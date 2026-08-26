import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const profile = fs.readFileSync(path.resolve("src/app/profile/page.tsx"), "utf8");
const editor = fs.readFileSync(path.resolve("src/app/profile/EditableSection.tsx"), "utf8");
const settings = fs.readFileSync(path.resolve("src/app/settings/page.tsx"), "utf8");
const categories = fs.readFileSync(path.resolve("src/app/settings/categories.ts"), "utf8");
const profileUi = profile.replace(/\/\*[\s\S]*?\*\//g, "");
const settingsUi = settings.replace(/\/\*[\s\S]*?\*\//g, "");
const settingsRoute = fs.readFileSync(
  path.resolve("src/app/api/candidates/[candidateId]/settings/route.ts"),
  "utf8",
);

test("candidate Settings contains no admin or operator controls", () => {
  assert.doesNotMatch(settingsUi, /\/admin\/settings|Scan now|scanner timeout|ATS concurrency/i);
  assert.doesNotMatch(settingsUi, /writerEnabled|scheduler:\s*\{/);
});

test("Profile presents persisted professional facts without a fabricated completeness score", () => {
  assert.match(profile, /const prefs = settings\.preferences/);
  assert.match(profile, /const auth = settings\.matchAffecting/);
  assert.doesNotMatch(profileUi, /profile completeness|completion percentage|completenessScore/i);
});

test("certifications come from the persisted derived profile and preserve an honest empty state", () => {
  assert.match(profile, /evidence\?\.certifications \?\? \[\]/);
  assert.match(profile, /No certifications added\./);
  assert.doesNotMatch(profileUi, /AWS Certified|SnowPro|Databricks Certified/);
});

test("work authorization is displayed only from saved candidate settings", () => {
  assert.match(profile, /const auth = settings\.matchAffecting/);
  assert.match(profile, /v\.workAuthorizedUS/);
  assert.match(profile, /v\.requiresSponsorship/);
  assert.match(profile, /value=\{auth\}/);
});

test("skills are searched in memory and rendered through a bounded window", () => {
  assert.match(profile, /const MAX_RENDERED = 80/);
  assert.match(profile, /matches\.slice\(0, Math\.min\(visibleCount, MAX_RENDERED\)\)/);
  assert.match(profile, /setVisibleCount\(\(count\) => Math\.min\(count \+ 24, MAX_RENDERED\)\)/);
  assert.equal(profile.match(/fetch\(`/g)?.length, 4, "Profile should make three reads and one existing settings write");
});

test("skill provenance names evidence sources without inventing employer attribution", () => {
  assert.match(profile, /Resume evidence/);
  assert.match(profile, /Skills inventory/);
  assert.doesNotMatch(profile, /attributedTo\.map|Employer evidence|Evidence from \$\{/);
});

test("privacy copy accurately distinguishes local storage from configured AI services", () => {
  // UI-AM — updated from "JobHunt" to "Career-Ops": settings/page.tsx was touched for this phase
  // (the new Answer Memory link), and every rendered "JobHunt" string in a touched file is fixed
  // per this codebase's established naming policy. The behavioral assertion this test exists for —
  // an accurate local-vs-AI-service distinction, never an absolute "nothing leaves this Mac" claim
  // — is unchanged.
  const copy = "Your Career-Ops data is stored locally on this Mac. Some AI-assisted features may send the content needed for a task to the configured AI service.";
  assert.ok(settings.includes(copy));
  assert.doesNotMatch(settings, /nothing is uploaded|never leaves this Mac/i);
});

test("candidate Settings exposes no secrets, raw API keys, or provider configuration", () => {
  assert.doesNotMatch(settings, /OPENAI_API_KEY|ANTHROPIC_API_KEY|apiKey|secretKey|providerName/);
});

test("candidate Profile and Settings controls retain 44px minimum touch targets", () => {
  assert.match(editor, /min-h-11/);
  assert.match(settings, /min-h-11 w-full/);
  assert.match(profile, /min-h-11/);
});

test("inline Profile editing moves focus into the form and restores it after exit", () => {
  assert.match(editor, /querySelector<HTMLElement>\("input, select, textarea"\)\?\.focus\(\)/);
  assert.match(editor, /editButtonRef\.current\?\.focus\(\)/);
  assert.match(editor, /if \(!defaultOpen\) return/);
  assert.match(editor, /onClick=\{open\}/);
  assert.match(editor, /restoreEditFocus\(\)/);
});

test("Profile and Settings use batched page-level reads rather than request-per-field", () => {
  assert.match(profile, /Promise\.all\(\[/);
  assert.match(settings, /Promise\.all\(\[/);
  assert.equal(settings.match(/fetch\(`/g)?.length, 2);
  assert.doesNotMatch(settings, /\/api\/settings/);
});

test("the existing candidate settings write contract remains PATCH with the same three buckets", () => {
  assert.match(profile, /method: "PATCH"/);
  assert.match(profile, /patchSettings\(candidateId, \{ contact: draft \}\)/);
  assert.match(profile, /patchSettings\(candidateId, \{ preferences: draft \}\)/);
  assert.match(profile, /patchSettings\(candidateId, \{ matchAffecting: draft \}\)/);
  assert.match(settingsRoute, /export async function PATCH/);
});

test("Settings exposes the approved candidate categories in order", () => {
  const labels = ["Job Search", "Notifications", "Applications", "Career Copilot", "Data & Privacy"];
  let cursor = -1;
  for (const label of labels) {
    const next = categories.indexOf(`label: "${label}"`);
    assert.ok(next > cursor, `${label} should appear in the approved order`);
    cursor = next;
  }
  assert.match(settings, /aria-label="Settings categories"/);
  assert.match(settings, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(settings, /overflow-x-auto/);
  assert.doesNotMatch(settings, /hidden[^\n]*SETTINGS_CATEGORIES|SETTINGS_CATEGORIES[^\n]*hidden/);
});

test("candidate and admin settings retain a clear route boundary", () => {
  const admin = fs.readFileSync(path.resolve("src/app/admin/settings/page.tsx"), "utf8");
  assert.doesNotMatch(settingsUi, /System settings|Control Center/);
  assert.match(admin, /ResumeWriterControl|writerEnabled/);
});

test("unavailable destructive data actions are not advertised", () => {
  assert.doesNotMatch(settingsUi, /Delete profile|Clear saved answers|Delete generated documents|Export data/);
  assert.doesNotMatch(settingsUi, /danger zone/i);
});
