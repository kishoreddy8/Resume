"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AdminCandidateProvider } from "@/lib/admin/AdminContext";
import { AdminLoadingState } from "@/components/admin";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";

/**
 * The admin gate.
 *
 * WHAT THIS IS: a product boundary. System operations are not part of a candidate's job search, so
 * a candidate who is not the owner is shown the door rather than a connector-health table.
 *
 * WHAT THIS IS NOT: the security boundary. That lives server-side on the APIs these pages call —
 * every candidate-scoped route already checks access, and the owner-authorised ones check owner
 * status against an unlocked session. Client-side checks are removable by anyone with a devtools
 * console, and pretending otherwise would be the dangerous kind of wrong. This gate exists so the
 * right people see the right product, and the server keeps deciding who may read what.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const candidateId = useResolvedCandidateId();
  const [candidate, setCandidate] = useState<{ isOwner: boolean; displayName: string } | null>(null);

  useEffect(() => {
    if (candidateId === null) return;
    let cancelled = false;
    fetch(`/api/candidates/${candidateId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        setCandidate(
          body
            ? { isOwner: Boolean(body.candidate?.is_owner), displayName: String(body.candidate?.display_name ?? "Owner") }
            : { isOwner: false, displayName: "" }
        );
      })
      .catch(() => !cancelled && setCandidate({ isOwner: false, displayName: "" }));
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  if (candidateId === null || candidate === null) {
    return (
      <div className="mx-auto w-full max-w-4xl py-10">
        <AdminLoadingState label="Verifying Admin access" />
      </div>
    );
  }

  if (!candidate.isOwner) {
    return (
      <div className="mx-auto w-full max-w-2xl py-12">
        <div className="admin-state admin-state-error">
          <span aria-hidden="true">!</span>
          <h1 className="mt-3 text-[24px] font-bold text-primary">Admin access required</h1>
          <p>
            This area manages how Career-Ops discovers jobs and keeps its connectors running. It is
            available only to the PIN-unlocked owner of this installation.
          </p>
          <Link
            href="/home"
            className="admin-button admin-button-primary mt-5"
          >
            Back to Career-Ops
          </Link>
        </div>
      </div>
    );
  }

  return (
    <AdminCandidateProvider value={{ candidateId, displayName: candidate.displayName }}>
      {children}
    </AdminCandidateProvider>
  );
}
