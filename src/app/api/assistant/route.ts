import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { buildAssistantPrompt, buildJobContext } from "@/lib/assistant/context";
import { askAssistant } from "@/lib/assistant/invoker";

/**
 * POST — answer one question about this installation's own data.
 *
 * POST ONLY, DELIBERATELY. A GET would be fetched by a prefetch, a crawler, or a page that merely
 * mounted, and every one of those would spend the user's Claude subscription on a question nobody
 * asked. Requiring a POST with a body makes every invocation an act.
 *
 * IT CHANGES NOTHING. No stage moves, no evidence is edited, no resume is written, no scan runs.
 * The assistant explains state; acting on it stays with the existing explicit controls.
 *
 * The model is handed facts and asked to explain them — see context.ts for why grounding is the
 * whole design rather than a safeguard on top of it.
 */

const BodySchema = z.object({
  candidateId: z.number().int().positive(),
  jobId: z.number().int().positive(),
  question: z.string().trim().min(3).max(500),
});

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A candidateId, jobId and question are required." }, { status: 400 });
  }
  const { candidateId, jobId, question } = parsed.data;

  if (!requireActiveCandidate(candidateId)) {
    return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  }
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const context = buildJobContext(candidateId, jobId);
  if (!context) {
    /* Not an error. There is genuinely nothing to explain, and saying so beats asking a model to
     * fill the gap. */
    return NextResponse.json({
      status: "no_context",
      message:
        "This job has not been evaluated against your profile yet, so there is no decision or evidence to explain.",
    });
  }

  const outcome = await askAssistant({ prompt: buildAssistantPrompt(question, context) });

  if (!outcome.ok) {
    return NextResponse.json({ status: outcome.reason, message: outcome.detail });
  }
  return NextResponse.json({ status: "ok", answer: outcome.answer, groundedIn: context.scope });
}
