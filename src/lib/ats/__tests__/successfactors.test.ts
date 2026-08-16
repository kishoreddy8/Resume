import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  decodeSuccessFactorsToken,
  encodeSuccessFactorsToken,
  fetchSuccessFactorsJobs,
  normalizeSuccessFactorsToken,
  parseDwrResponse,
  extractLocationFromPosting,
  isDetailHostTrusted,
  validateDetailResponseUrl,
  validateBootstrapRedirectHost,
} from "@/lib/ats/successfactors";

/**
 * Ported from the sibling branch antigravity/ats-successfactors (commit f2d450b + 6 hardening
 * commits), adapted to this branch's current architecture. Every test below through the last one
 * is DB-free (pure functions + real local HTTP fixtures, same convention as
 * usLocationFilter.test.ts's Workday/Greenhouse e2e tests) — no isolation scaffolding needed. Only
 * the final "allowlist integration" test touches the database, and is rewritten below with the
 * same isolated-temp-DB pattern as organizationRegistry.test.ts (the branch's original version
 * called getDb() with no CAREER_OPS_DB_PATH override, which would have run against the real
 * production database — not acceptable here).
 */


test("decodeSuccessFactorsToken & encodeSuccessFactorsToken round-trip", () => {
  const token = "career4.successfactors.com|Popularinc";
  const identity = decodeSuccessFactorsToken(token);
  assert.equal(identity.host, "career4.successfactors.com");
  assert.equal(identity.company, "Popularinc");

  const encoded = encodeSuccessFactorsToken(identity);
  assert.equal(encoded, token);

  assert.equal(normalizeSuccessFactorsToken(" CAREER4.SUCCESSFACTORS.COM | Popularinc "), token);
});

test("decodeSuccessFactorsToken rejects invalid tokens", () => {
  assert.throws(() => decodeSuccessFactorsToken("invalid"), /Invalid SuccessFactors host\|company token/);
  assert.throws(() => decodeSuccessFactorsToken("career4.successfactors.com|comp|extra"), /Invalid SuccessFactors host\|company token/);
  assert.throws(() => decodeSuccessFactorsToken("malicious.com|company"), /Invalid SuccessFactors host\|company token/);
});

test("validateBootstrapRedirectHost enforces non-circular trust and rejects all external redirects", () => {
  const identity = { host: "career4.successfactors.com", company: "Popularinc" };

  // 1. Saved hostname accepted (stays on primary host)
  assert.doesNotThrow(() =>
    validateBootstrapRedirectHost("https://career4.successfactors.com/career?company=Popularinc", identity)
  );

  // 2. Redirect to evil.example rejected unconditionally
  assert.throws(
    () => validateBootstrapRedirectHost("https://evil.example.com/career", identity),
    /redirected to an untrusted external host: evil.example.com/
  );

  // 3. Redirect to another custom domain (e.g. jobs.popular.com) rejected without saved source configuration
  assert.throws(
    () => validateBootstrapRedirectHost("https://jobs.popular.com/career", identity),
    /redirected to an untrusted external host: jobs.popular.com/
  );

  // 4. Redirect to another SuccessFactors cloud tenant rejected
  assert.throws(
    () => validateBootstrapRedirectHost("https://career8.successfactors.com/career?company=other", identity),
    /redirected to an untrusted external host: career8.successfactors.com/
  );

  // 5. Test override permits test server hostname
  assert.doesNotThrow(() =>
    validateBootstrapRedirectHost("http://127.0.0.1:8080/career", identity, "http://127.0.0.1:8080")
  );

  // 6. Malformed redirect URL is rejected
  assert.throws(
    () => validateBootstrapRedirectHost("not-a-valid-url", identity),
    /malformed URL/
  );

  // 7. User credentials in redirect URL are rejected
  assert.throws(
    () => validateBootstrapRedirectHost("https://user:pass@career4.successfactors.com/career", identity),
    /must not contain user credentials/
  );
});

test("isDetailHostTrusted and validateDetailResponseUrl enforce strict immutable hostname whitelist", () => {
  const trustedHosts = new Set(["career4.successfactors.com", "jobs.example.com"]);

  // 1. Saved hostname accepted
  assert.equal(isDetailHostTrusted("https://career4.successfactors.com/career?company=test", trustedHosts), true);
  const parsedSaved = validateDetailResponseUrl("https://career4.successfactors.com/career?company=test", trustedHosts);
  assert.equal(parsedSaved.hostname, "career4.successfactors.com");

  // 2. Prevalidated exact custom hostname accepted
  assert.equal(isDetailHostTrusted("https://jobs.example.com/job/123", trustedHosts), true);
  const parsedCustom = validateDetailResponseUrl("https://jobs.example.com/job/123", trustedHosts);
  assert.equal(parsedCustom.hostname, "jobs.example.com");

  // 3. Another SuccessFactors tenant rejected
  assert.equal(isDetailHostTrusted("https://career8.successfactors.com/career?company=other", trustedHosts), false);
  assert.throws(
    () => validateDetailResponseUrl("https://career8.successfactors.com/career?company=other", trustedHosts),
    /redirected to an untrusted host/
  );

  // 4. Evil example domain rejected
  assert.equal(isDetailHostTrusted("https://evil.example.com/job/123", trustedHosts), false);
  assert.throws(
    () => validateDetailResponseUrl("https://evil.example.com/job/123", trustedHosts),
    /redirected to an untrusted host/
  );

  // 5. Malformed URL rejected
  assert.equal(isDetailHostTrusted("not-a-valid-url", trustedHosts), false);
  assert.throws(
    () => validateDetailResponseUrl("not-a-valid-url", trustedHosts),
    /malformed URL/
  );

  // 6. User credentials rejected
  assert.throws(
    () => validateDetailResponseUrl("https://user:pass@career4.successfactors.com/career", trustedHosts),
    /must not contain user credentials/
  );
});

test("detailURLPrefix trust bounds: HTTP, relative, and credential-bearing prefixes cannot expand production trustedHosts", async () => {
  const serverInvalidPrefix = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career" && !url.searchParams.get("career_job_req_id")) {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=48625;s2.title="Analyst";s1[0]=s2;
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=1;s4.totalCount=1;
s0.postings=s1;
s0.detailURLPrefix="https://user:pass@evil.example.com/job";
s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }

    if (url.pathname === "/career" && url.searchParams.get("career_job_req_id")) {
      res.writeHead(302, { Location: `https://evil.example.com/job/48625` });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverInvalidPrefix.listen(0, "127.0.0.1", r));
  const port = (serverInvalidPrefix.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${port}`,
        allowPrivateNetworksForTests: true,
      }),
      /redirected to an untrusted host|fetch failed/
    );
  } finally {
    serverInvalidPrefix.close();
  }
});

test("parseDwrResponse parses safe DWR JavaScript payload without execution", () => {
  const sampleDwr = `
throw 'allowScriptTagRemoting is false.';
//#DWR-INSERT
//#DWR-REPLY
var s0={};var s1=[];var s2={};
s0.id=1001;
s0.title="Senior Software Engineer";
s0.postingDate="08/10/2026";
s1[0]=s0;
s2.postingCount="1";
s2.postings=s1;
dwr.engine._remoteHandleCallback('0','0',{payload:s2});
  `;

  const parsed = parseDwrResponse(sampleDwr, "0", "0");
  assert.equal(parsed.postingCount, "1");
  assert.equal(parsed.postings?.length, 1);
  assert.equal(parsed.postings?.[0]?.title, "Senior Software Engineer");
});

test("parseDwrResponse rejects call ID mismatches and exception ID mismatches", () => {
  const callbackCallIdMismatch = `
throw 'allowScriptTagRemoting is false.';
var s0={};
dwr.engine._remoteHandleCallback('0','1',s0);
  `;
  assert.throws(() => parseDwrResponse(callbackCallIdMismatch, "0", "0"), /DWR callback call ID mismatch/);

  const exceptionIdMismatch = `
throw 'allowScriptTagRemoting is false.';
var s0={};
dwr.engine._remoteHandleException('0','1',s0);
  `;
  assert.throws(() => parseDwrResponse(exceptionIdMismatch, "0", "0"), /DWR exception call ID mismatch/);
});

test("parseDwrResponse parser hardening: rejects unexpected throw statements, multiple callbacks, and batch ID mismatches", () => {
  const arbitraryThrowDwr = `
throw new Error("unexpected error");
var s0={};
dwr.engine._remoteHandleCallback('0','0',s0);
  `;
  assert.throws(() => parseDwrResponse(arbitraryThrowDwr), /Unexpected throw statement in DWR response/);

  const doubleCallbackDwr = `
throw 'allowScriptTagRemoting is false.';
var s0={};
dwr.engine._remoteHandleCallback('0','0',s0);
dwr.engine._remoteHandleCallback('0','0',s0);
  `;
  assert.throws(() => parseDwrResponse(doubleCallbackDwr), /DWR response contained multiple callback invocations/);

  const batchMismatchDwr = `
throw 'allowScriptTagRemoting is false.';
var s0={};
dwr.engine._remoteHandleCallback('5','0',s0);
  `;
  assert.throws(() => parseDwrResponse(batchMismatchDwr, "0", "0"), /DWR callback batch ID mismatch/);
});

test("parseDwrResponse rejects malicious payloads with executable JS keywords", () => {
  const maliciousDwr = `
throw 'allowScriptTagRemoting is false.';
var s0={};
s0.id=eval("process.exit(1)");
dwr.engine._remoteHandleCallback('0','0',s0);
  `;
  assert.throws(() => parseDwrResponse(maliciousDwr), /DWR statement contains prohibited executable JS keyword/);
});

test("parseDwrResponse rejects prototype pollution attempts", () => {
  const maliciousDwr = `
throw 'allowScriptTagRemoting is false.';
var s0={};
s0.__proto__={polluted:true};
dwr.engine._remoteHandleCallback('0','0',s0);
  `;
  assert.throws(() => parseDwrResponse(maliciousDwr), /Forbidden property in DWR assignment: __proto__/);
});

test("extractLocationFromPosting requires explicit location labels and ignores generic US fields", () => {
  const posting = {
    id: 101,
    title: "Engineer",
    otherValues: [
      [
        { fieldId: "department_obj", shortVal: "US Operations & Customer Support" },
        { fieldId: "division_obj", shortVal: "Global US Division" },
        { fieldId: "filter1", shortVal: "US Commercial Operations" },
        { fieldId: "location_obj", shortVal: '["Location",1,"London, UK"]' },
      ],
    ],
  };

  const location = extractLocationFromPosting(posting);
  assert.equal(location, "London, UK");
  assert.ok(!location.includes("US Commercial"));
  assert.ok(!location.includes("US Operations"));
});

test("fetchSuccessFactorsJobs enforces exact page boundaries, missing sort metadata, and truncated final page rejection", async () => {
  // Test 1: Wrong exact endRow on page 1
  const serverWrongEndRow = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=1000;s2.title="Job 0";s1[0]=s2;
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=99;s4.totalCount=1;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverWrongEndRow.listen(0, "127.0.0.1", r));
  const port1 = (serverWrongEndRow.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${port1}`,
        allowPrivateNetworksForTests: true,
      }),
      /invalid endRow/
    );
  } finally {
    serverWrongEndRow.close();
  }

  // Test 2: Missing sort metadata
  const serverMissingSort = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=1000;s2.title="Job 0";s1[0]=s2;
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=1;s4.totalCount=1;
s0.postings=s1;s0.options={pagination:s4};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverMissingSort.listen(0, "127.0.0.1", r));
  const port2 = (serverMissingSort.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${port2}`,
        allowPrivateNetworksForTests: true,
      }),
      /incorrect sortByColumn/
    );
  } finally {
    serverMissingSort.close();
  }

  // Test 3: Truncated page
  const serverTruncated = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s4={};
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=1;s4.totalCount=1;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverTruncated.listen(0, "127.0.0.1", r));
  const port3 = (serverTruncated.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${port3}`,
        allowPrivateNetworksForTests: true,
      }),
      /returned 0 postings, expected 1/
    );
  } finally {
    serverTruncated.close();
  }
});

test("fetchSuccessFactorsJobs rejects mid-pagination totalCount changes and duplicates", async () => {
  // Test 1: Mid-pagination totalCount change
  const serverCountChange = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (body.includes("batchId=0")) {
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=1000;s2.title="Job 0";s1[0]=s2;
s4.currentPage=1;s4.pageSize=1;s4.startRow=1;s4.endRow=1;s4.totalCount=2;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(dwrText);
        } else {
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=1001;s2.title="Job 1";s1[0]=s2;
s4.currentPage=2;s4.pageSize=1;s4.startRow=2;s4.endRow=2;s4.totalCount=999;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('1','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(dwrText);
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverCountChange.listen(0, "127.0.0.1", r));
  const portCount = (serverCountChange.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${portCount}`,
        allowPrivateNetworksForTests: true,
      }),
      /totalCount changed mid-pagination/
    );
  } finally {
    serverCountChange.close();
  }

  // Test 2: Cross-page duplicate job ID
  const serverDup = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (body.includes("batchId=0")) {
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=1000;s2.title="Job 0";s1[0]=s2;
s4.currentPage=1;s4.pageSize=1;s4.startRow=1;s4.endRow=1;s4.totalCount=2;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(dwrText);
        } else {
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=1000;s2.title="Job 0 Duplicate";s1[0]=s2;
s4.currentPage=2;s4.pageSize=1;s4.startRow=2;s4.endRow=2;s4.totalCount=2;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('1','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(dwrText);
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverDup.listen(0, "127.0.0.1", r));
  const portDup = (serverDup.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${portDup}`,
        allowPrivateNetworksForTests: true,
      }),
      /duplicate job ID 1000 across pages/
    );
  } finally {
    serverDup.close();
  }
});

test("fetchSuccessFactorsJobs STABLE_STALE_COUNT mode: positive and negative fixtures", async () => {
  let snapCounter = 0;
  let simulateMismatchOnSecondSnap = false;

  const serverStale = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career" && !url.searchParams.get("career_job_req_id")) {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (body.includes("batchId=0")) {
          // Page 1: pageSize 2, totalCount 4, returns 2 postings
          snapCounter++;
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s3={};var s4={};
s2.id=1000;s2.title="Job 1000";s1[0]=s2;
s3.id=1001;s3.title="Job 1001";s1[1]=s3;
s4.currentPage=1;s4.pageSize=2;s4.startRow=1;s4.endRow=2;s4.totalCount=4;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(dwrText);
        } else {
          // Page 2 (final page): expected 2 postings (startRow 3, endRow 4), but server returns 1 posting (job 1002)
          const jobId = (simulateMismatchOnSecondSnap && snapCounter > 1) ? 9999 : 1002;
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=${jobId};s2.title="Job ${jobId}";s1[0]=s2;
s4.currentPage=2;s4.pageSize=2;s4.startRow=3;s4.endRow=4;s4.totalCount=4;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('1','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(dwrText);
        }
      });
      return;
    }

    if (url.pathname === "/career" && url.searchParams.get("career_job_req_id")) {
      const reqId = url.searchParams.get("career_job_req_id");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h1>Job ${reqId}</h1><input type="hidden" name="jobReqId" value="${reqId}"/><input type="hidden" name="company" value="Popularinc"/><div class="jobdescription"><p>Valid description text for testing purposes with required length.</p></div></body></html>`);
      return;
    }

    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverStale.listen(0, "127.0.0.1", r));
  const portStale = (serverStale.address() as { port: number }).port;

  try {
    // 1. Without allowStableStaleCount: fails closed on count mismatch
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${portStale}`,
        allowPrivateNetworksForTests: true,
        allowStableStaleCount: false,
      }),
      /listing count mismatch/
    );

    // 2. With allowStableStaleCount and identical snapshots: succeeds
    snapCounter = 0;
    const jobs = await fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
      originOverride: `http://127.0.0.1:${portStale}`,
      allowPrivateNetworksForTests: true,
      allowStableStaleCount: true,
      usOnly: false,
    });
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].externalId, "1000");
    assert.equal(jobs[1].externalId, "1001");
    assert.equal(jobs[2].externalId, "1002");

    // 3. With allowStableStaleCount but snapshot 2 diverges: fails closed
    snapCounter = 0;
    simulateMismatchOnSecondSnap = true;
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${portStale}`,
        allowPrivateNetworksForTests: true,
        allowStableStaleCount: true,
        usOnly: false,
      }),
      /detected ID sequence divergence/
    );
  } finally {
    serverStale.close();
  }
});

test("fetchSuccessFactorsJobs rejects evil.example even if bootstrap redirects and serves matching canonical/base/siteUrl fields", async () => {
  const identity = { host: "career4.successfactors.com", company: "Popularinc" };

  // 1. Direct validation helper rejects external redirect even with originOverride set
  assert.throws(
    () => validateBootstrapRedirectHost("https://evil.example.com/career", identity, "http://127.0.0.1:8080"),
    /redirected to an untrusted external host: evil.example.com/
  );

  // 2. Server test where bootstrap 302 redirects to evil.example.com
  const mainServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(302, { Location: "https://evil.example.com/career" });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => mainServer.listen(0, "127.0.0.1", r));
  const mainPort = (mainServer.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${mainPort}`,
        allowPrivateNetworksForTests: true,
      }),
      /bootstrap redirected to an untrusted external host: evil.example.com|fetch failed/
    );
  } finally {
    mainServer.close();
  }
});

test("fetchSuccessFactorsJobs empty board totalCount=0 contract and malformed empty-board validation", async () => {
  // Positive empty-board contract
  const serverEmpty = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s4={};
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=0;s4.totalCount=0;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverEmpty.listen(0, "127.0.0.1", r));
  const port = (serverEmpty.address() as { port: number }).port;

  try {
    const jobs = await fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
      originOverride: `http://127.0.0.1:${port}`,
      allowPrivateNetworksForTests: true,
    });
    assert.deepEqual(jobs, []);
  } finally {
    serverEmpty.close();
  }

  // Malformed empty board (non-zero endRow on totalCount=0)
  const serverMalformedEmpty = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career") {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s4={};
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=5;s4.totalCount=0;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverMalformedEmpty.listen(0, "127.0.0.1", r));
  const portMalformed = (serverMalformedEmpty.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${portMalformed}`,
        allowPrivateNetworksForTests: true,
      }),
      /empty board returned invalid endRow/
    );
  } finally {
    serverMalformedEmpty.close();
  }
});

test("fetchSuccessFactorsJobs rejects untrusted host redirects and incidental job-number text", async () => {
  // Test 1: Detail URL redirection to an untrusted host on a different local port
  const serverUntrustedTarget = http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><h1>Job on untrusted port</h1><div class="jobdescription"><p>Valid length description for testing purposes here.</p></div></body></html>`);
  });
  await new Promise<void>((r) => serverUntrustedTarget.listen(0, "127.0.0.1", r));
  const untrustedPort = (serverUntrustedTarget.address() as { port: number }).port;

  const serverUntrustedHost = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career" && !url.searchParams.get("career_job_req_id")) {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=48625;s2.title="Analyst";s1[0]=s2;
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=1;s4.totalCount=1;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }

    if (url.pathname === "/career" && url.searchParams.get("career_job_req_id")) {
      res.writeHead(302, { Location: `http://localhost:${untrustedPort}/job/48625` });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverUntrustedHost.listen(0, "127.0.0.1", r));
  const port1 = (serverUntrustedHost.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${port1}`,
        allowPrivateNetworksForTests: true,
      }),
      /redirected to an untrusted host/
    );
  } finally {
    serverUntrustedHost.close();
    serverUntrustedTarget.close();
  }

  // Test 2: Detail URL redirection to a clean path with only incidental body text
  const serverIncidental = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career" && !url.searchParams.get("career_job_req_id")) {
      res.writeHead(200, { "Set-Cookie": "JSESSIONID=S1", "Content-Type": "text/html" });
      res.end(`<html><body></body></html>`);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      const dwrText = `
throw 'allowScriptTagRemoting is false.';
var s0={};var s1=[];var s2={};var s4={};
s2.id=48625;s2.title="Analyst";s1[0]=s2;
s4.currentPage=1;s4.pageSize=10;s4.startRow=1;s4.endRow=1;s4.totalCount=1;
s0.postings=s1;s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
      `;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(dwrText);
      return;
    }

    if (url.pathname === "/career" && url.searchParams.get("career_job_req_id")) {
      res.writeHead(302, { Location: `/job/incidental-test` });
      res.end();
      return;
    }

    if (url.pathname === "/job/incidental-test") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html>
          <body>
            <h1>Analyst</h1>
            <p>Salary for this role is $48625 per year in Michigan zip 48625.</p>
            <div class="jobdescription"><p>Full description paragraph with more than fifty characters required for testing purposes.</p></div>
          </body>
        </html>
      `);
      return;
    }

    res.writeHead(404); res.end();
  });

  await new Promise<void>((r) => serverIncidental.listen(0, "127.0.0.1", r));
  const port2 = (serverIncidental.address() as { port: number }).port;

  try {
    await assert.rejects(
      fetchSuccessFactorsJobs("career4.successfactors.com|Popularinc", {
        originOverride: `http://127.0.0.1:${port2}`,
        allowPrivateNetworksForTests: true,
      }),
      /missing positive requisition ID evidence|missing positive company identity evidence/
    );
  } finally {
    serverIncidental.close();
  }
});

test("fetchSuccessFactorsJobs fetches, paginates, and normalizes U.S. jobs cleanly", async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/career" && url.searchParams.get("company") === "Popularinc" && !url.searchParams.get("career_job_req_id")) {
      res.writeHead(200, {
        "Set-Cookie": "JSESSIONID=TEST_SESSION_ID_12345; Path=/; Secure; HttpOnly",
        "Content-Type": "text/html; charset=UTF-8",
      });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <script>var ajaxSecKey="SEC_KEY_999";</script>
          </head>
          <body>
            <input type="hidden" name="javax.faces.ViewState" value="VIEW_STATE_123" />
          </body>
        </html>
      `);
      return;
    }

    if (url.pathname.includes("search.dwr")) {
      req.resume();
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (body.includes("batchId=0")) {
          requestedPages.push("initial");
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
//#DWR-INSERT
//#DWR-REPLY
var s0={};var s1=[];var s2={};var s3={};var s4={};
s2.id=1000;s2.title="Job 0 - US Role";s2.postingDate="08/10/2026";
s3.id=1001;s3.title="Job 1 - Non-US Role";s3.postingDate="08/11/2026";
s1[0]=s2;s1[1]=s3;
s4.currentPage=1;s4.pageSize=2;s4.startRow=1;s4.endRow=2;s4.totalCount=3;
s0.postings=s1;s0.postingCount="3";s0.options={pagination:s4,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('0','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain; charset=UTF-8" });
          res.end(dwrText);
        } else {
          requestedPages.push("page2");
          const dwrText = `
throw 'allowScriptTagRemoting is false.';
//#DWR-INSERT
//#DWR-REPLY
var s0={};var s1=[];var s2={};var s3={};
s2.id=1002;s2.title="Job 2 - US Role Page 2";s2.postingDate="08/12/2026";
s1[0]=s2;
s3.currentPage=2;s3.pageSize=2;s3.startRow=3;s3.endRow=3;s3.totalCount=3;
s0.postings=s1;s0.postingCount="3";s0.options={pagination:s3,sortByColumn:"JOB_POSTING_DATE",sortOrder:"DESC"};
dwr.engine._remoteHandleCallback('1','0',{payload:s0});
          `;
          res.writeHead(200, { "Content-Type": "text/plain; charset=UTF-8" });
          res.end(dwrText);
        }
      });
      return;
    }

    if (url.pathname === "/career" && url.searchParams.get("career_job_req_id")) {
      const reqId = url.searchParams.get("career_job_req_id");
      detailRequests.push(reqId!);

      const isUs = reqId !== "1001";
      const title = reqId === "1000" ? "Job 0 - US Role" : reqId === "1001" ? "Job 1 - Non-US Role" : "Job 2 - US Role Page 2";
      res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
          <body>
            <h1>${title}</h1>
            <input type="hidden" name="jobReqId" value="${reqId}" />
            <input type="hidden" name="company" value="Popularinc" />
            <div>Department: <span>Engineering</span></div>
            <div>Workplace Type: Hybrid</div>
            <div class="jobdescription">
              <p>We are seeking a talented engineer for requisition ${reqId}. Salary range is $130,000 - $160,000 annually. Location: ${isUs ? "United States" : "United Kingdom"}.</p>
            </div>
          </body>
        </html>
      `);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const requestedPages: string[] = [];
  const detailRequests: string[] = [];

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    const token = "career4.successfactors.com|Popularinc";
    const jobs = await fetchSuccessFactorsJobs(token, {
      originOverride: origin,
      allowPrivateNetworksForTests: true,
    });

    assert.equal(jobs.length, 2);
    assert.deepEqual(requestedPages, ["initial", "page2"]);
    assert.deepEqual(detailRequests.sort(), ["1000", "1001", "1002"]);

    const job0 = jobs[0];
    assert.equal(job0.externalId, "1000");
    assert.equal(job0.title, "Job 0 - US Role");
    assert.ok(job0.descriptionText);
    assert.match(job0.descriptionText, /We are seeking a talented engineer for requisition 1000/);
  } finally {
    server.close();
  }
});

// --- DB-isolated allowlist integration test (isolated temp DB, same convention as
// organizationRegistry.test.ts) -------------------------------------------------------------

let tmpDir: string;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let recordDiscoveryResult: typeof import("@/db/queries/companies").recordDiscoveryResult;
let listJobSources: typeof import("@/db/queries/organizationRegistry").listJobSources;
let listScanReadyCompanies: typeof import("@/db/queries/organizationRegistry").listScanReadyCompanies;
let reviewJobSource: typeof import("@/db/queries/organizationRegistry").reviewJobSource;
let getOrganizationForCompany: typeof import("@/db/queries/organizationRegistry").getOrganizationForCompany;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-successfactors-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  const { getDb } = await import("@/db/index");
  ({ createCompany, recordDiscoveryResult } = await import("@/db/queries/companies"));
  ({ listJobSources, listScanReadyCompanies, reviewJobSource, getOrganizationForCompany } = await import(
    "@/db/queries/organizationRegistry"
  ));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("SuccessFactors allowlist integration: approved vs pending listScanReadyCompanies behavior", () => {
  const company = createCompany({
    name: "Popular Inc",
    source_type: "successfactors",
    ats_board_token: "career4.successfactors.com|Popularinc",
  });
  recordDiscoveryResult(company.id, {
    status: "VERIFIED",
    sourceType: "successfactors",
    atsBoardToken: "career4.successfactors.com|Popularinc",
    discoveredJobsUrl: "https://career4.successfactors.com/career?company=Popularinc",
    reason: "Direct ATS URL match (successfactors)",
    suspectedAts: null,
  });

  const organization = getOrganizationForCompany(company.id)!;
  const source = listJobSources(organization.id)[0];
  assert.equal(source.provider, "successfactors");
  assert.equal(source.review_status, "PENDING", "a newly discovered structured source starts PENDING, not auto-approved");
  assert.ok(
    !listScanReadyCompanies().some((candidate) => candidate.id === company.id),
    "a PENDING SuccessFactors source must be excluded from the scan-ready allowlist"
  );

  reviewJobSource(source.id, "APPROVED", "Validated company-specific public board");
  assert.ok(
    listScanReadyCompanies().some((candidate) => candidate.id === company.id),
    "an APPROVED SuccessFactors source must appear in the scan-ready allowlist, same as every other supported connector"
  );
});

test("SuccessFactors allowlist integration: REJECTED sources stay excluded", () => {
  const company = createCompany({
    name: "Rejected SF Co",
    source_type: "successfactors",
    ats_board_token: "career9.successfactors.com|RejectedCo",
  });
  recordDiscoveryResult(company.id, {
    status: "VERIFIED",
    sourceType: "successfactors",
    atsBoardToken: "career9.successfactors.com|RejectedCo",
    discoveredJobsUrl: "https://career9.successfactors.com/career?company=RejectedCo",
    reason: "Direct ATS URL match (successfactors)",
    suspectedAts: null,
  });
  const organization = getOrganizationForCompany(company.id)!;
  const source = listJobSources(organization.id)[0];

  reviewJobSource(source.id, "REJECTED", "Validation found a stale/broken board");
  assert.ok(
    !listScanReadyCompanies().some((candidate) => candidate.id === company.id),
    "a REJECTED SuccessFactors source must never appear in the scan-ready allowlist"
  );
});
