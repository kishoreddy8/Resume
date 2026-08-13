import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalJobDivaUrl, fetchJobDivaJobs, normalizeJobDivaToken } from "@/lib/ats/jobdiva";

const ACCOUNT = "7ujdnwmz4uu40171n76wb533tedtri07f69d1vu8oho2xtrahg63pe94t3055tt2";

test("JobDiva identity preserves exact host, tenant, company, and division scope", () => {
  assert.equal(normalizeJobDivaToken(`WWW1.JOBDIVA.COM|${ACCOUNT}|-0|5,2,5`), `www1.jobdiva.com|${ACCOUNT}|0|2,5`);
  assert.equal(canonicalJobDivaUrl(`www1.jobdiva.com|${ACCOUNT}|0|2,5`),
    `https://www1.jobdiva.com/portal/?a=${ACCOUNT}&compid=0&divisions=2%2C5#/`);
  assert.throws(() => normalizeJobDivaToken(`www1.jobdiva.com|short|0|`));
});

test("JobDiva exhausts exact scoped pages and filters before full details", async () => {
  const detailIds: string[] = [];
  const pageStarts: number[] = [];
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: 10_000 + index,
    title: index === 0 ? "US Engineer" : `EU Engineer ${index}`,
    location: index === 0 ? "Austin, TX" : "Berlin, Germany",
    postDate: 1_786_500_000_000,
  }));
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/candPortal/rest/auth/a") {
      assert.equal(req.headers.a, ACCOUNT);
      return res.end(JSON.stringify({ portalID: 2038, compid: 0, a: ACCOUNT, token: "anonymous-session-token-value" }));
    }
    if (req.url === "/candPortal/rest/job/searchjobsportal") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get("jobDivisions"), "2");
      const from = Number(params.get("from"));
      const to = Number(params.get("to"));
      pageStarts.push(from);
      return res.end(JSON.stringify({ total: rows.length, data: rows.slice(from - 1, to) }));
    }
    const id = req.url?.match(/\/getdetailbyjobid\/(\d+)\?/)?.[1];
    if (id) {
      detailIds.push(id);
      return res.end(JSON.stringify({ hasApplied: false, job: {
        id: Number(id), title: "US Engineer", postDate: 1_786_500_000_000, workingRemote: 0,
        positionType: "Full-time", jobDescription: "<p>Complete U.S. role description with $120,000 salary.</p>",
      } }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchJobDivaJobs(`www1.jobdiva.com|${ACCOUNT}|0|2`, {
      apiOriginOverride: `http://127.0.0.1:${port}`, usOnly: true, maxJobs: 3, maxAttempts: 1,
    });
    assert.deepEqual(pageStarts.sort((a, b) => a - b), [1, 1, 101, 101]);
    assert.deepEqual(detailIds, ["10000"]);
    assert.deepEqual(jobs.map((job) => job.externalId), ["10000"]);
    assert.match(jobs[0].descriptionText ?? "", /Complete U.S. role/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
