import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { isUrlSafeForNavigation } from "@/lib/net/safeFetch";

/**
 * Unit coverage for the shared boolean safety check src/lib/ats/discoveryBrowser.ts (Tier 3) uses
 * for BOTH its seed-URL pre-check and its per-navigation request interception — the same
 * private-IP/loopback/link-local/scheme logic safeFetch.test.ts already proves for the
 * exception-throwing path, exercised here through the boolean wrapper real callers use.
 */

test("isUrlSafeForNavigation: rejects loopback/localhost by default", async () => {
  assert.equal(await isUrlSafeForNavigation("http://127.0.0.1:9/"), false);
  assert.equal(await isUrlSafeForNavigation("http://localhost/admin"), false);
});

test("isUrlSafeForNavigation: rejects private/link-local IP ranges by default", async () => {
  assert.equal(await isUrlSafeForNavigation("http://10.0.0.5/"), false);
  assert.equal(await isUrlSafeForNavigation("http://192.168.1.1/"), false);
  assert.equal(await isUrlSafeForNavigation("http://169.254.169.254/"), false, "cloud metadata address");
});

test("isUrlSafeForNavigation: rejects non-http(s) schemes REGARDLESS of allowPrivateNetworksForTests", async () => {
  assert.equal(await isUrlSafeForNavigation("javascript:alert(1)", true), false);
  assert.equal(await isUrlSafeForNavigation("ftp://example.com/", true), false);
  assert.equal(await isUrlSafeForNavigation("file:///etc/passwd", true), false);
});

test("isUrlSafeForNavigation: an ordinary public https URL is allowed", async () => {
  assert.equal(await isUrlSafeForNavigation("https://example.com/careers"), true);
});

test("isUrlSafeForNavigation: allowPrivateNetworksForTests=true permits a local test server", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    assert.equal(await isUrlSafeForNavigation(`http://127.0.0.1:${port}/`, true), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("isUrlSafeForNavigation: a malformed URL is rejected, never throws", async () => {
  assert.equal(await isUrlSafeForNavigation("not a url"), false);
});
