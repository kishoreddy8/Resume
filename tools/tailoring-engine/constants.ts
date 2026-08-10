// Shared formatting constants for both the resume and cover-letter renderers, so the two
// documents in one application package are visually consistent (same font, size, margins).
//
// Sizes are in half-points (docx/OOXML convention: sz="22" = 11pt). Ranges below match the
// production-hardening typography spec; values are pinned to one exact number per role rather
// than left to vary per run, so every generated resume is visually consistent with every other.

export const FONT = "Calibri";
export const BLACK = "000000";
export const HEADING_RULE_COLOR = "444444";

export const SIZE_BODY = 22; // 11pt — body text, spec range 10.5-11pt
export const SIZE_NAME = 44; // 22pt — spec range 20-22pt
export const SIZE_TAGLINE = 22; // 11pt italic — spec range 11-12pt
export const SIZE_CONTACT = 20; // 10pt — spec range 9.5-10.5pt
export const SIZE_HEADING = 26; // 13pt — spec range 12-13pt
export const SIZE_EXPERIENCE_HEADING = 22; // 11pt bold — spec range 10.5-11pt (role/company/date line)

export const MARGIN = 864; // 0.6in — spec range 0.55-0.65in, in twips
export const PAGE_WIDTH = 12240; // US Letter, twips
export const PAGE_HEIGHT = 15840;
// Every width/tab-stop in the templates derives from this, never a hard-coded guess.
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
