import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { editAnswer, listAnswersForCandidate } from "@/db/queries/applicationVault";
import { DEFAULT_POLICY } from "@/lib/apply/questionTypes";

/**
 * UI-AM — the one candidate-facing read/write surface for the Application Answer Vault.
 *
 * NO NEW STORE. Every read here is `listAnswersForCandidate` (a display-friendly projection of the
 * exact same `application_answers`/`application_questions` tables the fill-time resolver reads);
 * every write is `editAnswer`, which itself calls the same `saveAnswer` the Question Center's batch
 * and single-answer paths already use. There is one Answer Vault, read and written the same way
 * everywhere.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO. No delete/forget — no such write path exists anywhere
 * in this codebase yet (confirmed: `applicationVault.ts` has no delete function, and
 * `/api/candidates/[candidateId]/settings/route.ts`'s own comment already documents that "clear
 * saved answers" was deliberately left unbuilt). Adding one here would be inventing new backend
 * mutation capability under cover of a UI phase, not evolving an existing path.
 */

export async function GET(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const rows = listAnswersForCandidate(candidateId).map((row) => ({
    id: row.id,
    question: row.question_text,
    answer: row.answer_value,
    questionType: row.question_type,
    /* The candidate-facing UI maps this to plain language and, for `auto_after_approval` types
     * only, an editable toggle — never rendered as this raw string. Sent as data (like every other
     * `runStatus`-shaped payload in this codebase) so the presentation module is the only place
     * that has to know the vocabulary, not duplicated per caller.
     *
     * DEFAULT_POLICY, not the stored `reuse_policy` column, is what actually governs this answer's
     * real fill-time behavior: resolveAnswer.ts and retryContext.ts both re-derive the policy fresh
     * from DEFAULT_POLICY[questionType] and never read the stored column at all — it is written
     * once by recordQuestion() and never consulted again by anything in the engine. Showing the
     * live DEFAULT_POLICY value is therefore the truthful choice; the stored column only remains as
     * a fallback for a legacy question_type string DEFAULT_POLICY no longer recognizes. */
    reusePolicy: DEFAULT_POLICY[row.question_type]?.reusePolicy ?? row.reuse_policy,
    sensitivity: row.sensitivity,
    approved: Boolean(row.approved_by_user),
    autoFillAllowed: Boolean(row.auto_fill_allowed),
    updatedAt: row.updated_at,
  }));

  return NextResponse.json({ answers: rows });
}

const PatchBody = z.object({
  id: z.number().int().positive(),
  answerValue: z.string().trim().min(1).max(5000).optional(),
  autoFillAllowed: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const body = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "A valid answer id is required." }, { status: 400 });
  if (parsed.data.answerValue === undefined && parsed.data.autoFillAllowed === undefined) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const updated = editAnswer(candidateId, parsed.data.id, {
    answerValue: parsed.data.answerValue,
    autoFillAllowed: parsed.data.autoFillAllowed,
  });
  if (!updated) return NextResponse.json({ error: "Saved answer not found." }, { status: 404 });

  return NextResponse.json({ status: "updated" });
}
