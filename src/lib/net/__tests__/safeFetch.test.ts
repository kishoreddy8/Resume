import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { classifyDnsLookupError, isDisallowedIPv4, isDisallowedIPv6, safeFetch, SafeFetchError } from "@/lib/net/safeFetch";

// A reserved TLD (RFC 2606) — guaranteed to never resolve, real or forwarded resolver. Used for a
// deterministic, real (not mocked) NXDOMAIN/ENOTFOUND case, distinct from a synthetic-error unit test.
const GUARANTEED_NONEXISTENT_HOST = "this-definitely-does-not-exist-xyz123456.invalid";

// --- DNS failure classification (hard NXDOMAIN vs. transient resolver failure) -------------------

test("classifyDnsLookupError: ENOTFOUND (host does not exist) -> dns_hostname_not_found (hard)", () => {
  assert.equal(classifyDnsLookupError({ code: "ENOTFOUND" }), "dns_hostname_not_found");
});

test("classifyDnsLookupError: ENODATA (no records for host) -> dns_hostname_not_found (hard)", () => {
  assert.equal(classifyDnsLookupError({ code: "ENODATA" }), "dns_hostname_not_found");
});

test("classifyDnsLookupError: EAI_AGAIN (temporary resolver failure) -> dns_resolution_failed (transient)", () => {
  assert.equal(classifyDnsLookupError({ code: "EAI_AGAIN" }), "dns_resolution_failed");
});

test("classifyDnsLookupError: ETIMEDOUT (resolver timeout) -> dns_resolution_failed (transient)", () => {
  assert.equal(classifyDnsLookupError({ code: "ETIMEDOUT" }), "dns_resolution_failed");
});

test("classifyDnsLookupError: an unrecognized or missing code defaults to transient, never hard", () => {
  assert.equal(classifyDnsLookupError({ code: "SOME_UNKNOWN_CODE" }), "dns_resolution_failed");
  assert.equal(classifyDnsLookupError(new Error("plain error, no code")), "dns_resolution_failed");
  assert.equal(classifyDnsLookupError(null), "dns_resolution_failed");
});

test("safeFetch: a hostname the resolver authoritatively reports does not exist throws dns_hostname_not_found, not dns_resolution_failed (real DNS lookup, RFC 2606 .invalid TLD)", async () => {
  await assert.rejects(
    () => safeFetch(`https://${GUARANTEED_NONEXISTENT_HOST}/`),
    (err: unknown) => err instanceof SafeFetchError && err.reason === "dns_hostname_not_found"
  );
});

// --- Pure range-check unit tests ----------------------------------------------------------------

test("isDisallowedIPv4: loopback/private/link-local/reserved ranges are all disallowed", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "224.0.0.1", "240.0.0.1"]) {
    assert.equal(isDisallowedIPv4(ip), true, `${ip} should be disallowed`);
  }
});

test("isDisallowedIPv4: ordinary public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    assert.equal(isDisallowedIPv4(ip), false, `${ip} should be allowed`);
  }
});

test("isDisallowedIPv4: 172.16.0.0/12 boundary — 172.15.x.x and 172.32.x.x are outside the private block", () => {
  assert.equal(isDisallowedIPv4("172.15.255.255"), false);
  assert.equal(isDisallowedIPv4("172.32.0.0"), false);
});

test("isDisallowedIPv6: loopback/link-local/unique-local/IPv4-mapped-private are disallowed", () => {
  for (const ip of ["::1", "fe80::1", "fc00::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isDisallowedIPv6(ip), true, `${ip} should be disallowed`);
  }
});

test("isDisallowedIPv6: ordinary public addresses are allowed", () => {
  assert.equal(isDisallowedIPv6("2001:4860:4860::8888"), false);
});

// --- Scheme/host validation (no live server needed — rejected before any network call) ---------

test("safeFetch: rejects non-http(s) schemes", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x"]) {
    await assert.rejects(safeFetch(url), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "disallowed_scheme");
      return true;
    });
  }
});

test("safeFetch: rejects a malformed URL", async () => {
  await assert.rejects(safeFetch("not a url"), (err: unknown) => {
    assert.ok(err instanceof SafeFetchError);
    assert.equal(err.reason, "invalid_url");
    return true;
  });
});

test("safeFetch: rejects localhost/loopback/link-local hosts by default (no test bypass)", async () => {
  for (const url of ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/"]) {
    await assert.rejects(safeFetch(url, { timeoutMs: 2000 }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "disallowed_host");
      return true;
    });
  }
});

// --- Integration tests against a real local HTTP server -----------------------------------------
// Uses allowPrivateNetworksForTests to opt the *destination* check out (the server necessarily runs
// on loopback) while every other safeFetch behavior (redirects, size cap, timeout, revalidation of
// non-scheme checks) runs for real. Never set outside tests — see the option's own doc comment.

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test("safeFetch: fetches a plain 200 response and returns its body", async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello world");
  });
  try {
    const result = await safeFetch(url, { allowPrivateNetworksForTests: true });
    assert.equal(result.status, 200);
    assert.equal(result.bodyText, "hello world");
    assert.equal(result.finalUrl, `${url}/`);
  } finally {
    await close();
  }
});

test("safeFetch: follows a redirect chain and reports the final URL", async () => {
  const { url, close } = await startServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/middle" });
      res.end();
    } else if (req.url === "/middle") {
      res.writeHead(302, { Location: "/end" });
      res.end();
    } else if (req.url === "/end") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("arrived");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await safeFetch(`${url}/start`, { allowPrivateNetworksForTests: true });
    assert.equal(result.bodyText, "arrived");
    assert.equal(result.finalUrl, `${url}/end`);
  } finally {
    await close();
  }
});

test("safeFetch: a redirect chain longer than maxRedirects is rejected", async () => {
  const { url, close } = await startServer((req, res) => {
    const n = Number((req.url ?? "/0").slice(1));
    res.writeHead(302, { Location: `/${n + 1}` });
    res.end();
  });
  try {
    await assert.rejects(safeFetch(`${url}/0`, { allowPrivateNetworksForTests: true, maxRedirects: 2 }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "too_many_redirects");
      return true;
    });
  } finally {
    await close();
  }
});

test("safeFetch: a redirect loop (A -> B -> A) is detected and rejected", async () => {
  const { url, close } = await startServer((req, res) => {
    const target = req.url === "/a" ? "/b" : "/a";
    res.writeHead(302, { Location: target });
    res.end();
  });
  try {
    await assert.rejects(safeFetch(`${url}/a`, { allowPrivateNetworksForTests: true, maxRedirects: 10 }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "redirect_loop");
      return true;
    });
  } finally {
    await close();
  }
});

test("safeFetch: a 3xx with no Location header is rejected", async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(302, {});
    res.end();
  });
  try {
    await assert.rejects(safeFetch(url, { allowPrivateNetworksForTests: true }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "missing_redirect_location");
      return true;
    });
  } finally {
    await close();
  }
});

test("safeFetch: redirect destinations are revalidated — a redirect to a disallowed scheme is rejected mid-chain", async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(302, { Location: "javascript:alert(1)" });
    res.end();
  });
  try {
    await assert.rejects(safeFetch(url, { allowPrivateNetworksForTests: true }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "disallowed_scheme");
      return true;
    });
  } finally {
    await close();
  }
});

test("safeFetch: rejects a response whose Content-Length exceeds the cap without reading the body", async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": "10000000", "Content-Type": "text/plain" });
    res.end("short"); // deliberately mismatched — the header alone must be enough to reject
  });
  try {
    await assert.rejects(safeFetch(url, { allowPrivateNetworksForTests: true, maxResponseBytes: 1000 }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "response_too_large");
      return true;
    });
  } finally {
    await close();
  }
});

test("safeFetch: rejects a streamed response that exceeds the cap even without a Content-Length header", async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    // No Content-Length — chunked. Stream well past the cap.
    for (let i = 0; i < 50; i++) res.write("x".repeat(1000));
    res.end();
  });
  try {
    await assert.rejects(safeFetch(url, { allowPrivateNetworksForTests: true, maxResponseBytes: 1000 }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "response_too_large");
      return true;
    });
  } finally {
    await close();
  }
});

test("safeFetch: a response body under the cap succeeds", async () => {
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("x".repeat(500));
  });
  try {
    const result = await safeFetch(url, { allowPrivateNetworksForTests: true, maxResponseBytes: 1000 });
    assert.equal(result.bodyText.length, 500);
  } finally {
    await close();
  }
});

test("safeFetch: a server that never responds is aborted as a timeout", async () => {
  const { url, close } = await startServer(() => {
    // Never call res.end() — hangs until the client times out.
  });
  try {
    await assert.rejects(safeFetch(url, { allowPrivateNetworksForTests: true, timeoutMs: 200 }), (err: unknown) => {
      assert.ok(err instanceof SafeFetchError);
      assert.equal(err.reason, "timeout");
      return true;
    });
  } finally {
    await close();
  }
});
