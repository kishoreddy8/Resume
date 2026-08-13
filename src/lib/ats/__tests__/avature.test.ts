import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalAvatureUrl, fetchAvatureJobs, normalizeAvatureToken } from "@/lib/ats/avature";

function meta(page: string, search = ""): string {
  return `<meta name="avature.portal.id" content="4"><meta name="avature.portal.urlPath" content="careers"><meta name="avature.portal.page" content="${page}"><meta name="avature.portallist.search" content="${search}">`;
}

test("Avature tokens preserve explicit portal mode and identity", () => {
  assert.equal(normalizeAvatureToken("MAXIMUS.AVATURE.NET|template|careers|Job-Search_US"), "maximus.avature.net|template|careers|Job-Search_US");
  assert.equal(canonicalAvatureUrl("xerox.avature.net|legacy|en_US/careers|SearchJobs"), "https://xerox.avature.net/en_US/careers");
});

test("Avature template mode requires two complete snapshots before U.S. details", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: 1000 + index, entityId: 9000 + index,
    fields: { title: { stringValue: `Role ${index}` }, location: { stringValue: index === 11 ? "United States" : "Germany" }, date: { stringValue: "2026-08-10" } } }));
  let origin = ""; const offsets: number[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
    if (url.pathname === "/careers/Job-Search_US") { res.setHeader("Content-Type", "text/html");
      return res.end(`<html><head>${meta("Job-Search_US")}</head><body><script>fetch('/4/_portalList?offset=0&recordsPerPage=10').then(r=>r.json())</script></body></html>`); }
    if (url.pathname === "/4/_portalList") { const offset = Number(url.searchParams.get("offset") ?? 0); offsets.push(offset); const page = rows.slice(offset, offset + 10);
      res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ results: page, offset, totalLimitReached: offset + 10 >= rows.length,
        columns: [{ code: "title", label: "Job Posting Title" }, { code: "location", label: "Location" }, { code: "date", label: "Date" }],
        recordsFrom: offset + 1, recordsTo: offset + page.length, total: String(rows.length),
        links: page.map((row) => ({ $detailLink: `${origin}/careers/FolderDetail/Role/${row.id}` })) })); }
    const id = url.pathname.match(/\/careers\/FolderDetail\/Role\/(\d+)$/)?.[1];
    if (id) { const row = rows.find((item) => String(item.id) === id)!; res.setHeader("Content-Type", "text/html");
      return res.end(`<html><head>${meta("FolderDetail", id)}</head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: row.fields.title.stringValue, description: "Complete public description", datePosted: "2026-08-10" })}</script></html>`); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try { const jobs = await fetchAvatureJobs("maximus.avature.net|template|careers|Job-Search_US", { originOverride: origin, allowPrivateNetworksForTests: true, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(offsets, [0, 0, 10, 0, 10]); assert.equal(jobs.length, 1); assert.equal(jobs[0].externalId, "1011"); assert.match(jobs[0].descriptionText ?? "", /Complete public/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Avature legacy mode exhausts exact HTML pages twice before U.S. details", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: 2000 + index, title: `Legacy Role ${index}`, country: index === 6 ? "United States" : "Germany" }));
  let origin = ""; const offsets: number[] = [];
  const listing = (offset: number) => { const page = rows.slice(offset, offset + 5); const articles = page.map((row) => `<article class="article article--result"><h3><a href="${origin}/en_US/careers/JobDetail/Role/${row.id}">${row.title}</a></h3><p><span>City:</span> ${row.country === "United States" ? "Austin" : "Berlin"}</p><p><span>State/Province:</span> ${row.country === "United States" ? "Texas" : "Berlin"}</p><p><span>Country:</span> ${row.country}</p></article>`).join("");
    return `<html><head>${meta("SearchJobs")}</head><div class="list-controls__legend">${offset + 1}-${offset + page.length} of ${rows.length} results</div>${articles}</html>`; };
  const server = http.createServer((req, res) => { const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
    if (url.pathname === "/en_US/careers" || url.pathname === "/en_US/careers/SearchJobs/") { const offset = Number(url.searchParams.get("jobOffset") ?? 0); offsets.push(offset); res.setHeader("Content-Type", "text/html"); return res.end(listing(offset)); }
    const id = url.pathname.match(/\/en_US\/careers\/JobDetail\/Role\/(\d+)$/)?.[1]; if (id) { const row = rows.find((item) => String(item.id) === id)!; res.setHeader("Content-Type", "text/html");
      return res.end(`<html><head>${meta("JobDetail", id)}<meta property="og:url" content="${origin}/en_US/careers/JobDetail/Role/${id}"><meta name="Description" content="${row.title} at created 10-Aug-2026"></head><article class="article article--details"><h3>Description &amp; Requirements</h3><div class="article__content__view"><p>Complete legacy description.</p></div></article></html>`); }
    res.statusCode = 404; res.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try { const jobs = await fetchAvatureJobs("xerox.avature.net|legacy|en_US/careers|SearchJobs", { originOverride: origin, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(offsets, [0, 5, 0, 5]); assert.equal(jobs.length, 1); assert.equal(jobs[0].externalId, "2006"); assert.match(jobs[0].descriptionText ?? "", /Complete legacy/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
