import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeJobUrl, dedupeKeyForAts, dedupeKeyForCareerLink, normalizeJobUrl } from "../dedupe";
import type { NormalizedJob } from "../../types";

function job(overrides: Partial<NormalizedJob> = {}): Pick<NormalizedJob, "title" | "url" | "location" | "postedAt" | "descriptionText"> {
  return {
    title: "Senior Software Engineer",
    url: "https://acme.com/careers/123-senior-software-engineer",
    location: null,
    postedAt: null,
    descriptionText: null,
    ...overrides,
  };
}

// --- dedupeKeyForAts: tier 1 ----------------------------------------------------------------

test("dedupeKeyForAts is stable for the same provider/company/external id", () => {
  const a = dedupeKeyForAts("greenhouse", 1, "req-42");
  const b = dedupeKeyForAts("greenhouse", 1, "req-42");
  assert.equal(a, b);
});

test("dedupeKeyForAts treats a different external id as a different identity", () => {
  const a = dedupeKeyForAts("greenhouse", 1, "req-42");
  const b = dedupeKeyForAts("greenhouse", 1, "req-43");
  assert.notEqual(a, b);
});

// --- URL normalization / tracking-param stripping -------------------------------------------

test("normalizeJobUrl strips known tracking params but keeps unrecognized (identity-bearing) ones", () => {
  const withTracking = normalizeJobUrl(
    "https://acme.com/careers/123-role?utm_source=linkedin&utm_campaign=q3&gh_jid=987&gclid=abc"
  );
  const withoutTracking = normalizeJobUrl("https://acme.com/careers/123-role?gh_jid=987");
  assert.equal(withTracking, withoutTracking, "tracking params should not affect the canonical URL");
  assert.match(withTracking, /gh_jid=987/, "non-tracking params must be preserved for identity");
});

test("normalizeJobUrl is insensitive to tracking-param order and host casing", () => {
  const a = normalizeJobUrl("https://ACME.com/careers/123-role?utm_campaign=x&utm_source=y");
  const b = normalizeJobUrl("https://acme.com/careers/123-role?utm_source=y&utm_campaign=x");
  assert.equal(a, b);
});

test("normalizeJobUrl strips a trailing slash and URL fragment", () => {
  const a = normalizeJobUrl("https://acme.com/careers/123-role/");
  const b = normalizeJobUrl("https://acme.com/careers/123-role#apply");
  const c = normalizeJobUrl("https://acme.com/careers/123-role");
  assert.equal(a, c);
  assert.equal(b, c);
});

test("normalizeJobUrl degrades gracefully on a malformed URL instead of throwing", () => {
  assert.doesNotThrow(() => normalizeJobUrl("not a url"));
});

test("canonicalizeJobUrl keeps two distinct job paths distinct", () => {
  const a = canonicalizeJobUrl("https://acme.com/careers/123-role").canonical;
  const b = canonicalizeJobUrl("https://acme.com/careers/456-other-role").canonical;
  assert.notEqual(a, b);
});

// --- dedupeKeyForCareerLink: tier 2 (canonical URL) ------------------------------------------

test("dedupeKeyForCareerLink: tracking-param URL variants resolve to the same identity", () => {
  const first = dedupeKeyForCareerLink(1, job({ url: "https://acme.com/careers/123-role?utm_source=linkedin" }));
  const second = dedupeKeyForCareerLink(1, job({ url: "https://acme.com/careers/123-role?utm_source=twitter&utm_campaign=fall" }));
  assert.equal(first, second);
});

test("dedupeKeyForCareerLink: a genuinely different job path is a different identity (repost with a new URL)", () => {
  const first = dedupeKeyForCareerLink(1, job({ url: "https://acme.com/careers/123-role" }));
  const second = dedupeKeyForCareerLink(1, job({ url: "https://acme.com/careers/456-role" }));
  assert.notEqual(first, second);
});

test("dedupeKeyForCareerLink: same URL, different company, is a different identity", () => {
  const first = dedupeKeyForCareerLink(1, job());
  const second = dedupeKeyForCareerLink(2, job());
  assert.notEqual(first, second);
});

test("dedupeKeyForCareerLink: a title change alone (same URL) does not change identity", () => {
  const first = dedupeKeyForCareerLink(1, job({ title: "Senior Software Engineer" }));
  const second = dedupeKeyForCareerLink(1, job({ title: "Staff Software Engineer" }));
  assert.equal(first, second, "URL identity must win over a cosmetic title edit on the same posting");
});

// --- dedupeKeyForCareerLink: tier 3 (company + title + location + date) ---------------------

test("dedupeKeyForCareerLink: falls back to title+location+date when the URL path is generic", () => {
  const first = dedupeKeyForCareerLink(
    1,
    job({ url: "https://acme.com/careers", location: "Austin, TX", postedAt: "2026-08-01" })
  );
  const second = dedupeKeyForCareerLink(
    1,
    job({ url: "https://acme.com/careers", location: "Austin, TX", postedAt: "2026-08-01", title: "senior software engineer " })
  );
  assert.equal(first, second, "normalized title/location should ignore casing/whitespace differences");
});

test("dedupeKeyForCareerLink: tier 3 distinguishes different locations behind the same generic URL", () => {
  const austin = dedupeKeyForCareerLink(
    1,
    job({ url: "https://acme.com/careers", location: "Austin, TX", postedAt: "2026-08-01" })
  );
  const remote = dedupeKeyForCareerLink(
    1,
    job({ url: "https://acme.com/careers", location: "Remote", postedAt: "2026-08-01" })
  );
  assert.notEqual(austin, remote);
});

// --- dedupeKeyForCareerLink: tier 4 (conservative content fingerprint) -----------------------

test("dedupeKeyForCareerLink: generic fallback fingerprint is used when URL is generic and no location/date exist", () => {
  const key = dedupeKeyForCareerLink(1, job({ url: "https://acme.com/careers", location: null, postedAt: null }));
  assert.match(key, /^career_link:1:fp:/);
});

test("dedupeKeyForCareerLink: fallback fingerprint never merges on title text alone", () => {
  const a = dedupeKeyForCareerLink(
    1,
    job({ url: "https://acme.com/careers", descriptionText: "Build backend services in Go." })
  );
  const b = dedupeKeyForCareerLink(
    1,
    job({ url: "https://acme.com/careers", descriptionText: "Design our React design system." })
  );
  assert.notEqual(a, b, "same title behind a generic URL but different description must not collapse to one identity");
});

test("dedupeKeyForCareerLink: identical generic-URL postings with no other signals are treated as the same identity", () => {
  const a = dedupeKeyForCareerLink(1, job({ url: "https://acme.com/careers" }));
  const b = dedupeKeyForCareerLink(1, job({ url: "https://acme.com/careers" }));
  assert.equal(a, b);
});
