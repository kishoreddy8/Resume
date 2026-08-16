/**
 * Per-tenant allowlist of a SuccessFactors company's own verified custom careers domain, for the
 * specific companies whose detail-fetch response legitimately redirects there (a real, common
 * SuccessFactors deployment pattern — SAP-hosted or company-branded custom career sites). Each
 * entry here was individually verified against independent evidence before being added — never
 * derived automatically from an observed redirect at scan time. src/lib/ats/successfactors.ts's own
 * trustedHosts construction never trusts a redirect it hasn't been told in advance to trust; this
 * file is the (human-reviewed, git-audited) source of that advance trust, nothing more.
 *
 * Keyed by the EXACT normalized ats_board_token ("host|company") already used to identify each
 * company's SuccessFactors tenant — never a bare company name or a wildcard/suffix pattern — so
 * trust can never leak across tenants/companies, and the value is the EXACT redirect hostname
 * observed (not a root-domain or suffix pattern), matching fetchSuccessFactorsJobs's own
 * exact-hostname-only trust check.
 *
 * Evidence for each entry (read-only audit, CAREEROPS — SUCCESSFACTORS PHASE 2, 2026-08-16):
 * - Norfolk Southern: jobs.nscorp.com — nscorp.com 301-redirects to the company's own
 *   independently-stored career_page_url (norfolksouthern.com); same real entity, verified live.
 * - Southwire / Newell Brands / Ball Corporation / Churchill Downs / NCH Corporation: the redirect
 *   target's registrable domain exactly matches the company's own independently-stored
 *   career_page_url (populated by discovery, before any SuccessFactors-specific code existed).
 * - Carestream Health: redirect target (careers.carestream.com) content confirmed live as
 *   "Carestream Health" branded ("© Carestream Health. All rights reserved."), matching the stored
 *   career_page_url's company (carestreamhealth.com).
 * - Holtec International: redirect target is SAP's own hosted-careers infrastructure
 *   (*.jobs.hr.cloud.sap), content confirmed live as Holtec International-branded.
 * - Baker Construction Enterprises: redirect target (bcecareers.com) content confirmed live as
 *   "Baker Construction Enterprises Inc." branded, matching its own copyright notice.
 *
 * Explicitly NOT added, despite also producing a TENANT_IDENTITY_FAILURE in the same fleet
 * validation, for lack of corroborating evidence — do not add without independent re-verification:
 * - Genfare (redirects to careers.spx.com) — SPX Technologies' own careers page lists its known
 *   subsidiaries (Patterson Kelley, Weil-McLain, Cues Inc., Marley MEP, Williamson-Thermoflo) and
 *   does not mention Genfare anywhere.
 * - Precision Planting (redirects to careers.agcocorp.com) — AGCO's own careers page (brands: Fendt,
 *   Massey Ferguson, PTx, Valtra) does not mention Precision Planting anywhere.
 * - Tellus Products (redirects to careers.fcc-asrgroup.com) — that domain belongs to ASR Group /
 *   Florida Crystals Corporation, an unrelated sugar-refining company; no mention of Tellus Products
 *   at all. Worth flagging as a potential misconfiguration, not just an unverified case.
 */
export const SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS: Readonly<Record<string, string>> = {
  "career8.successfactors.com|S003808746P": "jobs.nscorp.com",
  "career4.successfactors.com|southwireP": "careers.southwire.com",
  "career4.successfactors.com|NWL": "jobs.newellbrands.com",
  "career4.successfactors.com|ballcorpor": "jobs.ball.com",
  "career8.successfactors.com|churchilld": "jobs.churchilldowns.com",
  "career4.successfactors.com|nch": "careers.nch.com",
  "career4.successfactors.com|carestream": "careers.carestream.com",
  "career8.successfactors.com|holtecinte": "holtec.jobs.hr.cloud.sap",
  "career8.successfactors.com|bcci": "bcecareers.com",
};
