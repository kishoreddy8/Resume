import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ResumeLibraryEntry } from "../../api/candidates/[candidateId]/resume-library/route";
import type { ForYouResponseEntry } from "../../api/candidates/[candidateId]/for-you/route";
import {
  attentionOverflowCount,
  boundedRecommendations,
  chooseHomeAction,
  homeAttention,
  homeCounts,
  presentHomeResumes,
  type HomePresentationInput,
} from "../../home/homePresentation";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/home/page.tsx"), "utf8");
const homeRoute = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/candidates/[candidateId]/home/route.ts"),
  "utf8"
);
const presentation = fs.readFileSync(path.join(process.cwd(), "src/app/home/homePresentation.ts"), "utf8");

function resume(overrides: Partial<ResumeLibraryEntry> = {}): ResumeLibraryEntry {
  return {
    jobId: 41,
    dedupeKey: "job-41",
    company: "Acme",
    title: "Data Engineer",
    location: "Chicago",
    ats: "greenhouse",
    workflowId: 7,
    workflowStatus: "READY",
    iteration: 1,
    updatedAt: "2026-08-21T00:00:00.000Z",
    readiness: "READY_FOR_HUMAN_APPLICATION",
    humanMaySend: true,
    blockingReason: null,
    qualityGatePassed: true,
    overallScore: 100,
    isLegacyMissingAnalysis: false,
    canRevalidate: false,
    canRetry: false,
    documents: { resume: true, coverLetter: true, packageKind: "final" },
    ...overrides,
  };
}

function recommendation(id: number, score = 90): ForYouResponseEntry {
  return {
    job: {
      id,
      title: `Role ${id}`,
      company_name: `Company ${id}`,
      location: "Remote",
      posted_at: null,
      first_seen_at: "2026-08-20T00:00:00.000Z",
      source_type: "greenhouse",
      pinned: 0,
    },
    ranking: { overallScore: score, insufficientJdSignal: false },
  } as unknown as ForYouResponseEntry;
}

function input(overrides: Partial<HomePresentationInput> = {}): HomePresentationInput {
  return { profileStatus: "ok", applications: [], resumes: [], recommendations: [], ...overrides };
}

test("Home reads only the three existing bounded projections", () => {
  assert.match(page, /Promise\.all\(\[/);
  assert.match(page, /\/home`/);
  assert.match(page, /\/resume-library`/);
  assert.match(page, /\/for-you\?limit=5&roleFamily=PRIMARY,SECONDARY`/);
  assert.equal((page.match(/fetch\(`/g) ?? []).length, 3);
});

test("Home does not fetch a resume body, preview, artifact, or workflow per row", () => {
  assert.doesNotMatch(page, /resume-preview|\/artifacts|quality-workflow|document.body/);
  assert.doesNotMatch(page, /\.map\([^)]*=>\s*fetch/);
});

test("ready count follows humanMaySend rather than READY workflow text", () => {
  const counts = homeCounts(input({ resumes: [resume({ humanMaySend: false, readiness: "BLOCKED" })] }));
  assert.equal(counts.ready, 0);
});

test("sendable approved package counts as ready", () => {
  assert.equal(homeCounts(input({ resumes: [resume()] })).ready, 1);
});

test("application intervention has the highest next-action priority", () => {
  const action = chooseHomeAction(input({
    applications: [{ id: 8, status: "WAITING_FOR_MFA", title: "Engineer", company: "Acme" }],
    resumes: [resume({ workflowStatus: "FAILED", readiness: "BLOCKED", humanMaySend: false })],
  }));
  assert.deepEqual([action.kind, action.href, action.cta], ["application", "/applications/8", "Complete verification"]);
});

test("profile setup follows application interventions", () => {
  assert.equal(chooseHomeAction(input({ profileStatus: "missing" })).kind, "profile");
});

test("blocked resume action deep-links to review issues", () => {
  const action = chooseHomeAction(input({ resumes: [resume({ workflowStatus: "FAILED", readiness: "BLOCKED", humanMaySend: false })] }));
  assert.equal(action.kind, "issues");
  assert.equal(action.href, "/jobs/41?step=validation&focus=issues");
});

test("legacy refresh action deep-links without starting a mutation", () => {
  const action = chooseHomeAction(input({ resumes: [resume({ readiness: "BLOCKED", humanMaySend: false, isLegacyMissingAnalysis: true, canRevalidate: true })] }));
  assert.equal(action.kind, "revalidate");
  assert.equal(action.href, "/jobs/41?step=validation&focus=revalidate");
});

test("active tailoring links to discrete progress", () => {
  const action = chooseHomeAction(input({ resumes: [resume({ workflowStatus: "REVIEW_RUNNING", readiness: null, humanMaySend: null })] }));
  assert.equal(action.kind, "progress");
  assert.equal(action.href, "/jobs/41?step=results&focus=progress");
});

test("ready resume is preferred before a recommendation", () => {
  const action = chooseHomeAction(input({ resumes: [resume()], recommendations: [recommendation(99)] }));
  assert.equal(action.kind, "ready");
});

test("recommendations preserve the authoritative For You order", () => {
  const entries = [recommendation(3, 81), recommendation(1, 99), recommendation(2, 90)];
  assert.deepEqual(boundedRecommendations(entries).map((entry) => entry.job.id), [3, 1, 2]);
});

test("recommendations are bounded at three — a taste of the feed, not a second one (UIH Part 6)", () => {
  assert.equal(boundedRecommendations(Array.from({ length: 8 }, (_, i) => recommendation(i + 1))).length, 3);
});

test("attention merges applications and resume issues and remains bounded", () => {
  const applications = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, status: "WAITING_FOR_ANSWER", title: `Role ${i}`, company: "Acme" }));
  const resumes = Array.from({ length: 4 }, (_, i) => resume({ workflowId: 20 + i, jobId: 50 + i, workflowStatus: "FAILED", readiness: "BLOCKED", humanMaySend: false }));
  const items = homeAttention(input({ applications, resumes }));
  assert.equal(items.length, 5);
  assert.equal(items[0]?.href, "/applications/1");
  assert.match(items[4]?.href ?? "", /step=validation&focus=issues/);
});

test("unknown application enums never leak raw status text", () => {
  const action = chooseHomeAction(input({ applications: [{ id: 1, status: "NEW_INTERNAL_ENUM", title: null, company: null }] }));
  assert.equal(action.cta, "View progress");
  assert.doesNotMatch(action.detail, /NEW_INTERNAL_ENUM/);
});

test("empty account has a truthful browse action", () => {
  const action = chooseHomeAction(input());
  assert.deepEqual([action.kind, action.href, action.cta], ["browse", "/jobs", "Browse jobs"]);
});

test("candidate-critical copy is at least 13px and mobile CTAs remain reachable", () => {
  assert.doesNotMatch(page, /text-\[(?:9|10|11|12|12\.5)px\]/);
  assert.match(page, /min-h-1[12]/);
  assert.doesNotMatch(page, /hidden[^"\n]*sm:block[^\n]*action\.href/);
});

test("resume progress is derived from the shared Resume Studio presentation", () => {
  const rows = presentHomeResumes([resume({ workflowStatus: "WRITER_RUNNING", readiness: null, humanMaySend: null })]);
  assert.equal(rows[0]?.presentation.bucket, "tailoring");
});

/* ============================================================================================
 * UI-H — SPATIAL PREMIUM HOME — TEST CONTRACT (Part 16)
 * ============================================================================================ */

test("UIH-ATTENTION-01: at most one dominant attention card is ever rendered — no second full attention list", () => {
  assert.equal((page.match(/id="next-action"/g) ?? []).length, 1);
  // The pre-redesign aside rendered every attention item a second time in full; that section is gone —
  // the overflow beyond the dominant item is a compact count, never a second list of cards.
  assert.doesNotMatch(page, /aria-label="Needs attention"/);
});

test("UIH-ATTENTION-01: the overflow count never exceeds attention.length - 1 for a pool-drawn dominant item", () => {
  const applications = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, status: "WAITING_FOR_ANSWER", title: `Role ${i}`, company: "Acme" }));
  const view = input({ applications });
  const action = chooseHomeAction(view);
  const attention = homeAttention(view);
  assert.equal(action.kind, "application");
  assert.equal(attentionOverflowCount(action, attention), attention.length - 1);
});

test("UIH-ATTENTION-02: nothing needs the user -> zero overflow and the calm sentence renders, never an empty warning", () => {
  const action = chooseHomeAction(input());
  const attention = homeAttention(input());
  assert.equal(attention.length, 0);
  assert.equal(attentionOverflowCount(action, attention), 0);
  assert.equal(action.kind, "browse");
  assert.match(page, /Nothing needs your attention right now/);
  assert.doesNotMatch(page, /class="[^"]*warning[^"]*"[^>]*>\s*Nothing needs/i);
});

test("UIH.1-ATTENTION-03: the calm reassurance line is gated on kind === \"browse\" only — a ready resume or top match reads as good news on its own, never paired with a 'nothing needs you' disclaimer that would contradict the CTA right below it", () => {
  assert.match(page, /action\.kind === "browse" && <p/);
  // ready/match/progress must never be listed alongside the calm-line condition
  assert.doesNotMatch(page, /action\.kind === "browse" \|\| action\.kind === "ready"/);
  assert.doesNotMatch(page, /!urgent && <p className="text-\[13px\] font-medium text-tertiary">Nothing needs/);
});

test("UIH-READY-01: 'ready for you' resume rows are gated on the authoritative bucket, not a guess", () => {
  const blocked = presentHomeResumes([resume({ humanMaySend: false, readiness: "BLOCKED", workflowStatus: "FAILED" })]);
  assert.notEqual(blocked[0]?.presentation.bucket, "ready");
  const sendable = presentHomeResumes([resume()]);
  assert.equal(sendable[0]?.presentation.bucket, "ready");
});

test("UIH-JOBS-01: recommended jobs are read from the existing For You fetch, not recomputed", () => {
  assert.match(page, /\/for-you\?limit=5&roleFamily=PRIMARY,SECONDARY`/);
  assert.doesNotMatch(page, /rankForYou|computeRoleFamilyTier|classifyCandidateJobBucket/);
});

test("UIH-JOBS-02: no duplicate recommendation/ranking algorithm exists on Home", () => {
  assert.doesNotMatch(page, /\.sort\(/);
  assert.doesNotMatch(homeRoute, /rankForYou|ORDER BY.*RANDOM|computeRoleFamilyTier/i);
  // The home API route may read persisted match data but must never re-derive a score.
  assert.doesNotMatch(homeRoute, /overall_score\s*=|overallScore\s*=[^=]/);
});

test("UIH-ACTIVITY-01: recent activity renders the notification's own recorded text verbatim", () => {
  assert.match(homeRoute, /FROM notifications/);
  assert.match(page, /event\.text/);
  assert.doesNotMatch(page, /worked.*hours|productivity|hours saved/i);
});

test("UIH.1-ACTIVITY-02: the section is honestly labeled 'Recent activity', not 'Recent progress' — the underlying notification feed mixes alerts (HUMAN_REVIEW_REQUIRED, QUALITY_FAILURE, application_needs_attention) and an ambiguous outcome type with genuine progress, so calling all of it 'progress' would be false for roughly half of it", () => {
  assert.match(page, /title="Recent activity"/);
  assert.doesNotMatch(page, /title="Recent progress"/);
  assert.match(page, /aria-label="Recent activity"/);
});

test("UIH-METRIC-01: no interview/offer/hiring prediction anywhere in Home", () => {
  const forbidden = /interview rate|interview chance|offer rate|hiring probability|recruiter response probability|ai success score/i;
  assert.doesNotMatch(page, forbidden);
  assert.doesNotMatch(presentation, forbidden);
  assert.doesNotMatch(homeRoute, forbidden);
});

test("UIH-METRIC-02: no fabricated profile completion percentage", () => {
  assert.doesNotMatch(page, /profile[^.]*\d+%|\d+%[^.]*complete/i);
  assert.doesNotMatch(presentation, /profile[^.]*\d+%|\d+%[^.]*complete/i);
  assert.doesNotMatch(homeRoute, /profile[^.]*\d+%/i);
});

test("UIH-ACTION-01: every Home CTA destination is a real, existing route", () => {
  const routes = ["applications", "resume", "jobs", "onboarding", "settings/answers", "activity"];
  for (const route of routes) {
    const dir = path.join(process.cwd(), "src/app", route);
    assert.ok(fs.existsSync(dir), `expected src/app/${route} to exist`);
  }
});

test("UIH-MOBILE-01: no dashboard KPI tile grid on Home", () => {
  assert.doesNotMatch(page, /grid-cols-2 gap-3 lg:grid-cols-4/);
  assert.doesNotMatch(page, /New matches/);
  assert.doesNotMatch(page, /Tailoring in progress"[,:]/); // the old tile label, not the eyebrow copy
});

test("UIH-NAMING-01: no JobHunt string anywhere in candidate-facing Home", () => {
  assert.doesNotMatch(page, /JobHunt/);
});

test("UIH-ENGINE-01: Home imports nothing from the apply engine", () => {
  assert.doesNotMatch(page, /from ["']@\/lib\/apply/);
  assert.doesNotMatch(presentation, /from ["']@\/lib\/apply/);
  assert.doesNotMatch(homeRoute, /from ["']@\/lib\/apply/);
});

test("UIH.1-RESPONSIVE-01: desktop rail places Recommended jobs beside an independent-height Ready-for-you + Recent activity column, never a third dashboard column", () => {
  // Flexbox (not CSS Grid row-spanning) — a grid row-span here was tried and reverted during the
  // UI-H.1 checkpoint because spanning two row tracks forces them to grow to fit the taller rail,
  // stretching an empty gap into the shorter main column. Flexbox gives each column an independent
  // height with no shared-track distortion. Pinned here so it isn't silently reintroduced.
  assert.match(page, /xl:flex-row xl:items-start/);
  assert.doesNotMatch(page, /xl:row-span-2/);
  assert.doesNotMatch(page, /xl:grid-cols-\[minmax\(0,1fr\)_340px\]/);
  assert.match(page, /xl:w-\[340px\] xl:shrink-0/);
  // exactly one "contents" wrapper — the main-column grouping trick, not used elsewhere on the page
  assert.equal((page.match(/className="contents /g) ?? []).length, 1);
});

test("no predictive/AI success metrics were introduced in the API response shape", () => {
  assert.doesNotMatch(homeRoute, /successScore|confidenceScore|readinessScore|matchProbability/i);
});

/* ============================================================================================
 * UI-H.1 CHECKPOINT — additional findings from independent review
 * ============================================================================================ */

test("UIH.1-READY-02: saved-answer-memory is not surfaced under Ready-for-you — it is a passive resource with no pending task, not a completed work product", () => {
  assert.doesNotMatch(page, /answerMemoryCount/);
  assert.doesNotMatch(page, /settings\/answers/);
  // The route's own doc comment names the removed field for posterity — check the live code (the
  // import and the returned JSON object), not the historical explanation, for the actual field.
  assert.doesNotMatch(homeRoute, /listAnswersForCandidate/);
  assert.doesNotMatch(homeRoute, /^\s*answerMemoryCount,\s*$/m);
});

test("UIH.1-API-01: every field this route removed has no remaining consumer anywhere Home-adjacent", () => {
  const removedFieldNames = [
    "resumesCreated",
    "resumesThisWeek",
    "readyForTailoring",
    "needsReview",
    "evaluated",
  ];
  const searchRoots = [
    "src/app/home",
    "src/app/jobs",
    "src/app/applications",
    "src/app/resume",
    "src/app/settings",
    "src/app/candidates",
    "src/app/dashboard",
  ];
  function walk(dir: string): string[] {
    const abs = path.join(process.cwd(), dir);
    if (!fs.existsSync(abs)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(rel));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
    }
    return out;
  }
  const files = searchRoots.flatMap(walk).filter((f) => !f.includes("/home/route.ts") && !f.endsWith("home/route.ts"));
  for (const field of removedFieldNames) {
    for (const file of files) {
      const content = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      assert.doesNotMatch(
        content,
        new RegExp(`summary\\.jobs\\.${field}|summary\\.${field}`),
        `${file} still reads the removed Home field "${field}"`
      );
    }
  }
  // dashboard/page.tsx legitimately uses the SAME field NAME (readyForTailoring/needsReview) but
  // from a completely different endpoint (/api/operations, via getCandidateMatchDecisionCounts) —
  // confirm it is not reading it from the Home route, which would make this a real regression.
  const dashboard = fs.readFileSync(path.join(process.cwd(), "src/app/dashboard/page.tsx"), "utf8");
  assert.doesNotMatch(dashboard, /candidateId\}\/home/);
  assert.match(dashboard, /\/api\/operations/);
});
