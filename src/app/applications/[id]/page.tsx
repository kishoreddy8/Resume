"use client";

import { use } from "react";
import { ApplicationDetail } from "./ApplicationDetail";

/**
 * One application run. The route is a thin shell; the workspace itself is a client component so
 * the intervention and approval flows can own their own state.
 */
export default function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ApplicationDetail runId={Number(id)} />;
}
