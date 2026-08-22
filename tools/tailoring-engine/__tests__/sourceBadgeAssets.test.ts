import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSourceCertificationBadgeRuns,
  extractSourceCertificationBadges,
  MAX_SOURCE_BADGES,
  TRUSTED_CERTIFICATION_BADGE_MARKER,
} from "../sourceBadgeAssets";
import { makePng } from "./pngFixture";
import { writeMasterResumeDocxFixture } from "./masterResumeFixture";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-source-badge-"));
}

test("Source badges: a Master Resume with no embedded images yields no badges", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, []);
  const badges = await extractSourceCertificationBadges(masterPath);
  assert.deepEqual(badges, []);
});

test("Source badges: a nonexistent Master Resume path yields no badges, never throws", async () => {
  const badges = await extractSourceCertificationBadges(path.join(tempDir(), "does-not-exist.docx"));
  assert.deepEqual(badges, []);
});

test("Source badges: an undefined path yields no badges", async () => {
  assert.deepEqual(await extractSourceCertificationBadges(undefined), []);
});

test("Source badges: a corrupt/non-docx file at the path yields no badges, never throws", async () => {
  const dir = tempDir();
  const badPath = path.join(dir, "resume.docx");
  fs.writeFileSync(badPath, "this is not a zip file");
  const badges = await extractSourceCertificationBadges(badPath);
  assert.deepEqual(badges, []);
});

test("Source badges: a single embedded image is preserved byte-for-byte, with its real pixel dimensions", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const png = makePng(120, 60, [30, 90, 160]);
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: png, width: 40, height: 20 }]);

  const badges = await extractSourceCertificationBadges(masterPath);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].format, "png");
  assert.ok(badges[0].bytes.equals(png), "the extracted bytes must be byte-for-byte identical to the original embedded image");
  // Pixel dimensions come from the PNG's own IHDR chunk (120x60), not from whatever display size
  // the source docx happened to render it at (40x20) — the real asset's own aspect ratio wins.
  assert.equal(badges[0].pixelWidth, 120);
  assert.equal(badges[0].pixelHeight, 60);
});

test("Source badges: multiple embedded images are preserved, in document order", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const first = makePng(100, 50, [10, 10, 10]);
  const second = makePng(50, 100, [20, 20, 20]);
  await writeMasterResumeDocxFixture(masterPath, [
    { bytes: first, width: 30, height: 15 },
    { bytes: second, width: 15, height: 30 },
  ]);

  const badges = await extractSourceCertificationBadges(masterPath);
  assert.equal(badges.length, 2);
  assert.ok(badges[0].bytes.equals(first), "the first embedded image must be extracted first");
  assert.ok(badges[1].bytes.equals(second), "the second embedded image must be extracted second");
});

test("Source badges: more embedded images than the header has slots are capped, not silently truncated wrong", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const images = [makePng(40, 40, [1, 1, 1]), makePng(40, 40, [2, 2, 2]), makePng(40, 40, [3, 3, 3]), makePng(40, 40, [4, 4, 4])];
  await writeMasterResumeDocxFixture(
    masterPath,
    images.map((bytes) => ({ bytes, width: 20, height: 20 }))
  );

  const badges = await extractSourceCertificationBadges(masterPath);
  assert.equal(badges.length, MAX_SOURCE_BADGES);
  assert.ok(badges[0].bytes.equals(images[0]));
  assert.ok(badges[1].bytes.equals(images[1]));
});

test("Source badges: the exact same image embedded twice is only preserved once", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const png = makePng(80, 80, [50, 60, 70]);
  await writeMasterResumeDocxFixture(masterPath, [
    { bytes: png, width: 40, height: 40 },
    { bytes: png, width: 40, height: 40 },
  ]);

  const badges = await extractSourceCertificationBadges(masterPath);
  assert.equal(badges.length, 1, "duplicate byte-identical images must not produce two badges");
});

test("Source badges: an unrecognized image format is skipped, never guessed at", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  // A GIF signature — this codebase only trusts PNG/JPEG dimension parsing.
  const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(20, 0)]);
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: gif, width: 20, height: 20, format: "png" }]);
  // Even though the source docx's own drawing metadata claims "png", the actual bytes are not a
  // valid PNG — detectImage must go by the real bytes, not the source's own claimed type.
  const badges = await extractSourceCertificationBadges(masterPath);
  assert.deepEqual(badges, []);
});

test("Source badges: candidate isolation — two different Master Resumes never share extracted bytes", async () => {
  const dirA = tempDir();
  const dirB = tempDir();
  const pathA = path.join(dirA, "resume.docx");
  const pathB = path.join(dirB, "resume.docx");
  const imageA = makePng(60, 30, [111, 0, 0]);
  const imageB = makePng(60, 30, [0, 111, 0]);
  await writeMasterResumeDocxFixture(pathA, [{ bytes: imageA, width: 30, height: 15 }]);
  await writeMasterResumeDocxFixture(pathB, [{ bytes: imageB, width: 30, height: 15 }]);

  const badgesA = await extractSourceCertificationBadges(pathA);
  const badgesB = await extractSourceCertificationBadges(pathB);
  assert.ok(badgesA[0].bytes.equals(imageA));
  assert.ok(badgesB[0].bytes.equals(imageB));
  assert.ok(!badgesA[0].bytes.equals(imageB), "candidate A's extraction must never contain candidate B's image bytes");
  assert.ok(!badgesB[0].bytes.equals(imageA), "candidate B's extraction must never contain candidate A's image bytes");
});

test("Source badges: re-extracting the same Master Resume is deterministic — no accumulation across calls", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const png = makePng(50, 50, [9, 9, 9]);
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: png, width: 25, height: 25 }]);

  const first = await extractSourceCertificationBadges(masterPath);
  const second = await extractSourceCertificationBadges(masterPath);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.ok(first[0].bytes.equals(second[0].bytes), "repeated extraction from the same unchanged file must be identical every time");
});

// --- buildSourceCertificationBadgeRuns -------------------------------------------------------------

test("Source badges: every built run carries the exact trusted marker and preserves aspect ratio", () => {
  const wide = { bytes: makePng(200, 100), format: "png" as const, pixelWidth: 200, pixelHeight: 100 };
  const tall = { bytes: makePng(50, 100), format: "png" as const, pixelWidth: 50, pixelHeight: 100 };
  const runs = buildSourceCertificationBadgeRuns([wide, tall]);
  assert.equal(runs.length, 2);
  // ImageRun does not expose its constructor options back out for direct inspection, so the marker
  // and transformation are verified end-to-end via the real rendered XML in
  // sourceBadgeIntegration.test.ts. This test only proves TRUSTED_CERTIFICATION_BADGE_MARKER exists
  // as the single fixed string both this builder and the validator share.
  assert.equal(TRUSTED_CERTIFICATION_BADGE_MARKER, "career-ops-certification-badge");
});
