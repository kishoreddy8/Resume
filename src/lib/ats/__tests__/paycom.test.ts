import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalPaycomUrl, fetchPaycomJobs, normalizePaycomClientKey } from "@/lib/ats/paycom";

const key = "4689D9AB2F6F99AD5F352379B206FD14";

test("Paycom identity is client-key scoped", () => {
  assert.equal(normalizePaycomClientKey(key.toLowerCase()), key);
  assert.equal(canonicalPaycomUrl(key), `https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=${key}`);
  assert.throws(() => normalizePaycomClientKey("short"));
});

test("Paycom bootstraps an anonymous session and filters U.S. before details", async () => {
  const details: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/v4/ats/web.php/jobs")) {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const config = { sessionJWT: "anonymous-test-token", libConfig: JSON.stringify({ atsPortalMantleServiceUrl: `http://127.0.0.1:${port}/` }) };
      return res.end(`<script>var configsFromHost = ${JSON.stringify(config)};</script>`);
    }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/api/ats/job-posting-previews/search") {
      assert.equal(req.headers.authorization, "anonymous-test-token");
      return res.end(JSON.stringify({ jobPostingPreviewsCount: 2, jobPostingPreviews: [
        { jobId: 1, jobTitle: "Canada", locations: "Toronto, Ontario, Canada" },
        { jobId: 2, jobTitle: "US Engineer", locations: "Austin, TX", positionType: "Full Time" },
      ] }));
    }
    const id = req.url?.match(/\/api\/ats\/job-postings\/(\d+)/)?.[1];
    if (id) {
      details.push(id);
      return res.end(JSON.stringify({ jobPosting: { jobId: 2, jobTitle: "US Engineer", location: "Austin, TX", description: "<p>Complete role.</p>", qualifications: "<p>Salary $120,000 - $140,000.</p>" } }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchPaycomJobs(key, { hostOverride: `http://127.0.0.1:${port}`, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(details, ["2"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Complete role. Salary $120,000 - $140,000.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
