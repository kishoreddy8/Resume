import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalTaleoUrl, fetchTaleoJobs, normalizeTaleoToken } from "@/lib/ats/taleo";

test("Taleo identity is an exact tenant host and career section", () => {
  assert.equal(normalizeTaleoToken("UNIFIRST.TALEO.NET|UNF_EXTERNAL_SIMP"), "unifirst.taleo.net|unf_external_simp");
  assert.equal(canonicalTaleoUrl("unifirst.taleo.net|unf_external_simp"),
    "https://unifirst.taleo.net/careersection/unf_external_simp/jobsearch.ftl?lang=en");
  assert.throws(() => normalizeTaleoToken("taleo.net|bad"));
});

test("Taleo exhausts exact pages and filters locations before full details", async () => {
  const pages: number[] = []; const details: string[] = [];
  const rows = Array.from({ length: 26 }, (_, index) => ({ jobId: String(5000 + index), contestNo: String(9000 + index),
    column: [index === 0 ? "US Engineer" : `EU Engineer ${index}`, index === 0 ? '["United States-Texas-Austin"]' : '["Germany-Berlin"]', "Aug 13, 2026"],
    linkedColumn: 0, locationsColumns: [1] }));
  const server = http.createServer(async (req, res) => {
    if (req.url === "/careersection/example/jobsearch.ftl?lang=en") {
      res.setHeader("Content-Type", "text/html");
      return res.end(`<script>var settings={portalNo:'12345',urlOrigin:'http://127.0.0.1:${(server.address() as { port:number }).port}',urlCode:'example'};</script><script data-main="/careersection/v/js/facetedsearch/FacetedSearchPage.js"></script>`);
    }
    if (req.url?.startsWith("/careersection/rest/jobboard/searchjobs?")) {
      let body = ""; for await (const chunk of req) body += chunk;
      const page = JSON.parse(body).pageNo as number; pages.push(page);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ pagingData: { currentPageNo: page, pageSize: 25, totalCount: 26 }, requisitionList: rows.slice((page - 1) * 25, page * 25) }));
    }
    const contest = req.url?.match(/jobdetail\.ftl\?job=(\d+)/)?.[1];
    if (contest) {
      details.push(contest); res.setHeader("Content-Type", "text/html");
      const values = ["5000","true","5000","false","","false","5000","false","true","US Engineer","9000","!*!%3Cp%3EComplete%20US%20description%20%24120%2C000.%3C%2Fp%3E","","!*!%3Cp%3ERequired%20skills.%3C%2Fp%3E"];
      return res.end(`<input name="requisitionno" value="5000"><input id="requisitionDescriptionInterface.UP_APPLY_ON_REQ"><script>api.fillList('requisitionDescriptionInterface','descRequisition',[${values.map((value)=>`'${value}'`).join(",")}]);</script>`);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchTaleoJobs("unifirst.taleo.net|example", { originOverride: `http://127.0.0.1:${port}`,
      usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(pages.sort((a,b)=>a-b), [1,2]);
    assert.deepEqual(details, ["9000"]);
    assert.deepEqual(jobs.map((job)=>job.externalId), ["5000"]);
    assert.match(jobs[0].descriptionText ?? "", /Complete US description/);
  } finally { await new Promise<void>((resolve) => server.close(()=>resolve())); }
});
