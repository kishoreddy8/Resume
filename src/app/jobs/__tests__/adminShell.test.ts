import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ADMIN_STATUSES, ADMIN_STATUS_PRESENTATION } from "@/lib/admin/status";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");

test("Admin navigation exposes the final eight operational destinations without candidate duplication", () => {
  const source = read("src/components/AppSidebar.tsx");
  const expected = [
    ["/admin", "Overview"],
    ["/admin/companies", "Companies"],
    ["/admin/scanner", "Scanner"],
    ["/admin/writer", "Resume Writer"],
    ["/admin/applications", "Applications"],
    ["/admin/operations", "Operations"],
    ["/admin/settings", "Settings"],
    ["/admin/activity", "Activity"],
  ] as const;
  for (const [href, label] of expected) {
    assert.match(source, new RegExp(`href: "${href.replaceAll("/", "\\/")}", label: "${label}"`));
  }
  assert.doesNotMatch(source, /label: "Pipeline"/);
  assert.doesNotMatch(source, /label: "Configuration"/);
  assert.doesNotMatch(source, /label: "Health"/);
});

test("Admin mobile navigation uses a modal drawer with labelled, keyboard-dismissable controls", () => {
  const source = read("src/components/AppSidebar.tsx");
  assert.match(source, /adminDialogRef/);
  assert.match(source, /\.showModal\(\)/);
  assert.match(source, /onCancel=/);
  assert.match(source, /aria-label="Admin navigation"/);
  assert.match(source, /aria-current=\{active \? "page"/);
  assert.match(source, /min-h-12/);
});

test("shared confirmation dialog uses native modal focus containment and restores focus", () => {
  const source = read("src/components/admin/AdminPrimitives.tsx");
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /previousFocus\.current/);
  assert.match(source, /onCancel=/);
  assert.match(source, /type="button"/);
  assert.doesNotMatch(source, /confirm\(/);
});

test("Admin status vocabulary always supplies text, symbol, and tone", () => {
  assert.equal(ADMIN_STATUSES.length, 14);
  for (const status of ADMIN_STATUSES) {
    const presentation = ADMIN_STATUS_PRESENTATION[status];
    assert.ok(presentation.label.length > 0);
    assert.ok(presentation.symbol.length > 0);
    assert.ok(presentation.tone.length > 0);
  }
});

test("Admin typography remains readable and is scoped away from candidate UI", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.admin-product/);
  assert.match(css, /font-size: clamp\(28px, 2vw, 32px\)/);
  assert.match(css, /\.admin-table \{[\s\S]*?font-size: 15px/);
  assert.match(css, /\.admin-status \{[\s\S]*?font-size: 13px/);
  assert.match(css, /min-height: 44px/);

  const sidebar = read("src/components/AppSidebar.tsx");
  assert.match(sidebar, /const USER_NAV/);
  assert.match(sidebar, /href: "\/home", label: "Home"/);
  assert.match(sidebar, /href: "\/jobs", label: "Jobs"/);
});
