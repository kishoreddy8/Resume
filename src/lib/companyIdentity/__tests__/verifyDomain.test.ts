import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { verifyDomainIdentity } from "@/lib/companyIdentity/verifyDomain";

// verifyDomainIdentity always fetches `https://{domain}/` in production. Tests instead use
// rootUrlOverride (the same test-only hostOverride pattern every ATS connector already uses) to
// point the actual fetch at a local plain-HTTP server, while `domain` stays a cosmetic value
// recorded on a VERIFIED result — exactly mirroring how workday.ts/greenhouse.ts's own tests work.
function startServer(handler: http.RequestListener): Promise<{ rootUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ rootUrl: `http://127.0.0.1:${port}/`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function html(body: string): string {
  return `<html><body>${body}</body></html>`;
}

test("Path B: two distinct matching first-party channels (JSON-LD + footer) -> VERIFIED, medium confidence", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        html(
          `<script type="application/ld+json">{"@type":"Organization","legalName":"Acme Technologies Inc"}</script>` +
            `<footer>© 2026 Acme Technologies Inc. All rights reserved</footer>`
        )
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.method, "generated_verified_multisignal");
    assert.equal(result.confidence, "medium");
    assert.equal(result.channelsChecked.jsonLd, "match");
    assert.equal(result.channelsChecked.footer, "match");
  } finally {
    await close();
  }
});

test("a generated domain candidate that does not exist (NXDOMAIN) -> UNRESOLVED, not FAILED_TEMPORARY", async () => {
  // No rootUrlOverride — this genuinely resolves `domain` via real DNS. RFC 2606 reserved TLD,
  // guaranteed never to exist, so this is deterministic (not a mocked failure).
  const result = await verifyDomainIdentity({
    domain: "this-definitely-does-not-exist-xyz123456.invalid",
    employerNameRaw: "Some Employer",
  });
  assert.equal(result.status, "UNRESOLVED", "a hostname that will never resolve must not be retried as FAILED_TEMPORARY");
});

test("a transient network failure (connection refused) at the homepage fetch -> FAILED_TEMPORARY, unchanged by the DNS-classification fix", async () => {
  const result = await verifyDomainIdentity({
    domain: "test.example",
    rootUrlOverride: "http://127.0.0.1:1/", // nothing listening -> ECONNREFUSED -> network_error (transient)
    employerNameRaw: "Some Employer",
    allowPrivateNetworksForTests: true,
  });
  assert.equal(result.status, "FAILED_TEMPORARY");
});

test("only ONE strong channel matching (no second corroborating channel) -> UNRESOLVED", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(`<script type="application/ld+json">{"@type":"Organization","legalName":"Acme Technologies Inc"}</script>`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    assert.equal(result.status, "UNRESOLVED");
    assert.equal(result.channelsChecked.jsonLd, "match");
  } finally {
    await close();
  }
});

test("HTTP 200 + only a loose title mention (not a structured channel match) -> UNRESOLVED", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>Welcome to Acme</title></head><body>We build things.</body></html>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    assert.equal(result.status, "UNRESOLVED");
    assert.equal(result.channelsChecked.jsonLd, "no_match");
    assert.equal(result.channelsChecked.footer, "no_match");
  } finally {
    await close();
  }
});

test("conflicting identity: footer names a genuinely different legal entity -> AMBIGUOUS, never VERIFIED", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        html(
          `<script type="application/ld+json">{"@type":"Organization","legalName":"Acme Technologies Inc"}</script>` +
            `<footer>© 2026 Globex Corporation. All rights reserved</footer>`
        )
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    assert.equal(result.status, "AMBIGUOUS");
    assert.equal(result.channelsChecked.jsonLd, "match");
    assert.equal(result.channelsChecked.footer, "conflict");
  } finally {
    await close();
  }
});

test("unrelated but reachable domain -> UNRESOLVED", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html(`<footer>© 2026 Totally Different Company LLC</footer>`));
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    assert.notEqual(result.status, "VERIFIED");
  } finally {
    await close();
  }
});

test("parking page -> UNRESOLVED, Step C never runs (all channels not_checked)", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html(`This domain is for sale. Buy this domain today!`));
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    assert.equal(result.status, "UNRESOLVED");
    assert.equal(result.channelsChecked.jsonLd, "not_checked");
  } finally {
    await close();
  }
});

test("About and Terms/Privacy resolving to the identical page count as ONE channel, not two", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(`<a href="/legal-hub">info</a>`));
    } else if (req.url === "/about" || req.url === "/terms") {
      // Both About and Terms/Privacy redirect to the SAME underlying page.
      res.writeHead(302, { Location: "/legal-hub" });
      res.end();
    } else if (req.url === "/legal-hub") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(`<footer>© 2026 Acme Technologies Inc.</footer>`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    // Only ONE real distinct channel matched (the shared /legal-hub page, reached via both /about
    // and /terms) -> insufficient for Path B (needs >=2 DISTINCT channels) -> UNRESOLVED.
    assert.equal(result.status, "UNRESOLVED");
  } finally {
    await close();
  }
});

test("careers/ATS discovery is never invoked by verifyDomainIdentity — careersEvidence is always null", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        html(
          `<script type="application/ld+json">{"@type":"Organization","legalName":"Acme Technologies Inc"}</script>` +
            `<footer>© 2026 Acme Technologies Inc.</footer>`
        )
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({ domain: "test.example",
      rootUrlOverride: rootUrl, employerNameRaw: "Acme Technologies Inc", allowPrivateNetworksForTests: true });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.careersEvidence, null, "verifyDomainIdentity must never gate on or populate careers evidence — that's additive, attached by the caller");
  } finally {
    await close();
  }
});

test("Wikidata authoritative signal alone (self-sufficient) -> VERIFIED, high confidence, even with zero first-party channels", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(`Just a plain homepage, no structured identity data at all.`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({
      domain: "test.example",
      rootUrlOverride: rootUrl,
      employerNameRaw: "Acme Technologies Inc",
      authoritative: { wikidataConfirmed: true },
      allowPrivateNetworksForTests: true,
    });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.method, "wikidata");
    assert.equal(result.confidence, "high");
  } finally {
    await close();
  }
});

test("SEC corroboration alone (no first-party channel) is NOT sufficient — needs >=1 combined channel match", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(`Plain homepage, no structured identity data.`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({
      domain: "test.example",
      rootUrlOverride: rootUrl,
      employerNameRaw: "Acme Technologies Inc",
      authoritative: { secConfirmed: true },
      allowPrivateNetworksForTests: true,
    });
    assert.notEqual(result.status, "VERIFIED", "SEC corroboration alone, with zero first-party evidence, must not verify");
  } finally {
    await close();
  }
});

test("SEC corroboration + exactly ONE first-party channel match -> VERIFIED, high confidence", async () => {
  const { rootUrl, close } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(`<footer>© 2026 Acme Technologies Inc.</footer>`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await verifyDomainIdentity({
      domain: "test.example",
      rootUrlOverride: rootUrl,
      employerNameRaw: "Acme Technologies Inc",
      authoritative: { secConfirmed: true },
      allowPrivateNetworksForTests: true,
    });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.method, "sec_corroborated");
    assert.equal(result.confidence, "high");
  } finally {
    await close();
  }
});
