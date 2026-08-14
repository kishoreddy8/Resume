import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  canonicalAdpWorkforceNowUrl,
  decodeAdpWorkforceNowToken,
  encodeAdpWorkforceNowToken,
  fetchAdpWorkforceNowJobs,
} from "@/lib/ats/adpWorkforceNow";
import { detectAtsFromUrlString } from "@/lib/ats/detect";
import { isRealJobPosting } from "@/lib/ats/jobValidation";
import type { NormalizedJob } from "@/types";

const identity = {
  cid: "4aad6ff8-f078-4009-9c60-a05e5489cec6",
  ccId: "19000101_000001",
  lang: "en_US",
};

test("ADP Workforce Now identity token round-trips and generates a stable board URL", () => {
  const token = encodeAdpWorkforceNowToken(identity);
  assert.deepEqual(decodeAdpWorkforceNowToken(token), identity);
  const url = new URL(canonicalAdpWorkforceNowUrl(token));
  assert.equal(url.hostname, "workforcenow.adp.com");
  assert.equal(url.searchParams.get("cid"), identity.cid);
  assert.equal(url.searchParams.get("ccId"), identity.ccId);
  assert.equal(url.searchParams.get("lang"), identity.lang);
});

test("detectAtsFromUrlString detects ADP Workforce Now across recruitment and intermediateRedirect URLs", () => {
  const standard = detectAtsFromUrlString(
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=4aad6ff8-f078-4009-9c60-a05e5489cec6&ccId=19000101_000001&type=JS&lang=en_US"
  );
  assert.equal(standard?.sourceType, "adp_wfn");
  assert.equal(standard?.atsBoardToken, "4aad6ff8-f078-4009-9c60-a05e5489cec6|19000101_000001|en_US");

  const intermediate = detectAtsFromUrlString(
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/intermediateRedirect.html?cid=0025d30d-4243-498e-9345-1197ec6bd23d&ccId=19000101_000001&type=MP&lang=en_US"
  );
  assert.equal(intermediate?.sourceType, "adp_wfn");
  assert.equal(intermediate?.atsBoardToken, "0025d30d-4243-498e-9345-1197ec6bd23d|19000101_000001|en_US");

  // Rejects invalid hostname or missing cid
  assert.equal(detectAtsFromUrlString("https://workforcenow.adp.com/other/path"), null);
  assert.equal(detectAtsFromUrlString("https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html"), null);
});

test("ADP Workforce Now adapter exhausts $skip pagination, fetches details, and keeps explicit U.S. jobs", async () => {
  const skips: number[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    assert.equal(url.searchParams.get("cid"), identity.cid);
    assert.equal(url.searchParams.get("ccId"), identity.ccId);
    const detailId = url.pathname.match(/job-requisitions\/([^/]+)$/)?.[1];
    if (detailId) {
      const us = detailId !== "item-2";
      res.end(JSON.stringify({
        itemID: detailId,
        requisitionTitle: detailId === "item-1" ? "Data Engineer" : detailId === "item-2" ? "Canada Engineer" : "Platform Engineer",
        postDate: "2026-08-01T00:00:00Z",
        requisitionDescription: "<p>Build reliable data platforms.</p>",
        workLevelCode: { shortName: "Full Time" },
        requisitionLocations: [{ nameCode: { shortName: us ? "Austin, TX, US" : "Toronto, Ontario, Canada" } }],
        customFieldGroup: { stringFields: [
          { stringValue: `external-${detailId}`, nameCode: { codeValue: "ExternalJobID" } },
          { stringValue: "120000.00 To 150000.00 (USD) Annually", nameCode: { codeValue: "SalaryRange" } },
          { stringValue: "Engineering", nameCode: { codeValue: "HomeDepartment" } },
        ] },
      }));
      return;
    }
    const skip = Number(url.searchParams.get("$skip") ?? "1");
    skips.push(skip);
    const all = ["item-1", "item-2", "item-3"];
    const content = all.slice(skip - 1, skip).map((itemID) => ({ itemID, requisitionTitle: itemID }));
    res.end(JSON.stringify({ jobRequisitions: content, meta: { totalNumber: all.length } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchAdpWorkforceNowJobs(encodeAdpWorkforceNowToken(identity), {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxAttempts: 1,
      // Force one row per page so the test proves $skip advancement.
      maxJobs: undefined,
    });
    assert.deepEqual(skips, [1, 2, 3], "$skip follows ADP's one-based start sequence");
    assert.deepEqual(jobs.map((job) => job.externalId), ["item-1", "item-3"]);
    assert.equal(jobs[0].descriptionText, "Build reliable data platforms.");
    assert.equal(jobs[0].department, "Engineering");
    assert.equal(jobs[0].salaryText, "120000.00 To 150000.00 (USD) Annually");
    assert.match(jobs[0].url, /jobId=external-item-1/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("shared real-job validation filters ADP WFN jobs correctly", () => {
  const realJob: NormalizedJob = {
    externalId: "item-12345",
    title: "Platform Engineer",
    location: "Austin, TX, US",
    department: "Engineering",
    url: "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=4aad6ff8-f078-4009-9c60-a05e5489cec6&ccId=19000101_000001&type=JS&lang=en_US&jobId=item-12345",
    descriptionHtml: "<p>Build cloud infrastructure.</p>",
    descriptionText: "Build cloud infrastructure.",
    employmentType: "Full Time",
    workplaceType: null,
    salaryText: "120000.00 To 150000.00 (USD) Annually",
    postedAt: "2026-08-01T00:00:00Z",
    raw: null,
  };

  assert.equal(isRealJobPosting(realJob), true);

  const pseudoJob: NormalizedJob = {
    ...realJob,
    title: "General Application",
  };
  assert.equal(isRealJobPosting(pseudoJob), false);
});
