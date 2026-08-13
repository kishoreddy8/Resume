import assert from "node:assert/strict";
import { test } from "node:test";
import { checkConnectorHealth, type ConnectorHealthCandidate } from "@/lib/ats/connectorHealthCheck";
import type { Company } from "@/types";

const candidate: ConnectorHealthCandidate = {
  jobSourceId: 10,
  organizationId: 20,
  companyId: 30,
  canonicalName: "Example",
  provider: "greenhouse",
  company: { id: 30, source_type: "greenhouse", ats_board_token: "example" } as Company,
};

test("connector health probe reports a reachable job without persisting or loading it", async () => {
  const result = await checkConnectorHealth(candidate, {
    persist: false,
    fetcher: async (_company, options) => {
      assert.equal(options?.maxJobs, 1);
      assert.equal(options?.usOnly, false);
      return [{
        externalId: "job-1", title: "Engineer", location: "Austin, TX", department: null,
        url: "https://example.com/jobs/1", descriptionHtml: null, descriptionText: null,
        employmentType: null, workplaceType: null, salaryText: null, postedAt: null, raw: {},
      }];
    },
  });
  assert.equal(result.outcome, "HEALTHY_JOBS");
  assert.equal(result.jobsSeen, 1);
  assert.equal(result.sampleExternalId, "job-1");
});

test("connector health probe treats a successful empty board as healthy-empty", async () => {
  const result = await checkConnectorHealth(candidate, { persist: false, fetcher: async () => [] });
  assert.equal(result.outcome, "HEALTHY_EMPTY");
  assert.equal(result.errorCategory, null);
});

test("connector health probe records provider errors without revoking approval", async () => {
  const result = await checkConnectorHealth(candidate, {
    persist: false,
    fetcher: async () => { throw new Error("network unavailable"); },
  });
  assert.match(result.outcome, /^FAILED_/);
  assert.ok(result.errorCategory);
});
