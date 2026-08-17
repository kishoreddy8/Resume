import assert from "node:assert/strict";
import test from "node:test";
import { classifyJobLocation } from "../jobLocationScope";

/**
 * Stage 15 — US location normalization hardening. Proves classifyJobLocation() now safely
 * recognizes unspaced "STATE-CITY" formats (e.g. Workday's "GA-ATLANTA") via an explicit
 * not-a-place-phrase blocklist, while never treating a workplace-type phrase like "IN-PERSON" or
 * "OR-REMOTE" as a real address just because the two-letter prefix happens to be a real state code.
 * Every case here was either given explicitly by the mission or pulled from real production Workday
 * location strings (see this file's own case comments).
 */

// 1-7. Known U.S. (pre-existing behavior, unchanged)
test("1. 'Dallas, TX' -> US", () => assert.equal(classifyJobLocation("Dallas, TX"), "US"));
test("2. 'Dallas, Texas' -> US", () => assert.equal(classifyJobLocation("Dallas, Texas"), "US"));
test("3. 'New York, NY' -> US", () => assert.equal(classifyJobLocation("New York, NY"), "US"));
test("4. 'United States' -> US", () => assert.equal(classifyJobLocation("United States"), "US"));
test("4b. 'USA' -> US", () => assert.equal(classifyJobLocation("USA"), "US"));
test("4c. 'US' -> US", () => assert.equal(classifyJobLocation("US"), "US"));
test("5. 'Remote - US' -> US", () => assert.equal(classifyJobLocation("Remote - US"), "US"));
test("5b. 'Remote, United States' -> US", () => assert.equal(classifyJobLocation("Remote, United States"), "US"));
test("6. 'US Remote' -> US", () => assert.equal(classifyJobLocation("US Remote"), "US"));
test("7. 'Austin, TX / Remote' -> US", () => assert.equal(classifyJobLocation("Austin, TX / Remote"), "US"));

// 8-11. Newly supported unspaced STATE-CITY
test("8. 'GA-ATLANTA' -> US (the exact Stage 14-discovered Workday case)", () => assert.equal(classifyJobLocation("GA-ATLANTA"), "US"));
test("9. 'TX-AUSTIN' -> US", () => assert.equal(classifyJobLocation("TX-AUSTIN"), "US"));
test("10. 'CA-SAN FRANCISCO' -> US (multi-word city)", () => assert.equal(classifyJobLocation("CA-SAN FRANCISCO"), "US"));
test("11. 'NY-NEW YORK' -> US", () => assert.equal(classifyJobLocation("NY-NEW YORK"), "US"));

// 12-15. False-positive protection
test("12. 'IN-PERSON' must NOT become US merely because IN is Indiana", () => assert.equal(classifyJobLocation("IN-PERSON"), "UNKNOWN"));
test("13. 'OR-REMOTE' must NOT become US merely because OR is Oregon", () => assert.equal(classifyJobLocation("OR-REMOTE"), "UNKNOWN"));
test("14. an arbitrary/invalid two-letter prefix must not imply US", () => assert.equal(classifyJobLocation("ZZ-SOMEWHERE"), "UNKNOWN"));
test("15. a malformed/empty location remains UNKNOWN", () => {
  assert.equal(classifyJobLocation(""), "UNKNOWN");
  assert.equal(classifyJobLocation(null), "UNKNOWN");
  assert.equal(classifyJobLocation(undefined), "UNKNOWN");
  assert.equal(classifyJobLocation("   "), "UNKNOWN");
});

// 16-18. Non-US
test("16. 'Toronto, Canada' -> NON_US", () => assert.equal(classifyJobLocation("Toronto, Canada"), "NON_US"));
test("17. 'London, UK' -> NON_US", () => assert.equal(classifyJobLocation("London, UK"), "NON_US"));
test("18. 'Bengaluru, India' -> NON_US", () => assert.equal(classifyJobLocation("Bengaluru, India"), "NON_US"));

// 19-22. Remote ambiguity
test("19. bare 'Remote' -> UNKNOWN", () => assert.equal(classifyJobLocation("Remote"), "UNKNOWN"));
test("20. 'Worldwide Remote' must NOT become US", () => assert.equal(classifyJobLocation("Worldwide Remote"), "UNKNOWN"));
test("21. 'Remote-US' -> US", () => assert.equal(classifyJobLocation("Remote-US"), "US"));
test("22. 'US-Remote' -> US", () => assert.equal(classifyJobLocation("US-Remote"), "US"));

// Real production Workday evidence (Stage 14/15's own discovered cases) — the exact strings pulled
// from data/app.db for Elevance Health, Inc. (workday) job listings.
test("Real evidence: 'GA-ATLANTA, 740 W PEACHTREE ST NW' -> US", () =>
  assert.equal(classifyJobLocation("GA-ATLANTA, 740 W PEACHTREE ST NW"), "US"));
test("Real evidence: 'VA-NORFOLK, 5800 NORTHAMPTON BLVD' -> US", () =>
  assert.equal(classifyJobLocation("VA-NORFOLK, 5800 NORTHAMPTON BLVD"), "US"));
test("Real evidence: 'CT-ROCKY HILL, 500 ENTERPRISE DR, 3RD FL' -> US", () =>
  assert.equal(classifyJobLocation("CT-ROCKY HILL, 500 ENTERPRISE DR, 3RD FL"), "US"));
test("Real evidence: 'MI-DEARBORN, 15350 COMMERCE DR N, STE 202 & 210' -> US", () =>
  assert.equal(classifyJobLocation("MI-DEARBORN, 15350 COMMERCE DR N, STE 202 & 210"), "US"));
test("Real evidence: 'IN-INDIANAPOLIS, 220 VIRGINIA AVE' -> US (Indiana IS the correct state here)", () =>
  assert.equal(classifyJobLocation("IN-INDIANAPOLIS, 220 VIRGINIA AVE"), "US"));
