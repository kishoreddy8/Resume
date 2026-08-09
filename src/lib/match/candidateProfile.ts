import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CandidateProfile } from "./types";

/**
 * Loader/validator for data/candidates/<candidateId>/candidate-profile.json — the ONLY V1 source of
 * a candidate profile (see build-candidate-profile skill,
 * .claude/skills/build-candidate-profile/SKILL.md — invoked as `/build-candidate-profile <candidate_id>`).
 *
 * Master Resume and Master Skills Inventory (data/candidates/<candidateId>/master/{resume,skills}.*)
 * remain the sole factual authority at all times. This file is a derived, versioned INDEX only —
 * this module never writes it, never trusts it over the manifest's source hashes, and refuses to
 * treat a stale or missing profile as usable (see loadCandidateProfile below).
 *
 * Phase 2.5: every path below is candidate-scoped by an explicit candidateId parameter — there is no
 * "current candidate" fallback anywhere in this module. A caller that gets the wrong candidateId gets
 * the wrong candidate's data; there is no implicit default to accidentally cross-contaminate against.
 */

export const CANDIDATE_PROFILE_SCHEMA_VERSION = 1;

// CAREER_OPS_MASTER_DIR is a test-only override (mirroring src/db/index.ts's CAREER_OPS_DB_PATH
// convention) that specifies the exact master directory directly, bypassing per-candidate path
// derivation entirely — real app code never sets this env var. CAREER_OPS_CANDIDATES_DIR (also
// test-only) overrides just the candidates root, preserving per-candidate subdirectories.
function candidatesRoot(): string {
  return process.env.CAREER_OPS_CANDIDATES_DIR ?? path.join(process.cwd(), "data", "candidates");
}
function candidateDir(candidateId: number): string {
  return path.join(candidatesRoot(), String(candidateId));
}
function masterDir(candidateId: number): string {
  return process.env.CAREER_OPS_MASTER_DIR ?? path.join(candidateDir(candidateId), "master");
}
function candidateProfilePath(candidateId: number): string {
  return process.env.CAREER_OPS_MASTER_DIR
    ? path.join(process.env.CAREER_OPS_MASTER_DIR, "candidate-profile.json")
    : path.join(candidateDir(candidateId), "candidate-profile.json");
}
function manifestPath(candidateId: number): string {
  return path.join(masterDir(candidateId), "manifest.json");
}

const skillEntrySchema = z
  .object({
    rawSkillName: z.string().min(1),
    source: z.enum(["employer", "inventory_only"]),
    attributedTo: z.array(z.object({ employer: z.string().min(1), project: z.string().optional() })).optional(),
    yearsStated: z.number().positive().optional(),
  })
  .strict();

const experienceEntrySchema = z
  .object({
    employer: z.string().min(1),
    title: z.string().min(1),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    technologies: z.array(z.string()),
  })
  .strict();

const educationEntrySchema = z
  .object({
    level: z.string().min(1),
    field: z.string().nullable(),
    institution: z.string().nullable(),
  })
  .strict();

const certificationSchema = z.object({ name: z.string().min(1), issuer: z.string().optional() }).strict();

export const candidateProfileSchema = z
  .object({
    schemaVersion: z.number().int(),
    sourceHashes: z.object({ resume: z.string().min(1), skills: z.string().min(1) }).strict(),
    builtAt: z.string(),
    skills: z.array(skillEntrySchema),
    experience: z.array(experienceEntrySchema),
    education: z.array(educationEntrySchema),
    certifications: z.array(certificationSchema),
    totalYearsExperience: z.number().nonnegative().nullable(),
  })
  .strict();

interface ManifestEntry {
  filename: string;
  uploadedAt: string;
  sizeBytes: number;
  sha256?: string;
}
type Manifest = Partial<Record<"resume" | "skills", ManifestEntry>>;

function readManifest(candidateId: number): Manifest {
  const manifestFile = manifestPath(candidateId);
  if (!fs.existsSync(manifestFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
  } catch {
    return {};
  }
}

export type CandidateProfileLoadResult =
  | { status: "ok"; profile: CandidateProfile }
  | { status: "missing" }
  | { status: "stale" }
  | { status: "invalid"; error: string };

/**
 * Loads and validates the candidate profile, then checks it against the CURRENT manifest hashes
 * (see /api/master-files's sha256 field). A profile built against an older resume/skills upload is
 * "stale" — evaluateJobMatch.ts must never produce a match result from a stale or missing profile
 * (Phase 2 Revision 3 §9 / Revision 4: this is the mechanism that makes
 * "candidate-profile missing or stale must never produce READY_FOR_TAILORING" true by construction,
 * since no result is ever computed in either case).
 */
export function loadCandidateProfile(candidateId: number): CandidateProfileLoadResult {
  const profileFile = candidateProfilePath(candidateId);
  if (!fs.existsSync(profileFile)) return { status: "missing" };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(profileFile, "utf-8"));
  } catch {
    return { status: "invalid", error: "candidate-profile.json is not valid JSON" };
  }

  const parsed = candidateProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", error: parsed.error.message };
  }
  if (parsed.data.schemaVersion !== CANDIDATE_PROFILE_SCHEMA_VERSION) {
    return { status: "invalid", error: `Unsupported candidate-profile schemaVersion ${parsed.data.schemaVersion} (expected ${CANDIDATE_PROFILE_SCHEMA_VERSION})` };
  }

  const manifest = readManifest(candidateId);
  const resumeHash = manifest.resume?.sha256;
  const skillsHash = manifest.skills?.sha256;
  // Missing manifest hashes (upload predates the sha256 field, or files were never uploaded) can
  // never be verified as fresh — the safe direction is "treat as stale", never "assume fresh".
  if (!resumeHash || !skillsHash) return { status: "stale" };
  if (parsed.data.sourceHashes.resume !== resumeHash || parsed.data.sourceHashes.skills !== skillsHash) {
    return { status: "stale" };
  }

  return { status: "ok", profile: parsed.data as CandidateProfile };
}

/** Stable hash identity for cache-key purposes — the two source file hashes combined, not the
 *  candidate-profile.json's own bytes (so re-running build-candidate-profile against IDENTICAL
 *  master files, which can happen if the skill is re-run without a new upload, still cache-hits). */
export function candidateProfileHash(profile: CandidateProfile): string {
  return `${profile.sourceHashes.resume}:${profile.sourceHashes.skills}`;
}
