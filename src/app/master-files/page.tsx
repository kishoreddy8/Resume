"use client";

import { useEffect, useState } from "react";
import { useDisplayCandidateId, useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { UploadSlot, type Manifest } from "@/components/MasterFileUpload";
import { SkeletonRows } from "@/components/ui";

export default function MasterFilesPage() {
  /* Two different questions, deliberately answered by two different hooks. Requests wait only for
   * the server's answer; the id printed in the copy below waits for mount as well, because server
   * and client must agree on the very first render. */
  const candidateId = useResolvedCandidateId();
  const displayCandidateId = useDisplayCandidateId();
  const [manifest, setManifest] = useState<Manifest>({});
  const [loading, setLoading] = useState(true);

  async function load() {
    // Nothing is fetched against the optimistic guess — a request for a profile the user is not on
    // 401s when that profile has a PIN, and its only other outcome is a wasted round trip.
    if (candidateId === null) return;
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
        <h1 className="page-title">Master files</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          These are the source of truth for resume tailoring. They are never edited or overwritten
          programmatically — re-uploading archives the previous version. Tailoring itself happens
          through the Claude Code or Codex project skill with this explicit candidate id:{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
            candidate={displayCandidateId ?? "…"}
          </code>{" "}
          plus the target job id. Tailoring does not run inside this app.
        </p>
      </div>

      {(loading || candidateId === null) && <SkeletonRows rows={2} />}

      {!loading && candidateId !== null && (
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
