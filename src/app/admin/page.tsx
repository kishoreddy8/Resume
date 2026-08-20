"use client";

import Link from "next/link";
import { Surface } from "@/components/ui";

/**
 * Admin overview.
 *
 * A map, not a dashboard. Every destination here already existed and already renders its own real
 * numbers; duplicating a few of them on a landing page would mean two places that can disagree
 * about connector health, and the one you happened to open would be the one you believed.
 *
 * This exists so system operations have a home that is NOT the candidate's navigation rail. A
 * person looking for work should not be reading scan-run diagnostics between Jobs and Settings.
 */

const SECTIONS = [
  {
    href: "/admin/scanner",
    title: "ATS Scanner",
    body: "Scan runs, connector health, and what each source last returned.",
  },
  {
    href: "/admin/connectors",
    title: "Connectors",
    body: "ATS coverage across the registry, and the sources still unresolved.",
  },
  {
    href: "/admin/companies",
    title: "Companies",
    body: "The company registry, discovery state, and what JobHunt has observed of each.",
  },
  {
    href: "/admin/pipeline",
    title: "Pipeline",
    body: "Stage counts across the job corpus — the internal view, not a candidate's applications.",
  },
  {
    href: "/admin/operations",
    title: "System health",
    body: "Workers, queues, scheduler state and data health.",
  },
  {
    href: "/settings",
    title: "Configuration",
    body: "System configuration, AI providers, and feature switches.",
  },
];

export default function AdminOverviewPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 py-6">
      <header>
        <h1 className="page-title">System operations</h1>
        <p className="mt-1.5 max-w-[64ch] text-[12.5px] leading-relaxed text-tertiary">
          The machinery behind JobHunt: how jobs are discovered, which connectors are healthy, and
          what the system is doing. Separate from the candidate experience on purpose — nothing here
          is something a job seeker should have to think about.
        </p>
      </header>

      <ul className="grid gap-2.5 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="block">
              <Surface
                level="z3"
                className="h-full rounded-[var(--radius-xl)] px-4 py-3.5 transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)]"
              >
                <h2 className="text-[13.5px] font-semibold text-primary">{s.title}</h2>
                <p className="mt-1 text-[12px] leading-relaxed text-tertiary">{s.body}</p>
              </Surface>
            </Link>
          </li>
        ))}
      </ul>

      <p className="text-[11.5px] leading-relaxed text-tertiary">
        <Link href="/home" className="text-secondary underline-offset-2 hover:underline">
          ← Back to JobHunt
        </Link>
      </p>
    </div>
  );
}
