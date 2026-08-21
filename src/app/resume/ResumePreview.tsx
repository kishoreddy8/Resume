"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, Pill } from "@/components/ui";
import { IconDocument } from "@/components/icons";

/**
 * Read the tailored documents before downloading them.
 *
 * WHY IT RENDERS JSON AND NOT THE .docx. The artifacts route streams a Word file, which a browser
 * cannot display — clicking it downloads, which is the thing a preview exists to avoid. The
 * pipeline writes `resume_content.json` next to the .docx and that IS what the generator rendered,
 * so this shows the same content with no document parser and no second rendering path to keep in
 * step. Layout, fonts and page breaks are the .docx's business; what you check here is the words.
 *
 * A BEST ATTEMPT IS LABELLED AS ONE. A FAILED workflow preserves its strongest attempt under
 * human-review/. It is genuinely worth reading — this is exactly when you want to see what went
 * wrong before re-tailoring — but the banner says it did not clear validation, and nothing in this
 * component can make it sendable.
 */

interface ResumeContent {
  name?: string;
  tagline?: string;
  location?: string;
  phone?: string;
  email?: string;
  linkedin?: string;
  summary?: string[];
  skillGroups?: { label?: string; items?: string[] }[];
  experience?: { title?: string; company?: string; dates?: string; bullets?: string[] }[];
  education?: unknown[];
  certifications?: unknown[];
}

interface CoverLetterContent {
  name?: string;
  location?: string;
  phone?: string;
  email?: string;
  salutation?: string;
  paragraphs?: string[];
  closing?: string;
}

interface PreviewResponse {
  doc: "resume" | "coverLetter";
  packageKind: "final" | "best-attempt";
  workflowStatus: string;
  iteration: number;
  content: Record<string, unknown>;
}

/** Education and certification entries are loosely shaped across generations; render whatever
 *  string-ish fields are present rather than assuming a schema this component does not own. */
function describeEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const values = Object.values(entry as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string" && v.trim() !== ""
    );
    return values.length ? values.join(" · ") : null;
  }
  return null;
}

export function ResumePreview({
  candidateId,
  jobId,
  company,
  role,
  hasCoverLetter,
  downloadHref,
  onClose,
}: {
  candidateId: number;
  jobId: number;
  company: string | null;
  role: string | null;
  hasCoverLetter: boolean;
  downloadHref: (doc: "resume" | "coverLetter") => string;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<"resume" | "coverLetter">("resume");
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(
    async (which: "resume" | "coverLetter") => {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await fetch(
          `/api/candidates/${candidateId}/jobs/${jobId}/resume-preview?doc=${which}`
        );
        if (!res.ok) {
          setError(
            res.status === 404
              ? "There's no readable content for this document."
              : "We couldn't open this document."
          );
          return;
        }
        setData((await res.json()) as PreviewResponse);
      } catch {
        setError("We couldn't open this document.");
      } finally {
        setLoading(false);
      }
    },
    [candidateId, jobId]
  );

  useEffect(() => {
    // Fetch when the dialog opens and whenever you switch document; `load` is stable per job.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(doc);
  }, [load, doc]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resume = data?.doc === "resume" ? (data.content as ResumeContent) : null;
  const letter = data?.doc === "coverLetter" ? (data.content as CoverLetterContent) : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-[rgba(23,26,34,0.45)] px-4 py-8 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of the tailored resume for ${role ?? "this role"}${company ? ` at ${company}` : ""}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[860px] rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] shadow-[var(--shadow-hero)]"
      >
        {/* header */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--separator)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-bold tracking-[-0.01em] text-primary">
              {role ?? "Tailored resume"}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-tertiary">
              {company ?? "Job no longer listed"}
              {data && ` · v${data.iteration}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={downloadHref(doc)} className={BTN_SECONDARY}>
              Download
            </a>
            <button ref={closeRef} type="button" onClick={onClose} className={BTN_QUIET}>
              Close
            </button>
          </div>
        </div>

        {/* document switch — only offered when the other document actually exists */}
        {hasCoverLetter && (
          <div className="flex gap-1.5 border-b border-[var(--separator)] px-5 py-2.5">
            {(
              [
                ["resume", "Resume"],
                ["coverLetter", "Cover letter"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setDoc(id)}
                aria-pressed={doc === id}
                className={`inline-flex h-[34px] items-center rounded-[9px] px-3.5 text-[13px] font-medium transition-colors duration-150 ease-out ${
                  doc === id
                    ? "bg-[var(--tile-lav-bg)] text-[var(--accent)]"
                    : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* A preserved best attempt is real content that did not clear the gate. Saying so here is
         *  the whole reason it is safe to show. */}
        {data?.packageKind === "best-attempt" && (
          <div className="mx-5 mt-4 rounded-[10px] bg-[var(--pill-amber-bg)] px-4 py-3">
            <div className="text-[12.5px] font-semibold text-[var(--pill-amber-fg)]">
              Best attempt — not cleared to send
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-secondary">
              This is the strongest version JobHunt produced before validation stopped it. Read it to
              see what needs changing, then re-tailor from the job.
            </p>
          </div>
        )}

        {/* body */}
        <div className="max-h-[min(70vh,760px)] overflow-y-auto px-5 py-5">
          {loading && <p className="text-[12.5px] text-tertiary">Opening…</p>}
          {error && (
            <p role="alert" className="text-[12.5px] text-[var(--error)]">
              {error}
            </p>
          )}

          {resume && (
            <article className="text-primary">
              <header className="border-b border-[var(--separator)] pb-3.5">
                <h3 className="text-[19px] font-bold tracking-[-0.015em]">{resume.name}</h3>
                {resume.tagline && <p className="mt-0.5 text-[13px] text-secondary">{resume.tagline}</p>}
                <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-tertiary">
                  {[resume.location, resume.phone, resume.email, resume.linkedin]
                    .filter(Boolean)
                    .map((v) => (
                      <span key={v as string}>{v as string}</span>
                    ))}
                </p>
              </header>

              {resume.summary && resume.summary.length > 0 && (
                <Section title="Summary">
                  {resume.summary.map((line, i) => (
                    <p key={i} className="text-[12.5px] leading-relaxed text-secondary">
                      {line}
                    </p>
                  ))}
                </Section>
              )}

              {resume.skillGroups && resume.skillGroups.length > 0 && (
                <Section title="Skills">
                  <dl className="flex flex-col gap-1.5">
                    {resume.skillGroups.map((g, i) => (
                      <div key={i} className="flex flex-wrap gap-x-2 text-[12.5px] leading-relaxed">
                        <dt className="font-semibold text-primary">{g.label}:</dt>
                        <dd className="min-w-0 flex-1 text-secondary">{(g.items ?? []).join(", ")}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              )}

              {resume.experience && resume.experience.length > 0 && (
                <Section title="Experience">
                  <div className="flex flex-col gap-4">
                    {resume.experience.map((e, i) => (
                      <div key={i}>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="text-[13.5px] font-bold text-primary">{e.title}</span>
                          <span className="text-[12px] tabular-nums text-tertiary">{e.dates}</span>
                        </div>
                        <div className="text-[12.5px] text-secondary">{e.company}</div>
                        {e.bullets && e.bullets.length > 0 && (
                          <ul className="mt-1.5 flex flex-col gap-1">
                            {e.bullets.map((b, j) => (
                              <li key={j} className="flex gap-2 text-[12.5px] leading-relaxed text-secondary">
                                <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--text-tertiary)]" />
                                <span className="min-w-0">{b}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {resume.education && resume.education.length > 0 && (
                <Section title="Education">
                  {resume.education.map((e, i) => {
                    const text = describeEntry(e);
                    return text ? (
                      <p key={i} className="text-[12.5px] leading-relaxed text-secondary">
                        {text}
                      </p>
                    ) : null;
                  })}
                </Section>
              )}

              {resume.certifications && resume.certifications.length > 0 && (
                <Section title="Certifications">
                  {resume.certifications.map((c, i) => {
                    const text = describeEntry(c);
                    return text ? (
                      <p key={i} className="text-[12.5px] leading-relaxed text-secondary">
                        {text}
                      </p>
                    ) : null;
                  })}
                </Section>
              )}
            </article>
          )}

          {letter && (
            <article className="text-primary">
              <header className="border-b border-[var(--separator)] pb-3.5">
                <h3 className="text-[17px] font-bold tracking-[-0.015em]">{letter.name}</h3>
                <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-tertiary">
                  {[letter.location, letter.phone, letter.email].filter(Boolean).map((v) => (
                    <span key={v as string}>{v as string}</span>
                  ))}
                </p>
              </header>
              <div className="mt-4 flex flex-col gap-3">
                {letter.salutation && <p className="text-[12.5px] text-primary">{letter.salutation}</p>}
                {(letter.paragraphs ?? []).map((p, i) => (
                  <p key={i} className="text-[12.5px] leading-relaxed text-secondary">
                    {p}
                  </p>
                ))}
                {letter.closing && <p className="text-[12.5px] text-primary">{letter.closing}</p>}
              </div>
            </article>
          )}
        </div>

        {/* footer — the way back to changing it */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--separator)] px-5 py-3.5">
          <p className="text-[11.5px] text-tertiary">
            Shows the content JobHunt generated. Formatting and page layout live in the Word file.
          </p>
          <div className="flex items-center gap-2">
            {data && (
              <Pill tone={data.packageKind === "final" ? "success" : "warning"}>
                <IconDocument size={13} aria-hidden="true" />
                {data.packageKind === "final" ? "Approved package" : "Best attempt"}
              </Pill>
            )}
            {/* Re-tailoring happens against the job, where the workspace owns the whole flow. */}
            <a href={`/jobs/${jobId}`} className={BTN_PRIMARY}>
              Open job to re-tailor
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h4 className="mb-1.5 text-[11.5px] font-bold uppercase tracking-[0.08em] text-tertiary">{title}</h4>
      {children}
    </section>
  );
}
