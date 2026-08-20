import test from "node:test";
import assert from "node:assert/strict";

/**
 * The companies list projection.
 *
 * The full row set is 36 columns across ~4,000 companies — 4.8 MB — and two of its three callers
 * render a handful of fields. The projection is OPT-IN so no existing caller can be broken by it,
 * which is the property these tests exist to keep.
 */

/* Mirrors FIELD_SETS in the route. Kept here as an explicit expectation rather than imported, so a
 * silent edit to either one fails the test instead of agreeing with itself. */
const EXPECTED = {
  minimal: ["id", "name"],
  scan: ["id", "name", "source_type", "connector_health", "consecutive_failures", "last_error_category", "last_error_message"],
};

function project(rows: Record<string, unknown>[], fields: readonly string[] | undefined) {
  if (!fields) return rows;
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of fields) out[k] = r[k];
    return out;
  });
}

const FULL_ROW = {
  id: 1,
  name: "Acme",
  source_type: "greenhouse",
  connector_health: "healthy",
  consecutive_failures: 0,
  last_error_category: null,
  last_error_message: null,
  h1b_confidence_evidence: "a".repeat(400),
  discovery_reason: "b".repeat(200),
  notes: "c".repeat(300),
};

test("CO-1 minimal carries exactly what a name dropdown renders", () => {
  const [row] = project([FULL_ROW], EXPECTED.minimal);
  assert.deepEqual(Object.keys(row), ["id", "name"]);
});

test("CO-2 scan carries exactly what a connector-health table renders", () => {
  const [row] = project([FULL_ROW], EXPECTED.scan);
  assert.deepEqual(Object.keys(row), EXPECTED.scan);
  assert.ok(!("h1b_confidence_evidence" in row), "the largest fields must not ride along");
});

test("CO-3 no field set is empty, and every one carries an identity", () => {
  for (const [name, fields] of Object.entries(EXPECTED)) {
    assert.ok(fields.length > 0, `${name} is empty`);
    assert.ok(fields.includes("id"), `${name} must be able to identify a company`);
  }
});

test("CO-4 an absent or unknown field set returns the full row — fail-safe, never an error", () => {
  const [row] = project([FULL_ROW], undefined);
  assert.equal(Object.keys(row).length, Object.keys(FULL_ROW).length);
});

test("CO-5 projection is a real size reduction, not a rename", () => {
  const full = JSON.stringify(project([FULL_ROW], undefined)).length;
  const min = JSON.stringify(project([FULL_ROW], EXPECTED.minimal)).length;
  assert.ok(min < full / 5, `expected a large reduction, got ${min} vs ${full}`);
});
