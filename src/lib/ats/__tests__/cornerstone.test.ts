import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalCornerstoneUrl, fetchCornerstoneJobs, normalizeCornerstoneToken } from "@/lib/ats/cornerstone";

test("Cornerstone identity pins host, career site, and corporation", () => {
  assert.equal(normalizeCornerstoneToken("COLORCON.CSOD.COM|4|COLORCON"), "colorcon.csod.com|4|colorcon");
  assert.equal(canonicalCornerstoneUrl("colorcon.csod.com|4|colorcon"), "https://colorcon.csod.com/ux/ats/careersite/4/home?c=colorcon");
});

test("Cornerstone exhausts exact pages and filters U.S. jobs", async () => {
  const rows = Array.from({ length: 27 }, (_, index) => ({ requisitionId: 600 + index,
    displayJobTitle: `Role ${index}`, postingEffectiveDate: "8/10/2026",
    locations: [{ city: index === 26 ? "Austin" : "Berlin", state: index === 26 ? "TX" : "", country: index === 26 ? "US" : "Germany" }],
    externalDescription: `<p>Complete description ${index}</p>` }));
  const pages: number[] = [];
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/ux/ats/careersite/4/home")) { res.setHeader("Content-Type", "text/html");
      return res.end(`<script>var csodPlayerRouteInfo={"cid":"4"};</script><script>if(!csod.context) csod.context={"corp":"colorcon","cultureID":1,"cultureName":"en-US","endpoints":{"cloud":"https://us.api.csod.com/"},"token":"public-test-token"};</script>`); }
    if (req.url === "/rec-job-search/external/jobs" && req.method === "POST") { let body = ""; req.on("data", (part) => { body += part; }); req.on("end", () => {
      const parsed = JSON.parse(body) as { pageNumber: number }; pages.push(parsed.pageNumber); const start = (parsed.pageNumber - 1) * 25;
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: "Success", data: { totalCount: rows.length, requisitions: rows.slice(start, start + 25) } })); }); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { const address = server.address(); const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const jobs = await fetchCornerstoneJobs("colorcon.csod.com|4|colorcon", { originOverride: origin, apiOriginOverride: origin, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(pages, [1, 2]); assert.equal(jobs.length, 1); assert.equal(jobs[0].externalId, "626");
    assert.equal(jobs[0].location, "Austin, TX, US"); assert.match(jobs[0].descriptionText ?? "", /Complete description 26/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
