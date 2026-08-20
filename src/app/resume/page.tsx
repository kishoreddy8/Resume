"use client";

import Link from "next/link";
import CandidateIntelligencePage from "@/app/candidate-intelligence/page";

/**
 * Resume Intelligence — the user-facing name for what Candidate Intelligence already shows.
 *
 * REUSED, NOT REBUILT. The evidence view, the profile build, the skills and employers are all the
 * existing page; a second implementation would be a second thing to keep truthful. What changes is
 * the framing: a job seeker looks for "my resume", not "candidate intelligence", and the documents
 * that feed it are one click away instead of a separate top-level destination.
 */
export default function ResumePage() {
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Resume sections" className="flex flex-wrap gap-2 text-[12.5px]">
        <Link
          href="/master-files"
          className="rounded-md border border-[var(--border)] px-3 py-1.5 font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
        >
          Master resume &amp; skills
        </Link>
        <Link
          href="/onboarding"
          className="rounded-md border border-[var(--border)] px-3 py-1.5 font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
        >
          Target role &amp; setup
        </Link>
      </nav>
      <CandidateIntelligencePage />
    </div>
  );
}
