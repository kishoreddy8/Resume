// Shared formatting constants for both the resume and cover-letter renderers, so the two
// documents in one application package are visually consistent (same font, size, margins).
//
// Sizes are in half-points (docx/OOXML convention: sz="22" = 11pt). Ranges below match the
// production-hardening typography spec; values are pinned to one exact number per role rather
// than left to vary per run, so every generated resume is visually consistent with every other.

// Phase 3 Stage 4: bump whenever the rendering/layout logic changes in a way that would make an
// artifact regenerated under a new version meaningfully different from one already on disk. Not a
// DB column itself — tailoring_runs.renderer_version (Stage 2) stores this value once execution is
// wired (Stage 5+); this constant is the single source of truth for "what version am I right now."
//
// 2 (Stage 31): the reference-resume presentation standard — left-aligned header block, two-line
// role headers with Project:/Environment: lines, bulleted certifications, an optional Key Projects
// section, and the reference document's tighter type scale. Any artifact rendered at version 1 has
// a visibly different layout from one rendered now, which is exactly what this counter exists for.
export const RENDERER_VERSION = 2;

export const FONT = "Calibri";
export const BLACK = "000000";
export const HEADING_RULE_COLOR = "444444";

// --- Type scale ------------------------------------------------------------------------------
// Stage 31 pins these to the reference resume's own measured values (read out of its OOXML, not
// eyeballed from a rendering). The reference fits three employers, eight skill categories, three
// certifications and two degrees on two pages precisely because its body text is 10pt rather than
// 11pt; keeping 11pt body while adopting the reference's extra Project:/Environment: lines would
// have pushed a comparable resume onto a third page.
export const SIZE_BODY = 20; // 10pt — reference: w:sz="20"
export const SIZE_NAME = 40; // 20pt — reference: w:sz="40", bold
export const SIZE_TAGLINE = 23; // 11.5pt — reference: w:sz="23", bold (the headline line)
export const SIZE_CONTACT = 20; // 10pt — reference: w:sz="20"
export const SIZE_HEADING = 21; // 10.5pt — reference Heading1: w:sz="21", bold, caps, ruled
export const SIZE_EXPERIENCE_HEADING = 21; // 10.5pt bold — reference Heading2 (company/date line)
export const SIZE_ROLE_TITLE = 20; // 10pt bold italic — reference Heading4 (the job title line)

// --- Vertical rhythm -------------------------------------------------------------------------
// Also taken from the reference: it separates SECTIONS generously and everything inside a section
// tightly, which is what makes a dense document still scan quickly. Values are twips.
export const SPACE_BEFORE_SECTION = 140; // reference Heading1 spacing before
export const SPACE_AFTER_SECTION_RULE = 60;
export const SPACE_BEFORE_ROLE = 100; // reference Heading2 spacing before, between employers
export const SPACE_BETWEEN_BULLETS = 30; // reference ListParagraph spacing before
export const SPACE_BETWEEN_SKILL_LINES = 30;

export const MARGIN = 864; // 0.6in — spec range 0.55-0.65in, in twips
export const PAGE_WIDTH = 12240; // US Letter, twips
export const PAGE_HEIGHT = 15840;
// Every width/tab-stop in the templates derives from this, never a hard-coded guess.
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
