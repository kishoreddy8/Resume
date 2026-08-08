import { listJobs } from "../src/db/queries/jobs";
import { getJobCertifications, getJobSkills, upsertJobIntel } from "../src/db/queries/jobIntel";
import { extractJobIntel } from "../src/lib/jobIntel/extractJobIntel";

/**
 * Backfills Structured Job Intelligence for every job already in the database, reading each job's
 * already-stored description_html/description_text/employment_type/workplace_type/location/
 * salary_text/sponsorship fields — no live rescan of any ATS is performed. Safe to re-run any
 * number of times: upsertJobIntel() replaces a job's structured fields/skills/certifications rather
 * than accumulating duplicates (see src/db/queries/__tests__/jobIntel.test.ts's idempotency tests).
 *
 * Usage: npm run extract-job-intel [-- --verbose]
 */
async function main() {
  const verbose = process.argv.includes("--verbose");

  // listJobs() excludes archived jobs by default — a backfill should cover every job regardless of
  // lifecycle state, so both views are combined here rather than adding an "all" mode to the shared
  // query function just for this script.
  const active = listJobs({ archived: false });
  const archived = listJobs({ archived: true });
  const jobs = [...active, ...archived];

  console.log(`Extracting structured intelligence for ${jobs.length} job(s)...`);

  let processed = 0;
  let withSkills = 0;
  let withSalary = 0;
  let withClearance = 0;

  for (const job of jobs) {
    const intel = extractJobIntel({
      title: job.title,
      descriptionText: job.description_text,
      descriptionHtml: job.description_html,
      employmentTypeNative: job.employment_type,
      workplaceTypeNative: job.workplace_type,
      locationNative: job.location,
      salaryTextNative: job.salary_text,
      sponsorshipPolarity: job.sponsorship_polarity,
      sponsorshipSnippet: job.sponsorship_snippet,
    });

    upsertJobIntel(job.id, intel);
    processed++;
    if (intel.skills.length > 0) withSkills++;
    if (intel.compensation.min !== null || intel.compensation.max !== null) withSalary++;
    if (intel.clearance.required === "Required") withClearance++;

    if (verbose) {
      const skills = getJobSkills(job.id);
      const certs = getJobCertifications(job.id);
      console.log(
        `  [${job.id}] ${job.company_name} — ${job.title}\n` +
          `    seniority=${intel.seniority.level} employment=${intel.employmentType.type} workplace=${intel.location.workplaceType}\n` +
          `    experience=${intel.experience.minYears ?? "?"}-${intel.experience.preferredYears ?? "?"}yrs education=${intel.education.level ?? "Unknown"}\n` +
          `    salary=${intel.compensation.min ?? "?"}-${intel.compensation.max ?? "?"} ${intel.compensation.currency ?? ""} ${intel.compensation.period ?? ""}\n` +
          `    clearance=${intel.clearance.required} sponsorship=${job.h1b_combined_confidence}\n` +
          `    skills(required)=${skills.filter((s) => s.requirement_level === "Required").map((s) => s.skill_name).join(", ") || "none"}\n` +
          `    skills(preferred)=${skills.filter((s) => s.requirement_level === "Preferred").map((s) => s.skill_name).join(", ") || "none"}\n` +
          `    certifications=${certs.map((c) => `${c.name} (${c.requirement_level})`).join(", ") || "none"}`
      );
    }
  }

  console.log(
    `\nDone. ${processed}/${jobs.length} jobs processed. ` +
      `${withSkills} have at least one classified skill, ${withSalary} have a parsed salary range, ${withClearance} require clearance.`
  );
}

main().catch((err) => {
  console.error("Structured Job Intelligence backfill failed:", err);
  process.exit(1);
});
