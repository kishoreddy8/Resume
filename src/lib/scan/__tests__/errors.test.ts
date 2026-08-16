import assert from "node:assert/strict";
import { test } from "node:test";
import { categorizeHttpError, categorizeThrownError, isRetryableCategory, ScanConnectorError } from "@/lib/scan/errors";

/**
 * Connector Reliability Control Plane V1.1 — regression coverage for the real-production-evidence
 * classification fixes (see the V1.1 investigation report). Items 1-14 of the mission's required
 * 25-test list live here; items 15-25 (reliability routing/safety) live in
 * src/lib/ats/reliability/__tests__/ — most were already covered by Stage 10's suite, plus a small
 * number of new tests there specifically verifying these NEW patterns route correctly.
 */

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

// --- categorizeHttpError: network/timeout/HTTP-status classification (already correct — verified) ---

test("1. timeout (AbortError) classifies as network", () => {
  assert.equal(categorizeHttpError(undefined, abortError()), "timeout");
});

test("2. a DNS failure (TypeError, no response) classifies as network", () => {
  assert.equal(categorizeHttpError(undefined, new TypeError("fetch failed")), "network");
});

test("3. a connection reset/refused failure (TypeError, no response) classifies as network", () => {
  assert.equal(categorizeHttpError(undefined, new TypeError("ECONNRESET")), "network");
});

test("4. HTTP 429 classifies as rate_limited", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 429 }), undefined), "rate_limited");
});

test("5. HTTP 500 classifies as provider_5xx", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 500 }), undefined), "provider_5xx");
});

test("6. HTTP 502 classifies as provider_5xx", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 502 }), undefined), "provider_5xx");
});

test("7. HTTP 503 classifies as provider_5xx", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 503 }), undefined), "provider_5xx");
});

test("8. HTTP 504 classifies as provider_5xx", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 504 }), undefined), "provider_5xx");
});

test("9. HTTP 401 classifies as blocked", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 401 }), undefined), "blocked");
});

test("10. HTTP 403 classifies as blocked", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 403 }), undefined), "blocked");
});

test("11. a genuine board/site 404 classifies as invalid_config", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 404 }), undefined), "invalid_config");
});

test("12. a malformed/unparseable provider response classifies as parse_error", () => {
  assert.equal(categorizeHttpError(new Response(null, { status: 200 }), new SyntaxError("Unexpected token"), { isParseError: true }), "parse_error");
});

test("13. an unsafe navigation target (ScanConnectorError carrying unsafe_url) is never reclassified — categorizeThrownError trusts it verbatim", () => {
  const err = new ScanConnectorError("Disallowed IP literal", "unsafe_url", 0);
  assert.equal(categorizeThrownError(err), "unsafe_url");
});

test("14. a genuinely unrecognized synchronous throw stays unknown", () => {
  assert.equal(categorizeThrownError(new Error("Something completely unexpected happened")), "unknown");
});

// --- categorizeThrownError: real-production-evidence generic message patterns (V1.1) ---

test("V1.1a. JobDiva 'pagination shifted or returned an incomplete page' classifies as network (transient, confirmed via live reprobe)", () => {
  assert.equal(categorizeThrownError(new Error("JobDiva pagination shifted or returned an incomplete page")), "network");
});

test("V1.1b. JobDiva 'repeated snapshots disagreed; refusing authoritative ingestion' classifies as network", () => {
  assert.equal(categorizeThrownError(new Error("JobDiva repeated snapshots disagreed; refusing authoritative ingestion")), "network");
});

test("V1.1c. JobDiva 'listing/detail snapshot drift for job N; refusing authoritative ingestion' classifies as network", () => {
  assert.equal(categorizeThrownError(new Error("JobDiva listing/detail snapshot drift for job 28911533; refusing authoritative ingestion")), "network");
});

test("V1.1d. JobDiva 'duplicate job N across pages' and 'traversal did not match the reported total' both classify as network", () => {
  assert.equal(categorizeThrownError(new Error("JobDiva duplicate job 123 across pages")), "network");
  assert.equal(categorizeThrownError(new Error("JobDiva traversal did not match the reported total")), "network");
});

test("V1.1e. the generic 'has no full/exact description' pattern classifies as parse_error, regardless of which adapter produced it", () => {
  assert.equal(categorizeThrownError(new Error("Oracle Recruiting Cloud job 22367 has no full description")), "parse_error");
  assert.equal(categorizeThrownError(new Error("BambooHR job abc has no full description")), "parse_error");
  assert.equal(categorizeThrownError(new Error("UKG opportunity xyz has no exact description")), "parse_error");
});

test("V1.1f. Taleo 'detail description encoding is invalid' classifies as parse_error", () => {
  assert.equal(categorizeThrownError(new Error("Taleo detail description encoding is invalid")), "parse_error");
});

test("V1.1g. 'redirected to an untrusted host' classifies as blocked, not invalid_config", () => {
  assert.equal(
    categorizeThrownError(new Error("SuccessFactors detail response redirected to an untrusted host (expected career5.successfactors.eu, got jobs.lear.com)")),
    "blocked"
  );
  assert.equal(categorizeThrownError(new Error("SuccessFactors bootstrap redirected to an untrusted external host: evil.example.com")), "blocked");
});

test("V1.1h. 'Unsupported source_type: X' classifies as invalid_config", () => {
  assert.equal(categorizeThrownError(new Error("Unsupported source_type: successfactors")), "invalid_config");
});

test("V1.1i. the pre-existing missing/invalid-prefixed fallback still works unchanged", () => {
  assert.equal(categorizeThrownError(new Error("Missing Greenhouse board token")), "invalid_config");
  assert.equal(categorizeThrownError(new Error("Invalid Workday token structure")), "invalid_config");
});

test("V1.1j. isRetryableCategory still reflects only the 4 transient categories after the classification additions", () => {
  assert.equal(isRetryableCategory("network"), true);
  assert.equal(isRetryableCategory("parse_error"), false);
  assert.equal(isRetryableCategory("blocked"), false);
  assert.equal(isRetryableCategory("invalid_config"), false);
});
