import type { AtsAdapter } from "../types";

/**
 * Workday.
 *
 * EVERY VALUE BELOW WAS OBSERVED, NOT ASSUMED. Captured read-only from a live
 * `*.wd1.myworkdayjobs.com` tenant on 2026-08-25 with explicit operator authorisation, and pinned
 * by a sanitized fixture (`mockAts/mock-workday-myinformation.html`) plus the WORKDAY-* tests. The
 * previous assessment (`docs/ATS_APPLICATION_ADAPTER_ASSESSMENT.md`) deliberately refused to write
 * this adapter until that observation existed; this is the adapter that observation unblocked.
 *
 * Form automation only — the posting was already identified as Workday by the existing connector
 * layer, and this adapter is selected by the job record's `source_type`.
 *
 * WHAT THE OBSERVATION CHANGED ABOUT THE ORIGINAL PHASE 9A GUESS:
 *
 *  - `data-automation-id` is NOT on the input. It sits on a wrapper div up to three levels above
 *    (`formField-legalName--firstName`), while the input carries a stable, semantic id
 *    (`name--legalName--firstName`). Universal discovery now walks ancestors for it; the hints
 *    below use the stable ids, which are what actually address the controls.
 *  - Ids are NOT per-render generated. Phase 9A assumed `input--uid42`-style volatility and built a
 *    generated-id classifier for it. This tenant's ids are stable and human-readable, so the
 *    ordinary `#id` path applies and the automation-id preference never fires here.
 */
export const workdayAdapter: AtsAdapter = {
  sourceType: "workday",

  /**
   * Observed on the authenticated "My Information" step. These are a shortcut for the fields
   * Workday names consistently, NOT a form template: every other question is discovered from the
   * page and matched by its label, because Workday tenants configure their own question sets.
   */
  fieldSelectorHints() {
    return {
      first_name: "#name--legalName--firstName",
      last_name: "#name--legalName--lastName",
      location_current: "#address--addressLine1",
      location_city: "#address--city",
      phone: "#phoneNumber--phoneNumber",
    };
  },

  /**
   * PHASE 9E.2 — the observed entry sequence from job POSTING to the application.
   *
   * A Workday `apply_url` is a job posting, not a form. The three controls below were captured
   * read-only from the live State Street tenant on 2026-08-25, in this order, and are declared as
   * exact selectors with the text each was observed carrying. The engine verifies that text against
   * the live control before clicking and requires an observable transition after — it never
   * text-searches the page for something that says "Apply".
   *
   * TENANT-SPECIFIC RISK, STATED PLAINLY: this sequence is what ONE tenant does. Workday tenants
   * configure their own career sites, and another may skip the notice, use a different chooser, or
   * go straight to sign-in. Every step is therefore either `optional` or fails the run honestly
   * when absent — nothing here guesses at a variant that has not been observed.
   *
   *  1. `legalNoticeAcceptButton` — the cookie/website notice that overlays the posting and
   *     intercepts pointer events until dismissed. A TECHNICAL browsing prerequisite, not an
   *     application consent: it gates navigation on the public posting page, is presented before
   *     any application exists, and asks nothing about the candidate. It is marked `optional`
   *     because it does not appear once dismissed. No marketing opt-in is touched, and no
   *     substantive legal attestation is accepted anywhere in this sequence — the application's own
   *     consent controls are Voluntary Disclosures / Self Identify pages, which are ordinary form
   *     questions handled by planFields' existing sensitive/consent policy, never by this stage.
   *  2. `adventureButton` — "Apply" on the posting. This OPENS the application. It is safe here
   *     precisely because entry runs before any field is filled: there is nothing to submit. The
   *     universal classifier still treats a bare "Apply" as a final action everywhere else, and
   *     this declaration does not change that.
   *  3. `applyManually` — the deterministic branch of Workday's chooser. Chosen over
   *     `autofillWithResume` (which asks Workday to parse a resume and pre-fill fields Career-Ops
   *     did not author) and `useMyLastApplication` (which reuses a previous application's answers).
   *     Both would put values into the form that this system cannot vouch for.
   */
  entrySequence() {
    return [
      { selector: '[data-automation-id="legalNoticeAcceptButton"]', expectedText: "Accept Cookies", kind: "dismiss_notice" as const, optional: true },
      { selector: '[data-automation-id="adventureButton"]', expectedText: "Apply", kind: "enter_application" as const },
      { selector: '[data-automation-id="applyManually"]', expectedText: "Apply Manually", kind: "enter_application" as const },
      /* 4. `SignInWithEmailButton` — the auth wall offers social sign-in (Apple/Google/LinkedIn)
       *    plus this control, which reveals the email/password form `auth()` below addresses.
       *    Revealing a form is navigation, not authentication: no credential is entered here, and
       *    ensureAuthenticated still performs the actual sign-in. Optional because an already
       *    authenticated session goes straight to the application and never shows this wall. */
      { selector: '[data-automation-id="SignInWithEmailButton"]', expectedText: "Sign in with email", kind: "enter_application" as const, optional: true },
    ];
  },

  /** Observed entry is four controls; bounded there rather than at the engine's ceiling. */
  entryMaxSteps() {
    return 4;
  },

  /** Observed footer control, visible text "Save and Continue". The universal advance classifier
   *  still decides whether that text may be clicked — this only says WHERE the control is. */
  nextPageSelector() {
    return '[data-automation-id="pageFooterNextButton"]';
  },

  /**
   * DELIBERATELY EMPTY — see `reviewPageSelector`.
   *
   * Workday's step navigator renders every step's name, "Review" included, on EVERY page. Any text
   * marker matching "review" therefore fires on page 1 and would declare the very first page the
   * review page, ending the walk before anything is filled. Text cannot express this distinction,
   * so no text marker is offered at all.
   */
  reviewPageMarkers() {
    return [];
  },

  /**
   * The structural review test. Observed: Workday marks exactly one navigator item
   * `progressBarActiveStep` and every other `progressBarInactiveStep`. The real review page is
   * therefore "the ACTIVE step is the one named Review" — expressible only as a selector.
   *
   * `:has-text()` is Playwright's own pseudo-class, evaluated by the browser-side selector engine.
   */
  reviewPageSelector() {
    return '[data-automation-id="progressBarActiveStep"]:has-text("Review")';
  },

  /**
   * Observed: Workday's finite pickers ("How Did You Hear About Us?", "State", "Phone Device Type")
   * render their options as `[data-automation-id="menuItem"]` rather than `[role="option"]`, and
   * the trigger carries no `aria-controls`. Without this the engine saw no options at all and would
   * have offered the user a free-text box for a fixed list of choices.
   */
  pickerOptionSelector() {
    return '[data-automation-id="menuItem"]';
  },

  /** Observed sign-in wall wording, merged into the generic blocking detector's own signals. */
  loginWallMarkers() {
    return ["sign in", "create account"];
  },

  /**
   * Observed authenticated flow is 7 steps (My Information → My Experience → Application Questions
   * 1 of 2 → 2 of 2 → Voluntary Disclosures → Self Identify → Review). Bounded slightly above the
   * observed count so a tenant with one extra configured step still completes, while the engine's
   * own hard cap remains the ceiling.
   */
  maxPages() {
    return 8;
  },

  /**
   * Observed auth forms. Both the sign-in and create-account panels were captured read-only.
   *
   * `mode: "LOGIN_ONLY"` is deliberate and conservative. Account CREATION was performed once,
   * manually and under explicit operator authorisation, to reach the form for observation — but
   * `ACCOUNT_CREATION_SUPPORTED` would let the engine create accounts unattended on any Workday
   * tenant, and one observed tenant is not evidence that every tenant's creation flow is safe to
   * automate. Raising this requires its own authorisation and its own observation.
   *
   * NOTE ON `beecatcher`: both auth forms carry a visible honeypot input labelled "This input is
   * for robots only, do not enter if you're human." It is deliberately absent from every selector
   * here, and `ensureAuthenticated` only ever fills the selectors named below.
   */
  auth() {
    return {
      mode: "LOGIN_ONLY",
      emailSelector: '[data-automation-id="email"]',
      passwordSelector: '[data-automation-id="password"]',
      signInSelector: '[data-automation-id="signInSubmitButton"]',
      /* Observed ONLY on the authenticated application shell: the post-login navigation item. While
       * signed out that header reads "Sign In" instead.
       *
       * "my information" was here and had to be REMOVED — it is a step NAME, and Workday's progress
       * navigator prints every step name on every page INCLUDING the sign-in page. It therefore
       * matched while signed out, `classifyAuthState` returned AUTHENTICATED without authenticating,
       * and the engine went on to treat the login form as the application form. This is the exact
       * same navigator trap as `reviewPageMarkers`, which is why that one is empty too: no step
       * name is ever safe as a page marker on Workday. */
      authenticatedMarkers: ["candidate home"],
      invalidCredentialMarkers: ["invalid email or password"],
      /* Observed password requirements: lowercase, uppercase, special, numeric, alphabetic, min 8.
       * The universal generator's 24-character draw satisfies all of them. */
      passwordPolicy: { minLength: 8 },
    };
  },
};
