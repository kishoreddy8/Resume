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

test("discoverCompanySource: a direct recognized-but-unsupported ATS URL resolves NEEDS_ADAPTER, not UNRESOLVED", async () => {
  const result = await discoverCompanySource("https://jobs.smartrecruiters.com/ExampleCo");
  assert.equal(result.status, "NEEDS_ADAPTER");
  assert.equal(result.suspectedAts, "SmartRecruiters");
  assert.equal(result.sourceType, null);
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
