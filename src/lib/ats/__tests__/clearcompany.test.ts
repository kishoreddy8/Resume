import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalClearCompanyUrl, fetchClearCompanyJobs, normalizeClearCompanyTenant } from "@/lib/ats/clearcompany";

test("ClearCompany identity is tenant scoped", () => {
  assert.equal(normalizeClearCompanyTenant("Example-Co"), "example-co");
  assert.equal(canonicalClearCompanyUrl("example-co"), "https://example-co.clearcompany.com/careers/jobs");
  assert.throws(() => normalizeClearCompanyTenant("www"));
});

test("ClearCompany verifies its mapping and filters listing rows before details", async () => {
  const details: string[] = [];
  let origin = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/careers/portal") return res.end(`<script>window.$ccShortName = "example";</script>`);
    if (req.url === "/api/v1/careers/jobs/postings-url") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(`${origin}/employment/job-openings.php`)); }
    if (req.url?.startsWith("/employment/job-openings.php?")) return res.end(`<form action="job-openings.php"><input name="search" value="true"></form><div class="reqResult"><table>
      <tr data-req-id="101"><td class="departments">Engineering</td><td id="posTitle0" class="posTitle"><a href="job-opening.php?req=101&req_loc=201">US Engineer</a></td><td class="cities">Austin</td><td class="state">TX</td></tr>
      <tr data-req-id="102"><td class="departments">Engineering</td><td id="posTitle1" class="posTitle"><a href="job-opening.php?req=102&req_loc=202">Canada Engineer</a></td><td class="cities">Toronto</td><td class="state">ON</td></tr>
      </table></div>`);
    const match = req.url?.match(/^\/employment\/job-opening\.php\?req=(\d+)&req_loc=(\d+)$/);
    if (match) { details.push(`${match[1]}:${match[2]}`); return res.end(`<meta property="og:url" content="${origin}${req.url}"><a href="https://apply.hrmdirect.com/resumedirect/ApplyOnline/Apply.aspx?req_id=${match[1]}&source=x">Apply</a><div class="jobDesc"><div><p>Complete role description.</p></div></div>`); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    const jobs = await fetchClearCompanyJobs("example", { hostOverride: origin, postingsHostOverride: origin, usOnly: true, maxAttempts: 1 });
    assert.deepEqual(details, ["101:201"]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].descriptionText, "Complete role description.");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
