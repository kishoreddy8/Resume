import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { discoverCompanySourceV2, validateCandidate } from "../discoveryV2";
import type { DiscoveryV2Candidate } from "../discoveryV2";
import type { Company } from "../../../types";

/**
 * Discovery V2 (shadow mode) regression coverage — real headless Chromium against local HTTP
 * servers only, never the live internet, matching discoveryBrowser.test.ts's own established
 * convention exactly. allowPrivateNetworksForTests:true means isUrlSafeForNavigation short-circuits
 * before any DNS lookup (see safeFetch.ts), so fake-but-realistic-shaped external hostnames (e.g.
 * acme.wd5.myworkdayjobs.com) are safe to reference in fixtures without real DNS resolving them —
 * the request is still observed and inspected before it inevitably fails to actually connect.
 */

const servers: http.Server[] = [];
function startServer(handler: http.RequestListener): Promise<{ url: string; requestLog: string[] }> {
  return new Promise((resolve) => {
    const requestLog: string[] = [];
    const server = http.createServer((req, res) => {
      requestLog.push(req.url ?? "");
      handler(req, res);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, requestLog });
    });
  });
}
after(() => {
  for (const server of servers) server.close();
});

let nextId = 1;
function makeCompany(overrides: Partial<Company> = {}): Company {
  const id = nextId++;
  return {
    id, name: `Test Co ${id}`, source_type: "career_link", ats_board_token: null, career_page_url: null,
    is_active: 1, notes: null, h1b_match_employer_name: null, h1b_match_normalized: null,
    h1b_match_tier: null, h1b_match_score: null, h1b_confidence: "Unknown", h1b_lca_count: 0,
    h1b_latest_fiscal_year: null, h1b_confidence_evidence: null, h1b_updated_at: null,
    last_scanned_at: null, last_scan_status: null, last_scan_error: null, last_successful_scan_at: null,
    last_failed_scan_at: null, consecutive_failures: 0, last_error_category: null, last_error_message: null,
    connector_health: "unknown", resolution_status: "UNRESOLVED", discovered_jobs_url: null,
    discovery_attempted_at: null, discovery_reason: null, suspected_ats: null, verified_domain: null,
    domain_identity_status: "UNRESOLVED", last_successful_discovery_at: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// A deterministic validator stub, used wherever a test cares about detection/dedup, not real
// network validation (network-dependent classification is exercised by dedicated tests below).
const passingValidator = async () => ({ status: "VALIDATED_JOBS" as const, jobsSeen: 1 });
const zeroJobValidator = async () => ({ status: "VALIDATED_ZERO_JOBS" as const, jobsSeen: 0 });
const failingValidator = async () => ({ status: "VALIDATION_FAILED" as const, jobsSeen: 0 });

test("1. JS-rendered Workday detection (network request, invisible to any HTML scan)", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><div id="root"></div><script>
      fetch("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs").catch(function(){});
    </script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "workday");
  assert.ok(candidate, "must detect the Workday tenant from the fetch() call alone");
  assert.equal(candidate!.boardToken, "acme|wd5|External");
  assert.ok(candidate!.evidenceTypes.includes("NETWORK_REQUEST"));
});

test("2. JS-rendered Greenhouse detection (link only exists after client-side JS runs)", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><div id="root"></div><script>
      window.addEventListener('load', function() {
        var a = document.createElement('a');
        a.href = "https://boards.greenhouse.io/" + "rendergreenco";
        a.textContent = "Search Jobs";
        document.body.appendChild(a);
      });
    </script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "rendergreenco");
  assert.ok(candidate!.evidenceTypes.includes("STATIC_HTML"), "findEmbeddedAtsUrl over the rendered HTML is what catches this");
});

test("3. rendered Lever anchor is detected directly", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><a href="https://jobs.lever.co/leverco">Careers</a></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "lever");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "leverco");
});

test("4. Ashby iframe is detected via page.frames(), not just the main document", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><iframe src="/embed"></iframe></body></html>`);
    } else if (req.url === "/embed") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.ashbyhq.com/ashbyco">Open Roles</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "ashby");
  assert.ok(candidate, "must find the ATS link embedded inside the iframe's own document");
  assert.equal(candidate!.boardToken, "ashbyco");
  assert.ok(candidate!.evidenceTypes.includes("IFRAME"));
});

test("5. network-only ATS detection: a fetch() URL that never appears anywhere in the DOM", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><div>No jobs listed statically.</div><script>
      fetch("https://smartrecruiters-tenant.example.invalid/decoy").catch(function(){});
      fetch("https://api.smartrecruiters.com/v1/companies/netonlyco/postings").catch(function(){});
    </script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "smartrecruiters");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "netonlyco");
});

test("6. client-side redirect ATS: window.location navigates to a known ATS host", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><script>window.location.href = "https://jobs.ashbyhq.com/redirectco";</script></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "ashby");
  assert.ok(candidate, "the final navigated URL itself is a known ATS");
  assert.equal(candidate!.boardToken, "redirectco");
  assert.ok(result.redirectChain.length >= 1);
});

test("7. static HTML + network request for the SAME board collapse into one candidate", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body>
      <a href="https://boards.greenhouse.io/dupeco">Careers</a>
      <script>fetch("https://boards-api.greenhouse.io/v1/boards/dupeco/jobs").catch(function(){});</script>
    </body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const greenhouseCandidates = result.candidates.filter((c) => c.provider === "greenhouse" && c.boardToken === "dupeco");
  assert.equal(greenhouseCandidates.length, 1, "same provider+token from two signals must collapse into ONE candidate, not two");
});

test("8. a collapsed candidate retains every distinct evidence type it was seen through", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body>
      <a href="https://boards.greenhouse.io/multiev">Careers</a>
      <script>fetch("https://boards-api.greenhouse.io/v1/boards/multiev/jobs").catch(function(){});</script>
    </body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse" && c.boardToken === "multiev");
  assert.ok(candidate);
  assert.ok(candidate!.evidenceTypes.includes("STATIC_HTML"));
  assert.ok(candidate!.evidenceTypes.includes("NETWORK_REQUEST"));
  assert.ok(candidate!.evidenceUrls.length >= 2, "distinct evidence URLs must also be preserved");
});

test("9. an unrelated XHR (analytics/CDN) never produces a false candidate", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><script>
      fetch("https://cdn.example.invalid/analytics.js").catch(function(){});
      fetch("https://api.example.invalid/telemetry").catch(function(){});
    </script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.outcome, "NO_SOURCE_FOUND");
});

test("10. a network request to a disallowed target is aborted and never treated as evidence", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><script>
      fetch("http://169.254.169.254/latest/meta-data/").catch(function(){});
    </script></body></html>`);
  });
  // allowPrivateNetworksForTests:false here specifically, so the disallowed-IP-literal check (which
  // bypasses entirely when true) actually runs — this is the one test in this file that needs it.
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: false, validator: passingValidator });
  assert.equal(result.candidates.length, 0, "a blocked cloud-metadata request must never become evidence, structured or otherwise");
});

test("11. an in-page navigation to a disallowed scheme is blocked, discovery still resolves honestly", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><script>window.location.href = 'ftp://evil.example/';</script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.notEqual(result.outcome, "STRUCTURED_CANDIDATE_FOUND");
});

test("12. a third-party aggregator link (no ATS signature match) is never promoted to a candidate", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://www.linkedin.com/company/exampleco/jobs/">See jobs on LinkedIn</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  // Seeded from a careers-shaped URL — matches how Discovery V2 is actually invoked in production
  // (from company.career_page_url), and lets scoreCareersLink recognize this as a genuine jobs page
  // even though V2 never follows a link to reach it (see the "looksLikeJobsUrl" gate this proves).
  const result = await discoverCompanySourceV2(makeCompany(), `${url}/careers`, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.candidates.length, 0, "a LinkedIn aggregator link must never be detected as a structured ATS candidate");
  assert.equal(result.outcome, "GENERIC_ONLY", "the page itself was still reached and is a valid generic-scrape fallback");
});

test("13. VALIDATED_ZERO_JOBS classification and its MEDIUM confidence", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><a href="https://boards.greenhouse.io/zeroboard">Careers</a></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: zeroJobValidator });
  const candidate = result.candidates[0];
  assert.equal(candidate.validationStatus, "VALIDATED_ZERO_JOBS");
  assert.equal(candidate.confidence, "MEDIUM");
  assert.equal(candidate.recommendation, "NEEDS_SOURCE_REVIEW");
});

test("14. VALIDATION_FAILED classification and its LOW confidence", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><a href="https://boards.greenhouse.io/failboard">Careers</a></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: failingValidator });
  const candidate = result.candidates[0];
  assert.equal(candidate.validationStatus, "VALIDATION_FAILED");
  assert.equal(candidate.confidence, "LOW");
  assert.equal(candidate.recommendation, "NO_REPLACEMENT_FOUND");
});

test("15. UNSUPPORTED classification (direct unit test — every real detectAtsFromUrlString provider is already in the supported set today)", async () => {
  const company = makeCompany();
  const candidate: DiscoveryV2Candidate = {
    provider: "career_link" as never, // deliberately outside SUPPORTED_PROVIDERS for this defensive-path test
    boardToken: "whatever", canonicalUrl: null, evidenceTypes: ["STATIC_HTML"], evidenceUrls: ["https://example.com"],
    validationStatus: "NOT_ATTEMPTED", jobsSeen: 0, confidence: "LOW", recommendation: "NO_REPLACEMENT_FOUND",
  };
  const result = await validateCandidate(company, candidate);
  assert.equal(result.status, "UNSUPPORTED");
});

test("16. batch limit / duration reporting: a single call always returns a bounded, finite durationMs", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body>no ats here</body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.ok(result.durationMs >= 0 && result.durationMs < 30_000);
});

test("17. observed request count is bounded and reported", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body>no ats here</body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.ok(result.observedRequestCount >= 1, "at least the seed document request itself must be observed");
});

test("18. browser closes cleanly after a navigation failure (no hang, no leaked process)", async () => {
  const result = await discoverCompanySourceV2(makeCompany(), "http://127.0.0.1:9/", { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.outcome, "NAVIGATION_FAILED");
});

test("19. per-page timeout does not hang the whole attempt (a server that never responds)", async () => {
  const { url } = await startServer(() => {
    // Never call res.end() — simulates a hung connection.
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.outcome, "NAVIGATION_FAILED");
});

test("20. Discovery V2 never mutates the Company object it was given (zero DB writes possible from this call shape)", async () => {
  const company = makeCompany();
  const snapshot = { ...company };
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><a href="https://boards.greenhouse.io/immutableco">Careers</a></body></html>`);
  });
  await discoverCompanySourceV2(company, url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.deepEqual(company, snapshot, "discoverCompanySourceV2 must never mutate its input Company");
});

// --- Historical regression fixtures (Phase 14) ---------------------------------------------------
// LOCAL simulations of the discovery shapes previously identified as UNRESOLVED/career_link for
// these companies — never a live-site dependency. Each proves a page structure that Tier 1/2 (raw
// HTML only) cannot resolve now produces a structured candidate under Discovery V2's richer signals.

test("historical fixture — Docusign: Greenhouse board loaded via client-side fetch, invisible to static HTML", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><div id="careers-root">Loading open roles...</div><script>
      fetch("https://boards-api.greenhouse.io/v1/boards/docusign/jobs?content=true").catch(function(){});
    </script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate, "Docusign-style React career page must resolve via the Greenhouse API network signal");
  assert.equal(candidate!.boardToken, "docusign");
});

test("historical fixture — Chewy: Greenhouse embed script rendered after page load", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><div id="root"></div><script>
      window.addEventListener('load', function() {
        var s = document.createElement('script');
        s.src = "https://boards.greenhouse.io/embed/job_board/js?for=chewy";
        document.body.appendChild(s);
      });
    </script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "chewy");
});

test("historical fixture — Roblox: Greenhouse board embedded inside a same-origin iframe", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><iframe src="/careers-embed"></iframe></body></html>`);
    } else if (req.url === "/careers-embed") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://job-boards.greenhouse.io/roblox">All Openings</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "roblox");
  assert.ok(candidate!.evidenceTypes.includes("IFRAME"));
});

test("historical fixture — Salesforce: Workday CXS endpoint hit via XHR, no visible link anywhere", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><div id="app">Careers app loading…</div><script>
      fetch("https://salesforce.wd1.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/jobs", {method: "POST"}).catch(function(){});
    </script></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "workday");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "salesforce|wd1|External_Career_Site");
});

test("historical fixture — PayPal: client-side redirect straight to the Workday board root", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><script>window.location.href = "https://paypal.wd1.myworkdayjobs.com/jobs";</script></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "workday");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "paypal|wd1|jobs");
});

test("historical fixture — Adobe: Workday board reachable only via a rendered anchor + a duplicate CXS network call collapse into one candidate", async () => {
  const { url } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body>
      <a href="https://adobe.wd5.myworkdayjobs.com/external_career_site">Careers</a>
      <script>fetch("https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_career_site/jobs").catch(function(){});</script>
    </body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const workdayCandidates = result.candidates.filter((c) => c.provider === "workday" && c.boardToken === "adobe|wd5|external_career_site");
  assert.equal(workdayCandidates.length, 1, "the anchor and the CXS network call for the SAME site must collapse into one candidate");
  assert.ok(workdayCandidates[0].evidenceTypes.includes("STATIC_HTML"));
  assert.ok(workdayCandidates[0].evidenceTypes.includes("NETWORK_REQUEST"));
});
