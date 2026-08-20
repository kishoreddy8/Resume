"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * The success state, built entirely from counts the validated profile already carries.
 *
 * The three numbers are `profile.skills.length`, `profile.experience.length` and
 * `profile.certifications.length`, read by the server after the loader accepted the file. They are
 * not estimates and not derived — if the profile holds 38 skills, this says 38.
 *
 * There is deliberately no fourth "readiness" or "profile strength" figure. The engine publishes no
 * such number, and inventing a score here would put a fabricated metric on the one screen whose
 * whole job is to establish that the data can be trusted.
 */
export function ProfileReady({
  summary,
}: {
  summary: { skills: number; experience: number; certifications: number };
}) {
  const reduced = useReducedMotion() ?? false;

  const facts: { value: number; label: string }[] = [
    { value: summary.skills, label: summary.skills === 1 ? "evidenced skill" : "evidenced skills" },
    { value: summary.experience, label: summary.experience === 1 ? "employer" : "employers" },
    {
      value: summary.certifications,
      label: summary.certifications === 1 ? "certification" : "certifications",
    },
  ];

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0.14 } : { type: "spring", duration: 0.42, bounce: 0 }}
      className="plane plane-3 tint-match rounded-[var(--radius-xl)] px-5 py-4"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--success)] text-[9px] font-bold leading-none text-[var(--accent-fg)]"
        >
          ✓
        </span>
        <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-primary">Profile ready</h2>
      </div>

      <dl className="mt-3.5 flex flex-wrap gap-x-8 gap-y-3">
        {facts.map((f) => (
          <div key={f.label}>
            <dt className="sr-only">{f.label}</dt>
            <dd>
              <span className="text-[24px] font-semibold leading-none tabular-nums tracking-[-0.02em] text-primary">
                {f.value.toLocaleString()}
              </span>
              <span className="ml-1.5 text-[12px] text-tertiary">{f.label}</span>
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-[11.5px] leading-relaxed text-tertiary">
        Read from your two documents and checked against the matching engine&rsquo;s own schema.
        Every skill is attributed to where it came from, so nothing is claimed that your resume does
        not support.
      </p>
    </motion.div>
  );
}
