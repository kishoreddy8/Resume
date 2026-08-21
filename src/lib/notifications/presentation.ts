/**
 * The candidate-facing name for each kind of notification JobHunt sends.
 *
 * ONE MAPPING, TWO READERS. Home's activity rail and the Settings notification list both need to
 * name these, and two switch statements over the same strings is how the same event ends up called
 * "Resume ready" in one place and "Resume complete" in another. Home's wording is the established
 * one and is kept exactly; this module is where it now lives.
 *
 * THE LIST IS WHAT THE PRODUCT ACTUALLY EMITS. Every entry corresponds to a call site that really
 * creates notifications — the match generator, the resume quality pipeline, and the application
 * notifier. Nothing aspirational is listed, because Settings renders this list as the categories
 * you receive, and a category nothing can produce would be a promise the product does not keep.
 */

export interface NotificationPresentation {
  /** Short title, as Home already words it. */
  title: string;
  /** One line for Settings, explaining when it arrives. Home does not render this. */
  description: string;
}

export const NOTIFICATION_PRESENTATION: Record<string, NotificationPresentation> = {
  HIGH_VALUE_JOB_MATCH: {
    title: "New strong match",
    description: "A newly scanned job scores highly against your evidence.",
  },
  RESUME_READY: {
    title: "Resume ready",
    description: "A tailored resume finished writing and passed its checks.",
  },
  HUMAN_REVIEW_REQUIRED: {
    title: "Resume needs your review",
    description: "A tailored resume stopped short of clearing on its own.",
  },
  QUALITY_FAILURE: {
    title: "Resume review needs attention",
    description: "A resume review recorded a problem that needs you.",
  },
  application_needs_attention: {
    title: "Application needs attention",
    description: "An application stopped and cannot continue without you.",
  },
  application_outcome: {
    title: "Application status update",
    description: "An application reached a new state, including submission.",
  },
};

/** Display order for the Settings list: what you act on first, then what merely informs. */
export const NOTIFICATION_TYPE_ORDER: string[] = [
  "application_needs_attention",
  "HUMAN_REVIEW_REQUIRED",
  "QUALITY_FAILURE",
  "HIGH_VALUE_JOB_MATCH",
  "RESUME_READY",
  "application_outcome",
];

/**
 * The title for a recorded notification type.
 *
 * An unknown type is shown as a readable version of itself rather than guessed at or hidden — if
 * the product gains a kind of notification, the UI says what it is instead of silently dropping it.
 */
export function notificationTitle(type: string): string {
  const known = NOTIFICATION_PRESENTATION[type];
  if (known) return known.title;
  const words = type.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
