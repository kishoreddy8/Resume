import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  canonicalSmartRecruitersUrl,
  fetchSmartRecruitersJobs,
  normalizeSmartRecruitersToken,
} from "@/lib/ats/smartrecruiters";
import { detectAtsFromUrlString } from "@/lib/ats/detect";

test("SmartRecruiters token normalization and canonical URL generation", () => {
  // Standard token
  assert.equal(normalizeSmartRecruitersToken("Axiado"), "Axiado");
  assert.equal(normalizeSmartRecruitersToken("  DNAnexus  "), "DNAnexus");
  assert.equal(normalizeSmartRecruitersToken("XPPower2"), "XPPower2");
  assert.equal(normalizeSmartRecruitersToken("BurwoodGroupInc"), "BurwoodGroupInc");
  assert.equal(normalizeSmartRecruitersToken("QADInc"), "QADInc");

  // Canonical URLs
  assert.equal(canonicalSmartRecruitersUrl("Axiado"), "https://careers.smartrecruiters.com/Axiado");
  assert.equal(canonicalSmartRecruitersUrl("QADInc"), "https://careers.smartrecruiters.com/QADInc");

  // Rejections
  assert.throws(() => normalizeSmartRecruitersToken(""), /cannot be empty/);
  assert.throws(() => normalizeSmartRecruitersToken("   "), /cannot be empty/);
  assert.throws(() => normalizeSmartRecruitersToken("${CONFIG.company}"), /Invalid SmartRecruiters/);
  assert.throws(() => normalizeSmartRecruitersToken("null"), /Invalid SmartRecruiters/);
  assert.throws(() => normalizeSmartRecruitersToken("undefined"), /Invalid SmartRecruiters/);
  assert.throws(() => normalizeSmartRecruitersToken("company"), /Invalid SmartRecruiters/);
  assert.throws(() => normalizeSmartRecruitersToken("invalid!token@"), /Invalid SmartRecruiters/);
});

test("detectSmartRecruiters extracts standard and nested path tokens, and rejects placeholders", () => {
  // Standard URLs
  const d1 = detectAtsFromUrlString("https://careers.smartrecruiters.com/Axiado");
  assert.ok(d1);
  assert.equal(d1.sourceType, "smartrecruiters");
  assert.equal(d1.atsBoardToken, "Axiado");
  assert.equal(d1.canonicalSourceUrl, "https://careers.smartrecruiters.com/Axiado");

  // Nested path URLs (e.g. QADInc/corporate-careers)
  const d2 = detectAtsFromUrlString("https://careers.smartrecruiters.com/QADInc/corporate-careers");
  assert.ok(d2);
  assert.equal(d2.sourceType, "smartrecruiters");
  assert.equal(d2.atsBoardToken, "QADInc");
  assert.equal(d2.canonicalSourceUrl, "https://careers.smartrecruiters.com/QADInc");

  // Sub-brand URLs
  const d3 = detectAtsFromUrlString("https://careers.smartrecruiters.com/BoschGroup/india");
  assert.ok(d3);
  assert.equal(d3.sourceType, "smartrecruiters");
  assert.equal(d3.atsBoardToken, "BoschGroup");

  // jobs.smartrecruiters.com host
  const d4 = detectAtsFromUrlString("https://jobs.smartrecruiters.com/DNAnexus/743999999");
  assert.ok(d4);
  assert.equal(d4.sourceType, "smartrecruiters");
  assert.equal(d4.atsBoardToken, "DNAnexus");

  // Rejections: template placeholders
  assert.equal(
    detectAtsFromUrlString("https://jobs.smartrecruiters.com/${CONFIG.company}/${encodeURIComponent(id)}`"),
    null
  );
  // Rejection: bare root
  assert.equal(detectAtsFromUrlString("https://jobs.smartrecruiters.com"), null);
  assert.equal(detectAtsFromUrlString("https://careers.smartrecruiters.com/"), null);
});

test("fetchSmartRecruitersJobs: multi-page pagination, detail enrichment, and U.S.-only filtering", async () => {
  const requestedOffsets: number[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    const detail = url.pathname.match(/\/postings\/([a-zA-Z0-9_-]+)$/);
    if (detail) {
      const id = detail[1];
      if (id === "JOB-US-1") {
        res.end(JSON.stringify({
          id,
          name: "Staff Backend Engineer",
          releasedDate: "2026-08-01T00:00:00Z",
          location: { city: "Dallas", region: "TX", country: "us", fullLocation: "Dallas, TX, United States", hybrid: true },
          department: { label: "Infrastructure" },
          typeOfEmployment: { label: "Full-time" },
          jobAd: { jobDescription: "<p>Design high-scale APIs. Pay $160k - $200k/yr.</p>" },
        }));
        return;
      }
      if (id === "JOB-CA-1") {
        res.end(JSON.stringify({
          id,
          name: "Canada Operations Lead",
          releasedDate: "2026-08-02T00:00:00Z",
          location: { city: "Toronto", region: "ON", country: "ca", fullLocation: "Toronto, ON, Canada" },
          department: { label: "Operations" },
          jobAd: { jobDescription: "<p>Canadian operations oversight.</p>" },
        }));
        return;
      }
      if (id === "JOB-REMOTE-1") {
        res.end(JSON.stringify({
          id,
          name: "Ambiguous Remote Engineer",
          releasedDate: "2026-08-03T00:00:00Z",
          location: { fullLocation: "Remote", remote: true },
          department: { label: "Engineering" },
          jobAd: { jobDescription: "<p>Global remote position.</p>" },
        }));
        return;
      }
      if (id === "JOB-US-2") {
        res.end(JSON.stringify({
          id,
          name: "Principal Security Architect",
          releasedDate: "2026-08-04T00:00:00Z",
          location: { city: "Chicago", region: "IL", country: "us", fullLocation: "Chicago, IL, United States" },
          department: { label: "Security" },
          jobAd: { jobDescription: "<p>Security architecture and audit.</p>" },
        }));
        return;
      }
      res.writeHead(404).end("Not found");
      return;
    }

    const offset = Number(url.searchParams.get("offset") ?? "0");
    requestedOffsets.push(offset);
    if (offset === 0) {
      res.end(JSON.stringify({
        offset: 0,
        limit: 2,
        totalFound: 4,
        content: [
          { id: "JOB-US-1", name: "Staff Backend Engineer" },
          { id: "JOB-CA-1", name: "Canada Operations Lead" },
        ],
      }));
      return;
    }
    if (offset === 2) {
      res.end(JSON.stringify({
        offset: 2,
        limit: 2,
        totalFound: 4,
        content: [
          { id: "JOB-REMOTE-1", name: "Ambiguous Remote Engineer" },
          { id: "JOB-US-2", name: "Principal Security Architect" },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({ offset, limit: 2, totalFound: 4, content: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const filteredScopes: string[] = [];
    const jobs = await fetchSmartRecruitersJobs("Axiado", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxAttempts: 1,
      onLocationFiltered: (scope) => filteredScopes.push(scope),
    });

    // Both pages requested
    assert.deepEqual(requestedOffsets, [0, 2]);
    // Exactly 2 US jobs survive (JOB-US-1 and JOB-US-2)
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].externalId, "JOB-US-1");
    assert.equal(jobs[0].workplaceType, "Hybrid");
    assert.equal(jobs[0].salaryText, "$160k - $200k/yr");
    assert.equal(jobs[0].url, "https://jobs.smartrecruiters.com/Axiado/JOB-US-1");
    assert.equal(jobs[1].externalId, "JOB-US-2");

    // Location exclusions recorded
    assert.ok(filteredScopes.includes("NON_US")); // Toronto
    assert.ok(filteredScopes.includes("UNKNOWN")); // Bare Remote

    // Non-U.S. mode returns all 4 jobs
    const allJobs = await fetchSmartRecruitersJobs("Axiado", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: false,
      maxAttempts: 1,
    });
    assert.equal(allJobs.length, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchSmartRecruitersJobs: one posting's detail fetch exhausting retries degrades that job only, not the whole scan", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    const detail = url.pathname.match(/\/postings\/([a-zA-Z0-9_-]+)$/);
    if (detail) {
      const id = detail[1];
      if (id === "JOB-BROKEN") {
        res.writeHead(500).end("boom");
        return;
      }
      res.end(JSON.stringify({
        id,
        name: "Healthy Job",
        releasedDate: "2026-08-01T00:00:00Z",
        location: { city: "Denver", region: "CO", country: "us", fullLocation: "Denver, CO, United States" },
        jobAd: { jobDescription: "<p>Real description.</p>" },
      }));
      return;
    }
    res.end(JSON.stringify({
      offset: 0,
      limit: 10,
      totalFound: 2,
      content: [
        { id: "JOB-BROKEN", name: "Broken Detail Job", location: { fullLocation: "Denver, CO, United States" } },
        { id: "JOB-OK", name: "Healthy Job" },
      ],
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchSmartRecruitersJobs("Axiado", {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxAttempts: 1,
    });

    // Both jobs survive — the broken one degrades instead of aborting the whole scan.
    assert.equal(jobs.length, 2);
    const broken = jobs.find((j) => j.externalId === "JOB-BROKEN")!;
    const ok = jobs.find((j) => j.externalId === "JOB-OK")!;
    assert.ok(broken, "the job whose detail fetch failed must still appear (list-level fallback), not vanish");
    assert.equal(broken.descriptionText, null, "a failed detail fetch must degrade to no description, not fabricate one");
    assert.equal(broken.title, "Broken Detail Job", "falls back to the listing's own title");
    assert.equal(broken.location, "Denver, CO, United States", "falls back to the listing's own location");
    assert.equal(ok.descriptionText, "Real description.", "an unrelated posting's successful detail fetch is unaffected");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchSmartRecruitersJobs: fail-closed on duplicate posting IDs within or across pages", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      offset: 0,
      limit: 10,
      totalFound: 2,
      content: [
        { id: "DUP-1", name: "Job 1" },
        { id: "DUP-1", name: "Job 2" },
      ],
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(
      () =>
        fetchSmartRecruitersJobs("Axiado", {
          hostOverride: `http://127.0.0.1:${port}`,
          maxAttempts: 1,
        }),
      /Duplicate posting ID detected in SmartRecruiters snapshot: DUP-1/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchSmartRecruitersJobs: fail-closed on totalFound mutation during pagination", async () => {
  let callCount = 0;
  const server = http.createServer((_req, res) => {
    callCount++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      offset: callCount === 1 ? 0 : 1,
      limit: 1,
      totalFound: callCount === 1 ? 5 : 3, // Mutated totalFound!
      content: [{ id: `J-${callCount}`, name: `Job ${callCount}` }],
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(
      () =>
        fetchSmartRecruitersJobs("Axiado", {
          hostOverride: `http://127.0.0.1:${port}`,
          maxAttempts: 1,
        }),
      /SmartRecruiters totalFound mutated during pagination/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fetchSmartRecruitersJobs: fail-closed on unexpected empty page before totalFound", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      offset: 0,
      limit: 10,
      totalFound: 10,
      content: [], // Empty before totalFound!
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(
      () =>
        fetchSmartRecruitersJobs("Axiado", {
          hostOverride: `http://127.0.0.1:${port}`,
          maxAttempts: 1,
        }),
      /SmartRecruiters pagination returned empty content at offset 0 before reaching totalFound 10/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
