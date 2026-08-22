/**
 * The candidate's settings categories.
 *
 * WHAT IS NOT HERE. Lifecycle, suppression, scanner timeouts, retry backoff, ATS concurrency and
 * the scheduler used to be this route — the page was literally titled "Control Center". They are
 * operator controls that affect every profile rather than preferences that belong to a person, and
 * they now live at /admin/settings with the same components and the same API.
 *
 * Kept as data rather than inline JSX so the rail, the mobile selector and the routing all read one
 * list, and adding a category cannot leave one of the three behind.
 */

export type SettingsCategoryId =
  | "job-search"
  | "notifications"
  | "applications"
  | "career-copilot"
  | "data-privacy";

export interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  /** Shown under the panel title. */
  blurb: string;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "job-search", label: "Job Search", blurb: "Set your job search preferences." },
  { id: "notifications", label: "Notifications", blurb: "What JobHunt tells you about." },
  { id: "applications", label: "Applications", blurb: "How JobHunt helps you apply, and what it will never do without you." },
  { id: "career-copilot", label: "Career Copilot", blurb: "Guidance grounded in your own evidence." },
  { id: "data-privacy", label: "Data & Privacy", blurb: "Your profile's protection and storage." },
];

export function isSettingsCategory(value: string): value is SettingsCategoryId {
  return SETTINGS_CATEGORIES.some((c) => c.id === value);
}
