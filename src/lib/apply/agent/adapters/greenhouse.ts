import type { AtsAdapter } from "../types";

/**
 * Greenhouse.
 *
 * Built from a real posting, not from assumption: inspecting a live job-boards.greenhouse.io form
 * shows stable ids (`first_name`, `last_name`, `email`, `phone`, `resume`, `cover_letter`), proper
 * `<label for>` associations, and `required` set on the fields that need it.
 *
 * It automates the FORM only. Recognising that a posting is Greenhouse already happened upstream —
 * the job record carries `source_type` from the existing connector layer, and this adapter is
 * selected by that value rather than sniffing the URL again.
 *
 * The hints below are therefore a shortcut for the fields Greenhouse names consistently, NOT a form
 * template. Everything else is discovered from the page and matched by its label, because no two
 * Greenhouse forms carry the same custom questions — the same company adds and removes them between
 * postings. An adapter that assumed a fixed shape would fill the wrong field the first time one
 * changed, silently.
 */
export const greenhouseAdapter: AtsAdapter = {
  sourceType: "greenhouse",

  fieldSelectorHints() {
    return {
      first_name: "#first_name",
      last_name: "#last_name",
      email: "#email",
      phone: "#phone",
      phone_country_code: "#country",
      resume: "#resume",
      cover_letter: "#cover_letter",
    };
  },
};
