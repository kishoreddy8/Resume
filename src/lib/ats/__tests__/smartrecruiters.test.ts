import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { fetchSmartRecruitersJobs } from "@/lib/ats/smartrecruiters";

test("SmartRecruiters adapter exhausts offset pagination, fetches details, and retains only explicit U.S. jobs", async () => {
  const requestedOffsets: number[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    const detail = url.pathname.match(/\/postings\/(\d+)$/);
    if (detail) {
      const id = detail[1];
      const us = id !== "2";
      res.end(JSON.stringify({
        id,
        name: id === "1" ? "Data Engineer" : id === "2" ? "Toronto Engineer" : "Platform Engineer",
        releasedDate: "2026-08-01T00:00:00Z",
        location: us
          ? { fullLocation: "Austin, TX, United States", country: "us", hybrid: true }
          : { fullLocation: "Toronto, ON, Canada", country: "ca" },
        department: { label: "Engineering" },
        typeOfEmployment: { label: "Full-time" },
        jobAd: { jobDescription: "<p>Build reliable data systems. Salary $120,000 - $150,000/year.</p>" },
      }));
      return;
    }
    const offset = Number(url.searchParams.get("offset") ?? "0");
    requestedOffsets.push(offset);
    assert.equal(url.searchParams.get("country"), "us");
    const rows = [
      { id: "1", name: "Data Engineer" },
      { id: "2", name: "Toronto Engineer" },
      { id: "3", name: "Platform Engineer" },
    ];
    const content = rows.slice(offset, offset + 1);
    res.end(JSON.stringify({ offset, limit: 100, totalFound: rows.length, content }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchSmartRecruitersJobs("ExampleCo", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxAttempts: 1,
    });
    assert.deepEqual(requestedOffsets, [0, 1, 2]);
    assert.deepEqual(jobs.map((job) => job.externalId), ["1", "3"]);
    assert.equal(jobs[0].descriptionText, "Build reliable data systems. Salary $120,000 - $150,000/year.");
    assert.equal(jobs[0].workplaceType, "Hybrid");
    assert.equal(jobs[0].salaryText, "$120,000 - $150,000/year");
    assert.equal(jobs[0].url, "https://jobs.smartrecruiters.com/ExampleCo/1");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
