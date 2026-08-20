import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { invokeProfileBuild } from "@/lib/candidateProfileBuild/invoker";

/**
 * POST — build this candidate's profile by running their own Claude Code CLI.
 *
 * VALIDATION IS THE POINT. The CLI writes candidate-profile.json, but nothing is trusted just
 * because a model produced it. Acceptance is decided by loadCandidateProfile() — the same loader
 * the matching engine uses — which enforces the schema, the schemaVersion, and that sourceHashes
 * match the CURRENT upload manifest. If the model invented a shape, skipped a field, or hashed the
 * wrong file, the loader reports missing/stale/invalid and this route reports failure rather than
 * letting a plausible-looking profile through.
 *
 * The previous profile is snapshotted first and restored if the new one does not validate, so a
 * failed build can never leave a candidate worse off than before it ran.
 *
 * PROVENANCE. A profile built this way records builtBy: "claude-cli". The one built by a human
 * running /build-candidate-profile is indistinguishable in content, but knowing which produced a
 * given file matters when a match result is later questioned.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const candidateDir = path.join(process.cwd(), "data", "candidates", String(candidateId));
  const profilePath = path.join(candidateDir, "candidate-profile.json");

  // Snapshot whatever is there now, so a failed build is never destructive.
  const previous = fs.existsSync(profilePath) ? fs.readFileSync(profilePath) : null;

  const run = await invokeProfileBuild({ candidateId, candidateDir });
  if (!run.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: run.reason,
        error:
          run.reason === "disabled"
            ? "Automatic profile building is disabled in this environment."
            : `Profile build did not complete: ${run.detail}`,
        fallbackCommand: `/build-candidate-profile ${candidateId}`,
      },
      { status: run.reason === "disabled" ? 503 : 502 }
    );
  }

  // Trust nothing the model wrote until the real loader accepts it.
  const loaded = loadCandidateProfile(candidateId);
  if (loaded.status !== "ok") {
    if (previous) fs.writeFileSync(profilePath, previous);
    else if (fs.existsSync(profilePath)) fs.rmSync(profilePath);
    return NextResponse.json(
      {
        ok: false,
        reason: "validation_failed",
        profileStatus: loaded.status,
        error:
          "The generated profile did not pass validation and was discarded. The previous profile, if any, is unchanged.",
        fallbackCommand: `/build-candidate-profile ${candidateId}`,
      },
      { status: 422 }
    );
  }

  /* Provenance goes in a SIBLING file, never inside the profile.
   *
   * The first version wrote builtBy into candidate-profile.json itself. candidateProfileSchema is
   * .strict(), so the next read failed with unrecognized_keys and a freshly built, perfectly good
   * profile was reported invalid — the write that recorded how it was made is what broke it.
   * Validating before the write hid this; only re-reading afterwards exposed it. */
  try {
    fs.writeFileSync(
      path.join(candidateDir, "profile-build-meta.json"),
      JSON.stringify({ builtBy: "claude-cli", builtAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    // Provenance is a nicety; a valid profile must not be rejected because this failed.
  }

  return NextResponse.json({
    ok: true,
    candidateId,
    skills: loaded.profile.skills.length,
    experience: loaded.profile.experience.length,
    certifications: loaded.profile.certifications.length,
    totalYearsExperience: loaded.profile.totalYearsExperience,
  });
}
