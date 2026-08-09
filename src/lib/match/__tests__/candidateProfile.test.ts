import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { candidateProfileHash, loadCandidateProfile } from "../candidateProfile";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-master-"));
  process.env.CAREER_OPS_MASTER_DIR = tmpDir;
});

after(() => {
  delete process.env.CAREER_OPS_MASTER_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f));
});

function writeManifest(resumeHash: string, skillsHash: string) {
  fs.writeFileSync(
    path.join(tmpDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: resumeHash },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: skillsHash },
    })
  );
}

function writeProfile(resumeHash: string, skillsHash: string) {
  fs.writeFileSync(
    path.join(tmpDir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: resumeHash, skills: skillsHash },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [{ rawSkillName: "Python", source: "employer", attributedTo: [{ employer: "Acme" }] }],
      experience: [{ employer: "Acme", title: "Data Engineer", startDate: "2020-01", endDate: null, technologies: ["Python"] }],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
}

const HASH_A = crypto.createHash("sha256").update("resume-a").digest("hex");
const HASH_B = crypto.createHash("sha256").update("skills-b").digest("hex");

test("missing candidate-profile.json -> status 'missing'", () => {
  writeManifest(HASH_A, HASH_B);
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "missing");
});

test("matching hashes -> status 'ok'", () => {
  writeManifest(HASH_A, HASH_B);
  writeProfile(HASH_A, HASH_B);
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.profile.skills[0].rawSkillName, "Python");
    assert.equal(candidateProfileHash(result.profile), `${HASH_A}:${HASH_B}`);
  }
});

test("mismatched resume hash (master file re-uploaded since profile built) -> status 'stale'", () => {
  writeManifest(HASH_A, HASH_B);
  writeProfile("some-old-hash", HASH_B);
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "stale");
});

test("manifest missing a sha256 (pre-hash upload) -> status 'stale', never assumed fresh", () => {
  fs.writeFileSync(
    path.join(tmpDir, "manifest.json"),
    JSON.stringify({
      resume: { filename: "resume.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10 },
      skills: { filename: "skills.docx", uploadedAt: "2026-01-01T00:00:00Z", sizeBytes: 10, sha256: HASH_B },
    })
  );
  writeProfile(HASH_A, HASH_B);
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "stale");
});

test("malformed JSON -> status 'invalid'", () => {
  writeManifest(HASH_A, HASH_B);
  fs.writeFileSync(path.join(tmpDir, "candidate-profile.json"), "{not json");
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "invalid");
});

test("wrong schemaVersion -> status 'invalid'", () => {
  writeManifest(HASH_A, HASH_B);
  fs.writeFileSync(
    path.join(tmpDir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 999,
      sourceHashes: { resume: HASH_A, skills: HASH_B },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "invalid");
});

test("unrecognized-taxonomy skill entries are preserved verbatim, not rejected", () => {
  writeManifest(HASH_A, HASH_B);
  fs.writeFileSync(
    path.join(tmpDir, "candidate-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceHashes: { resume: HASH_A, skills: HASH_B },
      builtAt: "2026-01-01T00:00:00Z",
      skills: [{ rawSkillName: "SomeBrandNewToolNotInTaxonomyYet", source: "inventory_only" }],
      experience: [],
      education: [],
      certifications: [],
      totalYearsExperience: null,
    })
  );
  const result = loadCandidateProfile(1);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.profile.skills[0].rawSkillName, "SomeBrandNewToolNotInTaxonomyYet");
  }
});
