import test from "node:test";
import assert from "node:assert/strict";
import { exactComboboxOption } from "../comboboxSelection";

/**
 * The exact-match-only decision for combobox option selection (GAP-2/EXEC). Pure, no browser — the
 * actual DOM interaction in executor.ts is a thin wrapper around this function.
 */

test("EXEC-01: the exact approved value selects the matching option", () => {
  const options = ["Canada", "Mexico", "United States", "United Kingdom"];
  assert.equal(exactComboboxOption(options, "United States"), "United States");
});

test("EXEC-02: no exact option present means no selection is made — never a close/fuzzy pick", () => {
  const options = ["Canada", "Mexico", "United Kingdom"];
  assert.equal(exactComboboxOption(options, "United States"), null);
});

test("a substring match is not treated as exact", () => {
  const options = ["United States of America"];
  assert.equal(exactComboboxOption(options, "United States"), null, "a partial/prefix match must never be accepted as the answer");
});

test("matching is case-sensitive — a differently-cased option is not an exact match", () => {
  const options = ["united states"];
  assert.equal(exactComboboxOption(options, "United States"), null);
});

test("an empty option list never produces a match", () => {
  assert.equal(exactComboboxOption([], "United States"), null);
});
