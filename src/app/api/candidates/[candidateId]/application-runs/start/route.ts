import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { getJob } from "@/db/queries/jobs";
import { getCompany } from "@/db/queries/companies";
import { createRun, getRun } from "@/db/queries/applicationRuns";
import { loadKnownVariants, listAnswers } from "@/db/queries/applicationVault";
import { resolveCandidateContact } from "@/lib/resumeQuality/candidateContact";
import { resolveApplicationDocuments } from "@/lib/apply/documentLinkage";
import { selectAdapter } from "@/lib/apply/agent/selectAdapter";
import { ApplicationBrowserRuntime, realApplicationAgentDisabled } from "@/lib/apply/engine/browserRuntime";
import { executeRun, approveAndSubmit } from "@/lib/apply/engine/executor";
import type { StoredAnswer } from "@/lib/apply/resolveAnswer";
import type { QuestionType } from "@/lib/apply/questionTypes";

/**
 * POST — start (or resume) one application run, or submit one the user has approved.
 *
 * THIS IS THE ONLY PATH TO A BROWSER. Nothing else in the app imports the execution engine — a
 * test asserts that structurally — so Chromium starts if and only if a person asked for it here.
 *
 * EVERY PRECONDITION IS CHECKED BEFORE ANYTHING OPENS. No adapter for this ATS, no validated
 * resume, no verified contact details: each refuses with something the user can act on, and none
 * of them launches a browser to find out.
 *
 * SUBMISSION IS A SEPARATE ACTION with its own body shape, and the approval it carries names the
 * run. The storage layer refuses the transition otherwise, so this route cannot submit by accident
 * even if it wanted to.
 */

const StartBody = z.object({ action: z.literal("start"), jobId: z.number().int().positive() });
const ResumeBody = z.object({ action: z.literal("resume"), runId: z.number().int().positive() });
const SubmitBody = z.object({
  action: z.literal("submit"),
  runId: z.number().int().positive(),
  /** Must equal runId. Present so an approval is explicitly FOR this application, never inherited. */
  approvedRunId: z.number().int().positive(),
});
const Body = z.discriminatedUnion("action", [StartBody, ResumeBody, SubmitBody]);

function storedAnswerMap(candidateId: number): Map<string, StoredAnswer> {
  const map = new Map<string, StoredAnswer>();
  for (const a of listAnswers(candidateId)) {
    map.set(a.canonical_key, {
      answer_value: a.answer_value,
      answer_source: a.answer_source,
      approved_by_user: a.approved_by_user,
      auto_fill_allowed: a.auto_fill_allowed,
    });
  }
  return map;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: raw } = await ctx.params;
  const candidateId = Number(raw);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  }
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
  const denial = requireCandidateAccess(req, candidateId);
  if (denial) return denial;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  /* Verified contact details are required for every path — they are what fills the identity fields,
   * and the resolver is the same one the resume header uses. Nothing is guessed from a profile. */
  const contact = resolveCandidateContact(candidateId);
  if (!contact.isComplete || !contact.contact) {
    return NextResponse.json(
      {
        status: "contact_required",
        message: "Your contact details are incomplete, and they are what fills an application's identity fields.",
        problems: contact.problems,
      },
      { status: 200 }
    );
  }

  const runtime = new ApplicationBrowserRuntime();
  try {
    // ── submit ────────────────────────────────────────────────────────────────────────────────
    if (parsed.data.action === "submit") {
      const run = getRun(parsed.data.runId);
      if (!run || run.candidate_id !== candidateId) {
        return NextResponse.json({ error: "Application run not found" }, { status: 404 });
      }
      if (parsed.data.approvedRunId !== parsed.data.runId) {
        return NextResponse.json({ error: "The approval does not belong to this application." }, { status: 400 });
      }
      const after = await approveAndSubmit(run.id, runtime, { runId: run.id });
      return NextResponse.json({ status: after.status, run: { id: after.id, confirmation: after.confirmation_text } });
    }

    // ── resume an existing run ────────────────────────────────────────────────────────────────
    if (parsed.data.action === "resume") {
      const run = getRun(parsed.data.runId);
      if (!run || run.candidate_id !== candidateId) {
        return NextResponse.json({ error: "Application run not found" }, { status: 404 });
      }
      const after = await executeRun(run.id, runtime, {
        context: {
          candidateId,
          contact: contact.contact,
          resumePath: run.resume_file,
          coverLetterPath: run.cover_letter_file,
        },
        knownVariants: loadKnownVariants() as Map<string, { canonicalKey: string; type: QuestionType }>,
        storedAnswers: storedAnswerMap(candidateId),
      });
      return NextResponse.json({ status: after.status, run: { id: after.id, question: after.blocking_question } });
    }

    // ── start a new run ───────────────────────────────────────────────────────────────────────
    const job = getJob(parsed.data.jobId);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const adapter = selectAdapter({ source_type: job.source_type, url: job.url });
    if (!adapter) {
      return NextResponse.json({
        status: "unsupported_ats",
        message: `Career-Ops does not yet automate applications on ${job.source_type ?? "this site"}. Apply manually from the posting.`,
      });
    }

    const companyName = job.company_id ? getCompany(job.company_id)?.name ?? null : null;
    const docs = resolveApplicationDocuments({ candidateId, dedupeKey: job.dedupe_key, jobId: job.id, companyName });
    if (!docs.ready) {
      /* No validated resume means no run at all — not a run that pauses later. Refusing before a
       * browser opens keeps the failure cheap and the message specific. */
      return NextResponse.json({ status: "resume_required", message: docs.reason });
    }

    if (realApplicationAgentDisabled()) {
      return NextResponse.json({
        status: "agent_disabled",
        message:
          "Real application runs are switched off. Set CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT to \"false\" to enable them.",
      });
    }

    const run = createRun({
      candidateId,
      jobId: job.id,
      dedupeKey: job.dedupe_key,
      ats: adapter.sourceType,
      applyUrl: job.url,
      resumeFile: docs.resumePath,
      coverLetterFile: docs.coverLetterPath,
    });

    const after = await executeRun(run.id, runtime, {
      context: {
        candidateId,
        contact: contact.contact,
        resumePath: docs.resumePath,
        coverLetterPath: docs.coverLetterPath,
      },
      knownVariants: loadKnownVariants() as Map<string, { canonicalKey: string; type: QuestionType }>,
      storedAnswers: storedAnswerMap(candidateId),
    });

    return NextResponse.json({ status: after.status, run: { id: after.id, question: after.blocking_question } });
  } finally {
    /* The browser closes with the request. A run that paused resumes by opening a fresh page and
     * re-planning from its checkpoint — no process is held open waiting for a human. */
    await runtime.close();
  }
}
