import assert from "node:assert/strict";
import test from "node:test";
import { validateCandidateIdentity, validateJobSample } from "../pendingConnectorValidation";
import type { Company, NormalizedJob } from "@/types";

const company = {
  id: 1,
  name: "Acme, Inc.",
  source_type: "greenhouse",
  ats_board_token: "acme",
  verified_domain: "acme.example",
  domain_identity_status: "VERIFIED",
} as Company;

test("pending connector identity requires the URL, provider, token, domain, and company projection to agree", () => {
  const base = {
    jobSourceId: 4,
    organizationId: 8,
    canonicalName: "Acme, Inc.",
    provider: "greenhouse" as const,
    sourceKey: "acme",
    sourceUrl: "https://job-boards.greenhouse.io/acme/jobs/123",
    verifiedDomain: "acme.example",
    company,
  };
  assert.equal(validateCandidateIdentity(base), null);
  assert.match(
    validateCandidateIdentity({ ...base, sourceUrl: "https://boards.greenhouse.io/embed/job_board/js" }) ?? "",
    /not a valid supported ATS URL/
  );
  assert.match(validateCandidateIdentity({ ...base, sourceKey: "other" }) ?? "", /source key/i);
});

test("pending connector samples require genuine provider identity fields and HTTPS URLs", () => {
  const job = {
    externalId: "123",
    title: "Data Engineer",
    location: "Austin, TX",
    department: "Engineering",
    url: "https://job-boards.greenhouse.io/acme/jobs/123",
    descriptionHtml: "<p>Build systems</p>",
    descriptionText: "Build systems",
    employmentType: "Full-time",
    workplaceType: null,
    salaryText: null,
    postedAt: null,
    raw: {},
  } satisfies NormalizedJob;
  assert.equal(validateJobSample([job]), null);
  assert.match(validateJobSample([]) ?? "", /No explicit U\.S\. jobs/);
  assert.match(validateJobSample([{ ...job, externalId: null }]) ?? "", /no provider job ID/);
  assert.match(
    validateJobSample([{ ...job, location: "Toronto, Canada" }]) ?? "",
    /does not contain explicit U\.S\. location evidence/
  );
  assert.equal(
    validateJobSample([{ ...job, location: "Toronto, Canada" }], { requireUs: false }),
    null,
    "a valid international posting can prove connector operation without authorizing non-U.S. ingestion"
  );
  assert.match(validateJobSample([{ ...job, url: "http://example.test/job" }]) ?? "", /does not use HTTPS/);
});
