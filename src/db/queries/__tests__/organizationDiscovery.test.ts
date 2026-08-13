import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let createOrganization: typeof import("../organizationRegistry").createOrganization;
let nextOrganizationsForDiscovery: typeof import("../organizationDiscovery").nextOrganizationsForDiscovery;
let recordOrganizationDiscoveryState: typeof import("../organizationDiscovery").recordOrganizationDiscoveryState;
let organizationDiscoveryCounts: typeof import("../organizationDiscovery").organizationDiscoveryCounts;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-org-discovery-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ createOrganization } = await import("../organizationRegistry"));
  ({ nextOrganizationsForDiscovery, recordOrganizationDiscoveryState, organizationDiscoveryCounts } =
    await import("../organizationDiscovery"));
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const unresolvedDomain = {
  status: "UNRESOLVED" as const,
  domain: null,
  method: "unresolved" as const,
  confidence: null,
  evidence: ["no_verified_candidate"],
  channelsChecked: {
    jsonLd: "not_checked" as const,
    footer: "not_checked" as const,
    aboutPage: "not_checked" as const,
    termsPrivacyPage: "not_checked" as const,
  },
  careersEvidence: null,
};

test("registry discovery includes PERM-only/no-H1B organizations and checkpoints terminal outcomes", () => {
  const organization = createOrganization("PERM Only Example LLC");
  assert.ok(nextOrganizationsForDiscovery(100).some((row) => row.organizationId === organization.id));

  recordOrganizationDiscoveryState({
    organizationId: organization.id,
    resolvedCompanyId: null,
    domain: unresolvedDomain,
    source: null,
  });

  assert.ok(!nextOrganizationsForDiscovery(100).some((row) => row.organizationId === organization.id));
  assert.deepEqual(organizationDiscoveryCounts(), { searched: 1, pending: 0 });
});

test("temporary failures become retryable only after the cooldown", () => {
  const organization = createOrganization("Temporary Network Example LLC");
  recordOrganizationDiscoveryState({
    organizationId: organization.id,
    resolvedCompanyId: null,
    domain: { ...unresolvedDomain, status: "FAILED_TEMPORARY" },
    source: null,
  });
  assert.ok(!nextOrganizationsForDiscovery(100).some((row) => row.organizationId === organization.id));

  getDb().prepare(
    "UPDATE organization_discovery_state SET attempted_at = datetime('now', '-2 days') WHERE organization_id = ?"
  ).run(organization.id);
  assert.ok(nextOrganizationsForDiscovery(100).some((row) => row.organizationId === organization.id));
});

test("unsearched organizations outrank cooldown retries in the final bounded batch", () => {
  const retry = createOrganization("Old Temporary Retry LLC");
  recordOrganizationDiscoveryState({
    organizationId: retry.id,
    resolvedCompanyId: null,
    domain: { ...unresolvedDomain, status: "FAILED_TEMPORARY" },
    source: null,
  });
  getDb().prepare(
    "UPDATE organization_discovery_state SET attempted_at = datetime('now', '-2 days') WHERE organization_id = ?"
  ).run(retry.id);

  const neverAttempted = createOrganization("Final Unsearched Organization LLC");
  const [selected] = nextOrganizationsForDiscovery(1);

  assert.equal(selected.organizationId, neverAttempted.id);
});
