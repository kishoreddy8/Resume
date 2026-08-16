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
 * More entries (read-only audit, CAREEROPS — SUCCESSFACTORS PHASE 3, 2026-08-16) — three companies
 * that had separately advanced past their original PAGINATION_COUNT_MISMATCH blocker (once
 * allowStableStaleCount was wired in Phase 2) but then exposed a previously-hidden tenant-identity
 * redirect underneath, each confirmed via the company's OWN official site explicitly designating
 * the redirect target as its real application destination — the strongest evidence tier used in
 * this file, not just a domain-registrable-root match:
 * - Popular, Inc.: jobs.popular.com — registrable domain matches the stored career_page_url
 *   (popular.com) exactly, AND the redirect target's own live content confirms "© 2026 Popular, Inc."
 * - Talis Clinical, LLC: careers.getinge.com — Talis Clinical is a Getinge-supported entity
 *   (confirmed via its own site's Getinge-domain support contact), and Talis Clinical's own official
 *   website explicitly links its "Opportunities"/careers section directly to careers.getinge.com as
 *   its designated job application system. The SuccessFactors tenant's own company identifier
 *   ("GetingeProd") is consistent with this being Getinge's shared, consolidated HR platform.
 * - Perdue AgriBusiness LLC: jobs.perduecareers.com — Perdue AgriBusiness's own official careers
 *   page explicitly links to perduecareers.com with a search URL specifically scoped to "perdue
 *   agribusiness" (not merely the generic Perdue Farms brand), confirming the shared family portal
 *   is genuinely authorized for and scoped to this exact company.
 *
 * One more entry (CAREEROPS — SUCCESSFACTORS PHASE 4, 2026-08-16) — Tellus Products, investigated
 * but deliberately withheld in Phase 3 pending a dedicated pass:
 * - Tellus Products LLC: careers.fcc-asrgroup.com — Phase 2 flagged this as an apparently unrelated
 *   sugar-refining company. Phase 3 found the opposite: Tellus Products is genuinely, publicly owned
 *   by ASR Group (it upcycles sugarcane-fiber byproduct from sugar milling into compostable
 *   tableware). Phase 4 reconfirmed both directions of that relationship independently: ASR Group's
 *   own official site explicitly lists "Tellus Products" as one of its ten companies (navigation,
 *   dedicated logo, subsidiary footer), AND careers.fcc-asrgroup.com's own live content
 *   self-identifies as operated by ASR Group / Florida Crystals Corporation (copyright notice,
 *   "ASR Group Job Applicants" / "FCC Job Applicants" legal references) — the same
 *   VERIFIED_PARENT_ORGANIZATION standard used for Talis Clinical and Perdue AgriBusiness.
 *
 * One more entry (Connector Reliability Final Hardening, read-only trust review) — LEAR
 * CORPORATION, the strongest evidence tier of any entry in this file:
 * - LEAR CORPORATION: jobs.lear.com — three independent signals, not just a registrable-domain
 *   match. (1) The redirect target's OWN TLS certificate Subject is issued directly to
 *   "O=Lear Corporation, L=Southfield, ST=Michigan" — Southfield, MI is LEAR Corporation's real,
 *   independently-verifiable headquarters. (2) The exact hostname (not just registrable domain)
 *   byte-for-byte matches this company's own independently-stored career_page_url
 *   ("https://jobs.lear.com/go"), populated by discovery before any SuccessFactors-specific code
 *   existed. (3) jobs.lear.com's own page content embeds the literal string "learcorporP" — the
 *   same SuccessFactors tenant identifier as this exact ats_board_token
 *   ("career5.successfactors.eu|learcorporP2") — confirming it's genuinely LEAR's own branded
 *   front end for the SAME backend tenant, not a coincidental or unrelated target. No further
 *   redirect beyond jobs.lear.com was observed (confirmed via a full redirect-chain fetch).
 *
 * Explicitly NOT added, for lack of (or contradicting) corroborating evidence — do not add without
 * independent re-verification:
 * - Genfare (redirects to careers.spx.com) — SPX Technologies' own careers page lists its known
 *   subsidiaries (Patterson Kelley, Weil-McLain, Cues Inc., Marley MEP, Williamson-Thermoflo) and
 *   does not mention Genfare anywhere.
 * - Precision Planting (redirects to careers.agcocorp.com) — AGCO's own careers page (brands: Fendt,
 *   Massey Ferguson, PTx, Valtra) does not mention Precision Planting anywhere.
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
  "career4.successfactors.com|Popularinc": "jobs.popular.com",
  "career5.successfactors.eu|GetingeProd": "careers.getinge.com",
  "career4.successfactors.com|PerdueFarms": "jobs.perduecareers.com",
  "career4.successfactors.com|634633P": "careers.fcc-asrgroup.com",
  "career5.successfactors.eu|learcorporP2": "jobs.lear.com",
};
