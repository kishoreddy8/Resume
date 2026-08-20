import { redirect } from "next/navigation";

/**
 * Moved to /admin/companies.
 *
 * System operations now live under /admin so the candidate experience is not sharing a navigation
 * rail with connector health and scan runs. The old path redirects rather than 404s: bookmarks,
 * notes and anything else pointing here keep working, and nothing had to be removed to move it.
 */
export default function MovedPage() {
  redirect("/admin/companies");
}
