import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAtsFromUrlString } from "../detect";
import { findEmbeddedAtsUrl } from "../discovery";

/**
 * Discovery Parser Hardening — regression coverage for detectWorkday/decodeSavedUrl, the one
 * detectX function that (before this fix) matched raw regex against unparsed, undecoded input
 * instead of following every other provider's new URL(decodeSavedUrl(value)) pattern. See detect.ts's
 * own doc comment on detectWorkday and WORKDAY_URL_RE for the full root-cause explanation.
 */

// --- Greenhouse: confirm the "embed" case is ALREADY correct (audit finding, not a fix) ----------

test("Greenhouse embed script URL extracts the for= board token, never the literal word 'embed'", () => {
  const result = detectAtsFromUrlString("https://boards.greenhouse.io/embed/job_board/js?for=inovalon");
  assert.ok(result);
  assert.equal(result!.sourceType, "greenhouse");
  assert.equal(result!.atsBoardToken, "inovalon");
  assert.notEqual(result!.atsBoardToken, "embed");
});

test("a normal Greenhouse board URL (no embed path) still resolves correctly", () => {
  const result = detectAtsFromUrlString("https://job-boards.greenhouse.io/fetch");
  assert.ok(result);
  assert.equal(result!.sourceType, "greenhouse");
  assert.equal(result!.atsBoardToken, "fetch");
});

test("a Greenhouse embed script tag with no for= parameter (token lives in separate inline JS) correctly returns null rather than guessing", () => {
  // findEmbeddedAtsUrl scans every URL-looking token in the page; the bare script src alone has no
  // token to extract, and this module must never guess one from surrounding JS it doesn't parse.
  const html = `<script src="https://boards.greenhouse.io/embed/job_board/js"></script><script>Grnhse.Iframe.load({board_token: 'inovalon'});</script>`;
  assert.equal(findEmbeddedAtsUrl(html), null);
});

test("a Greenhouse embed script tag WITH a for= parameter resolves via findEmbeddedAtsUrl, same as discoverCompanySource's own integration test", () => {
  const html = `<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=fetch"></script>`;
  const result = findEmbeddedAtsUrl(html);
  assert.ok(result);
  assert.equal(result!.sourceType, "greenhouse");
  assert.equal(result!.atsBoardToken, "fetch");
});

// --- Workday: the real, reproducible bug this task fixes -----------------------------------------

test("Gilead-style HTML-entity contamination (&quot; escaped inline JSON) is stripped from the Workday site identifier", () => {
  const html = `<a href="https://gilead.wd1.myworkdayjobs.com/gileadcareers&quot;,&quot;intendedAudience&quot;:&quot;patient">Careers</a>`;
  const result = findEmbeddedAtsUrl(html);
  assert.ok(result);
  assert.equal(result!.sourceType, "workday");
  assert.equal(result!.atsBoardToken, "gilead|wd1|gileadcareers", "the site identifier must terminate at the escaped delimiter, not swallow everything after it");
});

test("a normal Workday URL with no contamination is completely unchanged by the fix", () => {
  const result = detectAtsFromUrlString("https://dynata.wd1.myworkdayjobs.com/careers");
  assert.ok(result);
  assert.equal(result!.atsBoardToken, "dynata|wd1|careers");
});

test("Workday query parameters never contaminate the site identifier (pre-existing behavior, still correct)", () => {
  const result = detectAtsFromUrlString("https://acme.wd1.myworkdayjobs.com/External?locationCountry=US&source=LinkedIn");
  assert.ok(result);
  assert.equal(result!.atsBoardToken, "acme|wd1|External");
});

test("HTML attributes appended after a raw (unquoted-extraction) Workday URL never contaminate the token", () => {
  // Simulates a URL that reached detectAtsFromUrlString without having first been cleanly extracted
  // by findEmbeddedAtsUrl's own URL_TOKEN_RE (e.g. a differently-sourced candidate string) — the
  // site capture itself must still stop at the HTML boundary, not rely solely on upstream extraction.
  const result = detectAtsFromUrlString(`https://acme.wd1.myworkdayjobs.com/External">Careers<`);
  assert.ok(result);
  assert.equal(result!.atsBoardToken, "acme|wd1|External");
});

test("a Workday URL with no site segment at all fails closed (returns null), never guesses a missing identifier", () => {
  const result = detectAtsFromUrlString("https://acme.wd1.myworkdayjobs.com/");
  assert.equal(result, null);
});

test("a Workday-hostname-looking string with a malformed/non-slug remainder fails closed rather than fabricating a token", () => {
  const result = detectAtsFromUrlString(`https://acme.wd1.myworkdayjobs.com/"><script>alert(1)</script>`);
  assert.equal(result, null, "the entire remainder is unsafe characters with nothing left after truncation — must reject, not return an empty/garbage site");
});

// --- osv- prefix: explicitly NOT rewritten (Phase 1.C finding) -----------------------------------

test("an 'osv-' prefixed Workday tenant is preserved exactly as-is — no automatic osv- stripping exists or is implemented", () => {
  const result = detectAtsFromUrlString("https://osv-chegg.wd5.myworkdayjobs.com/Chegg");
  assert.ok(result);
  assert.equal(result!.atsBoardToken, "osv-chegg|wd5|Chegg", "osv- is part of the literal tenant hostname and must never be silently rewritten by the parser");
});

test("a tenant that merely starts with the substring 'osv' but isn't the osv- prefix pattern is also left untouched (no partial-match rewriting of any kind)", () => {
  const result = detectAtsFromUrlString("https://osvaldo-corp.wd1.myworkdayjobs.com/External");
  assert.ok(result);
  assert.equal(result!.atsBoardToken, "osvaldo-corp|wd1|External");
});

// --- Discovery V2: real API-endpoint URL shapes (network-request sniffing) -----------------------
// Network requests observed via Playwright hit each provider's actual JSON API host, which differs
// from the human-facing board-root host every detectX function previously recognized exclusively.

test("Workday CXS API URL (the real fetch()/XHR endpoint) is recognized distinctly from the board-root form", () => {
  const result = detectAtsFromUrlString("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs");
  assert.ok(result);
  assert.equal(result!.sourceType, "workday");
  assert.equal(result!.atsBoardToken, "acme|wd5|External", "must extract the real site (External) from the CXS path, not misparse 'wday' as the site");
});

test("Workday board-root URL (non-CXS) still resolves exactly as before the CXS-shape fix", () => {
  const result = detectAtsFromUrlString("https://acme.wd5.myworkdayjobs.com/External");
  assert.ok(result);
  assert.equal(result!.atsBoardToken, "acme|wd5|External");
});

test("Greenhouse boards-api.greenhouse.io URL (the real JSON API host) is recognized", () => {
  const result = detectAtsFromUrlString("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true");
  assert.ok(result);
  assert.equal(result!.sourceType, "greenhouse");
  assert.equal(result!.atsBoardToken, "acme");
});

test("SmartRecruiters api.smartrecruiters.com URL (the real JSON API host) is recognized", () => {
  const result = detectAtsFromUrlString("https://api.smartrecruiters.com/v1/companies/acme/postings?offset=0");
  assert.ok(result);
  assert.equal(result!.sourceType, "smartrecruiters");
  assert.equal(result!.atsBoardToken, "acme");
});

test("Recruitee career and offer URLs resolve to the same tenant-scoped connector", () => {
  for (const url of ["https://framestore.recruitee.com/", "https://framestore.recruitee.com/o/freelance-cg-chicago"]) {
    const result = detectAtsFromUrlString(url);
    assert.ok(result);
    assert.equal(result.sourceType, "recruitee");
    assert.equal(result.atsBoardToken, "framestore");
    assert.equal(result.canonicalSourceUrl, "https://framestore.recruitee.com/");
  }
});
