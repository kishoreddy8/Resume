import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { normalizeAdminStatus, ADMIN_STATUSES, ADMIN_STATUS_PRESENTATION } from "@/lib/admin/status";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");

test("1. Admin navigation exposes operational destinations and preserves sidebar accessibility", () => {
  const sidebar = read("src/components/AppSidebar.tsx");
  assert.match(sidebar, /href: "\/admin", label: "Overview"/);
  assert.match(sidebar, /href: "\/admin\/companies", label: "Companies"/);
  assert.match(sidebar, /href: "\/admin\/scanner", label: "Scanner"/);
  assert.match(sidebar, /href: "\/admin\/writer", label: "Resume Writer"/);
  assert.match(sidebar, /href: "\/admin\/applications", label: "Applications"/);
  assert.match(sidebar, /href: "\/admin\/operations", label: "Operations"/);
  assert.match(sidebar, /href: "\/admin\/settings", label: "Settings"/);
  assert.match(sidebar, /href: "\/admin\/activity", label: "Activity"/);
  assert.match(sidebar, /aria-current=\{active \? "page" : undefined\}/);
});

test("2. Enabled controls fire existing API endpoints with proper payloads", () => {
  const scanner = read("src/app/admin/scanner/page.tsx");
  const companies = read("src/app/admin/companies/page.tsx");
  const settings = read("src/app/admin/settings/page.tsx");
  const ops = read("src/app/admin/operations/page.tsx");

  // Scanner calls discover, scan, approve/reject
  assert.match(scanner, /fetch\(\s*`\/api\/companies\/\$\{requestCompany\}\/discover/);
  assert.match(scanner, /fetch\(`\/api\/scan\?candidateId=/);
  assert.match(scanner, /fetch\(\s*`\/api\/companies\/\$\{proposal\.company_id\}\/source-proposals\/\$\{proposal\.id\}\/\$\{action\}/);

  // Companies calls scan, toggle, delete
  assert.match(companies, /fetch\(`\/api\/scan\?candidateId=/);
  assert.match(companies, /fetch\(\s*url,\s*confirm\.action === "delete"/);

  // Settings saves patched groups
  assert.match(settings, /fetch\(`\/api\/settings\?candidateId=/);
  assert.match(settings, /method:\s*"PATCH"/);

  // Operations calls production cycle
  assert.match(ops, /fetch\(`\/api\/production-cycle\?candidateId=/);
});

test("3. Disabled controls expose reasons and clear explanations in the UI", () => {
  const scanner = read("src/app/admin/scanner/page.tsx");
  const companies = read("src/app/admin/companies/page.tsx");

  // Proposal approval disabled explanation
  assert.match(scanner, /Requires HIGH confidence & VALIDATED_JOBS status/);
  assert.match(scanner, /title=\{[\s\S]*?Cannot approve: Proposal is not high confidence/);

  // Paused company scan disabled tooltip
  assert.match(companies, /Company is paused\. Resume company before scanning\./);
});

test("4. Missing prerequisites show clear actionable guidance cards", () => {
  const scanner = read("src/app/admin/scanner/page.tsx");
  const writer = read("src/app/admin/writer/page.tsx");

  assert.match(scanner, /<AdminGuidanceCard/);
  assert.match(scanner, /title="Automatic Scanning Disabled"/);
  assert.match(scanner, /href="\/admin\/settings"/);

  assert.match(writer, /<AdminGuidanceCard/);
  assert.match(writer, /title="Resume Writer Automation Disabled"/);
  assert.match(writer, /href="\/admin\/settings"/);
});

test("5. Status labels are normalized, truthful, and render accessible text and symbols", () => {
  assert.equal(normalizeAdminStatus("ready"), "healthy");
  assert.equal(normalizeAdminStatus("active"), "healthy");
  assert.equal(normalizeAdminStatus("stopped"), "disabled");
  assert.equal(normalizeAdminStatus("paused"), "disabled");
  assert.equal(normalizeAdminStatus("error"), "failed");
  assert.equal(normalizeAdminStatus("down"), "offline");
  assert.equal(normalizeAdminStatus("warning"), "degraded");
  assert.equal(normalizeAdminStatus("recovering"), "degraded");

  for (const status of ADMIN_STATUSES) {
    const p = ADMIN_STATUS_PRESENTATION[status];
    assert.ok(p.label.length > 0);
    assert.ok(p.symbol.length > 0);
  }

  const primitives = read("src/components/admin/AdminPrimitives.tsx");
  assert.match(primitives, /role="status"/);
  assert.match(primitives, /aria-hidden="true"/);
});

test("6. Loading states prevent duplicate clicks and indicate in-flight work", () => {
  const scanner = read("src/app/admin/scanner/page.tsx");
  const companies = read("src/app/admin/companies/page.tsx");
  const settings = read("src/app/admin/settings/page.tsx");

  assert.match(scanner, /disabled=\{!requestCompany \|\| busy\}/);
  assert.match(scanner, /\{busy \? "Discovering…" : "Request Connector Review"\}/);

  assert.match(companies, /disabled=\{isScanningThis \|\| !c\.isActive\}/);
  assert.match(companies, /\{isScanningThis \? "Scanning…" : "Scan"\}/);

  assert.match(settings, /disabled=\{saving === "scheduler" \|\| !isGroupDirty\("scheduler"\)\}/);
  assert.match(settings, /\{saving === "scheduler" \? "Saving…" : "Save Automation"\}/);
});

test("7. Successful mutations update the UI with feedback banners and reset dirty state", () => {
  const scanner = read("src/app/admin/scanner/page.tsx");
  const companies = read("src/app/admin/companies/page.tsx");
  const settings = read("src/app/admin/settings/page.tsx");

  assert.match(scanner, /setFeedback\(/);
  assert.match(scanner, /<AdminFeedbackBanner/);

  assert.match(companies, /setFeedback\(/);
  assert.match(companies, /<AdminFeedbackBanner/);

  assert.match(settings, /setFeedback\(`Section "\$\{group\}" settings saved successfully\.\`\)/);
  assert.match(settings, /isGroupDirty/);
});

test("8. Failures surface safe, human-readable error banners", () => {
  const primitives = read("src/components/admin/AdminPrimitives.tsx");
  assert.match(primitives, /AdminFeedbackBanner/);
  assert.match(primitives, /AdminErrorState/);
  assert.match(primitives, /role="alert"/);
});

test("9. Destructive or heavy operations use AdminConfirmDialog without bypassing guards", () => {
  const ops = read("src/app/admin/operations/page.tsx");
  const companies = read("src/app/admin/companies/page.tsx");
  const scanner = read("src/app/admin/scanner/page.tsx");

  assert.match(ops, /<AdminConfirmDialog[\s\S]*?title="Run Full Production Cycle\?"/);
  assert.match(companies, /<AdminConfirmDialog[\s\S]*?confirm\?\.action === "delete"/);
  assert.match(scanner, /<AdminConfirmDialog[\s\S]*?title="Approve Validated Connector Source\?"/);
});

test("10. Candidate/Admin product boundary and layout separation is preserved", () => {
  const layout = read("src/app/admin/layout.tsx");
  assert.match(layout, /AdminCandidateProvider/);
  assert.match(layout, /Admin access required/);
  assert.match(layout, /isOwner/);

  const shell = read("src/components/AppShell.tsx");
  assert.match(shell, /pathname\.startsWith\("\/admin"\) \? "admin-product" : "candidate-product"/);
});

test("11. No sensitive secrets or API keys are rendered in settings or diagnostics", () => {
  const settings = read("src/app/admin/settings/page.tsx");
  assert.doesNotMatch(settings, /apiKey/i);
  assert.doesNotMatch(settings, /secret/i);
  assert.match(settings, /Runtime state and secrets are never editable here|Candidate Profile is authoritative|Make sure your model API keys are configured in the environment/);
});

test("12. Admin overview quick links and health tiles route to proper sub-consoles", () => {
  const overview = read("src/app/admin/page.tsx");
  assert.match(overview, /href="\/admin\/operations"/);
  assert.match(overview, /href="\/admin\/scanner"/);
  assert.match(overview, /href="\/admin\/writer"/);
  assert.match(overview, /href="\/admin\/applications"/);
  assert.match(overview, /href="\/admin\/activity"/);
});

test("13. Typography classes and scale satisfy Admin readability targets", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.admin-page-header h1 \{[\s\S]*?font-size: clamp\(28px, 2vw, 32px\)/);
  assert.match(css, /\.admin-section-title \{[\s\S]*?font-size: clamp\(20px, 1.4vw, 22px\)/);
  assert.match(css, /\.admin-table \{[\s\S]*?font-size: 15px/);
  assert.match(css, /\.admin-button \{[\s\S]*?min-height: 44px/);
  assert.match(css, /\.admin-status \{[\s\S]*?font-size: 13px/);
});

test("14. Form inputs have associated labels and accessible focus states", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.admin-filter-bar input:focus/);
  assert.match(css, /\.admin-field select:focus/);

  const settings = read("src/app/admin/settings/page.tsx");
  assert.match(settings, /<label className="admin-field">/);
  assert.match(settings, /<span>/);
});

test("15. Table regions support accessible scrolling without cramped layouts", () => {
  const primitives = read("src/components/admin/AdminPrimitives.tsx");
  assert.match(primitives, /className="admin-table-scroll"/);
  assert.match(primitives, /role="region"/);
  assert.match(primitives, /tabIndex=\{0\}/);
  assert.match(primitives, /aria-label=\{label\}/);
});
