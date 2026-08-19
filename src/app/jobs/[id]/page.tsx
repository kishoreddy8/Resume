"use client";

import { use } from "react";
import { JobReview } from "./JobReview";

/**
 * The full-page job review route.
 *
 * Workbench Phase 1 moved the body of this page into JobReview so the Workbench's persistent detail
 * pane can render exactly the same review — same sections, same actions, same Stage 2 decision-first
 * ordering — instead of a second copy that would drift. This route keeps the two-column `page`
 * layout it has always had, and remains a valid deep link for a single job.
 */
export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <JobReview jobId={Number(id)} layout="page" />;
}
