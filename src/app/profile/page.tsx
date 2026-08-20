"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { LoadingRegion } from "@/components/ui";

/**
 * Profile — personal details, preferences, target roles.
 *
 * These already live on the candidate settings route, which is keyed by candidate id. Rather than
 * duplicating that form (and giving two places to edit the same contact details, one of which would
 * drift), /profile resolves the active candidate and hands over to it. The user gets a stable,
 * memorable destination; there is still exactly one implementation.
 */
export default function ProfilePage() {
  const candidateId = useResolvedCandidateId();
  const router = useRouter();

  useEffect(() => {
    if (candidateId !== null) router.replace(`/candidates/${candidateId}/settings`);
  }, [candidateId, router]);

  return (
    <div className="py-6">
      <LoadingRegion label="Opening your profile" />
    </div>
  );
}
