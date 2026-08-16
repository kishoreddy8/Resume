import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { discoverCompanySourceV2, readContentBounded, validateCandidate } from "../discoveryV2";
import type { DiscoveryV2Candidate } from "../discoveryV2";
import { sameRegistrableDomain } from "../sourceRediscovery";
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
    foundOnPage: "seed", validationStatus: "NOT_ATTEMPTED", jobsSeen: 0, confidence: "LOW", recommendation: "NO_REPLACEMENT_FOUND",
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

// --- Stage 2: two-hop historical fixtures (Phase 10) ----------------------------------------------
// Same six companies, now modeling the realistic homepage -> careers link -> hidden ATS shape the
// Stage-1 single-page fixtures above deliberately did NOT cover (the ATS was always already on the
// seed page there). Never a live-site dependency.

test("historical fixture (two-hop) — Docusign: homepage links to /careers, Greenhouse only found via network fetch on the second page", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><div id="careers-root">Loading…</div><script>
        fetch("https://boards-api.greenhouse.io/v1/boards/docusign/jobs?content=true").catch(function(){});
      </script></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate, "must follow the single careers link and find the ATS only reachable from there");
  assert.equal(candidate!.boardToken, "docusign");
  assert.equal(candidate!.foundOnPage, "followed");
  assert.equal(result.pagesVisited, 2);
});

test("historical fixture (two-hop) — Chewy: homepage links to /jobs, Greenhouse embed script only on the second page", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/jobs">Open Positions</a></body></html>`);
    } else if (req.url === "/jobs") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><script src="https://boards.greenhouse.io/embed/job_board/js?for=chewy"></script></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "chewy");
  assert.equal(result.pagesVisited, 2);
});

test("historical fixture (two-hop) — Roblox: homepage -> careers page -> Lever anchor", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Join Our Team</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.lever.co/roblox">Search Jobs</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "lever");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "roblox");
  assert.equal(result.followedCareersUrl, `${url}/careers`);
});

test("historical fixture (two-hop) — Salesforce: homepage -> careers page -> Ashby iframe", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><iframe src="/embed"></iframe></body></html>`);
    } else if (req.url === "/embed") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.ashbyhq.com/salesforce">Open Roles</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "ashby");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "salesforce");
  assert.ok(candidate!.evidenceTypes.includes("IFRAME"));
});

test("historical fixture (two-hop) — PayPal: homepage -> careers page -> network-only Workday CXS call", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><div id="app"></div><script>
        fetch("https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs").catch(function(){});
      </script></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "workday");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "paypal|wd1|jobs");
});

test("historical fixture (two-hop) — Adobe: homepage -> careers page, anchor + duplicate CXS network call collapse across pages", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body>
        <a href="https://adobe.wd5.myworkdayjobs.com/external_career_site">Careers</a>
        <script>fetch("https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_career_site/jobs").catch(function(){});</script>
      </body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const workdayCandidates = result.candidates.filter((c) => c.provider === "workday" && c.boardToken === "adobe|wd5|external_career_site");
  assert.equal(workdayCandidates.length, 1);
  assert.ok(workdayCandidates[0].evidenceTypes.includes("STATIC_HTML"));
  assert.ok(workdayCandidates[0].evidenceTypes.includes("NETWORK_REQUEST"));
});

// --- Stage 2: bounded careers-link navigation (Phase 9) --------------------------------------------

test("1. homepage -> /careers -> Workday", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://onehop.wd1.myworkdayjobs.com/External">Search Jobs</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "workday");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "onehop|wd1|External");
});

test("2. homepage -> /jobs -> Greenhouse", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/jobs">Jobs</a></body></html>`);
    } else if (req.url === "/jobs") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://boards.greenhouse.io/twohop">All Jobs</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "twohop");
});

test("3. homepage -> careers page -> Lever", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Open Positions</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.lever.co/threehop">View Jobs</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "lever");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "threehop");
});

test("4. homepage -> careers page -> Ashby iframe", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><iframe src="/embed-ashby"></iframe></body></html>`);
    } else if (req.url === "/embed-ashby") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.ashbyhq.com/fourhop">Open Roles</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "ashby");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "fourhop");
});

test("5. homepage -> careers page -> network-only Workday", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><script>fetch("https://fivehop.wd1.myworkdayjobs.com/wday/cxs/fivehop/External/jobs").catch(function(){});</script></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "workday");
  assert.ok(candidate);
  assert.equal(candidate!.boardToken, "fivehop|wd1|External");
});

test("6. seed already contains a structured candidate -> no second page is ever visited", async () => {
  const { url, requestLog } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://boards.greenhouse.io/directhit">Careers</a><a href="/careers">Also careers</a></body></html>`);
    } else {
      // Must never be hit — a candidate was already found on the seed page.
      res.writeHead(500); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.pagesVisited, 1);
  assert.equal(result.followedCareersUrl, null);
  assert.deepEqual(requestLog, ["/"]);
});

test("7. maximum one careers link is ever followed, even if the second page ALSO has an unrelated careers-shaped link", async () => {
  const { url, requestLog } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      // No ATS here, but ANOTHER careers-shaped link — must not be followed (would be a 2nd hop).
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers/more">View More Openings</a></body></html>`);
    } else {
      res.writeHead(500); res.end(); // a 3rd page must never be requested
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.pagesVisited, 2);
  assert.deepEqual(requestLog.filter((r) => r !== "/favicon.ico"), ["/", "/careers"]);
});

test("8. no recursive crawl: a careers link found only on the FOLLOWED page is never itself followed", async () => {
  // Same scenario as test 7, phrased around the explicit "no recursive crawl" requirement.
  const { url, requestLog } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers/deeper">Search More Jobs</a></body></html>`);
    } else {
      res.writeHead(500); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.outcome === "STRUCTURED_CANDIDATE_FOUND", false);
  assert.ok(!requestLog.includes("/careers/deeper"), "the second page's own careers link must never be followed — that would be a second hop");
});

test("9. an unrelated external careers link is never automatically followed", async () => {
  const { url, requestLog } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><a href="https://jobs.unrelated-external-domain.invalid/careers">Search Jobs</a></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.followedCareersUrl, null, "a cross-domain link must never be auto-followed");
  assert.equal(result.pagesVisited, 1);
  assert.deepEqual(requestLog, ["/"]);
});

test("10. a same-registrable-domain careers link IS allowed to be followed", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.lever.co/samedomainco">Search Jobs</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.followedCareersUrl, `${url}/careers`);
  assert.equal(result.pagesVisited, 2);
});

test("11. a careers subdomain is recognized as the same first-party company (unit-level: sameRegistrableDomain)", () => {
  assert.equal(sameRegistrableDomain("careers.example.com", "example.com"), true);
  assert.equal(sameRegistrableDomain("jobs.example.com", "www.example.com"), true);
  assert.equal(sameRegistrableDomain("careers.example.com", "unrelated-other-company.com"), false);
});

test("12. an unsafe careers link (disallowed scheme) is rejected, never navigated", async () => {
  // Uses a disallowed SCHEME rather than a private-IP literal: isUrlSafeForNavigation's scheme check
  // runs BEFORE the allowPrivateNetworksForTests bypass (see safeFetch.ts's assertSafeUrl), so this
  // is the one rejection that's still genuinely exercised while allowPrivateNetworksForTests:true is
  // needed for the local test server's own 127.0.0.1 seed URL to be reachable at all — matching the
  // exact same pattern Stage 1's own SSRF test (discoveryV2.test.ts test 11) already established.
  const { url, requestLog } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><a href="ftp://evil.example/careers">Careers Portal</a></body></html>`);
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.equal(result.followedCareersUrl, null);
  assert.deepEqual(requestLog, ["/"]);
});

test("13. a PDF seed URL is handled without ever launching a browser crawl against it", async () => {
  const company = makeCompany();
  const started = Date.now();
  const result = await discoverCompanySourceV2(company, "https://example.invalid/careers/EEOC_KnowYourRights.pdf", { allowPrivateNetworksForTests: true, validator: passingValidator });
  const elapsed = Date.now() - started;
  assert.equal(result.outcome, "INVALID_SEED_RESOURCE");
  assert.ok(elapsed < 500, `must return near-instantly with no browser/network launch at all for an obviously non-HTML seed, took ${elapsed}ms`);
});

test("14. duplicate candidates found across page 1 AND page 2 collapse into one candidate", async () => {
  // A candidate can only actually be found on page 2 alone in practice (page 1 finding one stops
  // navigation before page 2 is ever visited) — this proves the SHARED dedup map correctly handles
  // the same board being referenced multiple times WITHIN the followed page itself, using the exact
  // same collapsing logic that would apply across pages if evidence ever did span both.
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body>
        <a href="https://boards.greenhouse.io/duponpage2">Careers</a>
        <script>fetch("https://boards-api.greenhouse.io/v1/boards/duponpage2/jobs").catch(function(){});</script>
      </body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const matches = result.candidates.filter((c) => c.provider === "greenhouse" && c.boardToken === "duponpage2");
  assert.equal(matches.length, 1);
});

test("15. candidate evidence preserves WHICH page (seed vs followed) produced the signal", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://boards.greenhouse.io/pagelabel">Careers</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate);
  assert.equal(candidate!.foundOnPage, "followed");
});

test("16. the observed-request bound applies across BOTH pages combined, not reset per page", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body>no ats here</body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.ok(result.observedRequestCount <= 200, "must never exceed the shared MAX_V2_OBSERVED_REQUESTS cap across the whole attempt");
});

test("17. the redirect-chain bound applies across BOTH pages combined", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body>no ats here</body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.ok(result.redirectChain.length <= 10, "must never exceed the shared MAX_V2_REDIRECT_CHAIN cap across the whole attempt");
});

test("18. the overall wall-clock budget applies across BOTH pages combined, not per page", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body>no ats here</body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.ok(result.durationMs < 40_000, "the whole two-page attempt must stay within the shared overall budget");
});

test("19. a page with continuous background requests (never goes network-idle) does not hang the whole attempt", async () => {
  // Simulates Under Armour/Microsoft's real Stage-1 timeout pattern: a page that keeps firing
  // requests indefinitely (analytics/telemetry-style polling) never reaches Playwright's
  // "networkidle" state — proving the domcontentloaded + bounded-grace fix resolves in well under
  // the old guaranteed-15s-timeout behavior.
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a><script>
        setInterval(function() { fetch("/ping?" + Date.now()).catch(function(){}); }, 200);
      </script></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://boards.greenhouse.io/pollingco">Careers</a><script>
        setInterval(function() { fetch("/ping?" + Date.now()).catch(function(){}); }, 200);
      </script></body></html>`);
    } else if (req.url?.startsWith("/ping")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
    } else {
      res.writeHead(404); res.end();
    }
  });
  const started = Date.now();
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20_000, `must resolve well under the old guaranteed-15s-per-page timeout even with continuous background polling, took ${elapsed}ms`);
  const candidate = result.candidates.find((c) => c.provider === "greenhouse");
  assert.ok(candidate, "must still find the real candidate despite the page never going fully idle");
});

test("19b. a hanging content() read (real production hang: Under Armour, a cross-origin iframe whose execution context never settled) resolves within the bounded timeout instead of hanging forever", async () => {
  const neverResolves = { content: () => new Promise<string>(() => {}) };
  const started = Date.now();
  const result = await readContentBounded(neverResolves);
  const elapsed = Date.now() - started;
  assert.equal(result, null, "a timed-out content() read must resolve to null, not throw or hang");
  assert.ok(elapsed < 6_000, `must resolve well within the bounded V2_CONTENT_READ_TIMEOUT_MS window, took ${elapsed}ms`);
});

test("20. browser closes cleanly even when the second (followed) page navigation fails", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      // Hang forever — never res.end() — simulates the followed page itself failing to load.
      return;
    } else {
      res.writeHead(404); res.end();
    }
  });
  const result = await discoverCompanySourceV2(makeCompany(), url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  // The seed page's own signals (none here) still resolve honestly; the failed second page must not
  // throw or hang the whole attempt.
  assert.notEqual(result.outcome, "STRUCTURED_CANDIDATE_FOUND");
});

test("21. zero DB mutation is possible from this call shape (Company object never mutated across a two-page attempt)", async () => {
  const company = makeCompany();
  const snapshot = { ...company };
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://boards.greenhouse.io/nomutation">Careers</a></body></html>`);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await discoverCompanySourceV2(company, url, { allowPrivateNetworksForTests: true, validator: passingValidator });
  assert.deepEqual(company, snapshot);
});
