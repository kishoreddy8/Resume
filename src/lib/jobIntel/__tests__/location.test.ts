import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLocation } from "../location";

test("Remote via native workplace type field (tier 1, ATS-native)", () => {
  const result = extractLocation({ locationNative: "United States", workplaceTypeNative: "Remote", descriptionText: null });
  assert.equal(result.workplaceType, "Remote");
});

test("Hybrid via native workplace type field", () => {
  const result = extractLocation({ locationNative: "Austin, TX", workplaceTypeNative: "Hybrid", descriptionText: null });
  assert.equal(result.workplaceType, "Hybrid");
});

test("Onsite via native field ('On-site' spelling variant)", () => {
  const result = extractLocation({ locationNative: "Austin, TX", workplaceTypeNative: "On-site", descriptionText: null });
  assert.equal(result.workplaceType, "Onsite");
});

test("native ATS field takes precedence over JD text when both are present and could conflict", () => {
  const result = extractLocation({
    locationNative: "Austin, TX",
    workplaceTypeNative: "Onsite",
    descriptionText: "We occasionally allow remote work for the right candidate.",
  });
  assert.equal(result.workplaceType, "Onsite", "the reliable native field should win over a weaker text guess");
});

test("JD text fallback when no native field is present", () => {
  const result = extractLocation({ locationNative: null, workplaceTypeNative: null, descriptionText: "This role is fully remote." });
  assert.equal(result.workplaceType, "Remote");
});

test("city/state parsed from a single location string", () => {
  const result = extractLocation({ locationNative: "Austin, TX", workplaceTypeNative: null, descriptionText: null });
  assert.equal(result.primary.city, "Austin");
  assert.equal(result.primary.state, "TX");
});

test("multiple locations captured as a list", () => {
  const result = extractLocation({ locationNative: "Austin, TX; Denver, CO", workplaceTypeNative: null, descriptionText: null });
  assert.equal(result.locations.length, 2);
  assert.equal(result.locations[0].city, "Austin");
  assert.equal(result.locations[1].city, "Denver");
});

test("office days requirement extracted from JD text", () => {
  const result = extractLocation({
    locationNative: "Austin, TX",
    workplaceTypeNative: "Hybrid",
    descriptionText: "This is a hybrid role requiring 3 days a week in the office.",
  });
  assert.ok(result.officeDays && /3\s*days/.test(result.officeDays));
});

test("relocation language captured", () => {
  const result = extractLocation({
    locationNative: null,
    workplaceTypeNative: null,
    descriptionText: "Relocation assistance is available for this role.",
  });
  assert.ok(result.relocation);
});

test("travel percentage captured", () => {
  const result = extractLocation({
    locationNative: null,
    workplaceTypeNative: null,
    descriptionText: "This role requires up to 25% travel.",
  });
  assert.ok(result.travelPct && /25/.test(result.travelPct));
});

test("no location signal anywhere: Unknown, not fabricated", () => {
  const result = extractLocation({ locationNative: null, workplaceTypeNative: null, descriptionText: null });
  assert.equal(result.workplaceType, "Unknown");
  assert.deepEqual(result.locations, []);
});
