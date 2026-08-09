"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";

interface ManifestEntry {
  filename: string;
  uploadedAt: string;
  sizeBytes: number;
}

type Manifest = Partial<Record<"resume" | "skills", ManifestEntry>>;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadSlot({
  slot,
  label,
  description,
  entry,
  candidateId,
  onUploaded,
}: {
  slot: "resume" | "skills";
  label: string;
  description: string;
  entry?: ManifestEntry;
  candidateId: number;
  onUploaded: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function doUpload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.set("slot", slot);
      body.set("file", file);
      body.set("candidateId", String(candidateId));
      const res = await fetch("/api/master-files", { method: "POST", body });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(JSON.stringify(data.error));
      }
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setConfirming(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (entry) {
      setConfirming(true);
      // Stash the file on the input; actual upload happens after confirm.
      return;
    }
    doUpload(file);
  }

  function confirmReplace() {
    const file = inputRef.current?.files?.[0];
    if (file) doUpload(file);
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold">{label}</h2>
      <p className="mt-1 text-xs text-zinc-500">{description}</p>

      {entry ? (
        <div className="mt-3 rounded border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          <div className="font-medium">{entry.filename}</div>
          <div className="text-zinc-500">
            {formatBytes(entry.sizeBytes)} · uploaded {new Date(entry.uploadedAt).toLocaleString()}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded border border-dashed border-zinc-300 p-3 text-xs text-zinc-500 dark:border-zinc-700">
          No file uploaded yet.
        </div>
      )}

      <div className="mt-3">
        <input
          ref={inputRef}
          type="file"
          accept=".docx,.md,.txt"
          disabled={uploading}
          onChange={handleFileChange}
          className="text-xs"
        />
      </div>

      {confirming && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-amber-700 dark:text-amber-500">
            Replace current file? The old version will be archived, not deleted.
          </span>
          <button
            onClick={confirmReplace}
            className="rounded bg-zinc-900 px-2 py-1 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Replace
          </button>
          <button
            onClick={() => {
              setConfirming(false);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="text-zinc-500 underline"
          >
            Cancel
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export default function MasterFilesPage() {
  const candidateId = useActiveCandidateId();
  const [manifest, setManifest] = useState<Manifest>({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/master-files?candidateId=${candidateId}`);
      const data = await res.json();
      setManifest(data.manifest ?? {});
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Master files</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          These are the source of truth for resume tailoring. They are never edited or overwritten
          programmatically — re-uploading archives the previous version. Tailoring itself happens
          in Claude Code via the{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
            /tailor-resume
          </code>{" "}
          skill, not this app.
        </p>
      </div>

      {!loading && (
        <div className="grid gap-4 md:grid-cols-2">
          <UploadSlot
            slot="resume"
            label="Master Resume"
            description="Your full resume (.docx, .md, or .txt). Every tailored resume is derived from this."
            entry={manifest.resume}
            candidateId={candidateId}
            onUploaded={load}
          />
          <UploadSlot
            slot="skills"
            label="Master Skills Inventory"
            description="Every technology you genuinely know, grouped by ecosystem. Used to decide what can be truthfully emphasized per job."
            entry={manifest.skills}
            candidateId={candidateId}
            onUploaded={load}
          />
        </div>
      )}
    </div>
  );
}
