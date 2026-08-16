import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Route-level coverage for Discovery V2 Stage 3's proposal endpoints. Query-layer behavior (dedup,
 * staleness, approval preconditions) is covered exhaustively in
 * src/db/queries/__tests__/atsSourceProposals.test.ts — this file only checks that the HTTP layer
 * wires ids/params/status-codes correctly, per this session's established route-test convention (see
 * tailoringRunsPatchRoute.test.ts's doc comment on why these live outside the bracketed directories).
 */

let tmpDir: string;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let createProposalFromDiscoveryV2: typeof import("@/db/queries/atsSourceProposals").createProposalFromDiscoveryV2;
let GET_ALL: typeof import("../../ats-source-proposals/route").GET;
let GET_FOR_COMPANY: typeof import("../[id]/source-proposals/route").GET;
let APPROVE: typeof import("../[id]/source-proposals/[proposalId]/approve/route").POST;
let REJECT: typeof import("../[id]/source-proposals/[proposalId]/reject/route").POST;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-source-proposals-route-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  const { getDb } = await import("@/db/index");
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ createProposalFromDiscoveryV2 } = await import("@/db/queries/atsSourceProposals"));
  ({ GET: GET_ALL } = await import("../../ats-source-proposals/route"));
  ({ GET: GET_FOR_COMPANY } = await import("../[id]/source-proposals/route"));
  ({ POST: APPROVE } = await import("../[id]/source-proposals/[proposalId]/approve/route"));
  ({ POST: REJECT } = await import("../[id]/source-proposals/[proposalId]/reject/route"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function postRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /api/ats-source-proposals returns the global pending queue", async () => {
  const company = createCompany({ name: "Route Test Co A", source_type: "career_link", career_page_url: "https://routetestco-a.example/careers" });
  createProposalFromDiscoveryV2({
    companyId: company.id,
    currentSourceType: company.source_type,
    currentBoardToken: company.ats_board_token,
    candidate: {
      provider: "greenhouse",
      boardToken: "route-test-a",
      canonicalUrl: "https://boards.greenhouse.io/route-test-a",
      confidence: "HIGH",
      validationStatus: "VALIDATED_JOBS",
      recommendation: "PROMOTE",
      evidenceTypes: ["structured_api"],
      evidenceUrls: ["https://boards.greenhouse.io/route-test-a"],
    },
  });

  const res = await GET_ALL();
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.proposals.some((p: { proposed_board_token: string }) => p.proposed_board_token === "route-test-a"));
});

test("GET company-scoped proposals returns 404 for a nonexistent company, 400 for an invalid id", async () => {
  const notFound = await GET_FOR_COMPANY(new NextRequest("http://localhost/test"), { params: Promise.resolve({ id: "999999" }) });
  assert.equal(notFound.status, 404);

  const invalid = await GET_FOR_COMPANY(new NextRequest("http://localhost/test"), { params: Promise.resolve({ id: "not-a-number" }) });
  assert.equal(invalid.status, 400);
});

test("approve/reject 404 on an unknown proposal id, 409 when another company tries to act on it", async () => {
  const owner = createCompany({ name: "Route Test Co B", source_type: "career_link", career_page_url: "https://routetestco-b.example/careers" });
  const stranger = createCompany({ name: "Route Test Co C", source_type: "career_link", career_page_url: "https://routetestco-c.example/careers" });
  const proposal = createProposalFromDiscoveryV2({
    companyId: owner.id,
    currentSourceType: owner.source_type,
    currentBoardToken: owner.ats_board_token,
    candidate: {
      provider: "lever",
      boardToken: "route-test-b",
      canonicalUrl: "https://jobs.lever.co/route-test-b",
      confidence: "HIGH",
      validationStatus: "VALIDATED_JOBS",
      recommendation: "PROMOTE",
      evidenceTypes: ["structured_api"],
      evidenceUrls: ["https://jobs.lever.co/route-test-b"],
    },
  })!;

  const unknownProposal = await APPROVE(postRequest(), { params: Promise.resolve({ id: String(owner.id), proposalId: "999999" }) });
  assert.equal(unknownProposal.status, 404);

  const crossCompany = await APPROVE(postRequest(), { params: Promise.resolve({ id: String(stranger.id), proposalId: String(proposal.id) }) });
  assert.equal(crossCompany.status, 409);
  const crossCompanyJson = await crossCompany.json();
  assert.equal(crossCompanyJson.code, "COMPANY_MISMATCH");

  const rejectCrossCompany = await REJECT(postRequest(), { params: Promise.resolve({ id: String(stranger.id), proposalId: String(proposal.id) }) });
  assert.equal(rejectCrossCompany.status, 409);
});

test("approve succeeds (200) with the owning company id and reflects the new source", async () => {
  const owner = createCompany({ name: "Route Test Co D", source_type: "career_link", career_page_url: "https://routetestco-d.example/careers" });
  const proposal = createProposalFromDiscoveryV2({
    companyId: owner.id,
    currentSourceType: owner.source_type,
    currentBoardToken: owner.ats_board_token,
    candidate: {
      provider: "ashby",
      boardToken: "route-test-d",
      canonicalUrl: "https://jobs.ashbyhq.com/route-test-d",
      confidence: "HIGH",
      validationStatus: "VALIDATED_JOBS",
      recommendation: "PROMOTE",
      evidenceTypes: ["structured_api"],
      evidenceUrls: ["https://jobs.ashbyhq.com/route-test-d"],
    },
  })!;

  const res = await APPROVE(postRequest({ reviewNote: "looks right" }), { params: Promise.resolve({ id: String(owner.id), proposalId: String(proposal.id) }) });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.proposal.status, "APPROVED");
  assert.equal(json.proposal.proposed_board_token, "route-test-d");
});
