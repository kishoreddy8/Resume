import type { CandidateProfile } from "@/lib/match/types";
import { buildEmployerEvidenceMap } from "./employerEvidence";
import { extractCanonicalSkillsFromText } from "./reviewers/skillAliases";
import {
  PROJECT_DESCRIPTION_MAX_SENTENCES,
  PROJECT_DESCRIPTION_MAX_TECHNOLOGIES,
  renderWriterOutputQualitySection,
} from "./writerOutputQuality";
import type { ExperienceEntry, ResumeContent } from "../../../tools/tailoring-engine/types";

/**
 * Stage 31 — deterministic checks on the reference presentation structure.
 *
 * The reference format adds two labelled lines to every role: a `Project:` scope sentence and an
 * `Environment:` technology list. Both are attractive places for an unevidenced claim to hide,
 * precisely because neither looks like an achievement bullet:
 *
 *   - `Environment:` invites a stack listing, and the natural thing for a writer to list is the
 *     JD's stack, or everything the candidate knows — not the subset THIS employer's evidence
 *     supports. That is the multi-project attribution error the whole employer-evidence model
 *     exists to prevent, reappearing in a new field.
 *   - `Project:` invites a scope sentence, and a scope sentence is where a new client, domain,
 *     scale or metric can be introduced without any bullet ever claiming it.
 *
 * So neither field is trusted. Everything here is pure: no database, no filesystem, no AI. Nothing
 * in this module ever rewrites content — it reports, and the existing reviewers decide.
 */

export interface PresentationAttributionIssue {
  employer: string;
  field: "environment" | "projectDescription";
  /** The exact token that could not be supported, for a correction the writer can act on. */
  offending: string;
  message: string;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Names inside a scope sentence that no technology taxonomy would recognise but that are
 * unmistakably names rather than English: all-caps acronyms ("AML", "SAR") and tokens carrying a
 * digit ("GPT-4", "SCD2"). Deliberately narrow — a capitalisation heuristic would flag ordinary
 * words like "Predictive" or "Enterprise" and cost a sound resume its READY disposition, which is
 * a far worse failure than missing one unusual proper noun. Real technologies are covered
 * comprehensively by the skill taxonomy instead (see checkPresentationAttribution).
 */
export function extractProperNounTokens(sentence: string): string[] {
  const out: string[] = [];
  for (const raw of sentence.split(/[\s,;:()\[\]"'`]+/)) {
    const word = raw.replace(/[.!?]+$/, "").replace(/^[.\-–—]+/, "");
    if (word.length < 2) continue;
    const isAcronym = /^[A-Z][A-Z0-9/&.]*[A-Z0-9]$/.test(word) && /[A-Z]{2}/.test(word);
    const hasDigit = /\d/.test(word) && /[A-Za-z]/.test(word);
    if (isAcronym || hasDigit) out.push(word);
  }
  return out;
}

/** Every numeric claim in a string — "35%", "billions", "3x" all reduce to their digits. */
export function extractNumericClaims(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?\s*(?:%|x\b)?/gi) ?? []).map((m) => m.replace(/\s+/g, "").toLowerCase());
}

/**
 * The evidence a single role's own text provides — its bullets plus its title. A `Project:` line
 * or an `Environment:` entry is supported when it appears here, or in the employer's profile-level
 * evidence; nowhere else counts.
 */
function roleOwnText(role: ExperienceEntry): string {
  return [role.title, ...role.bullets].join(" \n ");
}

/**
 * Checks both new fields against employer-scoped evidence.
 *
 * Returns an empty list — not a pass — when there is no master profile to check against: an
 * unverifiable claim is the caller's problem to score (see evaluateTruthfulness's
 * insufficientProfileData path), and silently reporting "no issues" here would let this module
 * look like it had verified something it had not.
 */
export function checkPresentationAttribution(
  resume: ResumeContent,
  masterResumeProfile: CandidateProfile | undefined
): PresentationAttributionIssue[] {
  if (!masterResumeProfile) return [];
  const issues: PresentationAttributionIssue[] = [];
  const evidenceMap = buildEmployerEvidenceMap(masterResumeProfile);

  for (const role of resume.experience) {
    const employerEvidence = evidenceMap.employers.find(
      (e) => normalizeKey(e.employer) === normalizeKey(role.company) ||
        normalizeKey(e.employer).includes(normalizeKey(role.company)) ||
        normalizeKey(role.company).includes(normalizeKey(e.employer))
    );
    // An employer with no evidence block at all is already a blocking fabricated-employer finding
    // in checkEmploymentFacts; not this module's finding to duplicate.
    if (!employerEvidence) continue;

    /* The Master Skills Inventory is candidate-declared evidence, not a keyword list, and a
     * compressed Master Resume's silence about a technology under one client is not a statement
     * that it was never used there. So an Environment entry is accepted when it is written here OR
     * available here under the MSI rule. What stays rejected is unchanged: anything the candidate
     * cannot evidence at all, and anything the MSI explicitly scopes to other clients — those never
     * enter `availableViaMsi` in the first place. */
    const supportedKeys = new Set(
      [...employerEvidence.supported, ...employerEvidence.availableViaMsi].map(normalizeKey)
    );
    const ownText = roleOwnText(role);
    const ownTextLower = ownText.toLowerCase();
    // Canonical forms let "ADF" in an Environment line match "Azure Data Factory" in the evidence,
    // and vice versa, instead of failing on a spelling the writer was never told to use.
    const supportedCanonical = extractCanonicalSkillsFromText(
      [...employerEvidence.supported, ...employerEvidence.availableViaMsi, ownText].join(" \n ")
    );

    // --- Environment: every listed technology must be evidenced AT THIS EMPLOYER ---------------
    for (const tech of role.environment ?? []) {
      const key = normalizeKey(tech);
      if (key.length === 0) continue;
      if (supportedKeys.has(key)) continue;
      // A technology this role's own finished bullets attribute is evidence too — the bullets went
      // through the same truthfulness review, so accepting them here does not widen what counts.
      if (ownTextLower.includes(key)) continue;
      const canonical = extractCanonicalSkillsFromText(tech);
      if (canonical.size > 0 && [...canonical].every((c) => supportedCanonical.has(c))) continue;
      issues.push({
        employer: role.company,
        field: "environment",
        offending: tech,
        message:
          `Environment line for ${role.company} lists "${tech}", which this employer's evidence does not support ` +
          `and which no bullet under this role attributes. A technology used at a different employer may not be ` +
          `listed in this role's Environment line.`,
      });
    }

    // --- Project: may only restate what this role's own bullets already establish --------------
    const scope = role.projectDescription?.trim();
    if (!scope) continue;

    // Named technologies are resolved through the skill taxonomy, so this catches a real product
    // under any of its spellings and never mistakes an ordinary English word for one.
    const scopeNames = [
      ...extractCanonicalSkillsFromText(scope),
      ...extractProperNounTokens(scope),
    ];
    const reported = new Set<string>();
    for (const token of scopeNames) {
      const key = normalizeKey(token);
      if (reported.has(key)) continue;
      if (supportedKeys.has(key)) continue;
      if (ownTextLower.includes(key)) continue;
      if (supportedCanonical.has(token)) continue;
      reported.add(key);
      issues.push({
        employer: role.company,
        field: "projectDescription",
        offending: token,
        message:
          `Project line for ${role.company} names "${token}", which appears in no bullet under this role and in ` +
          `no evidence recorded for this employer. The Project line may only restate scope the role's own bullets ` +
          `already establish — never introduce a new system, client, domain or technology.`,
      });
    }

    const bulletNumbers = new Set(role.bullets.flatMap(extractNumericClaims));
    for (const claim of extractNumericClaims(scope)) {
      // Bare years ("2024") are dates, not impact metrics, and are covered by the dates field.
      if (/^\d{4}$/.test(claim)) continue;
      if (bulletNumbers.has(claim)) continue;
      issues.push({
        employer: role.company,
        field: "projectDescription",
        offending: claim,
        message:
          `Project line for ${role.company} states the figure "${claim}", which no bullet under this role states. ` +
          `The Project line may not introduce a metric of its own.`,
      });
    }
  }

  return issues;
}

// -----------------------------------------------------------------------------------------------
// Presentation-only structure checks. These are layout/completeness findings, not truth findings.
// -----------------------------------------------------------------------------------------------

export interface PresentationStructureIssue {
  severity: "HIGH" | "MEDIUM" | "LOW";
  /**
   * What kind of defect this is, because the two kinds must not carry the same weight.
   *
   * A truncated bullet is a CONTENT defect — the resume says less than it should, and that is worth
   * real formatting score. A missing Project:/Environment: line is a STRUCTURE defect: the facts are
   * sound, an annotation has simply not been written. Letting the latter accumulate freely across
   * three employers sank an otherwise perfect resume below the quality gate, which is the wrong
   * trade: it strands a truthful application over a presentation gap. So structure findings are
   * capped (see PRESENTATION_STRUCTURE_DEDUCTION_CAP) and instead carry HIGH priority corrections,
   * which is the lever that actually changes what the writer produces on the next iteration.
   */
  kind: "TRUNCATED_BULLET" | "MISSING_ANNOTATION" | "ENVIRONMENT_DUMP" | "PROJECT_DESCRIPTION_DENSE";
  message: string;
}

/** Total formatting score the missing-annotation/dump findings may cost, however many roles. */
export const PRESENTATION_STRUCTURE_DEDUCTION_CAP = 10;

/** A bullet that was cut rather than written — the reference format never abbreviates one. */
export function findTruncatedBullets(resume: ResumeContent): string[] {
  const truncated: string[] = [];
  for (const role of resume.experience) {
    for (const text of role.bullets) {
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      if (/(?:\.\.\.|…)$/.test(trimmed) || /\[(?:truncated|cut|snip)[^\]]*\]$/i.test(trimmed)) {
        truncated.push(`${role.company}: "${trimmed.slice(-60)}"`);
      }
    }
  }
  return truncated;
}

/**
 * Completeness of the reference structure, reported so the writer can finish the job — never so a
 * section gets invented. A missing Key Projects section is not reported at all: the candidate
 * profile carries no project evidence, so its absence is correct, not a defect.
 */
export function evaluatePresentationStructure(
  resume: ResumeContent,
  /** Stage 31 correction — with the profile, a missing Project/Environment line can be told apart
   *  from one that is correctly absent, so only the former is treated as a defect. */
  masterResumeProfile?: CandidateProfile
): PresentationStructureIssue[] {
  const issues: PresentationStructureIssue[] = [];

  for (const truncated of findTruncatedBullets(resume)) {
    issues.push({
      severity: "HIGH",
      kind: "TRUNCATED_BULLET",
      message: `A bullet is truncated rather than written to completion — ${truncated}. Write the full sentence.`,
    });
  }

  // Stage 31 correction. Previously both lines were reported at LOW with no consequence at all,
  // on the reasoning that an unwritten annotation should not fail a sound resume. That reasoning
  // was wrong in one direction: where the candidate's evidence DOES support a scope line, a resume
  // without one is not following the required structure, and a finding nothing acts on is the same
  // defect Stage 30's unwired detectors had. So the two cases are now separated — a line the
  // evidence supports is required, and a line the evidence cannot support stays silently omitted.
  const evidenceByEmployer = new Map(
    collectRoleProjectEvidence(resume, masterResumeProfile).map((e) => [normalizeKey(e.employer), e])
  );

  for (const role of resume.experience) {
    const evidence = evidenceByEmployer.get(normalizeKey(role.company));
    const hasProject = Boolean(role.projectDescription && role.projectDescription.trim().length > 0);
    const hasEnvironment = Boolean(role.environment && role.environment.length > 0);

    if (hasProject) {
      const project = role.projectDescription!.trim();
      const sentenceCount = project
        .split(/[.!?]+(?:\s|$)/)
        .map((sentence) => sentence.trim())
        .filter(Boolean).length;
      const technologies = extractCanonicalSkillsFromText(project);
      if (sentenceCount > PROJECT_DESCRIPTION_MAX_SENTENCES || technologies.size > PROJECT_DESCRIPTION_MAX_TECHNOLOGIES) {
        issues.push({
          severity: "MEDIUM",
          kind: "PROJECT_DESCRIPTION_DENSE",
          message:
            `Project line for ${role.company} has ${sentenceCount} sentence(s) and ${technologies.size} named ` +
            `technologies. Keep it to at most ${PROJECT_DESCRIPTION_MAX_SENTENCES} short sentences and ` +
            `${PROJECT_DESCRIPTION_MAX_TECHNOLOGIES} defining technologies; move detail into bullets or Environment.`,
        });
      }
    }

    if (!hasProject) {
      // With no profile at all, nothing can be said about what the evidence supports — report it,
      // but do not assert a requirement that has not been checked.
      const supported = evidence?.supportsProjectLine ?? false;
      issues.push({
        severity: supported ? "HIGH" : "LOW",
        kind: "MISSING_ANNOTATION",
        message: supported
          ? `${role.company} has no Project line, but CareerOps records ${evidence!.evidencedTechnologies.length} ` +
            `technologies and ${evidence!.bulletCount} reviewed bullets for this role — enough to describe its scope. ` +
            `Add one or two lines restating only what those bullets already establish.`
          : `${role.company} has no Project line. Add one sentence naming what this role's work was, restating only ` +
            `what the role's own bullets already establish.`,
      });
    }

    if (!hasEnvironment) {
      const supported = (evidence?.evidencedTechnologies.length ?? 0) > 0;
      issues.push({
        severity: supported ? "HIGH" : "LOW",
        kind: "MISSING_ANNOTATION",
        message: supported
          ? `${role.company} has no Environment line, but CareerOps records ${evidence!.evidencedTechnologies.length} ` +
            `technologies for this employer. List the ${ENVIRONMENT_MIN_ITEMS}-${ENVIRONMENT_MAX_ITEMS} strongest for ` +
            `this job description, most relevant first.`
          : `${role.company} has no Environment line. List the technologies this employer's evidence supports — ` +
            `no others.`,
      });
    }
  }

  issues.push(...findEnvironmentDumps(resume, masterResumeProfile));

  return issues;
}

/**
 * The writer-facing contract for the reference presentation standard.
 *
 * Stated as rules rather than as a template, because the reference document is a LAYOUT reference
 * only: none of its wording, employers, technologies, certifications, projects or metrics may be
 * reproduced. What the writer is being asked to match is the shape of the document.
 */
export function renderPresentationStandardSection(profile: CandidateProfile | undefined): string {
  let out = renderWriterOutputQualitySection();
  out += "## RESUME PRESENTATION STANDARD (STRUCTURE ONLY)\n\n";
  out +=
    "The resume renders in this exact section order: **name → headline → contact line → Professional " +
    "Summary → Technical Skills → Certifications → Professional Experience → Key Projects → Education**. " +
    "You do not control the layout; you control what goes into each part.\n\n";

  out += "**Headline.** One line, pipe-separated, leading with the candidate's own professional identity, " +
    "then the specialization this JD needs, then the defining technologies. Not a sentence.\n\n";

  out += "**Professional Summary.** Continuous prose, not bullets. Open by naming the profession and the " +
    "specialization this JD cares about.\n\n";

  out += "**Technical Skills — the candidate's technical ECOSYSTEM, not a transcription of the posting.**\n\n" +
    "The job description decides ORDER. The candidate's evidence decides MEMBERSHIP. Build the section from the " +
    "Master Skills Inventory, the candidate's evidence, the target domain, and the JD's priorities — in that " +
    "combination.\n\n" +
    "  - Put the JD-required skills FIRST, in the earliest categories and first within them, so they have the " +
    "strongest visibility.\n" +
    "  - THEN include the other evidence-backed technologies from the SAME domain that strengthen the profile. If " +
    "the JD asks for Python, Spark and Snowflake and the candidate also genuinely has PySpark, Spark SQL, " +
    "Databricks, Delta Lake, ADF, ADLS Gen2, Synapse, Airflow, Kafka, dbt, Azure DevOps, Pytest and Power BI, do " +
    "NOT discard those simply because the posting omitted them — a section listing only what the posting named " +
    "reads as a transcription and tells a recruiter nothing about depth.\n" +
    "  - Exclude technologies from unrelated domains, and never pad: this is not an excuse to dump the whole " +
    "inventory, and keyword stuffing is still a failure.\n" +
    "  - Never add a technology the candidate does not actually have.\n\n" +
    "Use clean, ATS-safe category labels for the target domain — for example Languages; Data Engineering / " +
    "Processing; Cloud; ETL / ELT; Databases / Warehouses; Lakehouse / Storage; Streaming; Orchestration; Data " +
    "Modeling; Data Quality / Testing; DevOps / CI-CD; BI / Analytics; AI / ML; Governance / Security — keeping " +
    "only the categories the candidate's evidence actually supports.\n\n";

  out += "**Certifications.** Exactly those the Master Resume records, verbatim, never expanded or " +
    "abbreviated. Whenever the candidate has at least one, the section is always rendered, as a bulleted list. " +
    "Omit the field entirely if there are none — never invent one to fill the section.\n\n";

  out += "**Professional Experience.** Each role renders as: employer (and location, only if the Master " +
    "Resume states one) with the dates right-aligned; the job title beneath; then two labelled lines around " +
    "the bullets:\n\n";
  out +=
    `  - \`projectDescription\` — ONE sentence, or at most ${PROJECT_DESCRIPTION_MAX_SENTENCES} short sentences, ` +
    `naming what this role's work was with no more than ${PROJECT_DESCRIPTION_MAX_TECHNOLOGIES} defining technologies, so a reader knows the scope ` +
    "before the bullets. It is a restatement, not an addition: every system, domain, client, technology and " +
    "figure in it must already appear in THIS role's own bullets. Introducing anything new here is a " +
    "truthfulness failure and is checked automatically.\n" +
    "  - NEVER open this sentence by echoing the job title back (the title already renders on its own line " +
    "directly above this one — repeating it here is redundant filler, not scope). Do not write \"<Job Title> " +
    "role delivering/building/performing ...\" or any paraphrase of that shape. Open instead with the work " +
    "itself — the system, platform or outcome — as the grammatical subject.\n" +
    "    Bad: \"AI Engineer role delivering a GenAI chatbot and multi-agent systems on Databricks and " +
    "Kubernetes infrastructure.\"\n" +
    "    Good: \"Delivered a GenAI chatbot and multi-agent systems on Databricks and Kubernetes " +
    "infrastructure, integrating Azure OpenAI-based retrieval-augmented generation for structured and " +
    "unstructured enterprise data.\"\n";
  out +=
    "  - `environment` — the technology stack of THIS role. Every entry must be either Already written " +
    "for THIS employer or Available here under the MSI rule, per the per-employer evidence section above. " +
    "A technology the candidate cannot evidence at all, or one the inventory explicitly scopes to another " +
    "client, may not be listed. This is checked automatically, per employer, per item.\n\n";
  out +=
    "Write every bullet as a complete sentence. Never abbreviate, elide or end one with \"…\" to save space — " +
    "the layout is dense enough to carry full bullets, and a cut bullet is a defect, not a fit.\n\n";

  const hasProjectEvidence = false; // CandidateProfile records no projects; see note below.
  void profile;
  out += "**Key Projects.** ";
  out += hasProjectEvidence
    ? "List the projects the Master Resume records, with their real technologies.\n\n"
    : "CareerOps holds NO recorded project evidence for this candidate, so **omit `keyProjects` entirely**. " +
      "The section then does not render at all. Do not invent projects, repositories or demos to fill it.\n\n";

  out += "**Education.** One string per entry in the form `\"<Degree>, <Institution> - <Dates>\"` (a plain hyphen, ' + 'not an em or en dash), matching the " +
    "Master Resume exactly. The renderer lays that out as degree with right-aligned dates and the institution " +
    "beneath; a line in any other form still renders correctly, just on one line.\n\n";

  return out;
}

// -----------------------------------------------------------------------------------------------
// Stage 31 correction — the evidence that makes a Project: line writable.
// -----------------------------------------------------------------------------------------------

/**
 * What CareerOps can actually show a writer about one employer's work, so a `Project:` line can be
 * written from evidence instead of imagination.
 *
 * There is no "project" record anywhere in CandidateProfile, and none is invented here. The scope of
 * a role is reconstructed from the two things that ARE recorded: the technologies the Master Resume's
 * own bullets attribute to this employer, and the tailored bullets for this role (which have already
 * been through truthfulness review). A role with neither supports no Project line, and gets none.
 */
export interface RoleProjectEvidence {
  employer: string;
  title: string;
  /** Technologies the Master Resume attributes to THIS employer. */
  evidencedTechnologies: string[];
  /** How many reviewed bullets this role carries — the other half of the scope evidence. */
  bulletCount: number;
  /** False when the role has no recorded technologies or no bullets: omit Project, never invent it. */
  supportsProjectLine: boolean;
}

export function collectRoleProjectEvidence(
  /** Undefined on iteration 1, when no resume exists yet — the employers then come from the profile
   *  itself, because this evidence is a property of the candidate's history, not of any draft. */
  resume: ResumeContent | undefined,
  masterResumeProfile: CandidateProfile | undefined
): RoleProjectEvidence[] {
  if (!masterResumeProfile) return [];
  const evidenceMap = buildEmployerEvidenceMap(masterResumeProfile);
  const roles = resume
    ? resume.experience.map((r) => ({ company: r.company, title: r.title, bullets: r.bullets }))
    : masterResumeProfile.experience.map((e) => ({ company: e.employer, title: e.title, bullets: [] as string[] }));
  return roles.map((role) => {
    const employerEvidence = evidenceMap.employers.find(
      (e) => normalizeKey(e.employer) === normalizeKey(role.company) ||
        normalizeKey(e.employer).includes(normalizeKey(role.company)) ||
        normalizeKey(role.company).includes(normalizeKey(e.employer))
    );
    const evidencedTechnologies = employerEvidence?.supported ?? [];
    const bulletCount = role.bullets.filter((b) => b.trim().length > 0).length;
    return {
      employer: role.company,
      title: role.title,
      evidencedTechnologies,
      bulletCount,
      // On iteration 1 there are no bullets yet, so the recorded technologies alone decide: the
      // writer is about to write the bullets, and a role with evidenced technologies has scope to
      // describe. On a later iteration an existing role with zero bullets genuinely has nothing.
      supportsProjectLine:
        evidencedTechnologies.length > 0 && (resume === undefined || bulletCount > 0),
    };
  });
}

/** SUMMARY QUALITY + WRITER TOKEN OPTIMIZATION (2026-08-23) — same writer-context-projection-only
 *  contract as employerEvidence.ts's filterEmployerEvidenceMap: collectRoleProjectEvidence itself is
 *  untouched and always computed against the full profile/resume; this only filters the RENDERED
 *  subset for a scoped TARGETED_REPAIR. `scope: null` means "no filter". */
export function filterRoleProjectEvidence(evidence: RoleProjectEvidence[], scope: ReadonlySet<string> | null): RoleProjectEvidence[] {
  if (scope === null) return evidence;
  return evidence.filter((e) => scope.has(e.employer));
}

/**
 * The per-employer material the writer needs in order to write a Project line and choose an
 * Environment subset. Rendered as a compact table rather than prose: the writer is selecting from a
 * fixed set here, not being persuaded of anything.
 */
export function renderRoleProjectEvidenceSection(evidence: RoleProjectEvidence[]): string {
  if (evidence.length === 0) return "";
  let out = "## PER-ROLE EVIDENCE FOR THE Project: AND Environment: LINES\n\n";
  out +=
    "For each role below you are given every technology CareerOps has recorded FOR THAT EMPLOYER. " +
    "This is the complete set you may draw on — and it is a menu, not a checklist.\n\n";
  for (const role of evidence) {
    out += `### ${role.employer} — ${role.title}\n`;
    out += `- Reviewed bullets available for this role: ${role.bulletCount}\n`;
    out += `- Technologies evidenced at this employer (${role.evidencedTechnologies.length}): ${role.evidencedTechnologies.join(", ") || "none recorded"}\n`;
    out += role.supportsProjectLine
      ? `- **Project line: REQUIRED.** Write one sentence, or at most ${PROJECT_DESCRIPTION_MAX_SENTENCES} short sentences, ` +
        `naming what this role's work was with no more than ${PROJECT_DESCRIPTION_MAX_TECHNOLOGIES} defining technologies, built only from the ` +
        `bullets you wrote for it and the technologies above. No new client, system, domain or metric.\n\n`
      : `- **Project line: OMIT.** CareerOps has no recorded technologies or bullets for this role, so there is ` +
        `nothing to describe. Leave \`projectDescription\` out rather than inventing scope.\n\n`;
  }
  out +=
    `**Environment line.** Choose the ${ENVIRONMENT_MIN_ITEMS}-${ENVIRONMENT_MAX_ITEMS} technologies from that ` +
    "employer's list that are strongest for THIS job description, most JD-relevant first. Do not paste the whole " +
    "list — an Environment line that reproduces every recorded technology is a dump, not a selection, and is " +
    "flagged as one. A technology may legitimately appear under more than one employer when that employer's own " +
    "evidence supports it; what you may never do is move one to an employer whose evidence does not.\n\n";
  return out;
}

/** The reference's Environment lines run to roughly a dozen technologies; these bound the same shape. */
export const ENVIRONMENT_MIN_ITEMS = 8;
export const ENVIRONMENT_MAX_ITEMS = 14;

/**
 * A "dump": an Environment line that simply reproduces the employer's entire recorded technology
 * set. Attribution-safe (every item IS evidenced there) but useless to a reader and unlike the
 * reference, which selects. Only flagged where there was a real selection to make.
 */
export function findEnvironmentDumps(
  resume: ResumeContent,
  masterResumeProfile: CandidateProfile | undefined
): PresentationStructureIssue[] {
  if (!masterResumeProfile) return [];
  const evidenceMap = buildEmployerEvidenceMap(masterResumeProfile);
  const issues: PresentationStructureIssue[] = [];
  for (const role of resume.experience) {
    const listed = role.environment?.filter((t) => t.trim().length > 0) ?? [];
    if (listed.length <= ENVIRONMENT_MAX_ITEMS) continue;
    const employerEvidence = evidenceMap.employers.find(
      (e) => normalizeKey(e.employer) === normalizeKey(role.company) ||
        normalizeKey(e.employer).includes(normalizeKey(role.company)) ||
        normalizeKey(role.company).includes(normalizeKey(e.employer))
    );
    const supportedCount = employerEvidence?.supported.length ?? 0;
    issues.push({
      severity: "MEDIUM",
      kind: "ENVIRONMENT_DUMP",
      message:
        `Environment line for ${role.company} lists ${listed.length} technologies` +
        (supportedCount > 0 ? ` out of the ${supportedCount} recorded for this employer` : "") +
        `. Select the ${ENVIRONMENT_MIN_ITEMS}-${ENVIRONMENT_MAX_ITEMS} strongest for THIS job description, ` +
        `most relevant first, rather than listing everything available.`,
    });
  }
  return issues;
}
