"use client";

import { use } from "react";
import { JobWorkspace } from "./JobWorkspace";

/**
 * The Job Workspace route — one job, one workflow, one step at a time.
 *
 * This deep link now opens the workspace (see JobWorkspace) rather than the stacked review. The
 * review itself is unchanged and still serves the Workbench's persistent detail pane on /jobs, so
 * the discovery experience is untouched by this route's change.
 */
export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <JobWorkspace jobId={Number(id)} />;
}
