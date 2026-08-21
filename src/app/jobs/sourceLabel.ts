/** The board a person could recognise. `built_in` is an internal seed marker, not a place. */
export function sourceLabel(source: string | null): string | null {
  if (!source || source === "built_in") return null;
  return source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
