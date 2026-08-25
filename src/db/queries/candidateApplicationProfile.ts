import { getDb } from "@/db";

/**
 * PHASE 9D — the candidate's structured employment/education facts, for deterministic application
 * filling. See `runCandidateApplicationProfileMigrations` (src/db/index.ts) for why these tables
 * start empty: there is no authoritative structured source to import from yet, so nothing here
 * ever invents a row. A candidate with none behaves exactly as before this phase — every employment/
 * education question on a form becomes a user question, never a guess.
 *
 * CANDIDATE-SCOPED. Every function below takes a candidateId and every query filters on it; there
 * is no "list every employment record" function, mirroring the same isolation `application_answers`
 * already has.
 */

export interface EmploymentRecord {
  id: number;
  candidateId: number;
  employer: string;
  title: string;
  /** "YYYY-MM" or null — never invented when the candidate hasn't supplied one. */
  startDate: string | null;
  /** null means current role. */
  endDate: string | null;
  location: string | null;
  displayOrder: number;
}

export interface EducationRecord {
  id: number;
  candidateId: number;
  institution: string;
  level: string;
  field: string;
  location: string | null;
  displayOrder: number;
}

interface EmploymentRow {
  id: number;
  candidate_id: number;
  employer: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  display_order: number;
}

interface EducationRow {
  id: number;
  candidate_id: number;
  institution: string;
  level: string;
  field: string;
  location: string | null;
  display_order: number;
}

function fromEmploymentRow(row: EmploymentRow): EmploymentRecord {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    employer: row.employer,
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    location: row.location,
    displayOrder: row.display_order,
  };
}

function fromEducationRow(row: EducationRow): EducationRecord {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    institution: row.institution,
    level: row.level,
    field: row.field,
    location: row.location,
    displayOrder: row.display_order,
  };
}

/** Chronological, newest first (by displayOrder, then id) — the order `AdapterContext.employment`
 *  and most ATS employment-history sections expect. */
export function listEmployment(candidateId: number): EmploymentRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM candidate_employment WHERE candidate_id = ? ORDER BY display_order ASC, id ASC`)
    .all(candidateId) as EmploymentRow[];
  return rows.map(fromEmploymentRow);
}

export function listEducation(candidateId: number): EducationRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM candidate_education WHERE candidate_id = ? ORDER BY display_order ASC, id ASC`)
    .all(candidateId) as EducationRow[];
  return rows.map(fromEducationRow);
}

export interface NewEmploymentRecord {
  candidateId: number;
  employer: string;
  title: string;
  startDate?: string | null;
  endDate?: string | null;
  location?: string | null;
  displayOrder?: number;
}

/** The caller supplies every fact explicitly — there is no derivation from a resume, a JD, or any
 *  other text here. This function only persists what it is given. */
export function addEmployment(input: NewEmploymentRecord): EmploymentRecord {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO candidate_employment (candidate_id, employer, title, start_date, end_date, location, display_order)
       VALUES (@candidateId, @employer, @title, @startDate, @endDate, @location, @displayOrder)`
    )
    .run({
      candidateId: input.candidateId,
      employer: input.employer,
      title: input.title,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      location: input.location ?? null,
      displayOrder: input.displayOrder ?? 0,
    });
  return fromEmploymentRow(
    db.prepare(`SELECT * FROM candidate_employment WHERE id = ?`).get(result.lastInsertRowid) as EmploymentRow
  );
}

export interface NewEducationRecord {
  candidateId: number;
  institution: string;
  level: string;
  field: string;
  location?: string | null;
  displayOrder?: number;
}

export function addEducation(input: NewEducationRecord): EducationRecord {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO candidate_education (candidate_id, institution, level, field, location, display_order)
       VALUES (@candidateId, @institution, @level, @field, @location, @displayOrder)`
    )
    .run({
      candidateId: input.candidateId,
      institution: input.institution,
      level: input.level,
      field: input.field,
      location: input.location ?? null,
      displayOrder: input.displayOrder ?? 0,
    });
  return fromEducationRow(
    db.prepare(`SELECT * FROM candidate_education WHERE id = ?`).get(result.lastInsertRowid) as EducationRow
  );
}

/** Deletes are scoped by BOTH id and candidateId — a caller can never delete another candidate's
 *  row even by supplying the wrong id, because the WHERE clause requires both to match. */
export function deleteEmployment(candidateId: number, id: number): void {
  getDb().prepare(`DELETE FROM candidate_employment WHERE id = ? AND candidate_id = ?`).run(id, candidateId);
}

export function deleteEducation(candidateId: number, id: number): void {
  getDb().prepare(`DELETE FROM candidate_education WHERE id = ? AND candidate_id = ?`).run(id, candidateId);
}
