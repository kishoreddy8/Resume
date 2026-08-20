import type { AtsAdapter } from "../types";

/**
 * Lever.
 *
 * Form automation only — the posting was already identified as Lever by the existing connector
 * layer, and this adapter is selected by the job record's `source_type`.
 *
 * Lever names its controls rather than id-ing them — `name="name"`, `name="email"`,
 * `name="resume"` — so selectorFor's `[name="…"]` fallback is what addresses them. The same rule
 * applies as everywhere else: these are hints for the fields Lever names consistently, and every
 * other question is discovered and matched by its label.
 *
 * Not yet verified against a live Lever posting. The hints are drawn from Lever's documented and
 * long-stable field names, and the discovery path does not depend on them being right: an
 * unrecognised field is asked about, never guessed at.
 */
export const leverAdapter: AtsAdapter = {
  sourceType: "lever",

  fieldSelectorHints() {
    return {
      full_name: '[name="name"]',
      email: '[name="email"]',
      phone: '[name="phone"]',
      location_current: '[name="location"]',
      resume: '[name="resume"]',
      linkedin_url: '[name="urls[LinkedIn]"]',
      github_url: '[name="urls[GitHub]"]',
    };
  },
};
