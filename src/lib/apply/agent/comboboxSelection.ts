/**
 * Choosing an option inside a react-select-style combobox (`role="combobox"`, no native `<select>`).
 *
 * DETERMINISTIC, EXACT MATCH ONLY — same discipline as questionMatching.ts. A combobox's real option
 * list only exists once the menu is open (react-select renders it lazily/virtualised), so this can
 * never be decided at field-discovery time; it is decided here, against whatever the browser actually
 * shows once the menu is open, and the browser-touching half in executor.ts is a thin wrapper around
 * this pure function.
 *
 * NO FUZZY MATCH, NO "CLOSEST" PICK. A combobox for a real application is exactly the sponsorship-vs-
 * work-authorization problem in a different shape: two options can look alike and mean opposite
 * things. Absence of an exact match returns null, and the caller must treat that exactly like any
 * other unanswerable field — pause and ask, never guess.
 */

/** The one option that exactly matches the approved target value, or null if none does. Case-
 *  sensitive: the approved value is either what the form actually offers, verbatim, or it is not a
 *  safe answer. */
export function exactComboboxOption(visibleOptions: readonly string[], targetValue: string): string | null {
  return visibleOptions.find((option) => option === targetValue) ?? null;
}
