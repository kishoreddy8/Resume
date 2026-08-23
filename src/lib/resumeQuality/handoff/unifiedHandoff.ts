/**
 * CLAUDE WRITER SPEED PHASE (2026-08-23) — SINGLE-PASS HANDOFF.
 *
 * WHY THIS EXISTS. The current handoff asks the external Claude Code CLI writer to open five
 * separate files (writer_prompt.md, then follow its own references to
 * resume_tailoring_instructions.md, master_resume_reference.json, extracted_job_requirements.json,
 * master_skills_inventory.md — plus, for a TARGETED_REPAIR, previous_resume_content.json and
 * sometimes previous_cover_letter_content.json) before it can start generating. Each of those is a
 * separate Read tool call — a full round trip — before any content generation begins. This module
 * builds ONE self-contained document (writer_handoff.md) carrying the exact same semantic content,
 * so the real Claude Code CLI needs only Read(writer_handoff.md) -> Write(writer_output.json), for
 * either mode.
 *
 * THIS IS TRANSPORT ONLY. Every companion-file argument here is the EXACT byte content already
 * written to disk for that file — this module is deliberately called AFTER the four companion files
 * are written (exporter.ts reads them back from the handoff directory), never re-derived, never
 * paraphrased, never a second independent source of truth. Reading the already-written bytes back
 * (rather than threading each file's source variable through separately) is what makes this safe even
 * for the copyPackageFile fallback paths (extracted_job_requirements.json / master_resume.txt /
 * master_skills_inventory.md can be a verbatim COPY of an externally-sourced workspace file, not a
 * string this module could otherwise see) — whatever ends up on disk for audit is EXACTLY what gets
 * embedded, by construction.
 *
 * ANCHOR SAFETY. The three insertion points below split on literal, hardcoded, ALWAYS-present marker
 * strings from the prompt template (verified by reading exporter.ts's own source — none of these
 * three headers is ever conditionally omitted, unlike e.g. "## PROFESSIONAL IDENTITY" or
 * "## PER-EMPLOYER EVIDENCE", which are skipped when their underlying data doesn't exist and are
 * therefore NOT used as anchors here). buildUnifiedWriterHandoff throws — never silently drops
 * content — if an anchor is not found, so a future prompt-template change that removes/renames one of
 * these headers fails loudly during export rather than silently shipping an incomplete handoff.
 */

const CONTACT_ANCHOR = "## CANDIDATE CONTACT DETAILS";
const GUARDRAILS_ANCHOR = "## CRITICAL TAILORING GUARDRAILS & OBJECTIVES";
const JD_MATRIX_ANCHOR = "## JD PRIORITY MATRIX";

export interface UnifiedWriterHandoffInput {
  /** buildExternalWriterPrompt's own complete output, built with singlePassMode: true (mode-agnostic
   *  — works for both INITIAL_GENERATION and TARGETED_REPAIR). */
  promptContent: string;
  /** The exact, complete bytes already written to resume_tailoring_instructions.md (including its own
   *  header — instruction version, hash, and scope note are already stated there, so this module
   *  doesn't need those passed separately). */
  instructionsFileContent: string;
  /** The exact, complete bytes already written to master_resume_reference.json or master_resume.txt
   *  (whichever this handoff produced). */
  masterReferenceFileContent: string;
  /** Whether masterReferenceFileContent is the structured JSON form (master_resume_reference.json,
   *  true) or the plain-text fallback (master_resume.txt, false) — controls only the code-fence
   *  language tag. */
  masterReferenceIsJson: boolean;
  /** The exact, complete bytes already written to extracted_job_requirements.json. */
  jobRequirementsFileContent: string;
  /** The exact, complete bytes already written to master_skills_inventory.md. */
  msiFileContent: string;
  /** TARGETED_REPAIR only — the exact bytes already written to previous_resume_content.json, when
   *  this handoff is a repair (writerInput.currentResume exists). Undefined for INITIAL_GENERATION,
   *  which never writes this file. rewriteRule's own repair-mode text names this file by filename
   *  ("Start from `previous_resume_content.json`..."), so a single-pass repair handoff that omitted
   *  it here would leave the writer with no baseline to repair from at all. */
  previousResumeFileContent?: string;
  /** TARGETED_REPAIR only — the exact bytes already written to previous_cover_letter_content.json,
   *  when present (omitted entirely for a resume-only repair — see patchContextProjection.ts's
   *  shouldOmitCoverLetterContext, already reflected in whether this file exists on disk at all). */
  previousCoverLetterFileContent?: string;
}

function splitOnAnchor(doc: string, anchor: string, label: string): { before: string; from: string } {
  const idx = doc.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      `buildUnifiedWriterHandoff: expected anchor "${anchor}" (${label}) was not found in the prompt content. ` +
        "Refusing to build a single-pass handoff that might be missing a section rather than guess where to insert it."
    );
  }
  return { before: doc.slice(0, idx), from: doc.slice(idx) };
}

/**
 * Builds ONE self-contained writer-facing document carrying the exact same semantic content
 * currently spread across writer_prompt.md + 4 companion files. Never mutates or re-derives any
 * input — pure string composition over already-written file bytes.
 */
export function buildUnifiedWriterHandoff(input: UnifiedWriterHandoffInput): string {
  let doc = input.promptContent;

  // 1. CANONICAL TAILORING RULES — inserted immediately before CANDIDATE CONTACT DETAILS, i.e. right
  //    after "THE CANONICAL STANDARD IS MANDATORY" finishes describing them. Embeds the exact bytes
  //    resume_tailoring_instructions.md holds, verbatim, so the writer never has to open it.
  {
    const { before, from } = splitOnAnchor(doc, CONTACT_ANCHOR, "candidate contact details");
    const block = `## CANONICAL TAILORING RULES (embedded — same content as resume_tailoring_instructions.md)\n\n${input.instructionsFileContent}\n\n---\n\n`;
    doc = before + block + from;
  }

  // 2. MASTER RESUME FACTS + MASTER SKILLS INVENTORY + (repair only) PREVIOUS RESUME/COVER LETTER
  //    CONTENT — inserted immediately before CRITICAL TAILORING GUARDRAILS & OBJECTIVES, which is the
  //    first place the prompt actually NEEDS the first two (guardrail 1 names both). The repair
  //    baseline documents are bundled in here too — rewriteRule's own repair-mode text (which
  //    immediately follows, inside the guardrails block) names previous_resume_content.json /
  //    previous_cover_letter_content.json by filename, so they must be embedded before that point is
  //    reached, exactly like the other two.
  {
    const { before, from } = splitOnAnchor(doc, GUARDRAILS_ANCHOR, "critical tailoring guardrails");
    const fence = input.masterReferenceIsJson ? "json" : "text";
    let block =
      `## MASTER RESUME FACTS (embedded — same content as master_resume_reference.json${input.masterReferenceIsJson ? "" : " / master_resume.txt"})\n\n` +
      `\`\`\`${fence}\n${input.masterReferenceFileContent}\n\`\`\`\n\n---\n\n` +
      `## MASTER SKILLS INVENTORY (embedded — same content as master_skills_inventory.md)\n\n` +
      `${input.msiFileContent}\n\n---\n\n`;
    if (input.previousResumeFileContent !== undefined) {
      block +=
        `## PREVIOUS RESUME CONTENT (embedded — same content as previous_resume_content.json — this repair's baseline)\n\n` +
        `\`\`\`json\n${input.previousResumeFileContent}\n\`\`\`\n\n---\n\n`;
    }
    if (input.previousCoverLetterFileContent !== undefined) {
      block +=
        `## PREVIOUS COVER LETTER CONTENT (embedded — same content as previous_cover_letter_content.json — this repair's baseline)\n\n` +
        `\`\`\`json\n${input.previousCoverLetterFileContent}\n\`\`\`\n\n---\n\n`;
    }
    doc = before + block + from;
  }

  // 3. JD REQUIREMENTS — inserted immediately before JD PRIORITY MATRIX, which is built FROM this
  //    same structured data (buildJdPriorityMatrix(writerInput.jobRequirements, ...)) — so the raw
  //    source sits directly above the derived summary that explains how to use it.
  {
    const { before, from } = splitOnAnchor(doc, JD_MATRIX_ANCHOR, "jd priority matrix");
    const block =
      `## JD REQUIREMENTS (embedded — same content as extracted_job_requirements.json, ` +
      `and the same data the matrix below was built from)\n\n\`\`\`json\n${input.jobRequirementsFileContent}\n\`\`\`\n\n---\n\n`;
    doc = before + block + from;
  }

  return doc;
}
