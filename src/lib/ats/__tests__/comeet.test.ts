import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalComeetUrl, fetchComeetJobs, normalizeComeetToken } from "@/lib/ats/comeet";

test("Comeet identity preserves slug and company UID", () => {
  assert.equal(normalizeComeetToken("Lumus|62.00f"), "lumus|62.00F");
  assert.equal(canonicalComeetUrl("lumus|62.00F"), "https://www.comeet.com/jobs/lumus/62.00F");
  assert.throws(() => normalizeComeetToken("lumus"));
});

test("Comeet validates embedded company/position identities and filters structured locations", async () => {
  let origin = "";
  const company = { slug: "example", company_uid: "12.ABC", token: "public-token" };
  const positions = [
    { name: "US Engineer", department: "Engineering", uid: "AA.123", employment_type: "Full-time", workplace_type: "Hybrid", time_updated: "2026-08-01T00:00:00Z", url_comeet_hosted_page: "", location: { city: "Austin", state: "TX", country: "US" }, custom_fields: { details: [{ name: "Description", value: "<p>Complete U.S. role.</p>", order: 1 }] } },
    { name: "EU Engineer", uid: "BB.456", url_comeet_hosted_page: "", location: { city: "Berlin", country: "DE" }, custom_fields: { details: [{ name: "Description", value: "<p>Complete EU role.</p>" }] } },
  ];
  const server = http.createServer((_req, res) => { positions[0].url_comeet_hosted_page = `${origin}/jobs/example/12.ABC/us-engineer/AA.123`; positions[1].url_comeet_hosted_page = `${origin}/jobs/example/12.ABC/eu-engineer/BB.456`; res.end(`var COMPANY_DATA = ${JSON.stringify(company)};\nvar COMPANY_POSITIONS_DATA = ${JSON.stringify(positions)};\n`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { const address=server.address(); const port=typeof address==="object"&&address?address.port:0; origin=`http://127.0.0.1:${port}`;
    const jobs=await fetchComeetJobs("example|12.ABC",{hostOverride:origin,usOnly:true,maxJobs:3,maxAttempts:1});
    assert.deepEqual(jobs.map((job)=>job.externalId),["AA.123"]); assert.equal(jobs[0].location,"Austin, TX, United States"); assert.equal(jobs[0].descriptionText,"Description Complete U.S. role.");
  } finally { await new Promise<void>((resolve)=>server.close(()=>resolve())); }
});
