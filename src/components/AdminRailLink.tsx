"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";

/**
 * The way into (and out of) system operations.
 *
 * WHY IT EXISTS. Moving admin under /admin without a link left it reachable only by typing the URL
 * or knowing a command-bar entry — the owner had no way to find their own operations console. A
 * destination with no door is the same as a deleted one.
 *
 * WHY IT IS OWNER-ONLY. A candidate using this to look for work should not have connector health
 * in their navigation; that is the whole point of the split. Hiding it is a product decision, not a
 * security control — the real boundary is server-side on the APIs those pages call, and this link's
 * absence protects nobody who knows the URL.
 *
 * It costs one request per shell mount, shared with everything else that already resolves the
 * active candidate, and renders nothing at all for a non-owner.
 */
export function AdminRailLink() {
  const candidateId = useResolvedCandidateId();
  const pathname = usePathname();
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    if (candidateId === null) return;
    let cancelled = false;
    fetch(`/api/candidates/${candidateId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && body?.candidate) setIsOwner(Boolean(body.candidate.is_owner));
      })
      .catch(() => {
        /* A failed check leaves the link hidden. Someone who needs it can still type the URL. */
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  if (!isOwner) return null;

  const inAdmin = pathname.startsWith("/admin");

  return (
    <Link
      href={inAdmin ? "/home" : "/admin"}
      className="mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-tertiary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
    >
      <span aria-hidden="true" className="text-[10px]">
        {inAdmin ? "◀" : "⚙"}
      </span>
      {inAdmin ? "Back to JobHunt" : "System operations"}
    </Link>
  );
}
