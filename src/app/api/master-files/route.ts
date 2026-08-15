import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";

/**
 * Phase 2.5: candidate-scoped. Every path below is parameterized by an explicit candidateId (query
 * param on GET, form field on POST) — never a global "current candidate" fallback. See
 * CAREER_OPS_HANDOFF.md's Phase 2.5 design record §8/9.
 *
 * PHASE 4 STAGE 5 — WHY THIS ROUTE DELIBERATELY DOES NOT TRIGGER A REMATCH.
 * Uploading a new Master Resume / Skills Inventory rewrites manifest.json's sha256 values, which
 * makes the candidate's derived candidate-profile.json STALE by definition (its sourceHashes no
 * longer match — see src/lib/match/candidateProfile.ts's loadCandidateProfile). Phase 2 correctly
 * refuses to evaluate against a stale profile, so a rematch fired from here would walk the
 * candidate's whole job set only to record "stale_candidate_profile" for every pair.
 *
 * The profile becomes usable again only when the OFFLINE /build-candidate-profile skill rewrites
 * candidate-profile.json against the new uploads. That is a file write with no server request, so
 * there is no honest server-side callback to hook — and inventing filesystem watching/polling to
 * guess at it would be exactly the fragile automatic detection Stage 5 rules out. The supported
 * sequence is therefore explicit:
 *     upload here -> run /build-candidate-profile <candidateId> -> then either
 *     POST /api/candidates/<candidateId>/rematch (page by page) or `npm run rematch-candidate`.
 */

function candidatesRoot(): string {
  return process.env.CAREER_OPS_CANDIDATES_DIR ?? path.join(process.cwd(), "data", "candidates");
}
function masterDir(candidateId: number): string {
  return path.join(candidatesRoot(), String(candidateId), "master");
}
function historyDir(candidateId: number): string {
  return path.join(masterDir(candidateId), "history");
}
function manifestPath(candidateId: number): string {
  return path.join(masterDir(candidateId), "manifest.json");
}

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

function readManifest(candidateId: number): Manifest {
  const manifestFile = manifestPath(candidateId);
  if (!fs.existsSync(manifestFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
  } catch {
    return {};
  }
}

function writeManifest(candidateId: number, manifest: Manifest) {
  fs.mkdirSync(masterDir(candidateId), { recursive: true });
  fs.writeFileSync(manifestPath(candidateId), JSON.stringify(manifest, null, 2));
}

function currentFilePath(candidateId: number, slot: Slot, filename: string): string {
  return path.join(masterDir(candidateId), `${slot}${path.extname(filename)}`);
}

function parseCandidateId(raw: string | null): number | null {
  if (raw === null) return null;
  const candidateId = Number(raw);
  return Number.isInteger(candidateId) && candidateId > 0 ? candidateId : null;
}

export async function GET(req: NextRequest) {
  const candidateId = parseCandidateId(req.nextUrl.searchParams.get("candidateId"));
  if (candidateId === null) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const manifest = readManifest(candidateId);
  return NextResponse.json({ manifest });
}

export async function POST(req: NextRequest) {
  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const candidateId = parseCandidateId(formData.get("candidateId") as string | null);
  if (candidateId === null) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

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

  fs.mkdirSync(historyDir(candidateId), { recursive: true });

  const manifest = readManifest(candidateId);
  const slotKey = slot as Slot;
  const existing = manifest[slotKey];

  // Archive the previous version instead of overwriting it — the master files are the single
  // source of truth for resume tailoring and must never be silently lost on re-upload.
  if (existing) {
    const existingPath = currentFilePath(candidateId, slotKey, existing.filename);
    if (fs.existsSync(existingPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archivedName = `${slotKey}-${timestamp}-${existing.filename}`;
      fs.renameSync(existingPath, path.join(historyDir(candidateId), archivedName));
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const destPath = currentFilePath(candidateId, slotKey, file.name);
  fs.writeFileSync(destPath, bytes);

  manifest[slotKey] = {
    filename: file.name,
    uploadedAt: new Date().toISOString(),
    sizeBytes: bytes.length,
    sha256: sha256Hex(bytes),
  };
  writeManifest(candidateId, manifest);

  return NextResponse.json({ manifest });
}
