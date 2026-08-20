import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { invokeProfileBuild } from "@/lib/candidateProfileBuild/invoker";
import { beginBuild, finishBuild, getBuildState, reportPhase, PHASE_LABEL } from "@/lib/candidateProfileBuild/registry";

/**
 * POST — start a profile build. Returns immediately; GET reports progress.
 *
 * The build is deliberately NOT awaited here. It takes about two minutes, and holding the response
 * open meant the work was tied to one page: navigating away lost all track of it, and nothing
 * prevented a second click from spawning a second CLI process — two billed runs racing to write the
 * same file. The registry makes the build a server-side fact that any page can ask about.
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

  const existing = getBuildState(candidateId);
  if (existing?.status === "running") {
    // Not an error: the caller simply asked for something already happening.
    return NextResponse.json({ ok: true, alreadyRunning: true, startedAt: existing.startedAt }, { status: 202 });
  }
  if (!beginBuild(candidateId)) {
    return NextResponse.json({ ok: true, alreadyRunning: true }, { status: 202 });
  }

  // Snapshot whatever is there now, so a failed build is never destructive.
  const previous = fs.existsSync(profilePath) ? fs.readFileSync(profilePath) : null;

  /* Runs detached from this response. Every exit path must call finishBuild, or the UI would show a
   * build running forever. */
  void (async () => {
    try {
      const run = await invokeProfileBuild({
        candidateId,
        candidateDir,
        onPhase: (phase) => reportPhase(candidateId, phase),
      });
      if (!run.ok) {
        finishBuild(candidateId, {
          ok: false,
          error:
            run.reason === "disabled"
              ? "Automatic profile building is disabled in this environment."
              : `Profile build did not complete: ${run.detail}`,
        });
        return;
      }

      // Trust nothing the model wrote until the real loader accepts it.
      reportPhase(candidateId, "validating");
      const loaded = loadCandidateProfile(candidateId);
      if (loaded.status !== "ok") {
        if (previous) fs.writeFileSync(profilePath, previous);
        else if (fs.existsSync(profilePath)) fs.rmSync(profilePath);
        finishBuild(candidateId, {
          ok: false,
          error:
            "The generated profile did not pass validation and was discarded. Your previous profile, if any, is unchanged.",
        });
        return;
      }

      /* Provenance goes in a SIBLING file, never inside the profile: candidateProfileSchema is
       * .strict(), and writing builtBy into it made the next read fail with unrecognized_keys. */
      try {
        fs.writeFileSync(
          path.join(candidateDir, "profile-build-meta.json"),
          JSON.stringify({ builtBy: "claude-cli", builtAt: new Date().toISOString() }, null, 2)
        );
      } catch {
        // Provenance is a nicety; a valid profile must not be rejected because this failed.
      }

      finishBuild(candidateId, {
        ok: true,
        summary: {
          skills: loaded.profile.skills.length,
          experience: loaded.profile.experience.length,
          certifications: loaded.profile.certifications.length,
        },
      });
    } catch (err) {
      finishBuild(candidateId, { ok: false, error: `Profile build failed unexpectedly: ${String(err)}` });
    }
  })();

  return NextResponse.json({ ok: true, started: true, candidateId }, { status: 202 });
}

/** GET — how a build is going, for any page that wants to show it. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const state = getBuildState(candidateId);
  return NextResponse.json({
    candidateId,
    status: state?.status ?? "idle",
    /* The phase is sent as finished prose, not a key, so the strip and the setup page cannot
     *  drift apart on wording — and so no client is tempted to derive a percentage from it. */
    phase: state?.phase ? PHASE_LABEL[state.phase] : null,
    startedAt: state?.startedAt ?? null,
    finishedAt: state?.finishedAt ?? null,
    error: state?.error ?? null,
    summary: state?.summary ?? null,
  });
}
