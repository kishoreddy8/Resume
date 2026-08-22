import fs from "node:fs";
import path from "node:path";
import { Document, ImageRun, Packer, Paragraph, TextRun } from "docx";

/**
 * Builds a minimal but real .docx, standing in for a candidate's uploaded Master Resume, with the
 * given images embedded as ordinary (untrusted-marker) inline pictures — exactly the shape a real
 * Word document a candidate uploads would have. Test-only.
 */
export async function writeMasterResumeDocxFixture(
  outputPath: string,
  images: { bytes: Buffer; width: number; height: number; format?: "png" | "jpg" }[]
): Promise<void> {
  const children: Paragraph[] = [new Paragraph({ children: [new TextRun("Master Resume — Jordan Example")] })];
  for (const img of images) {
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            data: img.bytes,
            type: img.format ?? "png",
            transformation: { width: img.width, height: img.height },
          }),
        ],
      })
    );
  }
  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}
