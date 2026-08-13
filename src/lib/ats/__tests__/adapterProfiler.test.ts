import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  ADAPTER_PROFILER_VERSION,
  profileAdapterCandidate,
  urlShape,
} from "@/lib/ats/adapterProfiler";

test("adapter profiler redacts public query values while preserving identity key names", () => {
  assert.equal(
    urlShape("https://jobs.example.com/search?company=acme&page=2&token=secret"),
    "https://jobs.example.com/search?company=<value>&page=<value>&token=<value>"
  );
});

test("adapter profiler passively records endpoint, pagination, and tenant evidence without persistence", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/bundle.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end('fetch("/api/job-requisitions?tenant=sample&page=1&limit=20")');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<html><script src="/bundle.js"></script><a href="/jobs/search?company=sample&offset=0">Jobs</a></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await profileAdapterCandidate({
      jobSourceId: 1,
      organizationId: 1,
      canonicalName: "Example Company",
      suspectedAts: "Example ATS",
      sourceUrl: `http://127.0.0.1:${port}/careers`,
    }, { persist: false, allowPrivateNetworksForTests: true });

    assert.equal(result.outcome, "PUBLIC_ENDPOINT_EVIDENCE");
    assert.equal(result.apiEvidence, true);
    assert.equal(result.paginationEvidence, true);
    assert.equal(result.tenantEvidence, true);
    assert.ok(result.endpointCandidates >= 2);
    assert.equal(result.evidence.schemaVersion, ADAPTER_PROFILER_VERSION);
    assert.ok(result.evidence.endpointEvidence.every((item) => !item.shape.includes("sample")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
