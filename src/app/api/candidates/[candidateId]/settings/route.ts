import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import {
  getMatchAffectingSettings,
  getRankingPreferences,
  updateCandidateSettings,
} from "@/db/queries/candidateSettings";

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

const patchSchema = z
  .object({
    matchAffecting: matchAffectingSchema.optional(),
    preferences: preferencesSchema.optional(),
  })
  .strict();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;
  const candidateId = Number(candidateIdParam);
  if (!Number.isInteger(candidateId)) return NextResponse.json({ error: "Invalid candidateId" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  return NextResponse.json({
    matchAffecting: getMatchAffectingSettings(candidateId),
    preferences: getRankingPreferences(candidateId),
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = await params;
  const candidateId = Number(candidateIdParam);
  if (!Number.isInteger(candidateId)) return NextResponse.json({ error: "Invalid candidateId" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings", details: parsed.error.issues }, { status: 400 });
  }

  updateCandidateSettings(candidateId, parsed.data);

  return NextResponse.json({
    matchAffecting: getMatchAffectingSettings(candidateId),
    preferences: getRankingPreferences(candidateId),
  });
}
