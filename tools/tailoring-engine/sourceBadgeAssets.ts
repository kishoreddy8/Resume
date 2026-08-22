import crypto from "node:crypto";
import fs from "node:fs";
import JSZip from "jszip";
import { ImageRun } from "docx";

/**
 * Certification badge presentation, source-of-truth clarification — real embedded badge images,
 * preserved from the candidate's own Master Resume, instead of the locally-generated text cards
 * certificationBadges.ts falls back to when no source image exists.
 *
 * WHY THIS IS SAFE FOR THE EXISTING "NO IMAGES" ATS RULE. validate-docx.ts previously banned every
 * `<w:drawing>` element outright — a deliberate, blanket rule, because embedded images are a real,
 * documented cause of silent ATS parsing failures. This module does not remove that protection; it
 * narrows it to one specific, verifiable exception: an inline (never floating/anchored) drawing
 * whose `<wp:docPr name="...">` carries this module's exact TRUSTED_CERTIFICATION_BADGE_MARKER.
 * Nothing else can produce that marker — it is set in exactly one place, buildSourceBadgeRuns below
 * — so validate-docx.ts's narrowed check (see its own comment) still rejects every other embedded
 * image: an arbitrary image, a photo, a remote fetch, or anything a writer's JSON output might one
 * day try to smuggle in. That last case is structurally impossible today regardless: ResumeContent
 * (tools/tailoring-engine/types.ts) has no image-bearing field at all, so nothing the writer
 * produces can ever reach ImageRun — only this module's own extraction, over bytes it reads
 * directly from that one candidate's own Master Resume file, ever does.
 *
 * WHERE THE BYTES COME FROM. The Master Resume's original uploaded file is preserved byte-for-byte
 * on disk at data/candidates/<candidateId>/master/resume.docx (see /api/master-files/route.ts) for
 * exactly as long as the candidate exists — re-uploads are archived, never deleted. When that file
 * is a .docx, its own embedded images (word/media/*, in the order their <w:drawing> elements appear
 * in word/document.xml) are extracted here, unmodified, and re-embedded as inline pictures. No
 * network fetch, no other candidate's directory, no cross-candidate cache: the caller passes this
 * exact candidate's own resolved path in (see resume-template.ts's generateResumeDocx and
 * tailoringExecution.ts's masterResumeDocxPath resolution) — there is no global/shared lookup here
 * that could ever answer with a different candidate's bytes.
 *
 * WHAT "CERTIFICATION BADGE" MEANS HERE. This module does not attempt to recognize what an image
 * depicts — that is not something deterministic code can verify, and the Master Resume is this
 * system's stated authority. Every embedded PNG/JPEG image anywhere in the candidate's own Master
 * Resume is treated as a certification badge asset, in document order, capped at MAX_SOURCE_BADGES.
 * In practice a Master Resume rarely embeds any other kind of image; this is stated as a known,
 * deliberate scope boundary, not a hidden assumption.
 */

export const TRUSTED_CERTIFICATION_BADGE_MARKER = "career-ops-certification-badge";

export interface SourceBadgeAsset {
  bytes: Buffer;
  format: "png" | "jpg";
  pixelWidth: number;
  pixelHeight: number;
}

// All badges ride the headline line as one horizontal row (see resume-template.ts's headerBlock) —
// three is the reference resume's own count and a reasonable ceiling before the row starts to
// visually outweigh the candidate's own identity text, which must stay dominant.
// Exported so validate-docx.ts can enforce the same ceiling as a second, independent check.
export const MAX_SOURCE_BADGES = 3;
// Real logo/badge exports are small; anything bigger is almost certainly not a compact badge, and
// embedding it would risk an oversized header — skip rather than guess at how to shrink it sanely.
const MAX_SOURCE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_IMAGE_DIMENSION = 4000;

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  // The IHDR chunk is always the first chunk, immediately after the 8-byte signature: 4-byte
  // length, 4-byte type "IHDR", then 4-byte width and 4-byte height, both big-endian.
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    let marker = buf[pos + 1];
    // Some encoders pad extra 0xFF fill bytes before the real marker byte.
    let markerPos = pos + 1;
    while (buf[markerPos] === 0xff && markerPos + 1 < buf.length) markerPos++;
    marker = buf[markerPos];
    pos = markerPos + 1;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no payload
    if (pos + 2 > buf.length) return null;
    const segmentLength = buf.readUInt16BE(pos);
    const isSofMarker = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSofMarker) {
      if (pos + 7 > buf.length) return null;
      return { height: buf.readUInt16BE(pos + 3), width: buf.readUInt16BE(pos + 5) };
    }
    if (marker === 0xd9) return null; // EOI reached with no SOF found
    pos += segmentLength;
  }
  return null;
}

function detectImage(bytes: Buffer): SourceBadgeAsset | null {
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_IMAGE_BYTES) return null;
  const png = pngDimensions(bytes);
  if (png) {
    if (png.width <= 0 || png.height <= 0 || png.width > MAX_SOURCE_IMAGE_DIMENSION || png.height > MAX_SOURCE_IMAGE_DIMENSION) return null;
    return { bytes, format: "png", pixelWidth: png.width, pixelHeight: png.height };
  }
  const jpg = jpegDimensions(bytes);
  if (jpg) {
    if (jpg.width <= 0 || jpg.height <= 0 || jpg.width > MAX_SOURCE_IMAGE_DIMENSION || jpg.height > MAX_SOURCE_IMAGE_DIMENSION) return null;
    return { bytes, format: "jpg", pixelWidth: jpg.width, pixelHeight: jpg.height };
  }
  return null; // any other format (EMF/WMF/GIF/BMP/SVG/...) is skipped, never guessed at
}

/**
 * Reads `masterResumeDocxPath` (when it exists and is a .docx) and returns its embedded images, in
 * the document order their `<w:drawing>` elements appear, deduplicated by content hash, capped at
 * MAX_SOURCE_BADGES. Never throws — any failure (missing file, corrupt zip, unexpected structure,
 * a non-.docx master resume) returns [], which the caller treats as "no source badges" and falls
 * back to the existing generic text-card presentation. Badges are decorative; nothing about resume
 * generation may ever depend on this succeeding.
 */
export async function extractSourceCertificationBadges(masterResumeDocxPath: string | undefined): Promise<SourceBadgeAsset[]> {
  if (!masterResumeDocxPath) return [];
  try {
    if (!fs.existsSync(masterResumeDocxPath)) return [];
    const buffer = fs.readFileSync(masterResumeDocxPath);
    const zip = await JSZip.loadAsync(buffer);

    const documentXml = await zip.file("word/document.xml")?.async("string");
    const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
    if (!documentXml || !relsXml) return [];

    const relTargets = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) {
      relTargets.set(m[1], m[2]);
    }

    const embedIds = [...documentXml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)]
      .map((m) => m[0].match(/r:embed="([^"]+)"/)?.[1])
      .filter((id): id is string => Boolean(id));

    const seenHashes = new Set<string>();
    const assets: SourceBadgeAsset[] = [];
    for (const rId of embedIds) {
      if (assets.length >= MAX_SOURCE_BADGES) break;
      const target = relTargets.get(rId);
      if (!target) continue;
      const mediaPath = "word/" + target.replace(/^\.?\//, "");
      const file = zip.file(mediaPath);
      if (!file) continue;
      const bytes = await file.async("nodebuffer");
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      if (seenHashes.has(hash)) continue;
      const asset = detectImage(bytes);
      if (!asset) continue;
      seenHashes.add(hash);
      assets.push(asset);
    }
    return assets;
  } catch {
    return [];
  }
}

// Compact by construction: a fixed display height, width derived from the source image's own
// pixel aspect ratio (never distorted), capped so an unusually wide source image cannot dominate
// the line it sits on.
const BADGE_DISPLAY_HEIGHT = 30;
const BADGE_DISPLAY_MAX_WIDTH = 110;

function displaySize(asset: SourceBadgeAsset): { width: number; height: number } {
  const width = Math.round(BADGE_DISPLAY_HEIGHT * (asset.pixelWidth / asset.pixelHeight));
  return { width: Math.min(width, BADGE_DISPLAY_MAX_WIDTH), height: BADGE_DISPLAY_HEIGHT };
}

/**
 * One inline ImageRun per preserved source badge, in the same order they were extracted. Every one
 * carries the exact TRUSTED_CERTIFICATION_BADGE_MARKER validate-docx.ts's narrowed image check
 * requires — this is the ONLY place in the codebase that ever sets it.
 */
export function buildSourceCertificationBadgeRuns(assets: SourceBadgeAsset[]): ImageRun[] {
  return assets.map(
    (asset) =>
      new ImageRun({
        data: asset.bytes,
        type: asset.format,
        transformation: displaySize(asset),
        altText: {
          name: TRUSTED_CERTIFICATION_BADGE_MARKER,
          title: TRUSTED_CERTIFICATION_BADGE_MARKER,
          description: "Certification badge preserved from the candidate's Master Resume",
        },
      })
  );
}

