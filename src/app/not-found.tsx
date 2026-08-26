import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { BTN_PRIMARY } from "@/components/ui/Panel";

/**
 * UI-2 — one Career-Ops not-found experience (design audit: 404 handling was inadequate).
 * Renders inside the root layout, so the sidebar stays available as a way out even from a dead URL.
 * Deliberately plain — a trust surface is the wrong place for a joke or a large illustration.
 */
export default function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="The page you're looking for doesn't exist, or the link may be out of date."
      action={
        <Link href="/home" className={BTN_PRIMARY}>
          Back to Home
        </Link>
      }
    />
  );
}
