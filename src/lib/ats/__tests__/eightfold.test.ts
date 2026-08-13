import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalEightfoldUrl, fetchEightfoldJobs, normalizeEightfoldToken } from "@/lib/ats/eightfold";

test("Eightfold identity pins host and embedded domain", () => {
  assert.equal(normalizeEightfoldToken("ALBEMARLE.EIGHTFOLD.AI|ALBEMARLE.COM"), "albemarle.eightfold.ai|albemarle.com");
  assert.match(canonicalEightfoldUrl("albemarle.eightfold.ai|albemarle.com"), /domain=albemarle.com/);
});

test("Eightfold exhausts pages and filters locations before details", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: 1000000 + index, posting_name: `Engineer ${index}`,
    location: index === 11 ? "Austin, Texas, United States of America" : "Berlin, Germany",
    locations: [index === 11 ? "Austin, Texas, United States of America" : "Berlin, Germany"],
    department: "Engineering", t_create: 1780000000, canonicalPositionUrl: `https://albemarle.eightfold.ai/careers/job/${1000000 + index}`, isPrivate: false }));
  const starts: number[] = []; const details: string[] = [];
  const server = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json");
    if (req.url === "/careers") { res.setHeader("Content-Type", "text/html"); return res.end(`<code id="smartApplyData">${JSON.stringify({ domain: "albemarle.com", count: 12, positions: rows.slice(0, 10) }).replace(/"/g, "&#34;")}</code>`); }
    const detail = req.url?.match(/\/api\/apply\/v2\/jobs\/(\d+)/)?.[1];
    if (detail) { details.push(detail); const row = rows.find((item) => String(item.id) === detail)!; return res.end(JSON.stringify({ ...row, job_description: "<p>Complete U.S. description.</p>" })); }
    const url = new URL(req.url ?? "/", "http://localhost"); const start = Number(url.searchParams.get("start") ?? "0"); starts.push(start);
    return res.end(JSON.stringify({ domain: "albemarle.com", count: 12, positions: rows.slice(start, start + 10) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { const address = server.address(); const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const jobs = await fetchEightfoldJobs("albemarle.eightfold.ai|albemarle.com", { originOverride: origin, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(starts, [0, 10]); assert.deepEqual(details, ["1000011"]); assert.equal(jobs[0].externalId, "1000011");
    assert.match(jobs[0].descriptionText ?? "", /Complete U.S. description/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
