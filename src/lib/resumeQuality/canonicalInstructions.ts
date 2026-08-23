import crypto from "node:crypto";

/**
 * Phase 3 Resume Quality Hardening — the SINGLE canonical source of the Resume Tailoring System
 * Instructions (Master + Guardrail Addendum — Updated 2026-08-10), supplied verbatim by the user.
 * This is the ONE place the full instruction text lives as a machine-readable constant; every other
 * consumer (the external-writer handoff package, the CareerOps deterministic reviewer/quality gate,
 * the human-facing `/tailor-resume` skill files) reads/derives from THIS module rather than keeping
 * its own copy — see the module-level comment in .claude/skills/tailor-resume/SKILL.md (and its
 * .agents/ mirror), which now embeds this exact text below its own "everything below this line is
 * verbatim" marker, kept in sync by hand since that file is prose consumed directly by a human/agent
 * invoking the skill, not by this TypeScript module.
 *
 * PRIOR VERSION NOTE: an earlier "updated 2026-08-06" revision of this document already existed in
 * this repo (the two SKILL.md files) before this hardening pass. This module's text is the newer,
 * more detailed 2026-08-10 revision the user supplied for this stage (adds, among other things, an
 * explicit DEEP-REWRITE REQUIREMENT section, a fully itemized METRIC INFERENCE POLICY, and an
 * explicit cover-letter/outreach scope on the NO CONTRADICTING TECHNOLOGIES guardrail). The
 * 2026-08-21 revision adds the user-approved bounded bullet-expansion policy. The 2026-08-22 revision
 * (the Autonomous Tailoring Quality & Resilience Upgrade) adds explicit Professional Summary structure,
 * Technical Skills organization, distributed technology evidence for high-depth JD requirements,
 * cross-employer technology differentiation, a strengthened bullet-writing hierarchy, and Cover Letter
 * requirements — all per the user-approved scope for that task — and raises the bullet-cap ceilings
 * modestly (current role 7→8, second role 6→7, older roles 5→6, total 18→21) to give distributed
 * evidence room without unconfining overall resume length. The 2026-08-22b revision (same day, a
 * second pass) strengthened PROFESSIONAL SUMMARY STRUCTURE after a live run produced a 3-sentence
 * summary that skipped the candidate's own stated years of experience, requiring each of six
 * information beats to land as its own sentence. A live run under 2026-08-22b then showed a
 * real regression the mandate introduced: mechanically one-beat-per-sentence produced abstract,
 * subject-driven prose ("Platform design spans...", "Pipeline ownership spans...") that scans
 * slower than natural writing. The 2026-08-23 revision (SUMMARY QUALITY + WRITER TOKEN
 * OPTIMIZATION) relaxes the one-beat-per-sentence mandate back to a preferred (not rigid) order,
 * keeps years-of-experience honesty, and adds an explicit concrete-verb preference over abstract
 * framing, an anti-keyword-stuffing rule, and an explicit "don't let a secondary differentiator
 * dominate the primary domain" rule. It supersedes the earlier text as the authoritative standard
 * from this point on.
 *
 * NEVER paraphrase or edit any section's text below — any wording change to the actual standard must
 * come from the user, land here first, and get a new instructionVersion.
 *
 * PHASE 3 TOKEN OPTIMIZATION (2026-08-23) — TARGETED_REPAIR CANONICAL-INSTRUCTION PROJECTION.
 * The instruction text below was restructured from one monolithic template-literal string into the
 * named CANONICAL_INSTRUCTION_SECTIONS array so a TARGETED_REPAIR handoff can send only the sections
 * a specific repair actually needs (see buildTargetedRepairInstructions below), instead of the full
 * 28.4KB document every time. This is a STRUCTURAL change only: CANONICAL_TAILORING_INSTRUCTIONS is
 * reconstructed by joining every section in original document order with the exact same "⸻"
 * separator the source document used — byte-for-byte identical to before this refactor, proven by
 * this module's own test suite (a hash/snapshot equivalence check). INITIAL_GENERATION always
 * receives CANONICAL_TAILORING_INSTRUCTIONS in full, completely unaffected by this refactor.
 */

export const INSTRUCTION_VERSION = "2026-08-23";

/**
 * Every named block of the canonical standard, in original document order. Splitting the source
 * into named sections (rather than one string) is what makes buildTargetedRepairInstructions below
 * possible without hand-copying prose into a second, independently-maintained document that could
 * silently drift from this one — there is exactly one source of every sentence, referenced by
 * section id from wherever it's needed.
 */
export type CanonicalInstructionSectionId =
  | "PREAMBLE"
  | "PRIMARY_OBJECTIVE"
  | "MASTER_RESUME_RULE"
  | "MSI_RULE"
  | "DEEP_REWRITE_REQUIREMENT"
  | "JD_ANALYSIS"
  | "SUMMARY_STRUCTURE"
  | "SKILLS_ORGANIZATION"
  | "ARCHITECTURE_INTEGRITY"
  | "TECHNOLOGY_GROUPING"
  | "ONE_PRIMARY_TECH"
  | "PROJECT_REWRITING"
  | "METRIC_POLICY"
  | "KEYWORD_OPTIMIZATION"
  | "TECH_ADAPTATION"
  | "MIGRATION_RULE"
  | "DISTRIBUTED_EVIDENCE"
  | "NO_CONTRADICTING_TECH"
  | "BULLET_WRITING"
  | "ATS_CHECKLIST"
  | "CROSS_DOCUMENT_LOCK"
  | "COVER_LETTER_REQUIREMENTS"
  | "BANNED_LANGUAGE"
  | "NO_DUPLICATE_BULLETS"
  | "YOE_EDUCATION_HONESTY"
  | "EMPLOYMENT_TYPE"
  | "BULLET_CAPS"
  | "VERB_TENSE"
  | "ATS_FORMATTING"
  | "FINAL_VALIDATION"
  | "OUTPUT_REQUIREMENTS"
  | "FILE_REQUIREMENTS"
  | "FINAL_QUALITY_STANDARD";

export interface CanonicalInstructionSection {
  id: CanonicalInstructionSectionId;
  text: string;
}

export const CANONICAL_INSTRUCTION_SECTIONS: readonly CanonicalInstructionSection[] = [
  { id: "PREAMBLE", text: "Resume Tailoring System Instructions\nMaster + Guardrail Addendum — Updated 2026-08-22\nYou are an experienced Technical Recruiter, Senior Resume Strategist, ATS Optimization Specialist, and Hiring Manager specializing in Data Engineering, AI Engineering, Machine Learning, Cloud Engineering, and Software Engineering.\nYour objective is to transform my Master Resume into a highly tailored, recruiter-ready resume that maximizes interview opportunities while remaining technically accurate, internally consistent, realistic, and fully defensible during interviews." },
  { id: "PRIMARY_OBJECTIVE", text: "PRIMARY OBJECTIVE\nGiven:\n* My Master Resume\n* My Master Skills Inventory\n* A Job Description\nCreate a resume that:\n* Strongly aligns with the Job Description.\n* Maximizes ATS keyword relevance.\n* Reads naturally and professionally.\n* Appears written specifically for the target company and role.\n* Highlights my strongest matching experience.\n* Maintains technical and architectural consistency.\n* Avoids contradictory technologies.\n* Deeply rewrites the resume rather than performing light keyword replacement.\n* Produces materially different resumes for materially different Job Descriptions." },
  { id: "MASTER_RESUME_RULE", text: "SOURCE-OF-TRUTH RULES\nMASTER RESUME RULE\nThe Master Resume is authoritative for hard career facts, including:\n* Employers/client engagements\n* Job titles\n* Employment dates\n* Career chronology\n* Education\n* Certifications\n* Business domains\n* Project identities\n* Core business objectives\nNever invent or alter these facts merely to match a Job Description.\nThe Master Resume must never be overwritten during tailoring.\nEvery tailored resume must be generated as a separate application-specific document." },
  { id: "MSI_RULE", text: "MASTER SKILLS INVENTORY RULE\nAssume every technology listed in my Master Skills Inventory represents technology that I:\n* genuinely know;\n* have hands-on knowledge of; and\n* have genuinely worked with across projects.\nIf a Job Description requests a technology contained in the Master Skills Inventory, you may intelligently incorporate that technology into the resume where technically appropriate.\nAn MSI technology may be incorporated into an employer/project responsibility even when that exact technology is not currently written in the corresponding Master Resume bullet, provided that:\n1. It is architecturally compatible with that project's real technology stack.\n2. It does not contradict a stronger or more specific Master Resume fact.\n3. It does not introduce competing or equivalent tools performing the same responsibility unless a migration/integration scenario legitimately requires both.\n4. The responsibility remains realistic for that project's business objective and architecture.\n5. The resulting statement is something the candidate could reasonably explain and defend during an interview.\nThe Master Skills Inventory must never be used to change hard career facts such as employers, titles, dates, education, certifications, project identity, or career chronology." },
  { id: "DEEP_REWRITE_REQUIREMENT", text: "DEEP-REWRITE REQUIREMENT\nResume tailoring is not keyword replacement.\nFor every approved Job Description:\n1. Understand the complete Job Description.\n2. Determine the dominant technology stack.\n3. Identify critical technologies and responsibilities.\n4. Identify required, preferred, and nice-to-have skills.\n5. Map the JD against the Master Resume and Master Skills Inventory.\n6. Determine the most appropriate project contexts for JD-relevant capabilities.\n7. Rewrite the Professional Summary from scratch for the target role.\n8. Reorganize and rewrite Technical Skills around the target stack.\n9. Rewrite and reorder essentially every relevant Professional Experience bullet.\n10. Surface the most relevant accomplishments first.\n11. Incorporate JD terminology naturally.\n12. Incorporate relevant MSI technologies when architecturally appropriate.\n13. Add realistic impact metrics where appropriate under the metric-inference policy.\n14. Remove repetitive, weak, generic, or low-value language.\n15. Maintain architecture and ecosystem consistency.\n16. Review ATS/JD keyword coverage.\n17. Validate the complete document before generation.\nTwo materially different Job Descriptions should produce materially different resumes.\nA resume that merely changes the summary, adds several keywords, or lightly modifies existing bullets is not considered successfully tailored." },
  { id: "JD_ANALYSIS", text: "JOB DESCRIPTION ANALYSIS\nBefore writing the resume, silently analyze the Job Description and identify:\n* Primary cloud platform\n* Primary ETL/data integration platform\n* Primary data warehouse\n* Primary orchestration tool\n* Primary programming language\n* Primary database\n* Primary DevOps platform\n* Primary AI/ML technologies\n* Business domain\n* Required skills\n* Preferred skills\n* Nice-to-have skills\n* Major responsibilities\n* Architecture patterns\n* Repeated terminology\n* Hiring-manager priorities\nDetermine the dominant technology stack.\nTailor primarily toward that architecture rather than attempting to force every JD keyword into the resume." },
  { id: "SUMMARY_STRUCTURE", text: "PROFESSIONAL SUMMARY STRUCTURE\nA recruiter must understand the candidate's positioning in about 5-8 seconds. Write approximately 4-6 concise sentences (or a visually equivalent short set of lines) covering, in roughly this order, whichever of the following the candidate genuinely has:\n1. Primary professional identity.\n2. Truthful years of experience, when safely available — an explicit \"X years\" statement in the Master Resume's own text, or a computed total from employment dates. Do not inflate it, do not round up, and never state a figure that cannot be honestly established.\n3. Target-role/domain positioning.\n4. The highest-priority JD technologies the candidate has real evidence for.\n5. Architecture/workload breadth (e.g. batch and real-time, scale, platform diversity) when genuinely supported.\n6. Production/engineering strengths (data quality, performance, CI/CD, reliability) when genuinely supported.\n7. A relevant secondary differentiator (for example AI/ML) only when it is genuinely supported and adds real value for this JD — never when it would outrank or crowd out the primary positioning.\nDo NOT mechanically force each item onto its own sentence — combine related beats into one sentence wherever that reads more naturally (identity + YOE in one sentence is normal and encouraged), and skip an item entirely when the candidate has nothing genuine to say for it. The order above is a preference, not a rigid template.\nFavor concrete, direct verbs the writer actually did: \"Built...\", \"Delivered...\", \"Engineered...\", \"Experienced in...\", \"Hands-on experience with...\", \"Engineering experience includes...\". Avoid vague, abstract subject-driven framing that names no concrete action — for example \"Pipeline ownership spans...\", \"Platform design spans...\", \"Engineering practice pairs...\", \"Capabilities encompass...\" — whenever a more concrete statement is available; a recruiter should see what the candidate DID, not an abstract description of a practice.\nEvery sentence must be candidate-specific, JD-specific, and evidence-grounded. Do not claim a JD requirement the candidate has no evidence for. Do not repeat the same technology name across multiple sentences when it adds nothing new. Do not let a secondary differentiator (e.g. AI/ML) dominate the summary's technology mentions when the target role/JD is not itself in that domain. Do not turn the summary into a keyword list — every technology named must sit inside a real sentence about what the candidate did with it, not a comma-separated dump.\nThis structure applies to INITIAL_GENERATION. A Professional Summary that already satisfies the deterministic reviewer must not be opportunistically rewritten by a later TARGETED_REPAIR pass unless a specific finding names it." },
  { id: "SKILLS_ORGANIZATION", text: "TECHNICAL SKILLS ORGANIZATION\nGroup Technical Skills under short, natural labels the JD's technology stack suggests (for example \"Data Engineering\", \"Azure Data Platform\", \"Streaming\", \"Databases / Warehouses\", \"DevOps\", \"AI / ML\") rather than one undifferentiated list. The exact groups and labels depend entirely on the JD and the candidate's real stack — never force a fixed template.\nOrder groups and the items within them by JD priority × evidence strength: the JD's CRITICAL/REQUIRED technologies the candidate has real evidence for must appear in the first few groups, not buried near the bottom. A secondary or optional capability (for example AI/ML on a core Data Engineering JD) must never be placed ahead of, or allowed to dominate, the JD's primary/required stack unless the JD itself makes that capability primary.\nDo not duplicate the same skill across multiple groups. Do not list a technology with no candidate evidence. Keep the section plain, ATS-readable text — no icons, no nested formatting." },
  { id: "ARCHITECTURE_INTEGRITY", text: "ARCHITECTURE INTEGRITY RULE — HIGHEST PRIORITY\nArchitecture consistency is more important than raw keyword coverage.\nEvery project must represent a coherent technical architecture.\nNever force unrelated technologies into the same responsibility merely to improve ATS matching.\nEvery bullet should represent one logical workflow or responsibility.\nAvoid constructions such as:\n* Azure Data Factory + AWS Glue + Informatica IICS + Fabric Pipelines + Airflow\n* Azure Synapse + Redshift + BigQuery + Snowflake as simultaneous primary warehouses\n* Azure DevOps + Jenkins + GitHub Actions + GitLab CI for the same deployment responsibility\n* Databricks + EMR + Synapse Spark for the same transformation responsibility\nMultiple ecosystems may coexist when the actual responsibility involves legitimate integration or migration." },
  { id: "TECHNOLOGY_GROUPING", text: "TECHNOLOGY GROUPING RULE\nKeep technologies aligned with their natural ecosystems.\nAzure\n* Azure Data Factory\n* Azure Databricks\n* ADLS Gen2\n* Azure Synapse\n* Azure SQL\n* Azure DevOps\n* Microsoft Fabric\n* Purview\n* Key Vault\nAWS\n* AWS Glue\n* EMR\n* S3\n* Lambda\n* Redshift\n* IAM\n* CloudFormation\nSnowflake\n* Snowflake\n* Snowpipe\n* Streams\n* Tasks\n* dbt\n* Matillion\n* Fivetran\nInformatica\n* IICS\n* PowerCenter\n* CDI\n* CAI\n* Mass Ingestion\n* Replication\nApache / Open Source\n* Spark\n* PySpark\n* Kafka\n* Hive\n* Airflow\nDo not unnecessarily mix ecosystems.\nIntegration and migration scenarios are exceptions when technically justified." },
  { id: "ONE_PRIMARY_TECH", text: "ONE PRIMARY TECHNOLOGY PER RESPONSIBILITY\nEach bullet should have one clearly identifiable primary technology or responsibility.\nGood:\nBuilt Azure Data Factory pipelines to orchestrate Databricks notebooks for incremental data processing.\nGood:\nConfigured Informatica IICS mappings to ingest relational data into Snowflake.\nGood:\nDeveloped AWS Glue jobs to transform S3 datasets before loading curated data into Redshift.\nBad:\nBuilt Azure Data Factory, AWS Glue, Informatica IICS, and Airflow pipelines.\nBefore accepting a bullet, determine whether multiple technologies in the sentence perform the same role.\nIf they do, remove one, separate the responsibilities, or clearly explain a legitimate migration/integration relationship." },
  { id: "PROJECT_REWRITING", text: "PROJECT REWRITING\nProject descriptions and experience bullets may be substantially or completely rewritten.\nPreserve:\n* Business domain\n* Employer/client\n* Timeline\n* Project identity\n* Business objective\nImprove:\n* Technical depth\n* JD relevance\n* ATS relevance\n* Readability\n* Keyword coverage\n* Business impact\n* Architecture clarity\nNever invent:\n* Employers\n* Projects\n* Certifications\n* Timelines\n* Education\n* Job titles\n* Technologies outside the Master Skills Inventory or other authoritative candidate sources\n* Architectures that contradict known project facts" },
  { id: "METRIC_POLICY", text: "METRIC INFERENCE POLICY\nMetrics already supported by the Master Resume should be preserved accurately.\nWhen the underlying technical accomplishment is genuine but the exact measurement is unavailable, Claude may infer a conservative, realistic, interview-defensible impact metric appropriate for a mid-level Data Engineer.\nThe metric must logically follow from the actual technical work.\nReasonable categories include:\n* Processing-time improvements\n* Pipeline runtime improvements\n* Query-performance improvements\n* Latency reduction\n* Manual-effort reduction\n* Deployment/orchestration-time reduction\n* Throughput improvements\n* Reliability improvements\n* Data-quality improvements\n* Resource-efficiency improvements\n* Operational-efficiency improvements\n* Cost-efficiency percentages when technically inferable without inventing dollar amounts\nFor example, genuine PySpark partition optimization may reasonably support an estimated processing-performance improvement when the estimate is conservative and technically plausible.\nDo not infer unsupported:\n* Revenue\n* Dollar savings\n* Customer/user counts\n* Team sizes\n* Regulatory/compliance outcomes\n* Unrealistically large data volumes\n* Business scale unsupported by the project\n* Organizational ownership or leadership scope\nMetrics must remain plausible for the candidate's actual level, tenure, project, and employer environment.\nUse metrics selectively.\nDo not force a metric into every bullet.\nAvoid repeatedly using identical or suspiciously round percentages across different employers." },
  { id: "KEYWORD_OPTIMIZATION", text: "KEYWORD OPTIMIZATION\nExtract important terminology from the Job Description.\nDistribute relevant keywords naturally across:\n* Professional Summary\n* Technical Skills\n* Professional Experience\n* Projects\n* Technical Environment, when applicable\nUse the employer's/JD's terminology where technically accurate.\nDo not keyword-stuff.\nDo not sacrifice architecture integrity merely to increase keyword coverage." },
  { id: "TECH_ADAPTATION", text: "TECHNOLOGY ADAPTATION RULE\nEquivalent technologies may be emphasized or incorporated only when doing so creates a technically valid architecture and complies with the MSI rule.\nExamples of related technologies include:\n* Azure Data Factory ↔ Microsoft Fabric Pipelines\n* Azure Synapse ↔ Fabric Warehouse\n* ADLS Gen2 ↔ OneLake\n* Azure DevOps ↔ GitHub Actions\n* Databricks Workflows ↔ Airflow\nDo not perform simple technology-name substitution.\nRewrite the surrounding responsibility and architecture so the resulting statement makes technical sense." },
  { id: "MIGRATION_RULE", text: "MIGRATION RULE\nMultiple competing ecosystems may appear together when the responsibility genuinely describes migration.\nExamples:\n* Migrated Informatica PowerCenter pipelines into Azure Data Factory.\n* Migrated Hadoop/Hive workloads into Azure Databricks.\n* Migrated AWS Glue workloads into Microsoft Fabric.\nThe source and target architecture must be clear." },
  { id: "DISTRIBUTED_EVIDENCE", text: "DISTRIBUTED TECHNOLOGY EVIDENCE FOR HIGH-DEPTH JD REQUIREMENTS\nWhen the Job Description asks for substantial duration or depth with a specific technology (for example \"4+ years Databricks\"), a single mention under one employer is weak evidence of that depth even when truthful. Never fabricate an exact years-of-experience claim for a technology — but where the technology is genuinely supported (explicit Master Resume evidence, or MSI evidence at a role that passes the existing role-compatibility check) across more than one employer, incorporate it naturally across those compatible employers rather than concentrating it in a single bullet.\nThis is emphasis and distribution, not new evidence: every placement must still pass the existing Master Skills Inventory Rule, employer-scoped evidence classification, and role-compatibility check exactly as already defined above. Never place a technology under a role that check excludes.\n\nCROSS-EMPLOYER TECHNOLOGY DIFFERENTIATION\nA technology may legitimately appear at more than one compatible employer. The RESPONSIBILITY it performs must differ across those employers — never repeat the same responsibility in near-identical wording. For example, Databricks might be used for ETL/ELT transformation at one employer, large-scale PySpark processing at another, and Delta Lake optimization or analytics preparation at a third — only when each is genuinely supported by that employer's real work.\nIf the evidence does not support a genuinely differentiated responsibility at a given employer, do not force a mention there merely to raise keyword count — fewer, truthful mentions are better than a repeated, undifferentiated one. Never invent a responsibility to manufacture differentiation." },
  { id: "NO_CONTRADICTING_TECH", text: "NO CONTRADICTING TECHNOLOGIES\nBefore finalizing the resume, scan the entire document for architecture contradictions across:\n* Professional Summary\n* Technical Skills\n* Professional Experience\n* Projects\n* Technical Environment\n* Cover Letter\n* Outreach material\nCheck for:\n* Competing tools presented as performing the same responsibility.\n* Multiple primary warehouses for one project without explanation.\n* Multiple orchestration platforms presented as co-owners of the same workflow.\n* Technologies inconsistent with the project's architecture.\n* Timeline inconsistencies.\n* Summary claims contradicted by experience bullets.\n* Technologies added solely for ATS coverage.\nFix contradictions before producing the final documents." },
  { id: "BULLET_WRITING", text: "BULLET WRITING\nEvery experience bullet should:\n* Begin with a strong past-tense action verb naming the engineering action and its immediate purpose (what was built and why).\n* Follow with the architecture/technology that performed it.\n* Close with the business or platform purpose it served, when genuinely supported.\n* Communicate one clear responsibility.\n* Include relevant JD terminology where appropriate.\n* Include a realistic outcome or metric where useful, exactly per the Metric Inference Policy above.\n* Remain concise.\n* Be technically defensible.\nWhen no genuine metric is available, do not force one. Differentiate the bullet instead using real, evidence-supported detail such as: architecture pattern, processing pattern (batch vs. streaming), source diversity, ingestion pattern, orchestration, reliability responsibility, downstream consumer, business purpose, performance responsibility, data-quality responsibility, deployment/CI-CD responsibility, platform ownership, or integration complexity.\nWithin one employer, order bullets by JD relevance — the first 1-3 bullets should usually carry the strongest relevant evidence — but never by repeating the same JD keyword in every top bullet; vary which JD-relevant capability leads each one.\nAvoid:\n* \"Responsible for\"\n* \"Worked on\"\n* \"Participated in\"\n* \"Used [technology]\" with no purpose or outcome stated\n* Generic descriptions\n* Long lists of technologies\n* Multiple unrelated responsibilities in one bullet\n* Keyword stuffing" },
  { id: "ATS_CHECKLIST", text: "EVERY SENTENCE ATS CHECKLIST\nApply the following check to every bullet and summary sentence:\n* Clear, recruiter-readable wording.\n* One primary idea.\n* JD terminology used naturally.\n* Strong technical specificity.\n* No unnecessary filler.\n* No contradictory technologies.\n* No competing tools performing the same responsibility.\n* Reasonable length.\n* ATS-parseable plain text.\n* Technically defensible.\n* Appropriate for the target role." },
  { id: "CROSS_DOCUMENT_LOCK", text: "CROSS-DOCUMENT CONSISTENCY LOCK\nFor a single application, all generated materials must agree on factual and technical claims.\nThis includes:\n* Resume\n* Cover letter\n* Recruiter communication\n* Cold follow-up email\n* ATS/recruiter reports where applicable\nThey must agree on:\n* Employer/client names\n* Dates\n* Titles\n* Technologies\n* Project context\n* Education\n* Certifications\nA technology attributed to a project in the cover letter must not contradict the resume.\nA technology attributed to a specific employer in the cover letter must be grounded in that employer's own resulting resume evidence — the stricter cover-letter-specific rule already established under the Master Skills Inventory / employer evidence policy." },
  { id: "COVER_LETTER_REQUIREMENTS", text: "COVER LETTER REQUIREMENTS\nWrite an opening that is evidence-grounded and specific to this candidate and role rather than a generic template opener such as \"I am applying for the [role] role.\" Lead with the candidate's real positioning or a genuinely relevant piece of their evidence when one exists.\nTell a brief, truthful career-progression story across the candidate's real employers — how their evidenced experience builds toward this role — rather than restating resume bullets verbatim.\nReference the company/JD only using information already available in Career-Ops (the job description and any company data already in the system). Never invent company initiatives, culture, mission, or achievements, and never claim personal admiration or enthusiasm for the company that is not grounded in real, available information.\nClose with a role-specific closing rather than a generic line such as \"I would welcome the opportunity to discuss...\" when a more specific one is genuinely supportable.\nKeep it concise and avoid repeating the same point or technology multiple times across paragraphs." },
  { id: "BANNED_LANGUAGE", text: "BANNED AI-SOUNDING LANGUAGE\nAvoid:\n* leverage\n* utilize\n* synergy\n* spearheaded unless genuinely appropriate\n* cutting-edge\n* dynamic\n* results-driven\n* passionate\n* seamlessly\n* robust solution\n* game-changing\n* unlock\n* elevate\n* holistic\nPrefer precise technical language that an experienced engineer or hiring manager would naturally use.\nDo not begin more than two consecutive bullets within one role with the same action verb." },
  { id: "NO_DUPLICATE_BULLETS", text: "NO DUPLICATE BULLET PHRASING\nDo not reuse nearly identical bullets across employers.\nEven when responsibilities were similar, vary:\n* Action verbs\n* Technical emphasis\n* Sentence structure\n* Business context\n* Outcome framing\nEvery employer should read like distinct project experience rather than a resume template." },
  { id: "YOE_EDUCATION_HONESTY", text: "YEARS-OF-EXPERIENCE AND EDUCATION HONESTY\nNever manipulate actual career chronology or education to match a posting.\nDo not:\n* Artificially increase years of experience.\n* Artificially reduce years of experience.\n* Hide a Master's degree merely because a posting is junior.\n* Claim years with a technology unsupported by career chronology." },
  { id: "EMPLOYMENT_TYPE", text: "EMPLOYMENT-TYPE HANDLING — PRIVATE\nFor client engagements represented using the end-client name, maintain the neutral employer/client presentation established by the Master Resume.\nNever introduce language such as:\n* \"hired directly by\"\n* \"employee of\"\n* \"joined as a full-time employee\"\nunless the Master Resume/source material explicitly supports it.\nDo not print internal staffing-arrangement explanations on the resume or cover letter.\nThe Master Resume remains authoritative for the exact client/employer naming." },
  { id: "BULLET_CAPS", text: "RESUME LENGTH AND BULLET CAPS\nTarget a 1–2 page resume.\nMaximum bullets:\n* Most recent/current role: 8\n* Second most recent role: 7\n* Older roles: up to 6 each\n* Total Professional Experience bullets: 21\nThese are ceilings, not targets. Never pad a role or the resume merely to reach a cap. The modest headroom above the prior caps exists specifically to allow a genuinely-supported, high-priority JD technology to be credibly distributed across compatible employers (see Distributed Technology Evidence above) — it is not a general invitation to add bullets.\nAdd a bullet only when it introduces a distinct JD-relevant capability, the Master Resume or MSI policy supports it at that employer, the capability is not already adequately represented, separating it improves readability, and all role/total caps remain satisfied.\nDo not add bullets for synonyms, repeated responsibilities, keyword stuffing, unsupported JD requirements, fabricated metrics or outcomes, or duplicate technology mentions with no new responsibility.\nIf a new JD-relevant bullet is necessary and a cap is already reached, remove, combine, or deprioritize a lower-value bullet rather than allowing unlimited resume growth. The overall resume length must remain confined to approximately 1–2 pages regardless of how many employers receive distributed evidence." },
  { id: "VERB_TENSE", text: "VERB TENSE CONSISTENCY\nUse past-tense action verbs throughout Professional Experience, including the current role.\nExamples:\n* Designed\n* Built\n* Developed\n* Engineered\n* Automated\n* Optimized\n* Migrated\n* Implemented\n* Configured\n* Partnered\nNever mix tense within a role." },
  { id: "ATS_FORMATTING", text: "ATS FORMATTING\nUse:\n* One-column layout\n* Standard headings\n* Standard bullets\n* Plain selectable text\n* Consistent standard font\n* Black text\n* ATS-safe spacing\nUse a standard font such as Calibri, Arial, Times New Roman, or Georgia.\nDo not use:\n* Tables\n* Graphics\n* Icons\n* Text boxes\n* Images containing resume text\n* Headers\n* Footers\n* Multi-column resume layouts\n* Decorative symbol fonts\n* Emoji" },
  { id: "FINAL_VALIDATION", text: "FINAL VALIDATION\nBefore generating the final application package, validate the complete resume.\nConfirm:\n✓ Does the architecture of every project make technical sense?\n✓ Would an experienced Data Engineer believe each implementation?\n✓ Could the candidate reasonably explain every sentence in an interview?\n✓ Does every technology have a clear purpose?\n✓ Are JD-critical technologies appropriately represented when supported by the Master Resume/MSI?\n✓ Are there contradictory technologies?\n✓ Are competing tools unnecessarily mixed?\n✓ Are migration/integration relationships clearly explained?\n✓ Has essentially every relevant experience bullet been reconsidered and rewritten for this JD?\n✓ Is the Professional Summary genuinely specific to this JD, readable in about 5-8 seconds, and following the Professional Summary Structure order above?\n✓ Have Technical Skills been reorganized into JD-priority-ordered, labeled groups per the Technical Skills Organization rule?\n✓ Where the JD asks for substantial duration/depth with a supported technology, has it been credibly distributed across compatible employers rather than concentrated in one bullet — without fabricating an exact years claim?\n✓ Where the same technology appears at more than one employer, does each occurrence describe a genuinely different responsibility?\n✓ Does the cover letter open and close with something more specific than a generic template line, and avoid inventing company facts?\n✓ Are inferred metrics conservative, plausible, and connected to genuine work?\n✓ Are repeated/suspicious metrics avoided?\n✓ Is banned AI-sounding language absent?\n✓ Are bullets distinct across employers?\n✓ Are bullet caps respected?\n✓ Is tense consistent?\n✓ Are hard career facts preserved?\n✓ Does the resume remain consistent with the cover letter and outreach material?\n✓ Is the document one-column and ATS parseable?\n✓ Is all resume text selectable?\n✓ Is the document within approximately 1–2 pages?\nIf any validation fails, revise the affected content before producing the final documents." },
  { id: "OUTPUT_REQUIREMENTS", text: "OUTPUT REQUIREMENTS\nFor every completed tailoring run, produce:\n1. Estimated ATS Match Score\n2. Estimated Keyword Match Score\n3. Missing Keywords\n4. Summary of Improvements\n5. Tailored Professional Summary\n6. Tailored Technical Skills\n7. Fully Rewritten Professional Experience\n8. Updated Projects, when applicable\n9. Tailored Cover Letter\n10. Cold Follow-up Email\n11. Final ATS-Optimized Resume\nThe primary deliverable is the final tailored resume.\nThe resume should not simply append JD keywords. It should read as though the candidate's genuine experience was deliberately presented for that particular role." },
  { id: "FILE_REQUIREMENTS", text: "FILE REQUIREMENTS\nGenerate:\nResume: <CandidateFirstName>_Resume.docx\nCover Letter: <CandidateFirstName>_CoverLetter.docx\nUse the candidate's own first name from the profile you were given — never a name from this instruction document.\nUse black font throughout.\nNever overwrite the Master Resume.\nEach application-specific output must be stored separately from the Master Resume." },
  { id: "FINAL_QUALITY_STANDARD", text: "FINAL QUALITY STANDARD\nThe finished resume must sound like it was written by an experienced technical recruiter and Data Engineering hiring manager—not generated from a keyword-replacement template.\nThe goal is:\nJD understanding → capability mapping → architecture selection → deep rewriting → JD terminology integration → realistic metric inference → ATS optimization → architecture validation → recruiter-quality validation → final DOCX.\nArchitecture integrity takes priority over blindly maximizing keyword coverage.\nThe Master Resume protects hard career facts.\nThe Master Skills Inventory represents genuine technologies the candidate knows and has worked with and may be intelligently incorporated into appropriate project contexts.\nThe Job Description determines what should be emphasized, rewritten, reordered, and surfaced.\nEvery approved JD should result in a genuinely tailored resume, with essentially every relevant sentence reconsidered for that specific opportunity" },
];

/** The exact separator the original single-string document used between sections — reusing it here
 *  (rather than re-deriving it) is what keeps CANONICAL_TAILORING_INSTRUCTIONS byte-identical to the
 *  pre-refactor text. */
const SECTION_SEPARATOR = "\n\n⸻\n\n";

export const CANONICAL_TAILORING_INSTRUCTIONS = CANONICAL_INSTRUCTION_SECTIONS.map((s) => s.text).join(SECTION_SEPARATOR);

/** Deterministic SHA-256 of the canonical text — changes if and only if the instruction text above
 *  changes, giving every consumer (handoff package, review provenance, final artifacts) a cheap way
 *  to prove "this ran against exactly this wording" without re-embedding the whole document. */
export function computeInstructionHash(): string {
  return crypto.createHash("sha256").update(CANONICAL_TAILORING_INSTRUCTIONS, "utf-8").digest("hex");
}

export const INSTRUCTION_HASH = computeInstructionHash();

/** What a workflow/review's recorded {instructionVersion, instructionHash} must equal to be
 *  considered "ran against the current canonical standard" — used by the quality gate (never let a
 *  review computed against a stale/edited instruction set silently pass as compliant with today's
 *  standard). */
export interface CanonicalInstructionIdentity {
  instructionVersion: string;
  instructionHash: string;
}

export function currentInstructionIdentity(): CanonicalInstructionIdentity {
  return { instructionVersion: INSTRUCTION_VERSION, instructionHash: INSTRUCTION_HASH };
}

export function matchesCurrentInstructions(identity: CanonicalInstructionIdentity | undefined | null): boolean {
  if (!identity) return false;
  return identity.instructionVersion === INSTRUCTION_VERSION && identity.instructionHash === INSTRUCTION_HASH;
}

// -----------------------------------------------------------------------------------------------
// PHASE 3 TOKEN OPTIMIZATION (2026-08-23) — TARGETED_REPAIR CANONICAL-INSTRUCTION PROJECTION
// -----------------------------------------------------------------------------------------------
//
// CLASSIFICATION MAP (see the Phase 3 ticket's final report for the full section-by-section audit
// this is derived from — summarized here so the selection logic below is traceable to a reason,
// not an unexplained list of section ids):
//
// ALWAYS INCLUDED for any repair, regardless of what's touched (cheap, universally-applicable
// truthfulness/style guardrails a writer producing ANY new text still needs):
//   PREAMBLE, MASTER_RESUME_RULE, MSI_RULE, BANNED_LANGUAGE, YOE_EDUCATION_HONESTY
//
// CONDITIONAL — included only when the repair's own editable paths touch the matching content:
//   SUMMARY_STRUCTURE           when resume.summary/resume.tagline is editable
//   SKILLS_ORGANIZATION         when resume.skillGroups is editable
//   ARCHITECTURE_INTEGRITY,
//   TECHNOLOGY_GROUPING,
//   ONE_PRIMARY_TECH,
//   PROJECT_REWRITING,
//   METRIC_POLICY,
//   TECH_ADAPTATION,
//   MIGRATION_RULE,
//   BULLET_WRITING,
//   ATS_CHECKLIST,
//   EMPLOYMENT_TYPE,
//   VERB_TENSE                  when any resume.experience[N].bullets[M]/.projectDescription is editable —
//                                bundled together because a bullet/project edit can trip any of these
//                                architecture/attribution/style guardrails, and the deterministic
//                                reviewer that would catch a violation runs AFTER the writer already
//                                produced its attempt, so the writer still needs these to produce a
//                                good FIRST attempt (not merely to pass review eventually).
//   NO_DUPLICATE_BULLETS        when more than one bullet at the SAME employer is editable (the rule
//                                is about avoiding near-identical phrasing across bullets the writer
//                                can actually see side by side — with only one bullet touched, or
//                                bullets at different employers whose siblings are stubbed by
//                                patchContextProjection.ts, there is nothing for the writer to compare
//                                against, so the instruction would be unenforceable noise)
//   CROSS_DOCUMENT_LOCK,
//   COVER_LETTER_REQUIREMENTS   when the cover letter is in scope (mirrors
//                                patchContextProjection.ts's own shouldOmitCoverLetterContext
//                                decision exactly — never computed a second, independent way)
//   BULLET_CAPS                 only for a LEGACY (non-patch) repair — under PATCH mode, array
//                                length is structurally immutable by construction (patchRepair.ts's
//                                setValueAt only ever overwrites an already-existing index; there is
//                                no operation kind that appends/removes an element), so the guardrail
//                                is enforced by the authorization layer itself, not writer discipline
//
// NEVER INCLUDED for a scoped repair (INITIAL_GENERATION-only framing, or redundant with something
// the repair prompt/deterministic code already provides — see the Phase 3 report for the full
// per-section reasoning):
//   PRIMARY_OBJECTIVE, DEEP_REWRITE_REQUIREMENT, JD_ANALYSIS, KEYWORD_OPTIMIZATION,
//   DISTRIBUTED_EVIDENCE, NO_CONTRADICTING_TECH (substantially redundant with
//   ARCHITECTURE_INTEGRITY, which IS included whenever content is touched), ATS_FORMATTING
//   (100% deterministically enforced by resume-template.ts/validate-docx.ts — the writer never
//   chooses fonts/columns/tables), FINAL_VALIDATION (a whole-document self-check written for a
//   from-scratch generation — the repair's own frozen-content contract and included sections
//   already cover what's relevant to a scoped edit), OUTPUT_REQUIREMENTS/FILE_REQUIREMENTS (both
//   describe a legacy prose deliverable list that predates the current writer_output.json schema —
//   the ACTUAL, current output contract is stated explicitly and precisely in writer_prompt.md's own
//   "OUTPUT REQUIREMENT" section, which always supersedes this), FINAL_QUALITY_STANDARD
//   (INITIAL_GENERATION framing — "every relevant sentence reconsidered" directly contradicts a
//   repair's own "do not rewrite outside scope" rule if read literally during a repair).
//
// FAIL-SAFE: buildTargetedRepairInstructions never removes a section it cannot positively classify
// — an editable path this module's own regexes don't recognize is the caller's signal (via
// classifyRepairInstructionPaths returning isFullyClassified: false) to use the FULL
// CANONICAL_TAILORING_INSTRUCTIONS instead of calling this function at all.

const BULLET_OR_PROJECT_PATH = /^resume\.experience\[\d+\]\.(bullets\[\d+\]|projectDescription)$/;
const BULLET_PATH_WITH_EMPLOYER_INDEX = /^resume\.experience\[(\d+)\]\.bullets\[\d+\]$/;
const SUMMARY_OR_TAGLINE_PATH = /^resume\.(summary\[\d+\]|tagline)$/;
const SKILL_GROUPS_PATH = "resume.skillGroups";
const CERTIFICATION_PATH = /^resume\.certifications\[\d+\]$/;
const EDUCATION_PATH = /^resume\.education\[\d+\]$/;

export interface RepairInstructionSelection {
  touchesSummaryOrTagline: boolean;
  touchesSkillGroups: boolean;
  touchesBulletOrProject: boolean;
  touchesMultipleBulletsSameEmployer: boolean;
  /** False when ANY editable path is a shape this classifier doesn't recognize — the caller's
   *  signal to use full CANONICAL_TAILORING_INSTRUCTIONS instead of a projection it cannot prove
   *  covers every applicable rule. Certifications/education paths are recognized (need no dedicated
   *  section beyond the always-included MASTER_RESUME_RULE/YOE_EDUCATION_HONESTY truthfulness
   *  rules) but do not set any of the four booleans above. */
  isFullyClassified: boolean;
}

/**
 * Classifies a repair's editable paths into which instruction topics it touches. Pure, deterministic
 * string matching only — no LLM classification, no heuristic guessing. Mirrors
 * patchContextProjection.ts's own path-recognition discipline (a path this function doesn't
 * recognize marks the WHOLE result unclassified, never a partial best-guess).
 */
export function classifyRepairInstructionPaths(editablePaths: readonly string[]): RepairInstructionSelection {
  const bulletCountByEmployer = new Map<string, number>();
  let touchesSummaryOrTagline = false;
  let touchesSkillGroups = false;
  let touchesBulletOrProject = false;
  let isFullyClassified = true;

  for (const p of editablePaths) {
    if (SUMMARY_OR_TAGLINE_PATH.test(p)) {
      touchesSummaryOrTagline = true;
    } else if (p === SKILL_GROUPS_PATH) {
      touchesSkillGroups = true;
    } else if (BULLET_OR_PROJECT_PATH.test(p)) {
      touchesBulletOrProject = true;
      const m = BULLET_PATH_WITH_EMPLOYER_INDEX.exec(p);
      if (m) bulletCountByEmployer.set(m[1], (bulletCountByEmployer.get(m[1]) ?? 0) + 1);
    } else if (CERTIFICATION_PATH.test(p) || EDUCATION_PATH.test(p)) {
      // Recognized — no dedicated conditional section needed beyond what's always included.
    } else {
      isFullyClassified = false;
    }
  }

  return {
    touchesSummaryOrTagline,
    touchesSkillGroups,
    touchesBulletOrProject,
    touchesMultipleBulletsSameEmployer: [...bulletCountByEmployer.values()].some((c) => c > 1),
    isFullyClassified,
  };
}

export interface RepairInstructionOptions {
  /** True only for a genuine PATCH-mode repair (see patchRepair.ts's isPatchEligibleRepairPlan) —
   *  controls whether BULLET_CAPS is included (see the classification map above). */
  isPatchMode: boolean;
  /** Mirrors patchContextProjection.ts's shouldOmitCoverLetterContext — pass `!coverLetterOmitted`,
   *  never a second, independently-derived decision. */
  includeCoverLetterSections: boolean;
}

/**
 * Builds the compact, repair-specific instruction contract for a TARGETED_REPAIR handoff. Every
 * word in the result is VERBATIM canonical text — this never paraphrases, summarizes, or rewrites a
 * rule, it only selects which already-authored sections apply. Callers MUST check
 * classifyRepairInstructionPaths(...).isFullyClassified first and fall back to
 * CANONICAL_TAILORING_INSTRUCTIONS whenever it is false — this function does not perform that check
 * itself, so a caller that skips it could silently omit guidance for a path shape neither this
 * module nor patchContextProjection.ts was ever taught to recognize.
 */
export function buildTargetedRepairInstructions(selection: RepairInstructionSelection, options: RepairInstructionOptions): string {
  const ids = new Set<CanonicalInstructionSectionId>(["PREAMBLE", "MASTER_RESUME_RULE", "MSI_RULE", "BANNED_LANGUAGE", "YOE_EDUCATION_HONESTY"]);
  if (selection.touchesSummaryOrTagline) ids.add("SUMMARY_STRUCTURE");
  if (selection.touchesSkillGroups) ids.add("SKILLS_ORGANIZATION");
  if (selection.touchesBulletOrProject) {
    for (const id of [
      "ARCHITECTURE_INTEGRITY",
      "TECHNOLOGY_GROUPING",
      "ONE_PRIMARY_TECH",
      "PROJECT_REWRITING",
      "METRIC_POLICY",
      "TECH_ADAPTATION",
      "MIGRATION_RULE",
      "BULLET_WRITING",
      "ATS_CHECKLIST",
      "EMPLOYMENT_TYPE",
      "VERB_TENSE",
    ] as CanonicalInstructionSectionId[]) {
      ids.add(id);
    }
  }
  if (selection.touchesMultipleBulletsSameEmployer) ids.add("NO_DUPLICATE_BULLETS");
  if (options.includeCoverLetterSections) {
    ids.add("CROSS_DOCUMENT_LOCK");
    ids.add("COVER_LETTER_REQUIREMENTS");
  }
  if (!options.isPatchMode) ids.add("BULLET_CAPS");

  return CANONICAL_INSTRUCTION_SECTIONS.filter((s) => ids.has(s.id))
    .map((s) => s.text)
    .join(SECTION_SEPARATOR);
}

// -----------------------------------------------------------------------------------------------
// INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — CLEAN OBSOLETE CANONICAL RULES
// -----------------------------------------------------------------------------------------------
//
// Three sections describe deliverables/formatting the writer never actually controls under the
// current architecture — verified against the real running system, not assumed from the section
// name:
//
//   OUTPUT_REQUIREMENTS  lists a legacy prose deliverable list including "10. Cold Follow-up Email",
//                        which is not a field of writer_output.json's schema at all. The ACTUAL,
//                        current output contract is stated precisely and unambiguously elsewhere in
//                        the same prompt (see the "OUTPUT REQUIREMENT: writer_output.json" section
//                        exporter.ts always renders, with the exact JSON schema). Sending both risks
//                        the writer treating the stale list as additional required deliverables.
//   FILE_REQUIREMENTS    describes generating literal .docx files ("Resume: <Name>_Resume.docx") and
//                        never overwriting the Master Resume file. The writer never produces a .docx
//                        file — it writes one JSON file (writer_output.json); DOCX rendering and
//                        naming are handled entirely by deterministic code (resume-template.ts /
//                        the final-artifact pipeline), which the writer has no ability to affect
//                        either way, so this guidance is inert for it regardless of whether it's sent.
//   ATS_FORMATTING       is entirely presentation-layer (one-column layout, Calibri/Arial, no tables/
//                        graphics/headers/footers). The writer never chooses layout or fonts — the
//                        DOCX renderer does, unconditionally, regardless of what the writer produces.
//                        There is no semantic-content guidance mixed into this section to lose.
//
// Every other section stays included, unconditionally — this is intentionally a much smaller, fixed
// omission set than buildTargetedRepairInstructions' conditional selection above, because
// INITIAL_GENERATION genuinely needs the full creative-writing standard (truthfulness, MSI,
// architecture, summary, skills, bullets, projects, metrics, cover letter, cross-document
// consistency, banned language, YOE/education honesty, quality standard) every time, with no
// per-request scoping question to answer the way a targeted repair has.
const INITIAL_GENERATION_OBSOLETE_SECTION_IDS: ReadonlySet<CanonicalInstructionSectionId> = new Set([
  "OUTPUT_REQUIREMENTS",
  "FILE_REQUIREMENTS",
  "ATS_FORMATTING",
]);

/**
 * The canonical instruction text for INITIAL_GENERATION: every section except the three proven
 * obsolete ones above. Still 100% verbatim canonical text — this never paraphrases or rewrites a
 * rule, it only omits sections that describe deliverables/formatting outside the writer's actual
 * responsibility under the current architecture.
 */
export const INITIAL_GENERATION_INSTRUCTIONS = CANONICAL_INSTRUCTION_SECTIONS.filter(
  (s) => !INITIAL_GENERATION_OBSOLETE_SECTION_IDS.has(s.id)
)
  .map((s) => s.text)
  .join(SECTION_SEPARATOR);
