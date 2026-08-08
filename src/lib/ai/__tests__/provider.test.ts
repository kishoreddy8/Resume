import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { clearProviders, getActiveProvider, registerProvider, resolveProvider } from "../provider";
import { FakeProvider } from "./testHelpers";

/**
 * Provider abstraction + enablement/credential resolution. No DB involved — provider.ts reads only
 * process.env and its in-process registry. Run with: npm test
 */

const ORIGINAL_ENABLED = process.env.CAREER_OPS_AI_ENABLED;
const ORIGINAL_PROVIDER = process.env.CAREER_OPS_AI_PROVIDER;

beforeEach(() => {
  clearProviders();
  delete process.env.CAREER_OPS_AI_ENABLED;
  delete process.env.CAREER_OPS_AI_PROVIDER;
});

afterEach(() => {
  clearProviders();
  if (ORIGINAL_ENABLED === undefined) delete process.env.CAREER_OPS_AI_ENABLED;
  else process.env.CAREER_OPS_AI_ENABLED = ORIGINAL_ENABLED;
  if (ORIGINAL_PROVIDER === undefined) delete process.env.CAREER_OPS_AI_PROVIDER;
  else process.env.CAREER_OPS_AI_PROVIDER = ORIGINAL_PROVIDER;
});

test("AI disabled: CAREER_OPS_AI_ENABLED unset resolves to disabled, no provider", () => {
  const resolution = resolveProvider();
  assert.equal(resolution.provider, null);
  assert.equal(resolution.reason, "disabled");
  assert.equal(getActiveProvider(), null);
});

test("AI disabled: CAREER_OPS_AI_ENABLED set to anything other than 'true' still resolves to disabled", () => {
  process.env.CAREER_OPS_AI_ENABLED = "1";
  const resolution = resolveProvider();
  assert.equal(resolution.provider, null);
  assert.equal(resolution.reason, "disabled");
});

test("missing credentials: enabled but no CAREER_OPS_AI_PROVIDER selected", () => {
  process.env.CAREER_OPS_AI_ENABLED = "true";
  const resolution = resolveProvider();
  assert.equal(resolution.provider, null);
  assert.equal(resolution.reason, "missing_credentials");
});

test("missing credentials: enabled, a provider name selected, but nothing registered under that name", () => {
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "nonexistent";
  const resolution = resolveProvider();
  assert.equal(resolution.provider, null);
  assert.equal(resolution.reason, "missing_credentials");
});

test("resolves to the registered provider once enabled and selected", () => {
  const fake = new FakeProvider({ name: "fake", steps: [{ raw: {} }] });
  registerProvider(fake);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "fake";

  const resolution = resolveProvider();
  assert.equal(resolution.provider, fake);
  assert.equal(getActiveProvider(), fake);
});

test("registering a different provider under the same name replaces the previous one", () => {
  const first = new FakeProvider({ name: "fake", steps: [{ raw: {} }] });
  const second = new FakeProvider({ name: "fake", steps: [{ raw: {} }] });
  registerProvider(first);
  registerProvider(second);
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "fake";

  assert.equal(getActiveProvider(), second);
});
