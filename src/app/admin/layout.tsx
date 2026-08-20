"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Surface } from "@/components/ui";
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
  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  useEffect(() => {
    if (candidateId === null) return;
    let cancelled = false;
    fetch(`/api/candidates/${candidateId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        setIsOwner(body ? Boolean(body.candidate?.is_owner) : false);
      })
      .catch(() => !cancelled && setIsOwner(false));
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  if (candidateId === null || isOwner === null) {
    return (
      <div className="mx-auto w-full max-w-4xl py-6">
        <p role="status" className="text-[12.5px] text-tertiary">
          Checking access…
        </p>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-2xl py-10">
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-6 py-8 text-center">
          <h1 className="text-[16px] font-semibold text-primary">System operations</h1>
          <p className="mx-auto mt-2 max-w-[52ch] text-[12.5px] leading-relaxed text-tertiary">
            This area manages how JobHunt discovers jobs and keeps its connectors running. It is
            available to the account that owns this installation.
          </p>
          <Link
            href="/home"
            className="mt-5 inline-block rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
          >
            Back to JobHunt
          </Link>
        </Surface>
      </div>
    );
  }

  return <>{children}</>;
}
