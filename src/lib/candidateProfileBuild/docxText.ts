import crypto from "node:crypto";
import fs from "node:fs";
import JSZip from "jszip";

/**
 * Mechanical .docx → text extraction. No interpretation, no reasoning.
 *
 * WHY THIS EXISTS, given the standing rule that the app has no .docx extraction. That rule was
 * written to keep RESUME REASONING out of the app — deciding which employer a skill belongs to, what
 * a date range implies, which years are actually claimed. None of that happens here. This unzips the
 * document and returns its text in order, which is closer to `cat` than to comprehension.
 *
 * It became necessary because the sandbox the CLI runs in cannot do it: Read rejects .docx as
 * binary, and the session deliberately has no Bash to unzip with. The alternative was granting the
 * sandbox a shell, which would trade a real security property for convenience. Extracting here and
 * handing over plain text keeps the boundary where it matters — the app moves bytes, Claude does the
 * reading.
 *
 * Paragraph structure is preserved because it carries meaning: a skill listed under an employer
 * heading is attributable, the same skill in a flat list is not. Flattening the document to one line
 * would destroy exactly the signal the profile depends on.
 */

export interface ExtractedDoc {
  text: string;
  /** sha256 of the ORIGINAL .docx, which is what candidate-profile.json must record. */
  sha256: string;
}

export async function extractDocxText(filePath: string): Promise<ExtractedDoc> {
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error(`${filePath} is not a readable .docx (no word/document.xml)`);
  const xml = await entry.async("string");

  const text = xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, sha256 };
}
