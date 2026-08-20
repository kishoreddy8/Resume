# ATS application-adapter assessment

Scope: **application-form automation only**. Discovering, detecting and normalising ATS sources is
already done by the connector layer; adapters are selected by the job record's own `source_type` and
add no detection of their own.

Priority is by **observed active job volume in this installation**, not by market share.

| ATS | Active | Total | Adapter | Status |
|---|---:|---:|---|---|
| workday | 8,523 | 11,428 | — | Assessed, not built. See below. |
| oracle_recruiting_cloud | 1,750 | 2,020 | — | Not assessed |
| greenhouse | 1,160 | 1,268 | ✅ built | Verified against a live form |
| smartrecruiters | 1,135 | 1,312 | — | Assessed, blocked. See below. |
| career_link | 1,048 | 1,179 | — | Not an ATS; heterogeneous career pages |
| adp_rm | 554 | 605 | — | Not assessed |
| jobdiva | 425 | 455 | — | Not assessed |
| lever | 141 | 141 | ✅ built | Verified against a live form |

Lever is low-volume here but was built because it shares the contract and provided the second real
form needed to prove the adapter architecture generalises — which it immediately did, by exposing a
defect the Greenhouse fixture had hidden (see below).

## What verification means here

Both built adapters were checked read-only against a **live posting**, and the captured markup is a
test fixture. That is the standard applied: an adapter validated only against a mock the author also
wrote proves the author agreed with themselves.

It earned its keep immediately. Greenhouse labels every control properly; **Lever labels none of
them** — no `<label for>`, no `aria-label`, no caption, only a `name` attribute. The planner treated
an unlabelled field as an unknown question, so on a real Lever form all fifteen fields blocked,
including the candidate's own name and email. A mock-only adapter would have shipped that.

## Workday — assessed, deliberately not built

Measured on a live `*.myworkdayjobs.com` posting:

- **0 form controls on the job page.** It is a single-page app; the application form is several
  navigations away.
- **`data-automation-id` attributes are present** (24 on the landing view alone) — genuinely stable
  automation hooks, and the one encouraging finding.
- **A legal/cookie notice gates the page**, with its own accept/decline controls.
- **Sign-in or account creation is required** before the form is reachable at all.

**Recommendation: do not build this adapter yet.** Not because it is hard, but because it cannot be
verified honestly right now:

1. The form is unreachable without an account. Every run would immediately stop at
   `ACCOUNT_REQUIRED`, so the adapter's actual value is entirely in code no one has seen execute.
2. Verifying it means creating a real account on a real employer's Workday tenant. Doing that
   autonomously, on the user's behalf, is not a decision to take without being asked.
3. Writing selectors for a form never observed is precisely the fabrication avoided everywhere else
   in this system.

**If it is to be built**, the safe order is: a user creates their Workday account manually and
completes it once; that session is used to observe the form structure read-only; the adapter is then
written against captured markup, exactly as Greenhouse and Lever were. The account-required pause
already exists in the state machine, so the flow degrades correctly in the meantime.

Workday is also the strongest argument for the credential store built alongside it — a Workday
adapter without secure credential handling would be the wrong thing to build first.

## SmartRecruiters — assessed, blocked

A live `jobs.smartrecruiters.com` posting exposed **1 control, 0 labelled, 0 named**. The apply flow
is not on the job page and no apply control was detectable from it. Needs the same treatment as
Workday: locate the real form URL first, then assess. Not blocked on anything fundamental — just not
yet observed.

## Not assessed

`oracle_recruiting_cloud`, `adp_rm`, `jobdiva`, `phenom`, `ukg_pro`, `icims`, `ashby`. Each needs the
same read-only probe before any adapter is written. Ashby is worth an early look despite low volume:
it is a modern, well-structured ATS and likely to resemble Greenhouse.

`career_link` is not an ATS — it is the catch-all for company career pages, which are heterogeneous
by definition. A generic form-filler for it would be guessing at unfamiliar layouts, which the
planner explicitly refuses to do.

## The rule that does not change per ATS

Every adapter contributes selectors and page knowledge. **None of them decides whether a field may
be filled.** That lives in one pure function over discovered fields, so the safety rules are
identical across every ATS and testable without a browser. An adapter cannot route around them.
