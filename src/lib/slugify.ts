/** Filesystem/URL-safe slug: lowercase, non-alphanumeric runs collapsed to a single hyphen. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "company";
}
