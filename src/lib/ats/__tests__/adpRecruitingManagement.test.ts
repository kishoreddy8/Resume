import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalAdpRmUrl, fetchAdpRmJobs, normalizeAdpRmToken } from "@/lib/ats/adpRecruitingManagement";

const token = "woodmark|8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee|G38EETAC9W8ZZ87W|woodmark1";

test("ADP RM identity is exact and canonical", () => {
  assert.equal(normalizeAdpRmToken(token), token);
  const url = new URL(canonicalAdpRmUrl(token));
  assert.equal(url.pathname, "/woodmark");
  assert.equal(url.searchParams.get("siteId"), "8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee");
  assert.throws(() => normalizeAdpRmToken("woodmark|bad|G38EETAC9W8ZZ87W|woodmark1"));
});

test("ADP RM exhausts the count and filters complete jobs to U.S. scope", async () => {
  const jobs = Array.from({ length: 101 }, (_, index) => ({ reqId: String(5000 + index),
    publishedJobTitle: `Engineer ${index}`, jobDescription: `<p>Complete description ${index}</p>`,
    careerSiteDomains: ["woodmark"], requisitionLocations: [{ address: index === 100
      ? { cityName: "Austin", countrySubdivisionLevel1: { codeValue: "TX" }, country: { codeValue: "USA" } }
      : { cityName: "Berlin", country: { codeValue: "DEU" } } }] }));
  const skips: number[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/public/staffing/v1/career-site/woodmark") return res.end(JSON.stringify({
      id: "8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee", domain: "woodmark", orgoid: "G38EETAC9W8ZZ87W",
      isiClientId: "woodmark1", active: true, isMyJobsEnabled: true, myJobsToken: "short-lived-token" }));
    const url = new URL(req.url ?? "/", "http://localhost"); const skip = Number(url.searchParams.get("$skip") ?? "0");
    skips.push(skip); return res.end(JSON.stringify({ count: jobs.length, jobRequisitions: jobs.slice(skip, skip + 100) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const result = await fetchAdpRmJobs(token, { myJobsOriginOverride: origin, apiOriginOverride: origin,
      usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(skips, [0, 100]); assert.deepEqual(result.map((job) => job.externalId), ["5100"]);
    assert.match(result[0].descriptionText ?? "", /Complete description 100/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
