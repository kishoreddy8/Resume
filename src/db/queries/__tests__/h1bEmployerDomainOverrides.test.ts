import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let findDomainOverride: typeof import("../h1bEmployerDomainOverrides").findDomainOverride;
let addDomainOverride: typeof import("../h1bEmployerDomainOverrides").addDomainOverride;
let listDomainOverrides: typeof import("../h1bEmployerDomainOverrides").listDomainOverrides;
let removeDomainOverride: typeof import("../h1bEmployerDomainOverrides").removeDomainOverride;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-domain-overrides-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ findDomainOverride, addDomainOverride, listDomainOverrides, removeDomainOverride } =
    await import("../h1bEmployerDomainOverrides"));
  const { getDb } = await import("../../index");
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("empty by default — never auto-seeded", () => {
  assert.deepEqual(listDomainOverrides(), []);
});

test("addDomainOverride curates a mapping, findDomainOverride reads it back", () => {
  addDomainOverride({ employerNameNormalized: "MICROSOFT", domain: "microsoft.com", notes: "manually reviewed" });
  const found = findDomainOverride("MICROSOFT");
  assert.ok(found);
  assert.equal(found!.domain, "microsoft.com");
  assert.equal(found!.notes, "manually reviewed");
});

test("re-approving the same employer upserts rather than duplicating", () => {
  addDomainOverride({ employerNameNormalized: "MICROSOFT", domain: "microsoft.com", notes: "updated note" });
  const all = listDomainOverrides().filter((o) => o.employer_name_normalized === "MICROSOFT");
  assert.equal(all.length, 1);
  assert.equal(all[0].notes, "updated note");
});

test("findDomainOverride returns undefined for an uncurated employer", () => {
  assert.equal(findDomainOverride("SOME RANDOM COMPANY"), undefined);
});

test("removeDomainOverride deletes the curated mapping", () => {
  addDomainOverride({ employerNameNormalized: "TEMP CO", domain: "tempco.com" });
  assert.ok(findDomainOverride("TEMP CO"));
  removeDomainOverride("TEMP CO");
  assert.equal(findDomainOverride("TEMP CO"), undefined);
});
