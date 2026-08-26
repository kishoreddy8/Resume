"use client";

import { OperationsConsole } from "@/components/admin/OperationsConsole";
import { useAdminCandidate } from "@/lib/admin/AdminContext";

/**
 * UI-ADMIN-1 — the Admin index is now the operations console.
 *
 * WHAT CHANGED AND WHY. This page used to be a link hub that re-classified server health into a
 * second client vocabulary (healthy/degraded/failed/offline/unknown) through a local displayStatus
 * map. That map existed because the API returned bare status enums with nothing else — no summary,
 * no reason, no evidence, no freshness — so the page had to invent presentation for verdicts it
 * could not explain. ADMIN-OPS-5 finished the server-side contract, so the translation layer is
 * gone: the console renders operations.subsystems[] directly and the five statuses are the only
 * vocabulary on screen.
 *
 * The sub-console links remain, because the detailed per-subsystem pages are still where an
 * operator goes after this screen tells them where to look.
 */
export default function AdminOverviewPage() {
  const { candidateId } = useAdminCandidate();
  return <OperationsConsole candidateId={candidateId} />;
}
