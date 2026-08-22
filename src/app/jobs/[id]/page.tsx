import { JobWorkspace } from "./JobWorkspace";
import { parseWorkspaceRoute } from "./workspaceRoute";

/**
 * The Job Workspace route — one job, one workflow, one step at a time.
 *
 * This deep link now opens the workspace (see JobWorkspace) rather than the stacked review. The
 * review itself is unchanged and still serves the Workbench's persistent detail pane on /jobs, so
 * the discovery experience is untouched by this route's change.
 */
export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <JobWorkspace jobId={Number(id)} routeRequest={parseWorkspaceRoute(query)} />;
}
