const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Decodes named + numeric HTML entities. Some ATS APIs (e.g. Greenhouse) double-encode content. */
export function decodeHtmlEntities(input: string): string {
  let out = input;
  // Entities can be nested one level deep (e.g. "&amp;lt;" -> "&lt;" -> "<"); two passes covers it.
  for (let pass = 0; pass < 2; pass++) {
    out = out
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&(amp|lt|gt|quot|apos|nbsp|mdash|ndash|rsquo|lsquo|rdquo|ldquo);/g, (_, name) => NAMED_ENTITIES[name]);
  }
  return out;
}

/** Strips HTML tags and collapses whitespace, for search/keyword-scan purposes only (not for display). */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  const decoded = decodeHtmlEntities(html);
  return decoded
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
