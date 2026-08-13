import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalRipplingUrl, fetchRipplingJobs, normalizeRipplingSlug } from "@/lib/ats/rippling";

const ids = {
  canada: "11111111-1111-4111-8111-111111111111",
  us: "22222222-2222-4222-8222-222222222222",
};

function nextData(pageProps: unknown): string {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></html>`;
}

test("Rippling identity is board-slug scoped", () => {
  assert.equal(normalizeRipplingSlug("Example-Co"), "example-co");
  assert.equal(canonicalRipplingUrl("example-co"), "https://ats.rippling.com/example-co/jobs");
  assert.throws(() => normalizeRipplingSlug("embed"));
  assert.throws(() => normalizeRipplingSlug("en-us"));
});

test("Rippling follows numbered pagination and filters U.S. before details", async () => {
  const listPages: number[] = [];
  const detailIds: string[] = [];
  const canada = { id: ids.canada, name: "Canada Engineer", locations: [{ name: "Toronto, Canada", countryCode: "CA" }] };
  const us = { id: ids.us, name: "US Engineer", department: { name: "Engineering" }, locations: [{ name: "Austin, TX", countryCode: "US", workplaceType: "HYBRID" }] };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const detailId = req.url?.match(/\/jobs\/([0-9a-f-]+)$/)?.[1];
    if (detailId) {
      detailIds.push(detailId);
      return res.end(nextData({ apiData: { jobPost: {
        uuid: ids.us,
        name: "US Engineer",
        description: { company: "<p>Company.</p>", role: "<p>Complete role. Salary $120,000 - $140,000.</p>" },
        workLocations: ["Austin, TX"],
        employmentType: { id: "Full-time" },
        createdOn: "2026-08-01T00:00:00.000Z",
      } } }));
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const page = Number(url.searchParams.get("page") ?? 0);
    listPages.push(page);
    const data = { items: page === 0 ? [canada] : [us], page, pageSize: 1, totalItems: 2, totalPages: 2 };
    return res.end(nextData({ dehydratedState: { queries: [{ queryKey: ["board", "example", "job-posts"], state: { data } }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchRipplingJobs("example", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxJobs: 3,
      maxAttempts: 1,
    });
    assert.deepEqual(listPages, [0, 1]);
    assert.deepEqual(detailIds, [ids.us]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Company. Complete role. Salary $120,000 - $140,000.");
    assert.equal(jobs[0].salaryText, "$120,000 - $140,000");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
