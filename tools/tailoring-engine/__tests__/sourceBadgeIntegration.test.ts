import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { Document, ImageRun, Packer, Paragraph, HorizontalPositionAlign, HorizontalPositionRelativeFrom, VerticalPositionAlign, VerticalPositionRelativeFrom } from "docx";
import { FIXTURES } from "../fixtures/index";
import { generateResumeDocx } from "../resume-template";
import { validateDocx } from "../validate-docx";
import { TRUSTED_CERTIFICATION_BADGE_MARKER } from "../sourceBadgeAssets";
import { makePng } from "./pngFixture";
import { writeMasterResumeDocxFixture } from "./masterResumeFixture";
import type { ResumeContent } from "../types";

const fixture = FIXTURES[0];

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-source-badge-integration-"));
}

function resumeWith(overrides: Partial<ResumeContent>): ResumeContent {
  return { ...fixture.resume, ...overrides };
}

async function documentXml(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  return zip.file("word/document.xml")!.async("string");
}

async function mediaBuffers(filePath: string): Promise<Buffer[]> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const mediaFiles = Object.keys(zip.files).filter((f) => /^word\/media\//.test(f) && !f.endsWith("/"));
  const out: Buffer[] = [];
  for (const f of mediaFiles.sort()) out.push(await zip.file(f)!.async("nodebuffer"));
  return out;
}

async function docxText(filePath: string): Promise<string> {
  const xml = await documentXml(filePath);
  return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const CERTS = ["Microsoft Certified: Azure Data Engineer Associate (DP-203)", "AWS Certified Cloud Practitioner"];

test("Source badges: preserved images win over the generic text-card fallback", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const badgeA = makePng(120, 60, [31, 78, 121]);
  const badgeB = makePng(60, 60, [43, 58, 74]);
  await writeMasterResumeDocxFixture(masterPath, [
    { bytes: badgeA, width: 40, height: 20 },
    { bytes: badgeB, width: 20, height: 20 },
  ]);

  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: CERTS }), outputPath, { masterResumeDocxPath: masterPath });

  const media = await mediaBuffers(outputPath);
  assert.equal(media.length, 2, "both preserved source images must be embedded in the output");
  assert.ok(media.some((b) => b.equals(badgeA)), "the first source badge's exact bytes must be present");
  assert.ok(media.some((b) => b.equals(badgeB)), "the second source badge's exact bytes must be present");

  const text = await docxText(outputPath);
  assert.doesNotMatch(text, /AZURE CERTIFIED|AWS CERTIFIED/, "the generic text-card fallback must not render when real source badges exist");

  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, true, `trusted source badges must validate cleanly: ${JSON.stringify(validation.violations)}`);
});

test("Source badges: image order is preserved end to end (headline badge first, contact badge second)", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const first = makePng(100, 50, [10, 10, 10]);
  const second = makePng(50, 100, [20, 20, 20]);
  await writeMasterResumeDocxFixture(masterPath, [
    { bytes: first, width: 30, height: 15 },
    { bytes: second, width: 15, height: 30 },
  ]);

  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: CERTS }), outputPath, { masterResumeDocxPath: masterPath });

  const xml = await documentXml(outputPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const relsXml = await zip.file("word/_rels/document.xml.rels")!.async("string");
  const relTargets = new Map([...relsXml.matchAll(/<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2]]));

  const embedIds = [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)].map((m) => m[0].match(/r:embed="([^"]+)"/)![1]);
  assert.equal(embedIds.length, 2);
  const bytesInOrder: Buffer[] = [];
  for (const rId of embedIds) {
    const target = relTargets.get(rId)!;
    bytesInOrder.push(await zip.file("word/" + target.replace(/^\.?\//, ""))!.async("nodebuffer"));
  }
  assert.ok(bytesInOrder[0].equals(first), "the headline-line badge must be the FIRST source image (document order)");
  assert.ok(bytesInOrder[1].equals(second), "the contact-line badge must be the SECOND source image (document order)");
});

test("Source badges: aspect ratio is preserved (not distorted to a square)", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  const wide = makePng(300, 100, [5, 5, 5]); // 3:1
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: wide, width: 30, height: 10 }]);

  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), outputPath, { masterResumeDocxPath: masterPath });

  const xml = await documentXml(outputPath);
  const extentMatch = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(extentMatch, "expected an image extent in the output");
  const cx = Number(extentMatch![1]);
  const cy = Number(extentMatch![2]);
  const renderedRatio = cx / cy;
  assert.ok(Math.abs(renderedRatio - 3) < 0.15, `rendered aspect ratio ${renderedRatio} should stay close to the source's 3:1 ratio`);
});

test("Source badges: top-right placement — reached via a real right tab stop, never a table", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: makePng(60, 60), width: 30, height: 30 }]);

  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), outputPath, { masterResumeDocxPath: masterPath });

  const xml = await documentXml(outputPath);
  assert.match(xml, /<w:tab\/>/);
  assert.match(xml, /<w:tab w:val="right" w:pos="10512"\/>/);
  assert.doesNotMatch(xml, /<w:tbl>/, "top-right placement must never use a table");
});

test("Source badges: the candidate's name paragraph is completely unaffected", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, [
    { bytes: makePng(60, 60), width: 30, height: 30 },
    { bytes: makePng(60, 60, [1, 2, 3]), width: 30, height: 30 },
  ]);

  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: CERTS }), outputPath, { masterResumeDocxPath: masterPath });

  const xml = await documentXml(outputPath);
  const firstParagraph = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/)?.[0] ?? "";
  const firstParagraphText = [...firstParagraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("");
  assert.equal(firstParagraphText, fixture.resume.name);
  assert.doesNotMatch(firstParagraph, /<w:drawing>/, "the name paragraph must never carry an embedded image");
});

test("Source badges: ATS certification text is preserved regardless of image presence", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: makePng(60, 60), width: 30, height: 30 }]);

  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: CERTS }), outputPath, { masterResumeDocxPath: masterPath });

  const text = await docxText(outputPath);
  for (const cert of CERTS) {
    assert.ok(text.includes(cert), `certification text must remain ATS-extractable: ${cert}`);
  }
});

test("Source badges: candidate isolation end to end — one candidate's render never contains another's badge bytes", async () => {
  const dirA = tempDir();
  const dirB = tempDir();
  const masterA = path.join(dirA, "resume.docx");
  const masterB = path.join(dirB, "resume.docx");
  const imageA = makePng(60, 60, [200, 0, 0]);
  const imageB = makePng(60, 60, [0, 200, 0]);
  await writeMasterResumeDocxFixture(masterA, [{ bytes: imageA, width: 30, height: 30 }]);
  await writeMasterResumeDocxFixture(masterB, [{ bytes: imageB, width: 30, height: 30 }]);

  const outA = path.join(dirA, "Resume.docx");
  const outB = path.join(dirB, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), outA, { masterResumeDocxPath: masterA });
  await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), outB, { masterResumeDocxPath: masterB });

  const mediaA = await mediaBuffers(outA);
  const mediaB = await mediaBuffers(outB);
  assert.ok(mediaA.some((b) => b.equals(imageA)));
  assert.ok(mediaB.some((b) => b.equals(imageB)));
  assert.ok(!mediaA.some((b) => b.equals(imageB)), "candidate A's rendered resume must never contain candidate B's badge image");
  assert.ok(!mediaB.some((b) => b.equals(imageA)), "candidate B's rendered resume must never contain candidate A's badge image");
});

test("Source badges: re-tailoring (re-rendering) produces no duplicate/accumulated images", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: makePng(60, 60), width: 30, height: 30 }]);

  const firstRender = path.join(dir, "first.docx");
  const secondRender = path.join(dir, "second.docx");
  await generateResumeDocx(resumeWith({ certifications: CERTS }), firstRender, { masterResumeDocxPath: masterPath });
  await generateResumeDocx(resumeWith({ certifications: CERTS }), secondRender, { masterResumeDocxPath: masterPath });

  const mediaFirst = await mediaBuffers(firstRender);
  const mediaSecond = await mediaBuffers(secondRender);
  assert.equal(mediaFirst.length, 1);
  assert.equal(mediaSecond.length, 1, "a second, independent render must not accumulate images from the first");
  assert.ok(mediaFirst[0].equals(mediaSecond[0]));
});

test("Source badges: an unrelated TARGETED_REPAIR (same certifications, same master resume) leaves badge bytes/placement byte-identical", async () => {
  // TARGETED_REPAIR never re-uploads a Master Resume and never touches ResumeContent.certifications
  // for a one-bullet fix — this simulates exactly that: two renders from the identical inputs,
  // standing in for "before" and "after" an unrelated repair pass.
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, [
    { bytes: makePng(90, 45), width: 30, height: 15 },
    { bytes: makePng(45, 90), width: 15, height: 30 },
  ]);

  const beforePath = path.join(dir, "before.docx");
  const afterPath = path.join(dir, "after.docx");
  await generateResumeDocx(resumeWith({ certifications: CERTS }), beforePath, { masterResumeDocxPath: masterPath });
  await generateResumeDocx(resumeWith({ certifications: CERTS }), afterPath, { masterResumeDocxPath: masterPath });

  const beforeXml = await documentXml(beforePath);
  const afterXml = await documentXml(afterPath);
  const stripIds = (xml: string) => xml.replace(/r:id="[^"]*"|w:id="[^"]*"/g, "");
  assert.equal(stripIds(beforeXml), stripIds(afterXml), "badge placement/dimensions/ordering must be byte-identical across an unrelated repair");

  const mediaBefore = await mediaBuffers(beforePath);
  const mediaAfter = await mediaBuffers(afterPath);
  assert.equal(mediaBefore.length, mediaAfter.length);
  for (let i = 0; i < mediaBefore.length; i++) assert.ok(mediaBefore[i].equals(mediaAfter[i]));
});

test("Source badges: no Master Resume image at all falls back safely to the existing generic text cards", async () => {
  const dir = tempDir();
  const outputPath = path.join(dir, "Resume.docx");
  // masterResumeDocxPath omitted entirely — the pre-existing, already-shipped behavior.
  await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), outputPath);

  const text = await docxText(outputPath);
  assert.match(text, /AWS CERTIFIED/, "with no source badge, the generic text-card fallback must still work exactly as before");
  const xml = await documentXml(outputPath);
  assert.doesNotMatch(xml, /<w:drawing>/, "no embedded image at all when there is no source badge");

  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, true);
});

test("Source badges: a Master Resume that exists but has no embedded images falls back safely, same as having none", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, []); // real .docx, zero images
  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), outputPath, { masterResumeDocxPath: masterPath });

  const text = await docxText(outputPath);
  assert.match(text, /AWS CERTIFIED/);
  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, true);
});

// --- Adversarial: validate-docx.ts's narrowed image exception ---------------------------------------

async function buildDocWithImage(outputPath: string, imageOptions: ConstructorParameters<typeof ImageRun>[0]): Promise<void> {
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new ImageRun(imageOptions)] })] }] });
  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

test("Adversarial: an embedded image with no trusted marker fails ATS validation", async () => {
  const dir = tempDir();
  const outputPath = path.join(dir, "Fake.docx");
  await buildDocWithImage(outputPath, {
    data: makePng(40, 40),
    type: "png",
    transformation: { width: 20, height: 20 },
    // No altText at all — an arbitrary/unmarked image, exactly what a writer-supplied or
    // accidentally-reintroduced image path would produce.
  });
  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, false);
  assert.ok(
    validation.violations.some((v) => v.includes("not a recognized, trusted certification badge")),
    `expected the untrusted-image violation, got: ${JSON.stringify(validation.violations)}`
  );
});

test("Adversarial: an embedded image with the WRONG marker name still fails ATS validation", async () => {
  const dir = tempDir();
  const outputPath = path.join(dir, "Fake.docx");
  await buildDocWithImage(outputPath, {
    data: makePng(40, 40),
    type: "png",
    transformation: { width: 20, height: 20 },
    altText: { name: "some-other-image", title: "logo", description: "not actually trusted" },
  });
  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, false);
  assert.ok(validation.violations.some((v) => v.includes("not a recognized, trusted certification badge")));
});

test("Adversarial: a floating/anchored image fails ATS validation even WITH the trusted marker", async () => {
  const dir = tempDir();
  const outputPath = path.join(dir, "Fake.docx");
  await buildDocWithImage(outputPath, {
    data: makePng(40, 40),
    type: "png",
    transformation: { width: 20, height: 20 },
    altText: { name: TRUSTED_CERTIFICATION_BADGE_MARKER, title: TRUSTED_CERTIFICATION_BADGE_MARKER },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, align: HorizontalPositionAlign.RIGHT },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, align: VerticalPositionAlign.TOP },
    },
  });
  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, false);
  assert.ok(
    validation.violations.some((v) => v.includes("floating/anchored image")),
    `expected the floating-image violation, got: ${JSON.stringify(validation.violations)}`
  );
});

test("Adversarial: more embedded images than the allowed cap fails ATS validation even if all are trusted", async () => {
  const dir = tempDir();
  const outputPath = path.join(dir, "Fake.docx");
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [1, 2, 3].map(
              () =>
                new ImageRun({
                  data: makePng(20, 20),
                  type: "png",
                  transformation: { width: 10, height: 10 },
                  altText: { name: TRUSTED_CERTIFICATION_BADGE_MARKER, title: TRUSTED_CERTIFICATION_BADGE_MARKER },
                })
            ),
          }),
        ],
      },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, false);
  assert.ok(validation.violations.some((v) => /more than the \d+ allowed/.test(v)));
});

test("Adversarial: a real generateResumeDocx render with trusted source badges passes cleanly (positive control)", async () => {
  const dir = tempDir();
  const masterPath = path.join(dir, "resume.docx");
  await writeMasterResumeDocxFixture(masterPath, [{ bytes: makePng(60, 60), width: 30, height: 30 }]);
  const outputPath = path.join(dir, "Resume.docx");
  await generateResumeDocx(resumeWith({ certifications: ["AWS Certified Cloud Practitioner"] }), outputPath, { masterResumeDocxPath: masterPath });
  const validation = await validateDocx(outputPath, "resume");
  assert.equal(validation.valid, true, `real trusted badges must validate cleanly: ${JSON.stringify(validation.violations)}`);
});
