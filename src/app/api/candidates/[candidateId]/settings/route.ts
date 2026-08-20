import { NextRequest, NextResponse } from "next/server";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import {
  getCandidateContact,
  getMatchAffectingSettings,
  getRankingPreferences,
  updateCandidateContact,
  updateCandidateSettings,
} from "@/db/queries/candidateSettings";
import { resolveCandidateContact } from "@/lib/resumeQuality/candidateContact";
import { computeCandidateSettingsHash } from "@/lib/match/candidateSettingsHash";
import { rematchCandidateJobsPage, type RematchCandidatePageResult } from "@/lib/match/rematchCandidate";

/**
 * Per-candidate settings — the UI for candidateSettings.ts (built/tested in the Phase 2.5 checkpoint
 * but never given a page). Mirrors the enforced type boundary from that module exactly: the request
 * body carries `matchAffecting` and `preferences` as two separate optional partials, never a single
 * flat object, so a client can never accidentally send a match-affecting field into the ranking-only
 * bucket or vice versa. Changing `preferences` alone never invalidates a Phase 2 match cache;
 * changing `matchAffecting` legitimately does (see candidateSettings.ts's own doc comment).
 */

const matchAffectingSchema = z
  .object({
    requiresSponsorship: z.boolean(),
    usCitizen: z.boolean(),
    workAuthorizedUS: z.boolean(),
    clearanceLevel: z.enum(["None", "Public Trust", "Secret", "Top Secret", "TS/SCI"]),
  })
  .partial()
  .strict();

const preferencesSchema = z
  .object({
    primaryTargetRole: z.string().trim().min(1).max(200).nullable(),
    secondaryTargetRoles: z.array(z.string().trim().min(1).max(200)).max(10),
    locationPreference: z.string().trim().min(1).max(200).nullable(),
    workplacePreference: z.array(z.string().trim().min(1).max(50)).max(10),
    employmentTypePreference: z.string().trim().min(1).max(50).nullable(),
  })
  .partial()
  .strict();

/**
 * Stage 26B — the candidate's real contact details, as a THIRD bucket alongside matchAffecting and
 * preferences, keeping this route's existing "never one flat object" boundary intact. Contact details
 * influence neither matching nor ranking, so a contact-only PATCH never invalidates a match cache.
 * Values are nullable so a field can be cleared; they are validated for placeholders below rather
 * than here, so the caller gets the same specific messages the tailoring pipeline would give.
 */
const contactSchema = z
  .object({
    email: z.string().trim().max(320).nullable(),
    phone: z.string().trim().max(50).nullable(),
    location: z.string().trim().max(200).nullable(),
    linkedin: z.string().trim().max(300).nullable(),
    github: z.string().trim().max(300).nullable(),
  })
  .partial()
  .strict();

const patchSchema = z
  .object({
    matchAffecting: matchAffectingSchema.optional(),
    preferences: preferencesSchema.optional(),
    contact: contactSchema.optional(),
  })
  .strict();

export async function GET(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;
  const candidateId = Number(candidateIdParam);
  if (!Number.isInteger(candidateId)) return NextResponse.json({ error: "Invalid candidateId" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const contactValidation = resolveCandidateContact(candidateId);
  return NextResponse.json({
    matchAffecting: getMatchAffectingSettings(candidateId),
    preferences: getRankingPreferences(candidateId),
    contact: getCandidateContact(candidateId),
    // Reported alongside the stored values so the settings page can show exactly what still blocks
    // tailoring, using the same rules the writer pipeline enforces — never a second set.
    contactStatus: {
      isComplete: contactValidation.isComplete,
      problems: contactValidation.problems,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;
  const candidateId = Number(candidateIdParam);
  if (!Number.isInteger(candidateId)) return NextResponse.json({ error: "Invalid candidateId" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const accessDenial = requireCandidateAccess(req, candidateId);
  if (accessDenial) return accessDenial;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings", details: parsed.error.issues }, { status: 400 });
  }

  // Phase 4 Stage 5: a match-affecting change moves candidateSettingsHash, which is half of the
  // Phase 2 cache identity — every one of this candidate's cached results is stale from here on.
  // The hash is compared before/after rather than trusting "the request contained matchAffecting":
  // re-saving identical values must not trigger any rematch work at all.
  const hashBefore = computeCandidateSettingsHash(getMatchAffectingSettings(candidateId));
  updateCandidateSettings(candidateId, parsed.data);
  // Stage 26B — written through its own function, which touches only the contact columns. Contact
  // details are not part of computeCandidateSettingsHash, so saving them never triggers a rematch.
  if (parsed.data.contact) updateCandidateContact(candidateId, parsed.data.contact);
  const hashAfter = computeCandidateSettingsHash(getMatchAffectingSettings(candidateId));

  // Exactly ONE bounded page (~2 s at the measured ~20 ms/job) — never a full walk, which would be
  // ~403 s and would hang this request. The response carries the cursor so the caller can continue
  // page-by-page via POST /api/candidates/[candidateId]/rematch, or finish it offline with
  // `npm run rematch-candidate`. A rematch failure must never turn a saved settings change into an
  // error response: the settings write above is already committed and is reported regardless.
  let rematch: RematchCandidatePageResult | null = null;
  if (hashBefore !== hashAfter) {
    try {
      rematch = rematchCandidateJobsPage({ candidateId });
    } catch {
      rematch = null;
    }
  }

  const contactValidation = resolveCandidateContact(candidateId);
  return NextResponse.json({
    matchAffecting: getMatchAffectingSettings(candidateId),
    preferences: getRankingPreferences(candidateId),
    contact: getCandidateContact(candidateId),
    contactStatus: {
      isComplete: contactValidation.isComplete,
      problems: contactValidation.problems,
    },
    rematch,
  });
}
