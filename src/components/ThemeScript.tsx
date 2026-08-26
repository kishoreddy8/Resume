import { THEME_INIT_SCRIPT } from "@/lib/theme";

/**
 * UI-M — must be the first thing in <body>, before any other content. A synchronous, non-async
 * script blocks the parser at the point it appears, so this runs and sets `data-theme` before the
 * browser paints anything below it — the flash this prevents is the one frame of "System" theme a
 * later effect would otherwise paint first for someone who chose an explicit Light or Dark.
 */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
}
