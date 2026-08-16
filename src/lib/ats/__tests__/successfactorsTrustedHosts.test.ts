import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSuccessFactorsToken } from "@/lib/ats/successfactors";
import { SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS } from "@/lib/ats/successfactorsTrustedHosts";

/**
 * CAREEROPS — SUCCESSFACTORS PHASE 3: verifies the trust map's contents directly (the generic
 * trustedCustomHost mechanism itself — acceptance, rejection, no cross-tenant leakage, credential
 * rejection — is already covered end-to-end against real HTTP fixtures in successfactors.test.ts;
 * this file only proves the MAP entries are exactly what Phase 3's evidence supports).
 */

test("Phase 3: Popular, Inc.'s exact token resolves to its verified custom host", () => {
  const token = normalizeSuccessFactorsToken("career4.successfactors.com|Popularinc");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "jobs.popular.com");
});

test("Phase 3: Talis Clinical's exact token resolves to its verified (parent-organization) custom host", () => {
  const token = normalizeSuccessFactorsToken("career5.successfactors.eu|GetingeProd");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "careers.getinge.com");
});

test("Phase 3: Perdue AgriBusiness's exact token resolves to its verified (family-portal) custom host", () => {
  const token = normalizeSuccessFactorsToken("career4.successfactors.com|PerdueFarms");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "jobs.perduecareers.com");
});

test("Phase 3: a different tenant's token does not inherit another tenant's trusted host", () => {
  // Same SuccessFactors host (career4.successfactors.com) as Popular/Perdue, but a different
  // company identifier that has no entry at all — the map is keyed per-tenant, not per-host, so a
  // sibling tenant on the same shared SAP host must not resolve to anyone else's trusted value.
  const unrelatedToken = normalizeSuccessFactorsToken("career4.successfactors.com|SomeOtherTenant");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[unrelatedToken], undefined);
});

test("Phase 4: Tellus Products' exact token resolves to its verified (parent-organization) custom host", () => {
  const token = normalizeSuccessFactorsToken("career4.successfactors.com|634633P");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "careers.fcc-asrgroup.com");
});

test("Phase 4: a different tenant on the same shared SAP host does not inherit Tellus's trusted host", () => {
  // Tellus is on career4.successfactors.com — the same host as Popular/Perdue/several Phase 2
  // entries. An unrelated company identifier on that same shared host must not resolve to Tellus's
  // (or anyone else's) trusted value — the map is keyed per-tenant, never per-host.
  const unrelatedToken = normalizeSuccessFactorsToken("career4.successfactors.com|NotTellusAtAll");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[unrelatedToken], undefined);
});

test("Phase 2/3 entries remain unchanged after the Phase 4 addition", () => {
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS["career8.successfactors.com|S003808746P"], "jobs.nscorp.com");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS["career4.successfactors.com|southwireP"], "careers.southwire.com");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS["career4.successfactors.com|Popularinc"], "jobs.popular.com");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS["career5.successfactors.eu|GetingeProd"], "careers.getinge.com");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS["career4.successfactors.com|PerdueFarms"], "jobs.perduecareers.com");
});

test("Connector Reliability Final Hardening: LEAR CORPORATION's exact token resolves to its verified (TLS-certificate-confirmed) custom host", () => {
  const token = normalizeSuccessFactorsToken("career5.successfactors.eu|learcorporP2");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "jobs.lear.com");
});

test("the trust map has exactly the expected number of entries (13 from Phase 2/3/4 + 1 for LEAR CORPORATION)", () => {
  assert.equal(Object.keys(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS).length, 14);
});
