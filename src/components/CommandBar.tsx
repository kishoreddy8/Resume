"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * The command palette. ⌘K / Ctrl+K.
 *
 * A NAMING DECISION, stated because it matters: the brief calls this an "AI Command Bar", and it is
 * deliberately not built as one. Every command below routes to a capability Career-Ops already has —
 * navigation, a job search, a jump to a section. Nothing here reasons, and no request is sent to a
 * model. Dressing deterministic routing up as AI would be the interface equivalent of a fabricated
 * confidence score: it would teach the user to expect understanding that isn't there. So it presents
 * itself as what it is, a fast way to reach real functionality, and the placeholder says so.
 *
 * Frequency rule: this is a keyboard-first control opened many times a day, so it opens with the
 * shortest transition the design system allows and never blocks input behind it.
 */

interface Command {
  id: string;
  label: string;
  group: string;
  /** Extra words that should match this command without being displayed. */
  keywords?: string;
  hint?: string;
  run: () => void;
}

const RECENT_KEY = "career-ops:command-recents";
const RECENT_MAX = 5;

/** Subsequence match, the behaviour people expect from this kind of control ("pip" finds Pipeline). */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const direct = h.indexOf(n);
  if (direct >= 0) return 1000 - direct; // contiguous matches always outrank scattered ones
  let hi = 0;
  let score = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found < 0) return -1;
    score += 10 - Math.min(9, found - hi);
    hi = found + 1;
  }
  return score;
}

export function CommandBar() {
  const router = useRouter();
  const pathname = usePathname();
  const reduced = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  /* Recents are pulled when the palette opens rather than on mount: they are only ever read while
   * it is visible, and doing it here keeps localStorage out of an effect entirely. */
  const loadRecents = useCallback(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      setRecents(raw ? JSON.parse(raw) : []);
    } catch {
      // A corrupt or unavailable store is not worth surfacing — recents are a convenience.
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
    restoreFocusTo.current?.focus();
  }, []);

  const remember = useCallback((id: string) => {
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  /** Jump to a section of the currently open job. Real anchors the review pane already renders. */
  const jumpTo = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }, []);

  const onJobsSurface = pathname.startsWith("/jobs");

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => router.push(href);
    const base: Command[] = [
      { id: "nav-dashboard", label: "Dashboard", group: "Go to", keywords: "home intelligence overview", run: go("/dashboard") },
      { id: "nav-jobs", label: "Jobs", group: "Go to", keywords: "queue search match", run: go("/jobs") },
      { id: "nav-pipeline", label: "Applications", group: "Go to", keywords: "pipeline applied interview offer", run: go("/pipeline") },
      { id: "nav-archived", label: "Archived jobs", group: "Go to", keywords: "closed old", run: go("/jobs/archived") },
      { id: "nav-companies", label: "Companies", group: "Go to", keywords: "sources career links", run: go("/companies") },
      { id: "nav-ats", label: "ATS Operations", group: "Go to", keywords: "scanner connectors health greenhouse lever workday", run: go("/scanner") },
      { id: "nav-coverage", label: "ATS Coverage", group: "Go to", keywords: "coverage proposals", run: go("/ats-coverage") },
      { id: "nav-candidate", label: "Candidate Intelligence", group: "Go to", keywords: "profile skills evidence experience certifications me", run: go("/candidate-intelligence") },
      { id: "act-foryou", label: "What jobs fit my experience?", group: "Find", keywords: "for you recommended matches suitable", run: go("/jobs") },
      { id: "act-ready", label: "Show jobs ready to tailor", group: "Find", keywords: "ready for tailoring approve", run: go("/jobs") },
      { id: "act-applications", label: "Show active applications", group: "Find", keywords: "pipeline applied interviewing offer", run: go("/pipeline") },
      { id: "act-scanner", label: "Show scanner health", group: "Find", keywords: "ats connectors ingestion operations", run: go("/scanner") },
      { id: "nav-master", label: "Master Files", group: "Go to", keywords: "resume skills inventory upload", run: go("/master-files") },
      { id: "nav-ops", label: "System Operations", group: "Go to", keywords: "health workers queues scheduler", run: go("/operations") },
      { id: "nav-settings", label: "Settings", group: "Go to", keywords: "configuration preferences ai providers", run: go("/settings") },
      { id: "nav-setup", label: "Profile setup", group: "Go to", keywords: "onboarding first run upload resume skills target role pin", run: go("/onboarding") },
      { id: "nav-applications", label: "Applications", group: "Go to", keywords: "application runs apply submitted waiting review agent", run: go("/applications") },
      /* These land on the same workspace, which groups by what needs a person — so they are one
       * destination reached three ways, not three parallel screens. */
      { id: "act-app-waiting", label: "Show applications waiting on me", group: "Find", keywords: "needs input captcha mfa question intervention blocked", run: go("/applications") },
      { id: "act-app-review", label: "Show applications ready for review", group: "Find", keywords: "approve submit ready review", run: go("/applications") },
      { id: "act-app-resume", label: "Resume an interrupted application", group: "Find", keywords: "continue paused stopped resume run", run: go("/applications") },
    ];

    // Contextual: only offered where the target actually exists on the page.
    if (onJobsSurface) {
      base.unshift(
        { id: "job-why", label: "Why is this job a match?", group: "This job", keywords: "explain reason strengths concerns verdict", hint: "scrolls", run: () => jumpTo("job-why") },
        { id: "job-skills", label: "What skills are missing evidence?", group: "This job", keywords: "compare profile jd alignment partial gaps", hint: "scrolls", run: () => jumpTo("job-skills") },
        { id: "job-requirements", label: "Show requirements", group: "This job", keywords: "experience education certification sponsorship", hint: "scrolls", run: () => jumpTo("job-requirements") },
        { id: "job-tailoring", label: "Prepare tailoring package", group: "This job", keywords: "tailor resume approve readiness", hint: "scrolls", run: () => jumpTo("job-tailoring") },
        { id: "job-resume", label: "Show resume history", group: "This job", keywords: "quality pipeline writer iteration workflow", hint: "scrolls", run: () => jumpTo("job-resume") },
        /* The tailoring plan: what will be emphasised, what must not be claimed, and where each
         * technology may be used. Scrolls rather than navigates — it lives on this page. */
        { id: "job-plan", label: "Open the tailoring plan", group: "This job", keywords: "resume studio evidence msi emphasize do not claim eligibility", hint: "scrolls", run: () => jumpTo("job-plan") }
      );
    }

    // A free-text query becomes a real search rather than a dead end. Both destinations filter
    // client-side against data they already load, so neither preloads an index for the palette.
    if (query.trim().length > 1) {
      const q = query.trim();
      base.unshift(
        {
          id: "search-jobs",
          label: `Search jobs for “${q}”`,
          group: "Search",
          hint: "title, company, description",
          run: () => router.push(`/jobs?q=${encodeURIComponent(q)}`),
        },
        {
          id: "search-companies",
          label: `Find company “${q}”`,
          group: "Search",
          hint: "name",
          run: () => router.push(`/companies?q=${encodeURIComponent(q)}`),
        }
      );
    }
    return base;
  }, [router, onJobsSurface, jumpTo, query]);

  const results = useMemo(() => {
    if (!query.trim()) {
      const recentSet = new Set(recents);
      const recent = recents.map((id) => commands.find((c) => c.id === id)).filter((c): c is Command => Boolean(c));
      return [...recent.map((c) => ({ ...c, group: "Recent" })), ...commands.filter((c) => !recentSet.has(c.id))];
    }
    return commands
      .map((c) => ({ c, s: Math.max(fuzzyScore(c.label, query), fuzzyScore(c.keywords ?? "", query) - 5) }))
      .filter((x) => x.s > 0 || x.c.id === "search-jobs")
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commands, query, recents]);

  // Global shortcut. Deliberately inert while typing anywhere else, so ⌘K never steals a keystroke.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        restoreFocusTo.current = document.activeElement as HTMLElement;
        setOpen((o) => {
          if (!o) loadRecents();
          return !o;
        });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [loadRecents]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = results[active];
      if (cmd) {
        remember(cmd.id);
        close();
        cmd.run();
      }
    }
  }

  /* Group headers resolved up front — deciding them inside the map meant mutating a variable
   * during render, which is exactly the pattern that breaks on a re-render. */
  const headerFor = results.map((cmd, i) => (i === 0 || results[i - 1].group !== cmd.group ? cmd.group : null));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.08 : 0.12 }}
        >
          {/* Scrim: dims to focus, and clicking it dismisses. */}
          <button
            type="button"
            aria-label="Close command palette"
            onClick={close}
            className="absolute inset-0 cursor-default bg-[rgba(10,11,15,0.45)]"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onKeyDown={onListKey}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.99, y: -4 }}
            transition={reduced ? { duration: 0.09 } : { type: "spring", duration: 0.2, bounce: 0 }}
            className="plane plane-5 relative w-full max-w-[34rem] overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-[var(--separator)] px-4 py-3">
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-tertiary">
                <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.2 10.2 L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="Search commands or jobs…"
                aria-label="Search commands or jobs"
                aria-controls="command-results"
                aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-primary outline-none placeholder:text-tertiary"
              />
              <kbd className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-tertiary">esc</kbd>
            </div>

            <ul id="command-results" role="listbox" aria-label="Commands" className="max-h-[52vh] overflow-y-auto py-1.5">
              {results.length === 0 && (
                <li className="px-4 py-6 text-center text-[12.5px] text-tertiary">No matching command.</li>
              )}
              {results.map((cmd, i) => {
                const header = headerFor[i];
                return (
                  <li key={cmd.id}>
                    {header && (
                      <div className="px-4 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.11em] text-tertiary">
                        {header}
                      </div>
                    )}
                    <div
                      id={`cmd-${cmd.id}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => {
                        remember(cmd.id);
                        close();
                        cmd.run();
                      }}
                      className={`mx-1.5 flex cursor-pointer items-center gap-3 rounded-[7px] px-2.5 py-[7px] text-[13px] ${
                        i === active ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-primary"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                      {cmd.hint && (
                        <span className={`shrink-0 text-[10.5px] ${i === active ? "opacity-75" : "text-tertiary"}`}>
                          {cmd.hint}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center gap-3 border-t border-[var(--separator)] px-4 py-2 text-[10.5px] text-tertiary">
              <span>↑↓ navigate</span>
              <span>↵ run</span>
              <span className="ml-auto">Routes to existing features — no model is called.</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
