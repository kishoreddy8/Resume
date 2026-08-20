import { NextResponse, type NextRequest } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { getRankingPreferences } from "@/db/queries/candidateSettings";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { getCandidateMatchDecisionCounts } from "@/db/queries/operations";
import fs from "node:fs";
import path from "node:path";

/**
 * One request describing exactly how far a candidate's setup has got, so the UI never has to guess
 * or stitch four endpoints together.
 *
 * WHY THIS EXISTS. A tester uploaded a Master Resume and Skills Inventory, saw both listed as
 * uploaded, and then got zero matches forever with nothing on screen explaining why. Uploading the
 * files does not build the derived profile the matching engine reads, and nothing said so. Every
 * step below is reported explicitly, including the one the app cannot perform itself.
 *
 * The step the app cannot do: building candidate-profile.json means reading .docx and reasoning
 * about which employer each skill belongs to, what the experience entries are, and what years the
 * resume actually STATES. The app has no .docx extraction and deliberately never has — that
 * reasoning lives in the /build-candidate-profile skill in Claude Code. A naive XML text dump would
 * produce a plausible-looking but wrong profile, and Stage 21's truthfulness guarantees rest on it
 * being right. So this reports the blocking step and the exact command instead of faking it.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
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

  /* Read the same manifest /api/master-files writes. Inlined rather than exported from that route
   * because a route module is not an importable helper — duplicating four lines beats coupling two
   * routes together. */
  const manifestFile = path.join(process.cwd(), "data", "candidates", String(candidateId), "master", "manifest.json");
  let manifest: { resume?: unknown; skills?: unknown } = {};
  if (fs.existsSync(manifestFile)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    } catch {
      manifest = {};
    }
  }
  const hasResume = Boolean(manifest.resume);
  const hasSkills = Boolean(manifest.skills);

  const loaded = loadCandidateProfile(candidateId);
  const profileStatus = loaded.status; // ok | missing | stale | invalid

  const prefs = getRankingPreferences(candidateId);
  // "Set" means the one field ranking actually needs. Secondary roles are optional by design.
  const hasPreferences = Boolean(prefs.primaryTargetRole && prefs.primaryTargetRole.trim());

  const counts = getCandidateMatchDecisionCounts(candidateId);
  const evaluated = counts.readyForTailoring + counts.needsReview + counts.blocked;

  const steps = {
    resume: hasResume,
    skills: hasSkills,
    preferences: hasPreferences,
    profile: profileStatus === "ok",
    evaluated: evaluated > 0,
  };

  /** The first thing standing between this candidate and a working workspace. */
  const blockedOn: string | null = !hasResume
    ? "resume"
    : !hasSkills
      ? "skills"
      : !hasPreferences
        ? "preferences"
        : profileStatus !== "ok"
          ? "profile"
          : evaluated === 0
            ? "evaluation"
            : null;

  return NextResponse.json({
    candidateId,
    steps,
    blockedOn,
    complete: blockedOn === null,
    profileStatus,
    /* The app cannot build this itself — see the header. Handing back the exact command means the
     * user never has to work out the candidate id or remember the skill's name. */
    profileCommand: `/build-candidate-profile ${candidateId}`,
    canEvaluate: hasResume && hasSkills && hasPreferences && profileStatus === "ok",
    counts: { ...counts, evaluated },
    preferences: prefs,
  });
}
