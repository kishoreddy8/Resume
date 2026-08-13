import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { discoverCompanySource } from "@/lib/ats/discovery";

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void>; requestCount: () => number }> {
  return new Promise((resolve) => {
    let count = 0;
    const server = http.createServer((req, res) => {
      count++;
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
        requestCount: () => count,
      });
    });
  });
}

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

test("discoverCompanySource: a direct known-ATS URL resolves VERIFIED with zero network calls (Tier 1)", async () => {
  const result = await discoverCompanySource("https://boards.greenhouse.io/exampleco");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "greenhouse");
  assert.equal(result.atsBoardToken, "exampleco");
});

test("discoverCompanySource: a Greenhouse embed script uses the for= board token, never the word embed", async () => {
  const result = await discoverCompanySource("https://boards.greenhouse.io/embed/job_board/js?for=exampleco");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "greenhouse");
  assert.equal(result.atsBoardToken, "exampleco");
  assert.equal(result.discoveredJobsUrl, "https://job-boards.greenhouse.io/exampleco");
});

test("discoverCompanySource: a Workday job/apply URL is normalized to the stable board root", async () => {
  const result = await discoverCompanySource(
    "https://elevancehealth.wd1.myworkdayjobs.com/ANT/job/GA-ATLANTA/Example_JR203091/apply"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "workday");
  assert.equal(result.atsBoardToken, "elevancehealth|wd1|ANT");
  assert.equal(result.discoveredJobsUrl, "https://elevancehealth.wd1.myworkdayjobs.com/ANT");
});

test("discoverCompanySource: a direct SmartRecruiters URL resolves to its stable company board", async () => {
  const result = await discoverCompanySource("https://jobs.smartrecruiters.com/ExampleCo");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "smartrecruiters");
  assert.equal(result.atsBoardToken, "ExampleCo");
  assert.equal(result.discoveredJobsUrl, "https://careers.smartrecruiters.com/ExampleCo");
});

test("discoverCompanySource: a modern ADP Workforce Now board resolves while preserving tenant identity", async () => {
  const result = await discoverCompanySource(
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?" +
      "cid=4aad6ff8-f078-4009-9c60-a05e5489cec6&amp;ccId=19000101_000001&amp;lang=en_US"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "adp_wfn");
  assert.equal(
    result.atsBoardToken,
    "4aad6ff8-f078-4009-9c60-a05e5489cec6|19000101_000001|en_US"
  );
});

test("discoverCompanySource: a Paylocity board resolves to a stable company identity", async () => {
  const result = await discoverCompanySource(
    "https://recruiting.paylocity.com/recruiting/jobs/All/c41ecedc-a1f9-407e-9fba-86b6e144fb39/Kashiv-Biosciences-LLC"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "paylocity");
  assert.equal(result.atsBoardToken, "c41ecedc-a1f9-407e-9fba-86b6e144fb39|Kashiv-Biosciences-LLC");
});

test("discoverCompanySource: any iCIMS job path resolves to its tenant-wide board", async () => {
  const result = await discoverCompanySource(
    "https://careers-example.icims.com/jobs/4879/platform-engineer/job?in_iframe=1"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "icims");
  assert.equal(result.atsBoardToken, "careers-example.icims.com");
  assert.equal(result.discoveredJobsUrl, "https://careers-example.icims.com/jobs/search");
});

test("discoverCompanySource: a UKG opportunity detail URL resolves to its exact public board", async () => {
  const result = await discoverCompanySource(
    "https://recruiting2.ultipro.com/MIL1017/JobBoard/f54234e9-dfde-b183-fd20-4fbdb19cba7a/" +
      "OpportunityDetail?opportunityId=57cd8adc-df7d-4fd2-b5db-7395ef0e66aa"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "ukg_pro");
  assert.equal(
    result.atsBoardToken,
    "recruiting2.ultipro.com|MIL1017|f54234e9-dfde-b183-fd20-4fbdb19cba7a"
  );
  assert.equal(
    result.discoveredJobsUrl,
    "https://recruiting2.ultipro.com/MIL1017/JobBoard/f54234e9-dfde-b183-fd20-4fbdb19cba7a/"
  );
});

test("discoverCompanySource: a BambooHR job URL resolves to its tenant-wide board", async () => {
  const result = await discoverCompanySource("https://Example-Co.bamboohr.com/careers/105");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "bamboohr");
  assert.equal(result.atsBoardToken, "example-co");
  assert.equal(result.discoveredJobsUrl, "https://example-co.bamboohr.com/careers");
});

test("discoverCompanySource: an Oracle Candidate Experience job path resolves to its host/site board", async () => {
  const result = await discoverCompanySource(
    "https://edel.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/job/22125"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "oracle_recruiting_cloud");
  assert.equal(result.atsBoardToken, "edel.fa.us2.oraclecloud.com|CX_2001");
  assert.equal(
    result.discoveredJobsUrl,
    "https://edel.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001"
  );
});

test("discoverCompanySource: a Workable job path resolves to its account-wide board", async () => {
  const result = await discoverCompanySource("https://apply.workable.com/corcentric/j/DC91C84645/");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "workable");
  assert.equal(result.atsBoardToken, "corcentric");
  assert.equal(result.discoveredJobsUrl, "https://apply.workable.com/corcentric/");
});

test("discoverCompanySource: embedded and localized Rippling paths resolve to one board identity", async () => {
  for (const url of [
    "https://ats.rippling.com/embed/example-co/jobs",
    "https://ats.rippling.com/en-GB/example-co/jobs/22222222-2222-4222-8222-222222222222",
  ]) {
    const result = await discoverCompanySource(url);
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.sourceType, "rippling");
    assert.equal(result.atsBoardToken, "example-co");
    assert.equal(result.discoveredJobsUrl, "https://ats.rippling.com/example-co/jobs");
  }
});

test("discoverCompanySource: a Paycom board URL ignores ephemeral session parameters", async () => {
  const result = await discoverCompanySource(
    "https://paycomonline.net/v4/ats/web.php/jobs?clientkey=4689d9ab2f6f99ad5f352379b206fd14&session_nonce=temporary"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "paycom");
  assert.equal(result.atsBoardToken, "4689D9AB2F6F99AD5F352379B206FD14");
  assert.equal(
    result.discoveredJobsUrl,
    "https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=4689D9AB2F6F99AD5F352379B206FD14"
  );
});

test("discoverCompanySource: a JazzHR detail URL resolves to its tenant board", async () => {
  const result = await discoverCompanySource(
    "https://Ouster.applytojob.com/apply/d1AElZrXms/Mechanical-Engineer?source=widget"
  );
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "jazzhr");
  assert.equal(result.atsBoardToken, "ouster");
  assert.equal(result.discoveredJobsUrl, "https://ouster.applytojob.com/apply");
});

test("discoverCompanySource: legacy and detail Jobvite URLs resolve to one tenant board", async () => {
  for (const url of [
    "http://jobs.jobvite.com/careers/riskspan/jobs?__jvst=Career%20Site",
    "https://jobs.jobvite.com/riskspan/job/o42rAfwR",
  ]) {
    const result = await discoverCompanySource(url);
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.sourceType, "jobvite");
    assert.equal(result.atsBoardToken, "riskspan");
    assert.equal(result.discoveredJobsUrl, "https://jobs.jobvite.com/riskspan/jobs");
  }
});

test("discoverCompanySource: a Breezy HR detail URL resolves to its tenant board", async () => {
  const result = await discoverCompanySource("https://Cytracom.breezy.hr/p/223dda3466ba-senior-software-engineer");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "breezy");
  assert.equal(result.atsBoardToken, "cytracom");
  assert.equal(result.discoveredJobsUrl, "https://cytracom.breezy.hr/");
});

test("discoverCompanySource: a Teamtailor detail URL resolves to its tenant board", async () => {
  const result = await discoverCompanySource("https://PassiveLogic.teamtailor.com/jobs/8147892-controls-deployment-engineer?source=widget");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "teamtailor");
  assert.equal(result.atsBoardToken, "passivelogic");
  assert.equal(result.discoveredJobsUrl, "https://passivelogic.teamtailor.com/jobs");
});

test("discoverCompanySource: ApplicantPro tenant and central detail URLs resolve to one board", async () => {
  for (const url of [
    "https://Improvizations.applicantpro.com/jobs/4118034-990328.html",
    "https://www.applicantpro.com/openings/improvizations/jobs/4118034/UT-Utah/Some-Role",
  ]) {
    const result = await discoverCompanySource(url);
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.sourceType, "applicantpro");
    assert.equal(result.atsBoardToken, "improvizations");
    assert.equal(result.discoveredJobsUrl, "https://improvizations.applicantpro.com/jobs/");
  }
});

test("discoverCompanySource: a localized Pinpoint posting resolves to its tenant board", async () => {
  const result = await discoverCompanySource("https://Marchex.pinpointhq.com/en/postings/563b4a25-cb58-4741-9cae-382f15f54d55");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "pinpoint");
  assert.equal(result.atsBoardToken, "marchex");
  assert.equal(result.discoveredJobsUrl, "https://marchex.pinpointhq.com/");
});

test("discoverCompanySource: a ClearCompany apply URL resolves to its tenant board", async () => {
  const result = await discoverCompanySource("https://MSSSolutions.clearcompany.com/careers/jobs/e2502a8c-080a-74cb-f57e-cf57be51c047/apply?source=x");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "clearcompany");
  assert.equal(result.atsBoardToken, "msssolutions");
  assert.equal(result.discoveredJobsUrl, "https://msssolutions.clearcompany.com/careers/jobs");
});

test("discoverCompanySource: homepage -> Careers link -> embedded Greenhouse link resolves VERIFIED", async () => {
  const { url, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<a href="/careers">Careers</a>`));
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<a href="https://boards.greenhouse.io/exampleco">Search Jobs</a>`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await discoverCompanySource(url, { allowPrivateNetworksForTests: true });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.sourceType, "greenhouse");
    assert.equal(result.atsBoardToken, "exampleco");
    assert.equal(result.discoveredJobsUrl, "https://boards.greenhouse.io/exampleco");
  } finally {
    await close();
  }
});

test("discoverCompanySource: three-hop chain (home -> careers -> search jobs) with an ATS only on the third page still resolves VERIFIED within budget", async () => {
  const { url, close, requestCount } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<a href="/careers">Careers</a>`));
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<a href="/careers/search-jobs">Search Jobs</a>`));
    } else if (req.url === "/careers/search-jobs") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<a href="https://jobs.ashbyhq.com/exampleco">Data Engineer</a>`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await discoverCompanySource(url, { allowPrivateNetworksForTests: true });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.sourceType, "ashby");
    assert.equal(requestCount(), 3);
  } finally {
    await close();
  }
});

test("discoverCompanySource: no ATS found but a careers page was reached — GENERIC_SUPPORTED, not UNRESOLVED", async () => {
  const { url, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<a href="/careers">Careers</a>`));
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<h1>Open Positions</h1><p>Engineer, Designer, PM</p>`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await discoverCompanySource(url, { allowPrivateNetworksForTests: true });
    assert.equal(result.status, "GENERIC_SUPPORTED");
    assert.equal(result.discoveredJobsUrl, `${url}/careers`);
    assert.equal(result.sourceType, null);
  } finally {
    await close();
  }
});

test("discoverCompanySource: a homepage with no careers link and no ATS is UNRESOLVED, never GENERIC_SUPPORTED on a guess", async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page(`<a href="/about">About</a><a href="/privacy">Privacy</a>`));
  });
  try {
    const result = await discoverCompanySource(url, { allowPrivateNetworksForTests: true });
    assert.equal(result.status, "UNRESOLVED");
    assert.equal(result.discoveredJobsUrl, null);
    assert.equal(result.sourceType, null);
  } finally {
    await close();
  }
});

test("discoverCompanySource: navigation clutter (Privacy/Locations/Talent Network) never outscores a real careers signal", async () => {
  const { url, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        page(
          `<a href="/privacy">Privacy</a><a href="/locations">Locations</a><a href="/talent-network">Talent Network</a><a href="/careers">Careers</a>`
        )
      );
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`<h1>Open roles</h1>`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await discoverCompanySource(url, { allowPrivateNetworksForTests: true });
    assert.equal(result.status, "GENERIC_SUPPORTED");
    assert.equal(result.discoveredJobsUrl, `${url}/careers`);
  } finally {
    await close();
  }
});

test("discoverCompanySource: an unreachable seed URL is FAILED_TEMPORARY (transient), not UNRESOLVED", async () => {
  // Nothing is listening on this port — ECONNREFUSED, a transient network condition.
  const result = await discoverCompanySource("http://127.0.0.1:1/", { allowPrivateNetworksForTests: true, });
  assert.equal(result.status, "FAILED_TEMPORARY");
  assert.equal(result.discoveredJobsUrl, null);
});

test("discoverCompanySource: a hostname that does not exist (e.g. a wrongly-generated domain candidate) is UNRESOLVED, not FAILED_TEMPORARY — retrying it would never help", async () => {
  // RFC 2606 reserved TLD — guaranteed never to resolve, a real (not mocked) NXDOMAIN/ENOTFOUND.
  const result = await discoverCompanySource("https://this-definitely-does-not-exist-xyz123456.invalid/");
  assert.equal(result.status, "UNRESOLVED", "a hard DNS failure must not be classified as retryable");
});

test("discoverCompanySource: pages/depth bounds are enforced — a long link chain is truncated, never an unbounded crawl", async () => {
  const { url, close, requestCount } = await startServer((req, res) => {
    const n = Number((req.url ?? "/0").replace("/", "") || "0");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page(`<a href="/${n + 1}">Careers ${n + 1}</a>`));
  });
  try {
    const result = await discoverCompanySource(`${url}/0`, { allowPrivateNetworksForTests: true });
    // Never resolves an ATS (there isn't one) — must stop well short of following all 50 hops.
    assert.equal(result.status, "GENERIC_SUPPORTED");
    assert.ok(requestCount() <= 3, `expected at most 3 requests, got ${requestCount()}`);
  } finally {
    await close();
  }
});
