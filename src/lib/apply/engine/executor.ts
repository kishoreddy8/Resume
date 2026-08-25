import type { Page } from "playwright";
import { advanceRun, getRun, recordEvent, updateCheckpoint, type ApplicationRun } from "@/db/queries/applicationRuns";
import { discoverFields, COLLECT_CONTROLS_SCRIPT, escapeAttributeValue, type RawControl } from "../agent/fieldDiscovery";
import { planFields, collectHumanQuestions } from "../agent/planFields";
import { exactComboboxOption } from "../agent/comboboxSelection";
import { findCanonicalLocation } from "../agent/locationNormalizer";
import { findCanonicalPhoneCountry } from "../agent/phoneCountryNormalizer";
import { detectBlocking, detectAlreadyApplied, BLOCKING_STATUS } from "../agent/detectBlocking";
import { readPageSignals } from "./pageSignals";
import { ensureAuthenticated } from "./auth";
import { authOutcomeProceeds, authOutcomeToBlockingCondition, deriveTenantKey } from "../auth";
import { keychainCredentialStore, type AtsAccountIdentity, type CredentialStore } from "../credentials";
import type { BlockingCondition } from "../agent/types";
import type { RunStatus } from "../runState";
import { selectAdapter } from "../agent/selectAdapter";
import { buildFinalReview, readSubmissionOutcome, type FinalReview } from "../finalReview";
import type { AdapterContext, AtsAdapter, FieldPlan, HumanQuestion, RunApprovedAnswer } from "../agent/types";
import {
  classifyAdvanceControl,
  hasPageAdvanced,
  matchesAnyMarker,
  resolveMultiPageConfig,
  type PageFingerprint,
} from "./multiPage";
import type { StoredAnswer } from "../resolveAnswer";
import type { QuestionType } from "../questionTypes";
import { getCandidateContact } from "@/db/queries/candidateSettings";
import { derivePhoneCountryCode } from "../agent/phoneCountryNormalizer";
import { ApplicationBrowserRuntime, type BrowserSession } from "./browserRuntime";

/**
 * The execution loop: walk one ApplicationRun through the state machine, in a real browser.
 *
 * THIS MODULE DECIDES NOTHING. What a field is, whether it may be filled, what value to use, when
 * to stop — all of that is the planner, the vault and the blocking detector, each already built and
 * tested. The executor's whole job is sequencing: navigate, look, plan, act, checkpoint, and stop
 * the moment anything needs a human.
 *
 * CHECKPOINT AFTER EVERY ACTION. Each filled field updates the persisted checkpoint, so a crash,
 * a refresh or a restart loses at most the action in flight. Resuming re-opens the page and
 * re-plans; already-persisted answers come back from the vault, not from a pretence that the old
 * browser session survived.
 *
 * THE LOOP CANNOT SUBMIT. Its terminal success state is READY_FOR_REVIEW. Submission lives in a
 * separate function that requires the caller to present an approval naming this exact run, and the
 * state machine underneath refuses the transition without it — two layers, either sufficient.
 */

export interface ExecutorDeps {
  context: AdapterContext;
  knownVariants: Map<string, { canonicalKey: string; type: QuestionType }>;
  storedAnswers: Map<string, StoredAnswer>;
}

export interface ExecutionCheckpoint {
  url: string | null;
  ats: string | null;
  step: "starting" | "navigating" | "filling" | "review" | "submitting";
  /** Selectors already acted on, with provenance. Values live in the review, never duplicated here. */
  completed: { selector: string; canonicalKey: string | null; source: string; kind: "fill" | "upload" }[];
  /** Candidate-approved answers scoped strictly to this ApplicationRun. */
  runAnswers?: Record<string, RunApprovedAnswer>;
  /** The review shown to the user, once built. It IS what the approval covers. */
  review?: FinalReview;
  /** Required unanswered questions collected for batch human input. Present only while WAITING_FOR_ANSWER. */
  humanQuestions?: HumanQuestion[];
  /** PHASE 9B — 1-based index of the page being processed. Present ONLY on multi-page adapters, so
   *  a single-page checkpoint stays byte-identical to its pre-9B shape. Old checkpoints without it
   *  remain readable: nothing reads this field back, it exists for audit and future safe resume. */
  page?: number;
  lastAction: string;
}

const DEFAULT_SUBMIT = "#submit_application, button[type=submit]";

// ── PHASE 9B — multi-page walk helpers (browser half; every DECISION lives in multiPage.ts) ──────

/** Read the current page's identity for transition detection. Fields and buttons only — cheap,
 *  deterministic, and aligned with what discovery itself sees. */
async function readPageFingerprint(page: Page): Promise<PageFingerprint> {
  const read = await page
    .evaluate(() => ({
      fieldIds: [...document.querySelectorAll("input, select, textarea")]
        .filter((el) => el.getAttribute("type") !== "hidden")
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}:${el.id || el.getAttribute("name") || el.getAttribute("data-automation-id") || ""}`
        ),
      buttonTexts: [...document.querySelectorAll("button, input[type=submit], input[type=button]")].map((el) =>
        ((el as HTMLElement).innerText || el.getAttribute("value") || "").trim()
      ),
    }))
    .catch(() => ({ fieldIds: [], buttonTexts: [] }));
  return { url: page.url(), ...read };
}

/** Every text the page offers for the advance control, or null when the control is absent.
 *  ALL of them go to the classifier — one dangerous reading outranks any number of safe ones. */
async function readAdvanceControlTexts(page: Page, selector: string): Promise<string[] | null> {
  const el = await page.$(selector).catch(() => null);
  if (!el) return null;
  /* No named function bindings inside evaluate callbacks — the bundler's name-preservation
   * helper (__name) does not exist in the browser context. Same reason COLLECT_CONTROLS_SCRIPT
   * is a string. */
  return el.evaluate((node) =>
    [
      ((node as HTMLElement).innerText ?? "").trim(),
      (node.getAttribute("aria-label") ?? "").trim(),
      (node.getAttribute("value") ?? "").trim(),
      (node.getAttribute("title") ?? "").trim(),
    ].filter((v) => v.length > 0)
  );
}

/**
 * Bounded wait for deterministic evidence that a Next click moved the application forward.
 * Polls the fingerprint rather than sleeping a fixed period — a fast SPA swap resolves in one
 * poll, and the 3s ceiling matches the async-combobox settle convention. A read that throws
 * mid-navigation is retried; it is evidence of change in flight, not of failure.
 */
async function waitForPageTransition(page: Page, before: PageFingerprint, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (hasPageAdvanced(before, await readPageFingerprint(page))) return true;
    } catch {
      /* navigation in flight — poll again */
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(150).catch(() => null);
  }
  try {
    return hasPageAdvanced(before, await readPageFingerprint(page));
  } catch {
    return false;
  }
}

/**
 * Selects one option in a react-select-style combobox (`role="combobox"`, no native `<select>`).
 *
 * SCOPED TO THE ACTIVE LISTBOX. After opening the combobox, React Select writes the listbox id into
 * `aria-controls` on the input. We read that id and scope every subsequent option read and click to
 * that one listbox — preventing unrelated open menus on the same page (e.g. a phone country-code
 * picker's `[role="listbox"]`) from polluting the option list. When `aria-controls` is absent (older
 * or simpler ATS boards), the query falls back to global `[role="option"]` as before.
 *
 * ASYNC-SAFE. Some ATS comboboxes fetch suggestions via API on each keystroke. The scoped listbox
 * may be empty immediately after the combobox opens, then populate a few hundred ms later. We capture
 * the initial snapshot and wait (up to 3 s) for it to change before reading the final option list —
 * a synchronous combobox that already has options resolves this immediately at zero extra cost.
 *
 * EXACT MATCH FIRST. If the typed value matches an option exactly, that option is used.
 * If not, the optional `normalize` callback is called with the visible options — it may return an
 * unambiguous canonical option (e.g. mapping bare "Dallas" to "Dallas, Texas, United States" for a
 * location_city field). If normalize also returns null, the function returns null and the run pauses.
 * The normaliser is the ONLY extension point; all other matching remains exact. See comboboxSelection.ts.
 */
async function selectComboboxOption(
  page: Page,
  selector: string,
  targetValue: string,
  normalize?: (opts: readonly string[]) => string | null
): Promise<string | null> {
  await page.click(selector);

  // React Select sets aria-controls on the input to the id of its listbox once the menu opens.
  // Scoping to that listbox keeps unrelated open menus out of our option reads.
  const listboxId = await page.$eval(selector, (el) => el.getAttribute("aria-controls") ?? "").catch(() => "");
  const optionSelector = listboxId ? `#${listboxId} [role="option"]` : '[role="option"]';

  await page.fill(selector, targetValue);

  // Capture the initial state of the scoped option list and wait for it to change. For async
  // comboboxes, the list starts empty (or with a stale set) and updates once the API responds.
  // For synchronous comboboxes, the list is already correct and this resolves immediately.
  const initialSnapshot = await page
    .$$eval(optionSelector, (els) => els.map((el) => (el.textContent ?? "").trim()).join("\x00"))
    .catch(() => "");
  await page
    .waitForFunction(
      (args) => {
        const els = document.querySelectorAll(args.sel);
        const current = Array.from(els)
          .map((el) => (el.textContent ?? "").trim())
          .join("\x00");
        return current !== args.init;
      },
      { sel: optionSelector, init: initialSnapshot },
      { timeout: 3000 }
    )
    .catch(() => null); // timeout is safe — we proceed with whatever options are present

  const visibleOptions = await page.$$eval(optionSelector, (els) => els.map((el) => (el.textContent ?? "").trim()));
  const chosen = exactComboboxOption(visibleOptions, targetValue) ?? normalize?.(visibleOptions) ?? null;
  if (!chosen) return null;

  const escaped = chosen.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionLocator = listboxId
    ? page.locator(`#${listboxId} [role="option"]`).filter({ hasText: new RegExp(`^${escaped}$`) }).first()
    : page.locator('[role="option"]').filter({ hasText: new RegExp(`^${escaped}$`) }).first();
  await optionLocator.click();
  return chosen;
}

/**
 * Safely discovers available options from a scoped combobox without selecting any value.
 *
 * SCOPED TO OWNED LISTBOX. Opens the combobox, reads aria-controls to scope option reading
 * strictly to its own listbox (preventing global option pollution, e.g. from phone iti widgets),
 * captures the visible options, and then cleanly dismisses the dropdown (via Escape / blur).
 *
 * READ-ONLY GUARANTEE. Never clicks any option, never types into the input, never selects any value.
 */
export async function discoverComboboxOptions(page: Page, selector: string): Promise<string[] | null> {
  try {
    await page.click(selector);

    // React Select sets aria-controls on the input to the id of its listbox once the menu opens.
    // Scoping to that listbox keeps unrelated open menus out of our option reads.
    const listboxId = await page.$eval(selector, (el) => el.getAttribute("aria-controls") ?? "").catch(() => "");
    const optionSelector = listboxId ? `#${listboxId} [role="option"]` : '[role="option"]';

    // Wait a bounded amount of time for options to render into the scoped listbox (sync or fast-loading)
    await page
      .waitForSelector(optionSelector, { timeout: 1500, state: "attached" })
      .catch(() => null);

    const rawOptions = await page
      .$$eval(optionSelector, (els) => els.map((el) => (el.textContent ?? "").trim()))
      .catch(() => []);

    // Dismiss the dropdown without selecting anything
    await page.keyboard.press("Escape").catch(() => null);
    await page.$eval(selector, (el) => (el as HTMLElement).blur?.()).catch(() => null);

    // Sanitize: trim, non-empty, deduplicate preserving order
    const seen = new Set<string>();
    const options: string[] = [];
    for (const raw of rawOptions) {
      const trimmed = raw.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        options.push(trimmed);
      }
    }

    return options.length > 0 ? options : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the deterministic option normaliser for a combobox field, if any.
 *
 * Used by BOTH `executeRun()` during initial filling and `approveAndSubmit()` during refill.
 * Exactly preserves:
 * 1. `location_city` -> `findCanonicalLocation(locationContext, opts)`
 * 2. `phone_country_code` -> `findCanonicalPhoneCountry(val, opts, countryContext)`
 * 3. All other / generic comboboxes -> `undefined` (strict exact-match only)
 */
export function getComboboxNormalizer(
  canonicalKey: string | null | undefined,
  fieldValue: string,
  context?: { locationContext?: string | null; phoneCountryContext?: string | null }
): ((opts: readonly string[]) => string | null) | undefined {
  if (canonicalKey === "location_city" && context?.locationContext) {
    const loc = context.locationContext;
    return (opts) => findCanonicalLocation(loc, opts);
  }
  if (canonicalKey === "phone_country_code") {
    const country = context?.phoneCountryContext ?? null;
    return (opts) => findCanonicalPhoneCountry(fieldValue, opts, country);
  }
  return undefined;
}

async function applyPlan(page: Page, plan: FieldPlan): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (plan.action === "fill") {
    if (plan.field.kind === "select") {
      await page.selectOption(plan.field.selector, { label: plan.value });
      return { ok: true };
    }
    if (plan.field.kind === "checkbox") {
      /* PHASE 9B — a checkbox is never toggled blindly. The planned value must map to a state
       * exactly; anything else is a question for the user, same as an unmatchable combobox. */
      const v = plan.value.trim().toLowerCase();
      if (v === "yes" || v === "true") {
        await page.check(plan.field.selector);
        return { ok: true };
      }
      if (v === "no" || v === "false") {
        await page.uncheck(plan.field.selector);
        return { ok: true };
      }
      return {
        ok: false,
        reason: `"${plan.value}" does not map unambiguously to a checkbox state — Career-Ops never toggles blindly.`,
      };
    }
    if (plan.field.kind === "radio") {
      /* PHASE 9B — the plan's field is ONE input of a radio group; the answer names an OPTION.
       * Select the group member whose own label/value equals the answer exactly — comboboxSelection's
       * exact-match discipline in radio shape. Zero matches or more than one both pause the run:
       * a real group never needs a guess, and duplicate labels are a page telling us it is unsure. */
      /* No named function bindings inside the evaluate callback — see readAdvanceControlTexts. */
      const located = await page.evaluate(
        (args) => {
          const target = document.querySelector(args.selector) as HTMLInputElement | null;
          if (!target) return { state: "missing" as const };
          const group = target.name
            ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(target.name)}"]`)]
            : [target];
          const wanted = args.value.trim();
          const hits = group.filter((el) => {
            const id = (el as HTMLInputElement).id;
            const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : null;
            const wrapped = el.closest("label")?.textContent;
            return [byFor, wrapped, el.getAttribute("value")].some((t) => (t ?? "").trim() === wanted && wanted.length > 0);
          });
          if (hits.length !== 1) return { state: hits.length === 0 ? ("no_option" as const) : ("ambiguous" as const) };
          const hit = hits[0] as HTMLInputElement;
          return { state: "found" as const, id: hit.id || null, index: group.indexOf(hit), name: target.name || null };
        },
        { selector: plan.field.selector, value: plan.value }
      );
      if (located.state === "missing") {
        return { ok: false, reason: "The radio control could not be found on the page." };
      }
      if (located.state === "no_option") {
        return {
          ok: false,
          reason: `No option in this radio group exactly matches "${plan.value}" — Career-Ops never selects a close match.`,
        };
      }
      if (located.state === "ambiguous") {
        return {
          ok: false,
          reason: `More than one option in this radio group matches "${plan.value}" — Career-Ops never guesses between them.`,
        };
      }
      if (located.id) {
        await page.check(`[id="${escapeAttributeValue(located.id)}"]`);
      } else if (located.name) {
        await page.locator(`input[type="radio"][name="${escapeAttributeValue(located.name)}"]`).nth(located.index).check();
      } else {
        await page.check(plan.field.selector);
      }
      return { ok: true };
    }
    if (plan.field.kind === "combobox") {
      // For location_city and phone_country_code, supply normalisers so bare or compact values
      // can resolve to the ATS canonical options without loosening any generic combobox matching.
      const normalize = getComboboxNormalizer(plan.canonicalKey, plan.value, {
        locationContext: plan.locationContext,
        phoneCountryContext: plan.phoneCountryContext,
      });
      const selected = await selectComboboxOption(page, plan.field.selector, plan.value, normalize);
      if (!selected) {
        return {
          ok: false,
          reason: `No option in this list exactly matches "${plan.value}" — Career-Ops never selects a close match.`,
        };
      }
      return { ok: true };
    }
    await page.fill(plan.field.selector, plan.value);
    return { ok: true };
  }
  if (plan.action === "upload") {
    await page.setInputFiles(plan.field.selector, plan.filePath);
  }
  return { ok: true };
}

/**
 * Run one application as far as it can safely go.
 *
 * Ends in a WAITING_* state (a human is needed), READY_FOR_REVIEW (filled, awaiting the user's
 * reading of it), or FAILED. Never SUBMITTED — see approveAndSubmit.
 */
export async function executeRun(
  runId: number,
  runtime: ApplicationBrowserRuntime,
  deps: ExecutorDeps,
  /* Same convention as approveAndSubmit's opts: the mock harness injects the adapter under test
   * here. Production callers omit it, and selection stays with the job record's own identity. */
  opts: { adapter?: AtsAdapter; credentialStore?: CredentialStore } = {}
): Promise<ApplicationRun> {
  let run = getRun(runId);
  if (!run) throw new Error(`No application run ${runId}`);
  if (!run.apply_url) {
    return advanceRun(runId, "FAILED", { blockingReason: "This run has no application URL." });
  }
  /* Captured once: `run` is reassigned by every advanceRun below, which would lose the narrowing. */
  const applyUrl = run.apply_url;

  const selection = selectAdapter({ source_type: (run.ats as never) ?? null, url: applyUrl });
  const activeAdapter: AtsAdapter | null = opts.adapter ?? selection?.adapter ?? null;
  /* PHASE 9B — null for every adapter without nextPageSelector (Greenhouse, Lever), and null keeps
   * the walk below collapsed to the exact single-page flow that existed before this phase. */
  const multi = resolveMultiPageConfig(activeAdapter);
  const credentialStore = opts.credentialStore ?? keychainCredentialStore;

  /** PHASE 9C — a login wall is not automatically a stop. When the active adapter declares an
   *  `auth` contract, `ensureAuthenticated` gets first say; only its non-proceeding outcomes turn
   *  into a paused run. An adapter without `auth` (Greenhouse, Lever, every Phase 9B test fixture)
   *  falls straight through to the ORIGINAL behavior — the condition, unchanged, blocks exactly as
   *  it did before this phase. */
  const resolveBlockingWithAuth = async (
    page: Page,
    condition: BlockingCondition | null
  ): Promise<{ condition: BlockingCondition; detail: string } | null> => {
    if (!condition) return null;
    const config = condition === "account_required" ? activeAdapter?.auth?.() : undefined;
    if (!config) return { condition, detail: condition };

    const identity: AtsAccountIdentity = {
      userId: String(deps.context.candidateId),
      ats: activeAdapter!.sourceType,
      tenant: deriveTenantKey(applyUrl),
      email: deps.context.contact.email,
    };
    const result = await ensureAuthenticated({ runId, page, identity, config, store: credentialStore });
    if (authOutcomeProceeds(result.outcome)) return null;
    return { condition: authOutcomeToBlockingCondition(result.outcome) ?? "account_required", detail: result.detail };
  };

  const previousCheckpoint = run.checkpoint_json ? (JSON.parse(run.checkpoint_json) as ExecutionCheckpoint) : null;

  const checkpoint: ExecutionCheckpoint = {
    url: null,
    ats: run.ats,
    step: "starting",
    completed: [],
    runAnswers: previousCheckpoint?.runAnswers ?? {},
    lastAction: "run loaded",
  };
  if (multi) checkpoint.page = 1;

  /* A resumed run re-enters from a waiting state; a fresh one from QUEUED. Both re-open the page —
   * the browser that was here before is gone, and pretending otherwise is how state diverges. */
  if (run.status === "QUEUED") run = advanceRun(runId, "STARTING");

  let session: BrowserSession | null = null;
  try {
    session = await runtime.open(applyUrl);
    checkpoint.url = session.page.url();
    checkpoint.step = "navigating";
    checkpoint.lastAction = "opened application page";
    if (run.status === "STARTING") run = advanceRun(runId, "NAVIGATING", { checkpoint });
    else updateCheckpoint(runId, checkpoint);

    /* Blocking conditions before anything else: a CAPTCHA gates the whole page, and filling behind
     * one both fails and looks exactly like the automation the site is asking not to receive. */
    const signals = await readPageSignals(session.page);

    /* PHASE 9D — checked before any blocking condition: the ATS reporting an existing application
     * is not something to wait out, and repeatedly retrying would be actively wrong. Terminal,
     * exactly like a run with no application URL at all. */
    if (detectAlreadyApplied(signals)) {
      recordEvent(runId, "already_applied_detected", null);
      return advanceRun(runId, "FAILED", {
        checkpoint,
        blockingReason: "This ATS reports an application already exists for this job. Nothing more will be attempted.",
      });
    }

    const blocking = await resolveBlockingWithAuth(session.page, detectBlocking(signals));
    if (blocking) {
      recordEvent(runId, "blocking_detected", blocking.detail);
      return advanceRun(runId, BLOCKING_STATUS[blocking.condition], { checkpoint });
    }

    if (run.status !== "FILLING") run = advanceRun(runId, "FILLING", { checkpoint });
    checkpoint.step = "filling";

    /* ── PHASE 9B — the page walk ────────────────────────────────────────────────────────────────
     * One bounded loop of discover → plan → fill → checkpoint per page. A single-page adapter
     * (multi === null) runs the body exactly once and breaks where the pre-9B code returned, so
     * Greenhouse and Lever behavior is unchanged by construction. Everything the loop DECIDES —
     * whether a control may be clicked, whether a page is review or a login wall, when to stop —
     * is a pure function in multiPage.ts. */
    const allPlans: FieldPlan[] = [];
    const plannedSelectors = new Set<string>();
    /* Review is built from the first plan seen for each selector; a remediation re-plan of the
     * same field never duplicates its line. */
    const rememberPlans = (plans: FieldPlan[]) => {
      for (const plan of plans) {
        if (plannedSelectors.has(plan.field.selector)) continue;
        plannedSelectors.add(plan.field.selector);
        allPlans.push(plan);
      }
    };
    /* Selectors acted on in THIS execution (a re-opened page always starts empty, so nothing
     * carries over from a previous checkpoint) plus radio groups already decided — one answer
     * decides a whole group, and its remaining members must not re-fire. */
    const completedSelectors = new Set<string>();
    const filledRadioGroups = new Set<string>();
    let pageNumber = 1;

    /* Apply every fill/upload plan in order. Returns the paused run on the first unanswerable
     * field (the pre-9B pause, verbatim), or null when the page is done. */
    const fillFromPlans = async (plans: FieldPlan[]): Promise<ApplicationRun | null> => {
      for (const plan of plans) {
        if (plan.action !== "fill" && plan.action !== "upload") continue;
        if (completedSelectors.has(plan.field.selector)) continue;
        if (plan.action === "fill" && plan.field.kind === "radio") {
          const groupKey = plan.field.name ?? plan.field.selector;
          if (filledRadioGroups.has(groupKey)) continue;
        }
        const result = await applyPlan(session!.page, plan);
        if (!result.ok) {
          /* A combobox/radio/checkbox with no exact mapping for the approved value — discoverable
           * only against the live control, so this is caught here rather than during planning.
           * Falls back to the SAME pause-and-ask behavior as any other unanswerable field. */
          return advanceRun(runId, "WAITING_FOR_ANSWER", {
            checkpoint,
            blockingQuestion: plan.field.label ?? plan.field.selector,
            blockingReason: result.reason,
          });
        }
        completedSelectors.add(plan.field.selector);
        if (plan.action === "fill" && plan.field.kind === "radio") {
          filledRadioGroups.add(plan.field.name ?? plan.field.selector);
        }
        checkpoint.completed.push({
          selector: plan.field.selector,
          canonicalKey: plan.action === "fill" ? plan.canonicalKey : null,
          source: plan.source,
          kind: plan.action,
        });
        checkpoint.lastAction = `${plan.action}: ${plan.field.label ?? plan.field.selector}`;
        updateCheckpoint(runId, checkpoint);
        recordEvent(
          runId,
          plan.action === "upload" ? "document_uploaded" : "field_filled",
          plan.field.label ?? plan.field.selector
        );
      }
      return null;
    };

    for (;;) {
      const controls = (await session.page.evaluate(COLLECT_CONTROLS_SCRIPT)) as RawControl[];
      const fields = discoverFields(controls);
      const plans = planFields({
        fields,
        context: deps.context,
        knownVariants: deps.knownVariants,
        storedAnswers: deps.storedAnswers,
        runAnswers: checkpoint.runAnswers,
        selectorHints: activeAdapter?.fieldSelectorHints(),
      });
      rememberPlans(plans);

      const paused = await fillFromPlans(plans);
      if (paused) return paused;

      /* Discover options for any required combobox questions going into the batch, so the
       * candidate UI can render multiple-choice dropdowns/pills instead of a plain text box. */
      for (const plan of plans) {
        if (
          plan.action === "ask" &&
          plan.field.required &&
          plan.field.kind === "combobox" &&
          (!plan.field.options || plan.field.options.length === 0)
        ) {
          const discovered = await discoverComboboxOptions(session.page, plan.field.selector);
          if (discovered && discovered.length > 0) {
            plan.field.options = discovered;
          }
        }
      }

      /* Collect all required unanswered fields at once. A single pause lets the user answer
       * everything in one batch rather than one field per execution cycle. */
      const humanQuestions = collectHumanQuestions(plans, deps.knownVariants);
      if (humanQuestions.length > 0) {
        checkpoint.humanQuestions = humanQuestions;
        recordEvent(runId, "human_question_batch_created", String(humanQuestions.length));
        return advanceRun(runId, "WAITING_FOR_ANSWER", {
          checkpoint,
          blockingQuestion: humanQuestions[0]!.label,
          blockingReason: humanQuestions[0]!.reason,
        });
      }

      /* Single-page adapters exit here — the exact point the pre-9B flow fell through to review. */
      if (!multi) break;

      const signals = await readPageSignals(session.page);
      if (matchesAnyMarker(signals.text, multi.reviewMarkers)) {
        /* The review page ends the walk. No further advance control is read, let alone clicked —
         * the engine never advances past review. */
        recordEvent(runId, "review_page_detected", `page ${pageNumber}`);
        break;
      }
      if (pageNumber >= multi.maxPages) {
        recordEvent(runId, "multi_page_limit_reached", `page ${pageNumber} of at most ${multi.maxPages}`);
        return advanceRun(runId, "FAILED", {
          checkpoint,
          blockingReason: "This application spans more pages than the safe limit; stopped before the review page.",
        });
      }

      const advanceTexts = await readAdvanceControlTexts(session.page, multi.nextSelector);
      if (advanceTexts === null) break; /* no advance control — this is the final page */
      const classification = classifyAdvanceControl(advanceTexts);
      if (classification !== "safe_advance") {
        /* NEVER-SUBMIT GUARD. A final-action control ("Submit Application", "Finish", …) is the
         * form's own submit — exactly what the single-page flow leaves for the user, so the walk
         * ends the same way: review built, nothing clicked. An ambiguous control is treated
         * identically because uncertain semantics are not a thing to click through; only the
         * audit trail distinguishes the two. */
        recordEvent(
          runId,
          classification === "final_action" ? "advance_control_blocked" : "advance_control_ambiguous",
          advanceTexts.join(" | ").slice(0, 200)
        );
        break;
      }

      const before = await readPageFingerprint(session.page);
      await session.page.click(multi.nextSelector);
      let advanced = await waitForPageTransition(session.page, before);
      if (!advanced) {
        recordEvent(runId, "page_did_not_advance", `page ${pageNumber}`);
        /* Bounded remediation, once: the click may have surfaced validation errors or revealed
         * required fields. Re-discover; fill anything newly authoritative; pause on anything
         * needing a human. Only a pass that actually filled something earns ONE more click —
         * an unchanged page is never clicked at again. */
        const retryControls = (await session.page.evaluate(COLLECT_CONTROLS_SCRIPT)) as RawControl[];
        const retryPlans = planFields({
          fields: discoverFields(retryControls),
          context: deps.context,
          knownVariants: deps.knownVariants,
          storedAnswers: deps.storedAnswers,
          runAnswers: checkpoint.runAnswers,
          selectorHints: activeAdapter?.fieldSelectorHints(),
        });
        rememberPlans(retryPlans);
        const newlyFillable = retryPlans.filter(
          (plan) => (plan.action === "fill" || plan.action === "upload") && !completedSelectors.has(plan.field.selector)
        );
        const retryPaused = await fillFromPlans(retryPlans);
        if (retryPaused) return retryPaused;
        const retryQuestions = collectHumanQuestions(retryPlans, deps.knownVariants);
        if (retryQuestions.length > 0) {
          checkpoint.humanQuestions = retryQuestions;
          recordEvent(runId, "human_question_batch_created", String(retryQuestions.length));
          return advanceRun(runId, "WAITING_FOR_ANSWER", {
            checkpoint,
            blockingQuestion: retryQuestions[0]!.label,
            blockingReason: retryQuestions[0]!.reason,
          });
        }
        if (newlyFillable.length === 0) {
          return advanceRun(runId, "FAILED", {
            checkpoint,
            blockingReason:
              "The application page did not advance and nothing more could be safely filled; stopped rather than clicking again.",
          });
        }
        const beforeRetry = await readPageFingerprint(session.page);
        await session.page.click(multi.nextSelector);
        advanced = await waitForPageTransition(session.page, beforeRetry);
        if (!advanced) {
          recordEvent(runId, "page_did_not_advance", `page ${pageNumber} (after retry)`);
          return advanceRun(runId, "FAILED", {
            checkpoint,
            blockingReason: "The application page did not advance after a bounded retry; stopped rather than clicking repeatedly.",
          });
        }
      }

      pageNumber += 1;
      checkpoint.page = pageNumber;
      checkpoint.url = session.page.url();
      checkpoint.lastAction = `advanced to page ${pageNumber}`;
      updateCheckpoint(runId, checkpoint);
      recordEvent(runId, "page_advanced", `page ${pageNumber} via ${multi.nextSelector}`);

      /* Blocking detection ON THE NEW PAGE, before anything on it is touched. A safe previous page
       * says nothing about this one: a CAPTCHA, MFA gate or login wall can appear at any step, and
       * the adapter's own login markers are merged with the generic detector's signals. */
      const nextSignals = await readPageSignals(session.page);
      const genericBlockingNow =
        detectBlocking(nextSignals) ??
        (matchesAnyMarker(`${nextSignals.text} ${nextSignals.markers.join(" ")}`, multi.loginMarkers)
          ? ("account_required" as const)
          : null);
      const blockingNow = await resolveBlockingWithAuth(session.page, genericBlockingNow);
      if (blockingNow) {
        recordEvent(runId, "blocking_detected", blockingNow.detail);
        return advanceRun(runId, BLOCKING_STATUS[blockingNow.condition], { checkpoint });
      }
    }

    checkpoint.step = "review";
    checkpoint.review = buildFinalReview({
      company: null,
      role: "",
      ats: run.ats,
      plans: allPlans,
      resumeFile: run.resume_file,
      coverLetterFile: run.cover_letter_file,
    });
    checkpoint.lastAction = "application filled; review built";
    return advanceRun(runId, "READY_FOR_REVIEW", { checkpoint });
  } catch (err) {
    /* Page content can leak into error messages; the stored reason stays generic and the detail
     * goes to the event log, which the run detail view exposes deliberately. */
    recordEvent(runId, "execution_error", String(err).slice(0, 300));
    return advanceRun(runId, "FAILED", { blockingReason: "The application run hit an error and stopped safely." });
  } finally {
    await session?.close();
  }
}

/**
 * The only path to a submitted application.
 *
 * Requires an approval naming this exact run — the storage layer refuses the transition otherwise —
 * and treats the click as a claim to verify, not a result. Only the page's own confirmation text
 * marks the run SUBMITTED; anything else is SUBMISSION_UNCONFIRMED and the user is asked to check.
 */
/**
 * PHASE 9D — abort an in-flight submission attempt and return to a NORMAL waiting state, using
 * only transitions runState.ts already allows: WAITING_FOR_SUBMIT_APPROVAL -> READY_FOR_REVIEW ->
 * FILLING -> the target waiting state. No edge is added to the state machine — this walks the
 * exact path a normal execution failure already takes, so one explicit approval never becomes
 * permission to skip past a newly-discovered question or a re-authentication requirement.
 */
async function abortSubmissionTo(
  runId: number,
  targetStatus: RunStatus,
  checkpoint: ExecutionCheckpoint | null,
  extra: { blockingReason?: string; blockingQuestion?: string } = {}
): Promise<ApplicationRun> {
  const current = getRun(runId)!;
  if (current.status === "WAITING_FOR_SUBMIT_APPROVAL") {
    advanceRun(runId, "READY_FOR_REVIEW", { checkpoint: checkpoint ?? undefined });
  }
  advanceRun(runId, "FILLING", { checkpoint: checkpoint ?? undefined });
  return advanceRun(runId, targetStatus, { checkpoint: checkpoint ?? undefined, ...extra });
}

export async function approveAndSubmit(
  runId: number,
  runtime: ApplicationBrowserRuntime,
  approval: { runId: number },
  opts: { submitSelector?: string; adapter?: AtsAdapter; deps?: ExecutorDeps; credentialStore?: CredentialStore } = {}
): Promise<ApplicationRun> {
  const run = getRun(runId);
  if (!run) throw new Error(`No application run ${runId}`);
  if (!run.apply_url) return advanceRun(runId, "FAILED", { blockingReason: "This run has no application URL." });
  const applyUrl = run.apply_url;

  /* Validated FIRST, outside any try/catch and before any state mutation or browser action — one
   * job's approval must never be usable for another, and a mismatch must fail exactly this cleanly
   * regardless of what pre-flight hardening happens below. Mirrors (and is redundantly re-checked
   * by) advanceRun's own belt-and-braces guard when the SUBMITTING transition actually happens. */
  if (!approval || approval.runId !== runId) {
    throw new Error("Submission requires an explicit approval for this application run.");
  }

  const selection = selectAdapter({ source_type: (run.ats as never) ?? null, url: applyUrl });
  const activeAdapter: AtsAdapter | null = opts.adapter ?? selection?.adapter ?? null;
  const credentialStore = opts.credentialStore ?? keychainCredentialStore;
  const checkpoint = run.checkpoint_json ? (JSON.parse(run.checkpoint_json) as ExecutionCheckpoint) : null;

  let session: BrowserSession | null = null;
  try {
    session = await runtime.open(applyUrl);

    /* ── PHASE 9D — re-authenticate BEFORE anything is refilled or clicked ─────────────────────
     * A session can expire between READY_FOR_REVIEW and the user's approval. Checked here, on the
     * SAME page the refill is about to use, exactly like the executor's own login-wall handling —
     * one policy chokepoint, not a second auth path. */
    if (activeAdapter?.auth) {
      const config = activeAdapter.auth();
      const identity: AtsAccountIdentity = {
        userId: String(opts.deps?.context.candidateId ?? run.candidate_id),
        ats: activeAdapter.sourceType,
        tenant: deriveTenantKey(applyUrl),
        email: opts.deps?.context.contact.email ?? "",
      };
      const authResult = await ensureAuthenticated({ runId, page: session.page, identity, config, store: credentialStore });
      if (!authOutcomeProceeds(authResult.outcome)) {
        recordEvent(runId, "submit_preflight_auth_blocked", authResult.detail);
        return abortSubmissionTo(
          runId,
          BLOCKING_STATUS[authOutcomeToBlockingCondition(authResult.outcome) ?? "account_required"],
          checkpoint
        );
      }
    }

    /* Refill from the approved review — a fresh page has empty fields, and the review the user
     * read IS the thing their approval covered. Only previously-completed selectors are touched;
     * nothing new is decided at submit time. Routed through the SAME `applyPlan` the normal
     * execution loop uses, so select/combobox/checkbox/radio/upload all get identical treatment —
     * no second, partial implementation of field-filling semantics at submit time. */
    if (checkpoint?.review) {
      const contact = getCandidateContact(run.candidate_id);
      const locationContext = contact?.location ?? null;
      const phoneCountryContext = contact?.phone
        ? derivePhoneCountryCode(contact.phone, contact.location)?.countryName ?? null
        : null;

      const controls = (await session.page.evaluate(COLLECT_CONTROLS_SCRIPT)) as RawControl[];
      const fields = discoverFields(controls);
      for (const completed of checkpoint.completed) {
        const field = fields.find((f) => f.selector === completed.selector);
        if (!field) continue;
        if (completed.kind === "upload") {
          const doc = completed.selector.toLowerCase().includes("cover") ? run.cover_letter_file : run.resume_file;
          if (doc) {
            const result = await applyPlan(session.page, {
              action: "upload",
              field,
              filePath: doc,
              source: completed.source as Extract<FieldPlan, { action: "upload" }>["source"],
            });
            if (!result.ok) throw new Error(`Approved document could not be re-attached for ${field.label ?? field.selector}: ${result.reason}`);
          }
          continue;
        }
        const line = checkpoint.review.answers.find(
          (a) => a.question === (field.label ?? completed.canonicalKey ?? "")
        );
        if (!line) continue;

        const plan: FieldPlan = {
          action: "fill",
          field,
          value: line.value,
          source: completed.source as Extract<FieldPlan, { action: "fill" }>["source"],
          canonicalKey: completed.canonicalKey,
          ...(completed.canonicalKey === "location_city" ? { locationContext: locationContext ?? undefined } : {}),
          ...(completed.canonicalKey === "phone_country_code" ? { phoneCountryContext: phoneCountryContext ?? undefined } : {}),
        };
        const result = await applyPlan(session.page, plan);
        if (!result.ok) {
          throw new Error(`Approved value "${line.value}" is no longer valid for ${field.label ?? field.selector}: ${result.reason}`);
        }
      }
    }

    /* ── PHASE 9D — new-question detection ──────────────────────────────────────────────────────
     * One explicit approval covers exactly the review the user read. If the live form now reveals
     * a required question that wasn't part of it, this is NOT authorization to answer it — leave
     * submission mode entirely and land back on the normal WAITING_FOR_ANSWER batch path. Only
     * runs when a caller supplies `deps` (the production route does); without it, this check is
     * skipped and behavior is exactly what it was before this phase. */
    if (opts.deps) {
      const freshControls = (await session.page.evaluate(COLLECT_CONTROLS_SCRIPT)) as RawControl[];
      const freshFields = discoverFields(freshControls);
      const freshPlans = planFields({
        fields: freshFields,
        context: opts.deps.context,
        knownVariants: opts.deps.knownVariants,
        storedAnswers: opts.deps.storedAnswers,
        runAnswers: checkpoint?.runAnswers,
        selectorHints: activeAdapter?.fieldSelectorHints(),
      });
      const newQuestions = collectHumanQuestions(freshPlans, opts.deps.knownVariants);
      if (newQuestions.length > 0) {
        recordEvent(runId, "submit_preflight_new_question", String(newQuestions.length));
        const nextCheckpoint: ExecutionCheckpoint = {
          ...(checkpoint ?? { url: session.page.url(), ats: run.ats, completed: [], lastAction: "" }),
          step: "filling",
          humanQuestions: newQuestions,
        };
        return abortSubmissionTo(runId, "WAITING_FOR_ANSWER", nextCheckpoint, {
          blockingQuestion: newQuestions[0]!.label,
          blockingReason: newQuestions[0]!.reason,
        });
      }
    }

    if (run.status === "READY_FOR_REVIEW") advanceRun(runId, "WAITING_FOR_SUBMIT_APPROVAL");
    advanceRun(runId, "SUBMITTING", { submitApproval: approval });

    await session.page.click(opts.submitSelector ?? DEFAULT_SUBMIT);
    await session.page.waitForTimeout(1500);

    const text = await session.page.evaluate(() => document.body?.innerText ?? "");
    const outcome = readSubmissionOutcome(text);
    recordEvent(runId, "submit_attempted", outcome.evidence);

    if (outcome.confirmed) {
      return advanceRun(runId, "SUBMITTED", { confirmationText: outcome.evidence });
    }
    return advanceRun(runId, "SUBMISSION_UNCONFIRMED", {
      blockingReason: "The submit was clicked but the site did not clearly confirm receipt. Please verify.",
    });
  } catch (err) {
    recordEvent(runId, "execution_error", String(err).slice(0, 300));
    return advanceRun(runId, "FAILED", {
      blockingReason: "Submission hit an error; the application may not have been sent.",
    });
  } finally {
    await session?.close();
  }
}
