# CAREER-OPS — PHASE 9 SPECIFICATION
## Universal Application Autofill Engine — Greenhouse Preservation + Workday Reference Adapter

**Status:** IN PROGRESS

**Recovered from:** the interrupted Phase 9 development session of 2026-08-25 (session
`86b6dbd9-eed4-4acc-b294-1c26d078ba64`, prompt #25, 04:57 UTC). The session was interrupted
5m16s into implementation, after the additive `types.ts` / `fieldDiscovery.ts` contract edits and
before anything else. The complete original 27-section instruction is preserved verbatim below.

**Current implementation checkpoint:** Phase 9A stabilization — regression coverage for the
`selectorFor` data-automation-id change, comment corrections, and this document. No multi-page
engine, no Workday adapter, no schema migration yet.

**IMPORTANT IMPLEMENTATION NOTE — policy architecture.** The conceptual `ApplicationProfile` /
safety-class wording in the original spec (§2, §3, §4) must be ADAPTED to the existing
`AnswerSource` + `DEFAULT_POLICY` architecture (`src/lib/apply/questionTypes.ts`,
`src/lib/apply/resolveAnswer.ts`, `src/lib/apply/agent/planFields.ts`, the
`application_questions`/`application_answers` vault) — NOT implemented as a competing policy
source. The existing model remains the single policy source of truth; the spec's own §2 and §4
require exactly this ("Do not copy this schema blindly if an existing model already handles part
of it"). Mapping: CLASS A–C ≈ `QuestionType` × `AnswerSource` fillable provenance; CLASS D ≈
`sensitivity: "protected"` + `reusePolicy: "never_auto"`; CLASS E ≈ `open_ended` +
`ask_each_time`; CLASS F ≈ `detectBlocking` → distinct `WAITING_*` run states.

**IMPORTANT IMPLEMENTATION GATE — Workday (discovered during recovery).** Per
`docs/ATS_APPLICATION_ADAPTER_ASSESSMENT.md`: do NOT implement a real Workday form adapter until
authenticated real form markup has been observed/captured safely. A live probe measured 0 form
controls on the job page (SPA; the form sits behind sign-in several navigations deep). Writing
selectors for a form never observed is precisely the fabrication this system avoids everywhere
else. The safe order is: the operator creates/authenticates a Workday account manually and
completes one application; that session is used to observe the form read-only; the adapter is
then written against captured markup, exactly as Greenhouse and Lever were. Until then §7 is
BLOCKED, and jobs with `source_type="workday"` continue to degrade cleanly to
`{status: "unsupported_ats"}` at the start route. The `AGENT-10c` tripwire tests asserting
`automatedSourceTypes() === ["greenhouse","lever"]` remain correct until a Workday adapter is
intentionally registered, and must be updated deliberately in that same future commit.

---

## ORIGINAL PHASE 9 INSTRUCTION (verbatim)

CAREER-OPS — PHASE 9
UNIVERSAL APPLICATION AUTOFILL ENGINE
GREENHOUSE PRESERVATION + WORKDAY REFERENCE ADAPTER

OBJECTIVE

Resume generation is now sufficiently mature for us to begin application automation.

Career-Ops already has Greenhouse autofill/application functionality.

DO NOT rebuild Greenhouse.

The goal of this phase is to:

1. Inspect the existing Greenhouse implementation.
2. Extract reusable application concepts into a Universal Application Engine.
3. Preserve existing Greenhouse behavior.
4. Implement Workday as the first difficult reference adapter.
5. Autofill as much of the application as safely possible.
6. Validate every required field.
7. STOP at READY_FOR_REVIEW by default.
8. Do NOT auto-submit applications in this phase.

The operator's current pain point is spending ~15–20 minutes manually filling each job application.

The desired future workflow is:

Job selected
→ tailored resume READY
→ ATS detected
→ candidate application profile loaded
→ application form opened
→ fields discovered
→ deterministic mapping
→ resume/cover letter uploaded
→ standard questions answered from authoritative profile
→ required-field validation
→ READY_FOR_REVIEW
→ human verifies
→ submit

This phase should dramatically reduce manual application time without sacrificing correctness.

============================================================
0. SAFETY / NON-NEGOTIABLE RULES
============================================================

DO NOT:

- submit any real application
- click final Submit
- answer questions by guessing
- fabricate candidate facts
- fabricate work authorization answers
- fabricate sponsorship answers
- fabricate salary expectations
- fabricate demographic information
- fabricate disability/veteran information
- bypass CAPTCHA
- bypass anti-bot protections
- bypass login/security controls
- create accounts without explicit operator authorization
- store passwords in source code
- store secrets in git
- modify candidate identity facts
- alter resumes/cover letters
- rebuild Greenhouse from scratch
- commit or push until final operator review
- use git add .
- run destructive git commands

If a form asks an ambiguous or unsupported question:

mark:
NEEDS_USER_INPUT

Do not guess.

============================================================
1. FIRST — INSPECT CURRENT STATE
============================================================

Run:

git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline

Read:

CLAUDE.md
AGENTS.md if present

Then locate all existing application automation code.

Search for:

Greenhouse
autofill
application
apply
ATS
form
browser
Playwright
Puppeteer
resume upload
cover letter
candidate profile
work authorization
sponsorship

Produce an architecture inventory BEFORE changing anything.

I need to know:

A. How Greenhouse detection works.
B. How Greenhouse fields are discovered.
C. How candidate values are mapped.
D. How resume upload works.
E. Whether cover-letter upload exists.
F. How custom questions are handled.
G. Whether autofill currently submits automatically.
H. How browser sessions are launched.
I. What audit/logging exists.
J. What portions are reusable outside Greenhouse.

Do not assume filenames.

Trace the real production flow.

============================================================
2. DEFINE THE UNIVERSAL APPLICATION MODEL
============================================================

Create or formalize one normalized application profile.

Conceptually:

ApplicationProfile {
  identity
  contact
  location
  links
  workAuthorization
  sponsorship
  education[]
  employment[]
  skills
  resume
  coverLetter
  standardAnswers
  demographicAnswers
}

BUT:

Do not copy this schema blindly if an existing model already handles part of it.

Prefer adapting existing architecture rather than creating parallel sources of truth.

Each value should include provenance/confidence where useful.

Example:

{
  value: "Yes",
  source: "candidate_profile",
  confidence: "AUTHORITATIVE"
}

Possible provenance categories:

AUTHORITATIVE_PROFILE
MASTER_RESUME
USER_SAVED_ANSWER
JOB_SPECIFIC
INFERRED_SAFE
NEEDS_USER_INPUT

High-risk answers must never use INFERRED_SAFE.

============================================================
3. QUESTION SAFETY CLASSES
============================================================

Introduce deterministic question classification.

At minimum:

CLASS A — SAFE DIRECT PROFILE

Examples:
name
email
phone
LinkedIn
city/state
education
employer names
job titles
dates

Can autofill from authoritative candidate facts.

CLASS B — SAVED USER PREFERENCE / AUTHORIZED ANSWER

Examples:
work authorization
need sponsorship now/future
willingness to relocate
remote/hybrid preference
notice period
desired employment type

Only autofill if the candidate has explicitly stored an answer.

CLASS C — JOB-SPECIFIC BUT DETERMINISTIC

Examples:
years using Python
years using Snowflake
experience with AWS

Only answer when Career-Ops has an authoritative deterministic rule and evidence.

Do not exaggerate years.

CLASS D — SENSITIVE / LEGAL / VOLUNTARY

Examples:
race
gender
ethnicity
veteran status
disability
self-identification
EEO
salary attestation
criminal-history/legal attestations

Do NOT infer.

Use:
USER_SAVED_ANSWER
or
NEEDS_USER_INPUT

CLASS E — FREE-TEXT / CUSTOM

Examples:
"Why do you want to work here?"
"Describe your experience with..."
"Why are you a good fit?"

Do NOT generate with an LLM in this phase.

If no approved stored answer exists:
NEEDS_USER_INPUT

Later we can build a controlled answer engine separately.

CLASS F — SECURITY / HUMAN VERIFICATION

CAPTCHA
MFA
email verification
SMS verification
security question

Never bypass.

Set:
USER_ACTION_REQUIRED

============================================================
4. UNIVERSAL FIELD REPRESENTATION
============================================================

Create a normalized field model independent of ATS.

Example conceptual shape:

ApplicationField {
  id
  ats
  page
  label
  normalizedLabel
  type
  required
  options[]
  mappedProfileField
  proposedValue
  confidence
  source
  safetyClass
  status
}

Statuses:

DISCOVERED
MAPPED
FILLED
VALIDATED
NEEDS_USER_INPUT
USER_ACTION_REQUIRED
UNSUPPORTED
ERROR

Do not over-engineer if existing Greenhouse types already provide a strong base.

============================================================
5. ATS ADAPTER CONTRACT
============================================================

Create one common adapter interface.

Conceptually:

ATSAdapter {
  detect(...)
  openApplication(...)
  discoverFields(...)
  normalizeField(...)
  mapField(...)
  fillField(...)
  uploadResume(...)
  uploadCoverLetter(...)
  nextPage(...)
  validatePage(...)
  detectSubmissionReady(...)
  collectAudit(...)
}

Do not require all ATS systems to behave identically.

The interface should support multi-page ATS systems.

The core engine should own universal behavior.

Adapters should own ATS-specific DOM/navigation behavior.

============================================================
6. PRESERVE GREENHOUSE AS REFERENCE ADAPTER
============================================================

Refactor only as necessary.

Greenhouse must continue to work.

Do NOT rewrite working Greenhouse logic simply for architectural purity.

Wrap/adapt the current implementation into the universal contract where practical.

Add regression tests proving:

- Greenhouse detection unchanged.
- Existing field mappings unchanged.
- Resume upload unchanged.
- Existing question handling unchanged.
- Current validation unchanged.
- Submission behavior remains disabled/not expanded.

============================================================
7. WORKDAY — FIRST HARD ADAPTER
============================================================

Implement Workday as the first new major ATS adapter.

Workday is intentionally chosen because it exercises:

- multiple pages
- account/session flows
- resume upload
- parsed resume data
- employment-history forms
- education-history forms
- location/contact
- conditional questions
- work authorization
- sponsorship
- custom questions
- required-field validation
- review page

Support common Workday-hosted application structure without hardcoding one employer.

Do not assume every tenant has identical selectors.

Use robust selectors/labels/roles where possible.

============================================================
8. WORKDAY SESSION / LOGIN SAFETY
============================================================

Workday frequently requires:

- login
- account creation
- email
- password
- verification

Do NOT automate account creation or passwords in this phase unless an existing authenticated session is already available and the user explicitly authorized its use.

If login is required:

return:

USER_ACTION_REQUIRED:
WORKDAY_LOGIN

Then resume automation after the authenticated page is available.

Do not store credentials.

============================================================
9. MULTI-PAGE STATE MACHINE
============================================================

Build a deterministic application-state machine.

Example:

INIT
→ ATS_DETECTED
→ APPLICATION_OPENED
→ LOGIN_REQUIRED / READY
→ CONTACT
→ EXPERIENCE
→ EDUCATION
→ QUESTIONS
→ DOCUMENTS
→ VOLUNTARY_DISCLOSURES
→ REVIEW
→ READY_FOR_REVIEW

Exact page names may vary.

The engine should not depend solely on page order.

Detect page purpose from form content.

Persist progress so a user can resume after manual intervention.

============================================================
10. RESUME & COVER LETTER RESOLUTION
============================================================

The application system must use the correct finalized artifacts.

Never upload:

draft resume
old resume
wrong company resume
wrong candidate resume
placeholder cover letter

Resolve from the Career-Ops finalized tailoring run.

Verify:

candidate ID
job ID
company
role
publication/final status
artifact existence

Before upload.

If final resume is unavailable:

BLOCK application preparation.

Cover letter:

upload only when:
- application accepts one
- legitimate final cover letter exists
- lifecycle says it is valid

Otherwise skip gracefully.

============================================================
11. EMPLOYMENT HISTORY AUTOFILL
============================================================

Map authoritative candidate experience.

Preserve:

employer
title
dates

Do not fabricate:

location
manager
salary
reason for leaving
phone
address

unless explicitly stored.

If Workday asks for these and they are absent:

NEEDS_USER_INPUT

Handle:
- current job checkbox
- start/end month/year
- multiple employers
- ordered chronology

============================================================
12. EDUCATION AUTOFILL
============================================================

Map only authoritative education facts.

Preserve:

degree
field
institution

Do not invent graduation dates if absent.

If required and unavailable:

NEEDS_USER_INPUT

============================================================
13. WORK AUTHORIZATION / SPONSORSHIP
============================================================

This is HIGH-RISK.

Do not derive answers from resume/JD.

Read only explicit candidate application-profile values.

Design fields such as:

authorizedToWorkInUS
requiresCurrentSponsorship
requiresFutureSponsorship

If any required value is absent:

NEEDS_USER_INPUT

Never default "No" simply because it increases application success.

============================================================
14. ATS FIELD NORMALIZATION
============================================================

Build deterministic alias normalization.

Examples:

"First Name"
"Given Name"
"Legal First Name"

→ firstName

"Are you legally authorized to work..."
"Authorized to work in the United States?"

→ authorizedToWorkInUS

"Will you now or in the future require sponsorship..."

→ requiresSponsorship

Use normalized patterns, not employer-specific exact strings only.

Keep high-risk question matching conservative.

============================================================
15. DROPDOWN / RADIO OPTION MAPPING
============================================================

The proposed answer must map safely to available options.

Example:

profile:
"Yes"

form options:
Yes / No

→ exact match.

If form options are:

Citizen
Permanent Resident
Work Authorization
Other

and the profile does not contain the exact underlying category:

NEEDS_USER_INPUT

Do not infer from a generic "authorized = yes".

============================================================
16. CUSTOM QUESTIONS
============================================================

Discover and store custom questions.

For each:

question
required?
type
options
normalized category
proposed answer
source
confidence
status

Do not use LLM-generated answers yet.

Career-Ops may autofill only:

- exact saved user answers
- deterministic direct facts
- safe normalized standard answers

Everything else:
NEEDS_USER_INPUT

This creates a valuable saved-answer library over time.

============================================================
17. SAVED ANSWER MEMORY / REUSE
============================================================

Design an application-answer store.

When the operator manually answers a recurring question, Career-Ops should be able to reuse it later after explicit confirmation/storage.

Examples:

sponsorship
relocation
remote preference
salary preference
portfolio
LinkedIn
how heard about us
notice period

Do NOT automatically save sensitive voluntary disclosures unless explicitly authorized.

Store:

normalizedQuestionKey
answer
questionClass
source
lastConfirmedAt
allowedReuse

============================================================
18. VALIDATION ENGINE
============================================================

Before READY_FOR_REVIEW:

Validate:

- every visible required field answered
- uploaded resume correct
- file upload completed
- no client-side errors
- no required page skipped
- employment dates valid
- education data valid
- required radio/dropdown selected
- no unresolved safety-critical question
- no CAPTCHA/MFA pending
- no wrong candidate/job artifact

Produce:

ApplicationValidationReport

with:

PASS
NEEDS_INPUT
USER_ACTION_REQUIRED
BLOCKED
ERROR

============================================================
19. NEVER SUBMIT IN PHASE 9
============================================================

This is critical.

Even when every field is valid:

STOP before final Submit.

Final state:

READY_FOR_REVIEW

The browser may remain on the final review page.

The user performs the final submit manually.

Do not click:

Submit
Submit Application
Apply
Finish

when that action actually sends the application.

============================================================
20. APPLICATION AUDIT PACKAGE
============================================================

For every prepared application create an audit record.

Include:

candidate
job
company
ATS
adapter
timestamp
resume artifact
cover-letter artifact
pages visited
fields discovered
fields filled
source for each answer
unanswered fields
user-action fields
validation result
screenshots where useful
final URL
submission status = NOT_SUBMITTED

Do not store secrets.

============================================================
21. UI / CAREER-OPS INTEGRATION
============================================================

Design the user flow.

Possible actions:

Prepare Application
Resume Application
Review Answers

Statuses:

NOT_STARTED
PREPARING
NEEDS_INPUT
USER_ACTION_REQUIRED
READY_FOR_REVIEW
SUBMITTED
FAILED

Do not redesign the whole Career-Ops UI in this phase.

Add only the minimum integration necessary.

============================================================
22. OVERNIGHT FUTURE ARCHITECTURE
============================================================

Do NOT implement unattended mass application submission in this phase.

But make the architecture compatible with a future queue:

READY resume
→ PREPARE application
→ autofill
→ validation
→ READY_FOR_REVIEW

Future overnight mode may prepare many applications.

It should NOT silently submit.

============================================================
23. GENERIC ATS FUTURE SUPPORT
============================================================

Do not implement all 37 ATS in this phase.

But ensure the adapter architecture can later support:

Greenhouse
Workday
Lever
Ashby
iCIMS
SmartRecruiters
Jobvite
Workable
Oracle Recruiting
SAP SuccessFactors
Taleo
BambooHR
JazzHR
ADP Recruiting
UKG
Dayforce
and other hosted/custom application forms

Avoid designing Workday-specific assumptions into the universal core.

============================================================
24. TESTING STRATEGY
============================================================

Build comprehensive unit/integration fixtures.

Do NOT submit real applications.

Use fixture HTML / local test pages / safe test environments.

Required tests at minimum:

APP-PROFILE-01
Authoritative identity mapping.

APP-PROFILE-02
Missing optional field does not fabricate value.

APP-PROFILE-03
Missing required sensitive answer → NEEDS_USER_INPUT.

ATS-DETECT-01
Existing Greenhouse detection still works.

ATS-DETECT-02
Workday detection works.

FIELD-MAP-01
First/last/email/phone normalization.

FIELD-MAP-02
LinkedIn mapping.

FIELD-MAP-03
Work authorization normalization.

FIELD-MAP-04
Sponsorship normalization.

FIELD-SAFE-01
Sensitive answer never inferred.

FIELD-SAFE-02
Ambiguous dropdown → NEEDS_USER_INPUT.

GREENHOUSE-REGRESSION-01+
Existing Greenhouse autofill behavior preserved.

WORKDAY-01
Contact page discovered.

WORKDAY-02
Resume upload detected.

WORKDAY-03
Employment history mapped.

WORKDAY-04
Education mapped.

WORKDAY-05
Required custom question captured.

WORKDAY-06
Conditional page transition handled.

WORKDAY-07
Login requirement → USER_ACTION_REQUIRED.

WORKDAY-08
CAPTCHA → USER_ACTION_REQUIRED.

WORKDAY-09
Required unresolved question prevents READY.

WORKDAY-10
Review page detected.

DOC-01
Correct tailored resume selected.

DOC-02
Wrong-job artifact rejected.

DOC-03
Placeholder cover letter rejected.

VALIDATION-01
All required fields complete → READY_FOR_REVIEW.

VALIDATION-02
Required unanswered field → NEEDS_INPUT.

VALIDATION-03
Final submit is never clicked.

AUDIT-01
Every autofilled value contains source/provenance.

AUDIT-02
Submission status remains NOT_SUBMITTED.

ADAPTER-01
Universal engine can run Greenhouse adapter.

ADAPTER-02
Universal engine can run Workday adapter.

ADAPTER-03
Core engine does not branch directly on ATS-specific DOM selectors.

============================================================
25. REAL READ-ONLY / SAFE DEMO
============================================================

After tests pass, if an existing REAL Greenhouse or Workday job is available:

You may perform a safe demonstration only with explicit safeguards.

Allowed:

- detect ATS
- open application
- discover fields
- produce proposed field map
- stop before filling if real-page mutation is unsafe

Do NOT:

- submit
- create accounts
- bypass login
- answer sensitive questions
- upload unless explicitly safe/authorized

Prefer screenshots/reporting rather than side effects.

============================================================
26. VERIFICATION
============================================================

Run:

focused Phase 9 tests
existing Greenhouse regression tests
full relevant application/ATS subsystem tests
npm test
npx tsc --noEmit
ESLint touched files
git diff --check
npm run build -- --webpack

Report exact counts.

============================================================
27. FINAL REPORT
============================================================

Return:

A. Starting HEAD
B. Ending HEAD
C. Files changed
D. Existing Greenhouse architecture discovered
E. Reusable Greenhouse components
F. Universal ApplicationProfile design
G. Field model
H. Question safety-class model
I. ATS adapter contract
J. Universal orchestration/state machine
K. Greenhouse integration result
L. Greenhouse regressions
M. Workday detection
N. Workday page handling
O. Workday login/session behavior
P. Workday resume upload
Q. Employment autofill
R. Education autofill
S. Work authorization handling
T. Sponsorship handling
U. Sensitive-question handling
V. Custom-question handling
W. Saved-answer store
X. Validation engine
Y. READY_FOR_REVIEW lifecycle
Z. Final-submit protection
AA. Audit/provenance logging
AB. UI integration
AC. Future overnight architecture
AD. Future ATS extensibility
AE. New tests
AF. Test results
AG. TypeScript
AH. ESLint
AI. git diff --check
AJ. Build
AK. Real browser demo performed?
AL. Real application submitted? MUST BE NO
AM. Account created? MUST BE NO
AN. CAPTCHA/MFA bypassed? MUST BE NO
AO. DB migrations/changes
AP. Commit performed? MUST BE NO
AQ. Push performed? MUST BE NO
AR. Remaining risks/gaps
AS. Recommended Phase 10

End with exactly one:

PHASE9_UNIVERSAL_APPLICATION_ENGINE_READY_FOR_REVIEW

or

PHASE9_UNIVERSAL_APPLICATION_ENGINE_NEEDS_FOLLOWUP

STOP AFTER REPORT.

Do not commit.
Do not push.
Do not submit any application.
