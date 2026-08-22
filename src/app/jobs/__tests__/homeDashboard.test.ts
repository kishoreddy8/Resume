import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ResumeLibraryEntry } from "../../api/candidates/[candidateId]/resume-library/route";
import type { ForYouResponseEntry } from "../../api/candidates/[candidateId]/for-you/route";
import {
  boundedRecommendations,
  chooseHomeAction,
  homeAttention,
  homeCounts,
  presentHomeResumes,
  type HomePresentationInput,
} from "../../home/homePresentation";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/home/page.tsx"), "utf8");

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

test("recommendations are bounded at five", () => {
  assert.equal(boundedRecommendations(Array.from({ length: 8 }, (_, i) => recommendation(i + 1))).length, 5);
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
