import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDomainCandidates } from "@/lib/companyIdentity/domainCandidates";

test("generates a compact and hyphenated .com candidate from a normalized name", () => {
  const candidates = generateDomainCandidates("Acme Technologies Inc");
  // "Acme Technologies Inc" -> normalizeEmployerName strips "Inc" and "Technologies" (both
  // suffix words) -> "Acme" -> single-word compact/hyphenated collapse to one candidate.
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.every((c) => c.endsWith(".com")));
});

test("multi-word normalized name produces both compact and hyphenated variants", () => {
  const candidates = generateDomainCandidates("Ernst & Young U.S. LLP");
  assert.ok(candidates.includes("ernstyoungus.com"));
  assert.ok(candidates.includes("ernst-young-us.com"));
  assert.equal(candidates.length, 2);
});

test("never invents an abbreviation — no ey.com for Ernst & Young", () => {
  const candidates = generateDomainCandidates("Ernst & Young U.S. LLP");
  assert.ok(!candidates.includes("ey.com"));
});

test("an empty employer name produces no candidates", () => {
  assert.deepEqual(generateDomainCandidates(""), []);
});

test("degenerate short normalized name below the minimum length produces no candidates", () => {
  // "Co" alone normalizes to "" (single suffix word strips to empty) — but a name like "A B"
  // that survives normalization at 2 chars total should still be rejected as too short/generic.
  const candidates = generateDomainCandidates("A B");
  assert.deepEqual(candidates, []);
});

test("candidates are deterministic — same input always produces the same output", () => {
  const a = generateDomainCandidates("Wal-Mart Associates, Inc.");
  const b = generateDomainCandidates("Wal-Mart Associates, Inc.");
  assert.deepEqual(a, b);
});
