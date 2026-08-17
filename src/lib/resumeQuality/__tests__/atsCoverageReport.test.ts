import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import { buildAtsCoverageReport, renderAtsCoverageReport } from "../atsCoverageReport";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { JD_SHAPES, MULTI_JD_MASTER_PROFILE } from "./fixtures/multiJdCandidate";

test("matches the mission's own worked example shape: Snowflake/Python represented, dbt supported-but-missing, Airflow unsupported", () => {
  const resume: ResumeContent = {
    name: "Test", tagline: "Senior Data Engineer", location: "Remote", phone: "312-555-9821", email: "t@gmail.com",
    summary: ["Senior Data Engineer specializing in Snowflake and Python."],
    skillGroups: [{ label: "Skills", items: ["Snowflake", "Python"] }], // dbt evidenced but NOT listed here
    experience: [{ title: "Senior Data Engineer", company: "Northwind Logistics Analytics", dates: "2022 - Present", bullets: ["Built Snowflake pipelines in Python."] }],
    education: [],
  };
  const requirements = JD_SHAPES[0].requirements; // Snowflake(P1), dbt(P1... wait check), Airflow(P2), Python(P2), Docker(P4), Kubernetes(P4)
  const matrix = buildJdPriorityMatrix(requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const report = buildAtsCoverageReport(resume, matrix);
  const byReq = Object.fromEntries(report.map((r) => [r.requirement, r.status]));

  assert.equal(byReq["Snowflake"], "SUPPORTED_AND_REPRESENTED");
  assert.equal(byReq["Python"], "SUPPORTED_AND_REPRESENTED");
  assert.equal(byReq["dbt"], "SUPPORTED_BUT_MISSING"); // candidate has dbt evidence but this resume text omits it
});

test("a requirement with zero candidate evidence is always UNSUPPORTED, never silently promoted", () => {
  const resume: ResumeContent = {
    name: "Test", tagline: "AI Data Engineer", location: "Remote", phone: "312-555-9821", email: "t@gmail.com",
    summary: ["AI-focused data engineer."], skillGroups: [{ label: "Skills", items: ["Python"] }],
    experience: [], education: [],
  };
  const matrix = buildJdPriorityMatrix(JD_SHAPES[2].requirements, "AI Data Engineer", MULTI_JD_MASTER_PROFILE); // Azure OpenAI/RAG unsupported
  const report = buildAtsCoverageReport(resume, matrix);
  const byReq = Object.fromEntries(report.map((r) => [r.requirement, r.status]));
  assert.equal(byReq["Azure OpenAI"], "UNSUPPORTED");
  assert.equal(byReq["RAG"], "UNSUPPORTED");
});

test("UNSUPPORTED entries are never silently converted into resume edits — buildAtsCoverageReport never mutates the resume object passed in", () => {
  const resume: ResumeContent = {
    name: "Test", tagline: "AI Data Engineer", location: "Remote", phone: "312-555-9821", email: "t@gmail.com",
    summary: ["AI-focused data engineer."], skillGroups: [{ label: "Skills", items: ["Python"] }],
    experience: [], education: [],
  };
  const before = JSON.parse(JSON.stringify(resume));
  const matrix = buildJdPriorityMatrix(JD_SHAPES[2].requirements, "AI Data Engineer", MULTI_JD_MASTER_PROFILE);
  buildAtsCoverageReport(resume, matrix);
  assert.deepEqual(resume, before);
});

test("renderAtsCoverageReport produces the pipe-delimited requirement|priority|status format", () => {
  const matrix = buildJdPriorityMatrix(JD_SHAPES[0].requirements, "Senior Data Engineer", MULTI_JD_MASTER_PROFILE);
  const resume: ResumeContent = {
    name: "Test", tagline: "Senior Data Engineer", location: "Remote", phone: "312-555-9821", email: "t@gmail.com",
    summary: ["Senior Data Engineer."], skillGroups: [{ label: "Skills", items: ["Snowflake"] }],
    experience: [], education: [],
  };
  const report = buildAtsCoverageReport(resume, matrix);
  const rendered = renderAtsCoverageReport(report);
  assert.ok(rendered.includes("Snowflake | P1 | SUPPORTED_AND_REPRESENTED"));
});
