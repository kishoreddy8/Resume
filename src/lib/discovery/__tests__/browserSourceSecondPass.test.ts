import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("../../../db").getDb;
let createCompany: typeof import("../../../db/queries/companies").createCompany;
let updateCompanyDomainIdentity: typeof import("../../../db/queries/companies").updateCompanyDomainIdentity;
let listBrowserSourceCandidates: typeof import("../browserSourceSecondPass").listBrowserSourceCandidates;
let discoverBrowserSourceCandidate: typeof import("../browserSourceSecondPass").discoverBrowserSourceCandidate;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-browser-source-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../../db"));
  ({ createCompany, updateCompanyDomainIdentity } = await import("../../../db/queries/companies"));
  ({ listBrowserSourceCandidates, discoverBrowserSourceCandidate } = await import("../browserSourceSecondPass"));
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("browser second pass promotes a verified connector to pending review and checkpoints the attempt", async () => {
  const company = createCompany({
    name: "Rendered Careers Inc.",
    source_type: "career_link",
    career_page_url: "https://rendered.example/careers",
  });
  updateCompanyDomainIdentity(company.id, {
    verifiedDomain: "rendered.example",
    domainIdentityStatus: "VERIFIED",
  });
  const db = getDb();
  const organizationId = (db.prepare(
    "SELECT organization_id FROM organization_company_links WHERE company_id = ?"
  ).get(company.id) as { organization_id: number }).organization_id;
  db.prepare(
    `INSERT INTO organization_discovery_state (
       organization_id, resolved_company_id, domain_identity_status, domain,
       source_resolution_status, discovered_jobs_url
     ) VALUES (?, ?, 'VERIFIED', 'rendered.example', 'UNRESOLVED', NULL)`
  ).run(organizationId, company.id);

  const [candidate] = listBrowserSourceCandidates(10);
  assert.ok(candidate);
  const result = await discoverBrowserSourceCandidate(candidate, {
    discoverer: async () => ({
      status: "VERIFIED",
      sourceType: "greenhouse",
      atsBoardToken: "rendered",
      discoveredJobsUrl: "https://job-boards.greenhouse.io/rendered",
      reason: "fixture rendered ATS",
      suspectedAts: null,
    }),
  });
  assert.equal(result.resultStatus, "VERIFIED");

  const source = db.prepare(
    "SELECT provider, source_key, review_status FROM job_sources WHERE legacy_company_id = ?"
  ).get(company.id) as { provider: string; source_key: string; review_status: string };
  assert.deepEqual(source, { provider: "greenhouse", source_key: "rendered", review_status: "PENDING" });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM organization_source_discovery_attempts").get() as { n: number }).n,
    1
  );
  assert.equal(listBrowserSourceCandidates(10).length, 0, "a completed browser_v1 attempt is resumably excluded");
});
