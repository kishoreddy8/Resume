import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalNewtonUrl, fetchNewtonJobs, normalizeNewtonClientId } from "@/lib/ats/newton";

const CLIENT = "8a78826752b0003a0152d305414414ee";
const US_ID = "8a78839e99cae871019a11b126397978";
const EU_ID = "8a78839e9fd3ba7b019ff120fa126d7a";

test("Newton identity is an exact 32-hex client ID", () => {
  assert.equal(normalizeNewtonClientId(CLIENT.toUpperCase()), CLIENT);
  assert.equal(canonicalNewtonUrl(CLIENT), `https://recruitingbypaycor.com/career/CareerHome.action?clientId=${CLIENT}`);
  assert.throws(() => normalizeNewtonClientId("short"));
});

test("Newton filters complete CareerHome rows before exact client/job details", async () => {
  const requested: string[] = []; let origin = "";
  const row = (id: string, title: string, location: string) => `<div class="gnewtonCareerGroupRowClass"><div class="gnewtonCareerGroupJobTitleClass"><a href="${origin}/career/JobIntroduction.action?clientId=${CLIENT}&id=${id}&source=&lang=en">${title}</a></div><div class="gnewtonCareerGroupJobDescriptionClass">${location}</div></div>`;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url?.startsWith("/career/CareerHome.action?")) return res.end(`<form name="candidateHome" action="${origin}/career/CareerHomeSearch.action">${row(US_ID,"US Engineer","Austin, TX")}${row(EU_ID,"EU Engineer","Berlin, Germany")}</form>`);
    const url = new URL(req.url ?? "/", origin); const id = url.searchParams.get("id");
    if (url.pathname === "/career/JobIntroduction.action" && id) { requested.push(id); return res.end(`<form id="gravityApplyJob" action="${origin}/career/SubmitResume.action?parentUrl=&clientId=${CLIENT}&id=${id}"></form><td id="gnewtonJobPosition"><b>Position:</b> US Engineer</td><td id="gnewtonJobLocationInfo">Austin, TX<br></td><td id="gnewtonJobDescriptionText"><p>Complete U.S. role description.</p></td>`); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; origin = `http://127.0.0.1:${port}`;
    const jobs = await fetchNewtonJobs(CLIENT, { originOverride: origin, usOnly: true, maxJobs: 3, maxAttempts: 1 });
    assert.deepEqual(requested, [US_ID]); assert.deepEqual(jobs.map((job) => job.externalId), [US_ID]); assert.match(jobs[0].descriptionText ?? "", /Complete U.S./);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
