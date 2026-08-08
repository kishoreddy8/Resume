#!/usr/bin/env node
// Renders a generated .docx visually via docx-preview (client-side, no LibreOffice needed) and
// screenshots it with Playwright. This is how the tab-stop bug (a literal "\t" character instead
// of a real <w:tab/> element — invisible in the raw code, invisible in a "looks right" review of
// the XML) was actually found: it never right-aligned in a real render. Run this after any change
// to resume-template.ts / cover-letter-template.ts, and spot-check any content run that looks off.
//
// Usage: node .claude/skills/tailor-resume/engine/visual-check/screenshot.mjs <path-to.docx> [out.png]
//
// Honest limitation: docx-preview renders continuously (no true page-break reflow), so the
// resulting height is a page-COUNT ESTIMATE (total rendered height / page height), not verified
// real pagination — it will not show exactly where Word would break page 1 from page 2.

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const targetDocx = process.argv[2];
const outPng = process.argv[3] ?? path.join(process.cwd(), "visual-check.png");
if (!targetDocx) {
  console.error("Usage: node screenshot.mjs <path-to.docx> [out.png]");
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-visual-check-"));
fs.copyFileSync(path.join(__dirname, "index.html"), path.join(tmpDir, "index.html"));
fs.copyFileSync(
  path.join(PROJECT_ROOT, "node_modules/jszip/dist/jszip.min.js"),
  path.join(tmpDir, "jszip.min.js")
);
fs.copyFileSync(
  path.join(PROJECT_ROOT, "node_modules/docx-preview/dist/docx-preview.min.js"),
  path.join(tmpDir, "docx-preview.min.js")
);
fs.copyFileSync(targetDocx, path.join(tmpDir, "target.docx"));

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const server = http.createServer((req, res) => {
  const filePath = path.join(tmpDir, decodeURIComponent(req.url === "/" ? "/index.html" : req.url));
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  });
});

const port = await new Promise((resolve) => {
  server.listen(0, () => resolve(server.address().port));
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForFunction("window.renderDone === true", { timeout: 15000 });
  await page.waitForTimeout(1000); // let docx-preview's async tab-stop pass finish
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(500);

  const err = await page.evaluate("window.renderError || null");
  if (err) {
    console.error("Render error:", err);
    process.exitCode = 1;
  } else {
    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".docx")).map((el) => el.getBoundingClientRect().height)
    );
    const totalHeightPx = boxes.reduce((a, b) => a + b, 0);
    const pageHeightPx = 1400 * (11 / 14.58); // rough US-Letter-at-this-viewport-width estimate
    console.log(`Rendered content height: ${totalHeightPx.toFixed(0)}px (~${(totalHeightPx / pageHeightPx).toFixed(1)} pages estimated)`);
    console.log("NOTE: this is a continuous-render height estimate, not verified page-break placement.");
    await page.screenshot({ path: outPng, fullPage: true });
    console.log(`Wrote ${outPng}`);
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
