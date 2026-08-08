import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCompensation } from "../compensation";

test("salary range parsed into min/max, annual by default", () => {
  const result = parseCompensation("$120,000 - $150,000", null);
  assert.equal(result.min, 120000);
  assert.equal(result.max, 150000);
  assert.equal(result.period, "annual");
});

test("hourly rate parsed with period='hourly', not converted to annual", () => {
  const result = parseCompensation("$45/hr", null);
  assert.equal(result.min, 45);
  assert.equal(result.period, "hourly");
});

test("'K' suffix multiplies by 1000, no other unit conversion happens", () => {
  const result = parseCompensation("$120K - $150K", null);
  assert.equal(result.min, 120000);
  assert.equal(result.max, 150000);
});

test("currency code detected when present", () => {
  const result = parseCompensation("120,000 - 150,000 USD", null);
  assert.equal(result.currency, "USD");
});

test("currency defaults to USD when a $ amount has no explicit code", () => {
  const result = parseCompensation("$120,000 - $150,000", null);
  assert.equal(result.currency, "USD");
});

test("bonus/commission/equity captured from description text separately from the range", () => {
  const result = parseCompensation("$120,000 - $150,000", "This role includes an annual bonus and equity in the form of RSUs.");
  assert.ok(result.bonus);
  assert.ok(result.equity);
});

test("null salary text: everything null, nothing fabricated", () => {
  const result = parseCompensation(null, "We pay competitively.");
  assert.equal(result.min, null);
  assert.equal(result.max, null);
  assert.equal(result.currency, null);
});

test("unparseable salary text: min/max stay null rather than guessing", () => {
  const result = parseCompensation("Competitive salary", null);
  assert.equal(result.min, null);
  assert.equal(result.max, null);
});
