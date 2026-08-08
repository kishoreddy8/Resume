import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDomain } from "../domain";

test("explicit domain keyword: FinTech", () => {
  assert.equal(extractDomain("We are a fast-growing fintech startup.").domain, "FinTech");
});

test("explicit domain keyword: Healthcare", () => {
  assert.equal(extractDomain("Join our healthcare technology team.").domain, "Healthcare");
});

test("no explicit domain language: null, never guessed from company name", () => {
  const result = extractDomain("We build great software.");
  assert.equal(result.domain, null);
  assert.equal(result.evidence, null);
});

test("null description handled safely", () => {
  assert.equal(extractDomain(null).domain, null);
});
