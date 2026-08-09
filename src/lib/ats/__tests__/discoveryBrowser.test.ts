import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { discoverCompanySource } from "@/lib/ats/discovery";
import { discoverCompanySourceBrowser, discoverCompanySourceWithBrowserFallback } from "@/lib/ats/discoveryBrowser";

/**
 * Tier 3 (browser-rendered fallback) regression coverage — real headless Chromium against local
 * HTTP servers only, never the live internet. See discoveryBrowser.ts's own module doc comment for
 * the exact bounds/safety model being proven here.
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

// Splits the target URL into pieces JOINED AT RUNTIME (window.atob/string concatenation) rather
// than ever appearing as one contiguous "https://..." token anywhere in the raw HTTP response —
// Tier 1/2's findEmbeddedAtsUrl scans the WHOLE raw document text for any such contiguous token
// (including inside inline <script> source), so a naively-embedded literal string would be found
// by Tier 1/2 too, defeating the point of this test. Only after the browser actually EXECUTES this
// script and inserts the reassembled URL into a real DOM attribute does it become a contiguous,
// findable token — exactly the JS-hidden-ATS scenario Tier 3 exists to solve.
function jsRenderedPage(hrefParts: string[], linkText: string): string {
  const partsLiteral = hrefParts.map((p) => JSON.stringify(p)).join(" + ");
  return `<html><body><div id="root"></div><script>
    window.addEventListener('load', function() {
      var href = ${partsLiteral};
      var a = document.createElement('a');
      a.href = href;
      a.textContent = ${JSON.stringify(linkText)};
      document.getElementById('root').appendChild(a);
    });
  </script></body></html>`;
}

test("Tier 3 finds an ATS link that only exists after client-side JS renders it — invisible to Tier 1/2", async () => {
  const { url } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(jsRenderedPage(["https://boards.greenhouse.io/", "exampleco"], "Search Jobs"));
  });

  const httpOnly = await discoverCompanySource(url, { allowPrivateNetworksForTests: true });
  assert.equal(httpOnly.status, "UNRESOLVED", "raw HTML has no anchors at all — Tier 1/2 must not find anything");

  const withBrowser = await discoverCompanySourceBrowser(url, { allowPrivateNetworksForTests: true });
  assert.equal(withBrowser.status, "VERIFIED");
  assert.equal(withBrowser.sourceType, "greenhouse");
  assert.equal(withBrowser.atsBoardToken, "exampleco");
});

test("discoverCompanySourceWithBrowserFallback: Tier 3 is skipped entirely when Tier 1/2 already resolves", async () => {
  const { url } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><a href="https://boards.greenhouse.io/exampleco">Careers</a></body></html>`);
  });

  const result = await discoverCompanySourceWithBrowserFallback(url, { allowPrivateNetworksForTests: true });
  assert.equal(result.status, "VERIFIED");
  assert.ok(!result.reason.includes("[Browser]"), "must resolve via Tier 1/2 (safeFetch), never touching the browser tier at all");
});

test("read-only-first: resolves from the rendered seed page alone, no click ever needed", async () => {
  const { requestLog } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.ashbyhq.com/exampleco">Open Positions</a></body></html>`);
    } else {
      // If Tier 3 ever tried to follow a link (it shouldn't need to — the ATS is already on the
      // seed page), it would hit this and fail loudly rather than silently succeeding.
      res.writeHead(500);
      res.end();
    }
  });
  const serverInfo = servers[servers.length - 1];
  const address = serverInfo.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const result = await discoverCompanySourceBrowser(url, { allowPrivateNetworksForTests: true });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "ashby");
  assert.deepEqual(requestLog, ["/"], "no second page was ever requested — resolved from passive inspection of the seed page alone");
});

test("bounded click: a chain requiring MORE than one followed link does not fully resolve via Tier 3", async () => {
  const { url } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers">Careers</a></body></html>`);
    } else if (req.url === "/careers") {
      // The ATS link is TWO hops from the seed — beyond Tier 3's strict "at most 1 click" bound.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="/careers/search-jobs">Search Jobs</a></body></html>`);
    } else if (req.url === "/careers/search-jobs") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><a href="https://jobs.lever.co/exampleco">Data Engineer</a></body></html>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const result = await discoverCompanySourceBrowser(url, { allowPrivateNetworksForTests: true });
  assert.notEqual(result.status, "VERIFIED", "the ATS link is two hops away — one bounded click must not be enough to reach it");
});

test("SSRF: a loopback seed URL is refused BEFORE the browser ever launches", async () => {
  const result = await discoverCompanySourceBrowser("http://127.0.0.1:9/", { allowPrivateNetworksForTests: false });
  assert.equal(result.status, "UNRESOLVED");
  assert.match(result.reason, /unsafe/i);
});

test("SSRF: an in-browser navigation attempt to a disallowed scheme is blocked, not just the seed URL", async () => {
  // ftp:// is rejected by isUrlSafeForNavigation regardless of allowPrivateNetworksForTests (the
  // scheme check happens before that bypass) — proving page.route's per-navigation interception is
  // actually wired up and independently enforced, not just the one-time seed-URL pre-check.
  const { url } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body><script>window.location.href = 'ftp://evil.example/';</script></body></html>`);
  });

  const result = await discoverCompanySourceBrowser(url, { allowPrivateNetworksForTests: true });
  // The blocked navigation should never crash/hang the whole attempt — it just finds nothing on
  // the (still-loaded) seed page and resolves honestly.
  assert.notEqual(result.status, "VERIFIED");
});
