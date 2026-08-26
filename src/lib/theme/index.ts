/**
 * UI-M — theme preference. System stays the default: a candidate who never opens this control sees
 * byte-identical behaviour to before this module existed (`prefers-color-scheme` alone, via the CSS
 * already in globals.css). Explicit Light/Dark set a `data-theme` attribute on <html> that the same
 * CSS's `:not([data-theme="light"])` / `[data-theme="dark"]` blocks read to override the OS choice.
 *
 * This is a UI preference, not candidate data — persisted client-side only (localStorage), no DB
 * table, no API route.
 */

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "career-ops:theme";
const THEME_ATTR = "data-theme";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    // Private-mode / storage-disabled — System is always a safe fallback.
    return "system";
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  if (preference === "system") {
    document.documentElement.removeAttribute(THEME_ATTR);
  } else {
    document.documentElement.setAttribute(THEME_ATTR, preference);
  }
}

export function setThemePreference(preference: ThemePreference): void {
  if (typeof window !== "undefined") {
    try {
      if (preference === "system") {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, preference);
      }
    } catch {
      // Nothing to persist to — the attribute still applies for the rest of this session.
    }
  }
  applyThemePreference(preference);
}

/**
 * Inlined verbatim into a blocking `<script>` as the first child of <body> (see ThemeScript) so it
 * runs before first paint — an explicit stored choice is applied before the browser ever paints the
 * OS-default theme. Keep in sync with readStoredThemePreference/applyThemePreference above if either
 * changes; this copy can't import them; it has to run standalone, before hydration.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var v=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(v==="light"||v==="dark"){document.documentElement.setAttribute(${JSON.stringify(
  THEME_ATTR,
)},v);}}catch(e){}})();`;
