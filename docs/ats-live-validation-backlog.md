# ATS live-validation backlog

Platforms this repository can only honestly call `DETECTION_ONLY` or `NEEDS_LIVE_VALIDATION`
today (see `docs/ats-adapter-coverage.md` / `src/lib/apply/agent/adapters/coverage.ts`). Nothing
below was observed live during this phase — no real ATS was opened, no account was created, no
credentials were used, no application was submitted. Each row states exactly what real, read-only
observation would be needed before a fixture (and therefore an adapter) could honestly be written,
per the no-selector-fiction rule: a selector must come from real evidence, never be guessed and then
"proven" against a fixture built from the same guess.

**Standing rule for every platform below, no exceptions:** observation must be read-only browsing of
a real posting's **public, unauthenticated** apply form. Never create a real account, never enter
real personal data, never click Submit/Apply/Finish/Send/Complete/Save and Submit or any other
final action, never attempt to bypass a CAPTCHA/MFA/email-verification wall. If a platform's apply
flow requires authentication before the form is even visible, that itself is the finding — record it
as an `AUTH_REQUIRED` shape, not a reason to log in.

## Tier 1 — high-value major ATS

| Platform | Missing evidence | Risk |
|---|---|---|
| Ashby | Real application-form markup; whether fields carry semantic labels/ARIA roles (adapter's own notes expect this is likely, unproven) | Low |
| iCIMS | Application-entry URL shape and form markup; historically heavy per-tenant template customization means one tenant's markup may not generalize — observe 2-3 distinct tenants, not one | Medium |
| SmartRecruiters | Real apply-form URL and markup (prior assessment, `docs/ATS_APPLICATION_ADAPTER_ASSESSMENT.md`, found only 1 unlabelled/unnamed control on the job page itself — the apply form is not there; locate the real form URL first) | Medium |
| Oracle Recruiting Cloud | Real form markup; expected heavy custom-widget controls (similar historical pattern to Workday) rather than plain HTML inputs | High |
| Oracle Taleo | Real form markup; legacy product, expect older/heavier markup — do not assume modern semantic HTML applies | High |
| SAP SuccessFactors | Real form markup and whether a multi-page flow exists | Medium |
| ADP Workforce Now | Real form markup and application-entry path | Medium |
| ADP Recruiting Management | Real form markup — distinct product from ADP WFN, do not assume identical | Medium |
| UKG Pro Recruiting | Real form markup and application-entry path | Medium |
| Jobvite | Real form markup and whether a distinct review step exists | Medium |

## Tier 2 — common modern ATS

| Platform | Missing evidence | Risk |
|---|---|---|
| Workable | Real form markup (product has a modern reputation; unproven) | Low |
| Recruitee | Real form markup | Low |
| Teamtailor | Real form markup | Low |
| BambooHR | Real form markup; whether the public careers-page apply flow differs from the internal HR product | Low |
| JazzHR | Real form markup | Low |
| Breezy HR | Real form markup | Low |
| Pinpoint | Real form markup | Low |
| Comeet | Real form markup | Low |
| Rippling Recruiting | Real form markup; whether Rippling's broader HR-suite auth model leaks into the public apply flow | Medium |

## Tier 3 — additional enterprise / SMB

| Platform | Missing evidence | Risk |
|---|---|---|
| Eightfold | Real form markup; AI-matching-vendor products sometimes gate the form behind a profile-import step | Medium |
| Cornerstone Recruiting | Real form markup | Medium |
| Avature | Real form markup; historically CRM-style enterprise product with heavy custom widgetry — do not assume generic discovery suffices | High |
| ClearCompany | Real form markup | Low |
| Paycom | Real form markup; payroll-suite products have historically required account/portal auth before the form is visible | Medium |
| Paylocity Recruiting | Real form markup; same portal-auth caveat as Paycom | Medium |
| ApplicantPro | Real form markup | Low |
| ApplicantStack | Real form markup | Low |
| Personio | Real form markup | Low |
| CATS | Real form markup | Low |
| GoHire | Real form markup | Low |
| Newton (Paycor Recruiting) | Real form markup — this IS the Paycor coverage entry, no separate SourceType exists | Low |
| SilkRoad | Real form markup; legacy product, expect older markup patterns | Medium |
| JobDiva | Real form markup | Medium |

## Needs live validation before detection itself can be trusted

| Platform | Missing evidence | Risk |
|---|---|---|
| Phenom | The one `SourceType` with **no detector function** in `src/lib/ats/detect.ts` (confirmed by direct grep) — this is a gap in the discovery layer, not the apply-adapter layer this phase covers. Needs a real posting to derive a detection pattern from before any apply-layer work is meaningful. | Medium |

## Recommended, not required — platforms already fixture-verified but with a known gap

| Platform | Missing evidence | Risk |
|---|---|---|
| Lever | `PARTIAL_FIXTURE_VERIFIED` today. Its `fieldSelectorHints()` are drawn from Lever's documented, long-stable public field-naming convention (legitimate static/public evidence), not a captured live posting — the adapter's own comment states this explicitly. Recommended, not required: confirm the documented convention still matches a real, current Lever posting. | Low |

## Suggested observation order

1. Ashby, Workable, Recruitee, Teamtailor, BambooHR, JazzHR, Breezy, Pinpoint, Comeet — modern,
   semantic-HTML-forward products where the universal engine is most likely to already work
   unmodified; cheapest to confirm, highest chance of promoting straight to `FULL_FIXTURE_VERIFIED`
   with little or no new adapter code.
2. iCIMS, SmartRecruiters, Jobvite, SAP SuccessFactors, ADP WFN/RM, UKG Pro, Rippling — established
   platforms where per-tenant variation or a non-obvious form URL is the main open question.
3. Oracle Recruiting Cloud, Oracle Taleo, Avature, Paycom, Paylocity, Eightfold — historically the
   heaviest custom-widget or portal-auth risk; budget the most observation time here, and expect some
   of these to need real adapter hints (à la Workday) rather than working out of the box.
4. Phenom — resolve the discovery-layer detection gap first; apply-layer work on it is not yet
   meaningful without that.

Nothing in this backlog blocks the rest of the catalog — per the governing task's explicit
instruction, no single difficult platform holds up progress on the others.
