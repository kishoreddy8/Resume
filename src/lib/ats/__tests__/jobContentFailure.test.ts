import assert from "node:assert/strict";
import { test } from "node:test";
import { degradeMissingDescription } from "@/lib/ats/jobContentFailure";
import type { NormalizedJob } from "@/types";

function makeJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "1", title: "Data Engineer", location: "Austin, TX", department: null,
    url: "https://example.com/jobs/1", descriptionHtml: "<p>real</p>", descriptionText: "real",
    employmentType: null, workplaceType: null, salaryText: "$100k", postedAt: null, raw: {},
    ...overrides,
  };
}

test("degradeMissingDescription blanks only the description fields, preserving every other field", () => {
  const job = makeJob();
  const degraded = degradeMissingDescription(job);
  assert.equal(degraded.descriptionHtml, null);
  assert.equal(degraded.descriptionText, "");
  assert.equal(degraded.externalId, job.externalId);
  assert.equal(degraded.title, job.title);
  assert.equal(degraded.location, job.location);
  assert.equal(degraded.url, job.url);
  assert.equal(degraded.salaryText, job.salaryText, "unrelated fields are preserved unchanged");
});
