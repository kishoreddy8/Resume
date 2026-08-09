import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const MASTER_DIR = path.join(process.cwd(), "data", "master");
const HISTORY_DIR = path.join(MASTER_DIR, "history");
const MANIFEST_PATH = path.join(MASTER_DIR, "manifest.json");

const SLOTS = ["resume", "skills"] as const;
type Slot = (typeof SLOTS)[number];

const ALLOWED_EXTENSIONS = [".docx", ".md", ".txt"];

interface ManifestEntry {
  filename: string;
  uploadedAt: string;
  sizeBytes: number;
  /** sha256 of the file's raw bytes — the staleness-detection anchor for Phase 2's candidate
   *  profile (see src/lib/match/candidateProfile.ts). Added additively; older manifest entries
   *  written before this field existed simply have it undefined, which the profile loader treats
   *  as "cannot verify freshness" (never as "assume fresh"). */
  sha256: string;
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

type Manifest = Partial<Record<Slot, ManifestEntry>>;

function readManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeManifest(manifest: Manifest) {
  fs.mkdirSync(MASTER_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function currentFilePath(slot: Slot, filename: string): string {
  return path.join(MASTER_DIR, `${slot}${path.extname(filename)}`);
}

export async function GET() {
  const manifest = readManifest();
  return NextResponse.json({ manifest });
}

export async function POST(req: NextRequest) {
  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const slot = formData.get("slot");
  const file = formData.get("file");

  if (typeof slot !== "string" || !SLOTS.includes(slot as Slot)) {
    return NextResponse.json({ error: `slot must be one of: ${SLOTS.join(", ")}` }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return NextResponse.json(
      { error: `Unsupported file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` },
      { status: 400 }
    );
  }

  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const manifest = readManifest();
  const slotKey = slot as Slot;
  const existing = manifest[slotKey];

  // Archive the previous version instead of overwriting it — the master files are the single
  // source of truth for resume tailoring and must never be silently lost on re-upload.
  if (existing) {
    const existingPath = currentFilePath(slotKey, existing.filename);
    if (fs.existsSync(existingPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archivedName = `${slotKey}-${timestamp}-${existing.filename}`;
      fs.renameSync(existingPath, path.join(HISTORY_DIR, archivedName));
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const destPath = currentFilePath(slotKey, file.name);
  fs.writeFileSync(destPath, bytes);

  manifest[slotKey] = {
    filename: file.name,
    uploadedAt: new Date().toISOString(),
    sizeBytes: bytes.length,
    sha256: sha256Hex(bytes),
  };
  writeManifest(manifest);

  return NextResponse.json({ manifest });
}
