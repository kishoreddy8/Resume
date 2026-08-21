"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSearch } from "@/components/icons";

/**
 * The header search field.
 *
 * IT IS NOT A SEARCH ENGINE. It submits to the job search that already exists: `/jobs?q=` is the
 * same entry point the command palette uses, read by the jobs page on mount. Nothing here queries,
 * ranks or filters, so there is no second search implementation to disagree with the first — and no
 * request is made from this field at all.
 *
 * WHY A FIELD AND NOT A BUTTON. A control that looks like a search box and merely navigates is a
 * small lie that costs a user their typed query. This one keeps the query and lands them on real
 * results, which is what the shape promises.
 *
 * `/` focuses it, matching the hint it displays — and only when the caret is not already in
 * something typable, so it never eats a slash mid-sentence.
 */
export function HeaderSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        el?.isContentEditable === true;
      if (typing) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = query.trim();
        /* An empty submit still goes to Jobs — the field's whole promise is that it takes you
         * there — but it does not append an empty filter. */
        router.push(q ? `/jobs?q=${encodeURIComponent(q)}` : "/jobs");
      }}
      className="hidden w-full max-w-[var(--home-search-max)] md:block"
    >
      <label className="group relative flex items-center">
        <span className="sr-only">Search jobs, companies and skills</span>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[18px] text-tertiary transition-colors duration-150 ease-out group-focus-within:text-[var(--accent)]"
        >
          <IconSearch size={19} />
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs, companies, skills..."
          enterKeyHint="search"
          className="h-[46px] w-full rounded-[14px] border border-[#E2E5ED] bg-[var(--z3-bg)] pl-12 pr-14 text-[14.5px] text-primary shadow-[var(--shadow-row)] transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-tertiary focus:border-[var(--accent)] focus:outline-none dark:border-[var(--border)] [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute right-3.5 grid h-[26px] min-w-[26px] place-items-center rounded-[8px] border border-[var(--border)] px-2 text-[12px] leading-none text-tertiary"
        >
          /
        </kbd>
      </label>
    </form>
  );
}
