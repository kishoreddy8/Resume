import test from "node:test";
import assert from "node:assert/strict";
import { planFields, collectHumanQuestions } from "../planFields";
import type { DiscoveredField, AdapterContext, RunApprovedAnswer } from "../types";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";

const CONTEXT: AdapterContext = {
  candidateId: 1,
  contact: {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "(214) 555-0100",
    location: "Dallas, TX",
    linkedin: "https://linkedin.com/in/janedoe",
  },
  resumePath: "/path/to/resume.pdf",
  coverLetterPath: null,
};

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();
const NO_ANSWERS = new Map<string, StoredAnswer>();

const CUSTOM_DW_FIELD: DiscoveredField = {
  selector: "#question_66626305",
  id: "question_66626305",
  name: "question_66626305",
  kind: "combobox",
  label: "Which best describes your primary role in data warehouse projects you've worked on?",
  required: true,
  options: [
    "I designed and built pipelines and models directly, writing the code and owning the architecture",
    "I led the data team and reviewed technical decisions made by engineers on my team",
    "I built and maintained reports and dashboards that consumed data from the warehouse",
    "I worked across data, analytics, and engineering as a hybrid analyst-engineer",
  ],
};

const CUSTOM_DE_FIELD: DiscoveredField = {
  selector: "#question_66626306",
  id: "question_66626306",
  name: "question_66626306",
  kind: "combobox",
  label: "Which best describes the primary environment where you've done your data engineering work?",
  required: true,
  options: [
    "B2B SaaS or enterprise software, serving internal analytics, product, or go-to-market teams",
    "Consumer or media platform, serving recommendation engines, content pipelines, or user behavior analytics",
    "Agency or consulting, building data solutions across multiple client industries without a single platform focus",
    "Financial services or fintech, primarily compliance, risk, or transaction data pipelines",
  ],
};

const SPONSORSHIP_FIELD: DiscoveredField = {
  selector: "#question_65938389",
  id: "question_65938389",
  name: "question_65938389",
  kind: "combobox",
  label: "Do you now or in the future require visa sponsorship?",
  required: true,
  options: ["Yes", "No"],
};

const SALARY_FIELD: DiscoveredField = {
  selector: "#salary_expectation",
  id: "salary_expectation",
  name: "salary_expectation",
  kind: "text",
  label: "Desired Salary",
  required: true,
};

const DEMOGRAPHIC_GENDER_FIELD: DiscoveredField = {
  selector: "#gender",
  id: "gender",
  name: "gender",
  kind: "select",
  label: "Gender Identity",
  required: false,
  options: ["Decline to state", "Female", "Male", "Non-binary"],
};

test("RUNANS-01: Without runAnswers, unmapped custom question plans as ask", () => {
  const plans = planFields({
    fields: [CUSTOM_DW_FIELD],
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, "ask");
  assert.equal(plans[0].field.selector, CUSTOM_DW_FIELD.selector);
});

test("RUNANS-02: With runAnswers, two custom unmapped questions plan as fill with canonicalKey null", () => {
  const runAnswers: Record<string, RunApprovedAnswer> = {
    [CUSTOM_DW_FIELD.id!]: {
      questionId: CUSTOM_DW_FIELD.id!,
      selector: CUSTOM_DW_FIELD.selector,
      label: CUSTOM_DW_FIELD.label!,
      answer: "I designed and built pipelines and models directly, writing the code and owning the architecture",
      canonicalKey: null,
      questionType: null,
    },
    [CUSTOM_DE_FIELD.id!]: {
      questionId: CUSTOM_DE_FIELD.id!,
      selector: CUSTOM_DE_FIELD.selector,
      label: CUSTOM_DE_FIELD.label!,
      answer: "B2B SaaS or enterprise software, serving internal analytics, product, or go-to-market teams",
      canonicalKey: null,
      questionType: null,
    },
  };

  const plans = planFields({
    fields: [CUSTOM_DW_FIELD, CUSTOM_DE_FIELD],
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    runAnswers,
  });

  assert.equal(plans.length, 2);

  // RUNANS-03: custom approved answer becomes action: fill
  assert.equal(plans[0].action, "fill");
  assert.equal(plans[1].action, "fill");

  // RUNANS-04: source is USER_INTERVENTION
  if (plans[0].action === "fill") {
    assert.equal(plans[0].source, "USER_INTERVENTION");
    assert.equal(plans[0].value, "I designed and built pipelines and models directly, writing the code and owning the architecture");
    // RUNANS-05: canonicalKey remains null; no fabricated global key
    assert.equal(plans[0].canonicalKey, null);
  }

  if (plans[1].action === "fill") {
    assert.equal(plans[1].source, "USER_INTERVENTION");
    assert.equal(plans[1].value, "B2B SaaS or enterprise software, serving internal analytics, product, or go-to-market teams");
    assert.equal(plans[1].canonicalKey, null);
  }
});

test("RUNANS-06 & RUNANS-07: Canonical question with Vault answer uses Vault, while custom question uses runAnswers", () => {
  const variants = new Map<string, { canonicalKey: string; type: QuestionType }>();
  variants.set("Do you now or in the future require visa sponsorship?", {
    canonicalKey: "sponsorship_required",
    type: "sponsorship",
  });

  const storedAnswers = new Map<string, StoredAnswer>();
  storedAnswers.set("sponsorship_required", {
    answer_value: "Yes",
    answer_source: "USER_INTERVENTION",
    approved_by_user: 1,
    auto_fill_allowed: 1,
  });

  const runAnswers: Record<string, RunApprovedAnswer> = {
    [CUSTOM_DW_FIELD.id!]: {
      questionId: CUSTOM_DW_FIELD.id!,
      selector: CUSTOM_DW_FIELD.selector,
      label: CUSTOM_DW_FIELD.label!,
      answer: "I led the data team and reviewed technical decisions made by engineers on my team",
      canonicalKey: null,
      questionType: null,
    },
  };

  const plans = planFields({
    fields: [SPONSORSHIP_FIELD, CUSTOM_DW_FIELD],
    context: CONTEXT,
    knownVariants: variants,
    storedAnswers,
    runAnswers,
  });

  assert.equal(plans.length, 2);

  // Sponsorship filled from Vault
  assert.equal(plans[0].action, "fill");
  if (plans[0].action === "fill") {
    assert.equal(plans[0].canonicalKey, "sponsorship_required");
    assert.equal(plans[0].value, "Yes");
  }

  // DW Role filled from runAnswers
  assert.equal(plans[1].action, "fill");
  if (plans[1].action === "fill") {
    assert.equal(plans[1].canonicalKey, null);
    assert.equal(plans[1].source, "USER_INTERVENTION");
    assert.equal(plans[1].value, "I led the data team and reviewed technical decisions made by engineers on my team");
  }
});

test("RUNANS-09: Answered questions disappear from collectHumanQuestions batch", () => {
  const runAnswers: Record<string, RunApprovedAnswer> = {
    [CUSTOM_DW_FIELD.id!]: {
      questionId: CUSTOM_DW_FIELD.id!,
      selector: CUSTOM_DW_FIELD.selector,
      label: CUSTOM_DW_FIELD.label!,
      answer: "I built and maintained reports and dashboards that consumed data from the warehouse",
      canonicalKey: null,
      questionType: null,
    },
  };

  // One answered field and one unanswered field
  const plans = planFields({
    fields: [CUSTOM_DW_FIELD, CUSTOM_DE_FIELD],
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    runAnswers,
  });

  const humanQuestions = collectHumanQuestions(plans, NO_VARIANTS);
  assert.equal(humanQuestions.length, 1, "Only the unanswered DE question should be in humanQuestions batch");
  assert.equal(humanQuestions[0].id, CUSTOM_DE_FIELD.id);
});

test("RUNANS-12: Changed employer option list rejects/stops rather than guessing", () => {
  const runAnswers: Record<string, RunApprovedAnswer> = {
    [CUSTOM_DW_FIELD.id!]: {
      questionId: CUSTOM_DW_FIELD.id!,
      selector: CUSTOM_DW_FIELD.selector,
      label: CUSTOM_DW_FIELD.label!,
      answer: "Old Option That Employer Removed",
      canonicalKey: null,
      questionType: null,
    },
  };

  const plans = planFields({
    fields: [CUSTOM_DW_FIELD],
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    runAnswers,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, "ask", "Must stop and ask when saved answer is not in current employer options");
  if (plans[0].action === "ask") {
    assert.ok(plans[0].reason.includes("no longer one of the options"));
  }
});

test("RUNANS-13: ask_each_time question works for current run via runAnswers without auto-fill in Vault", () => {
  const variants = new Map<string, { canonicalKey: string; type: QuestionType }>();
  variants.set("Desired Salary", {
    canonicalKey: "desired_salary",
    type: "salary",
  });

  // Vault has an entry, but compensation is ask_each_time so Vault resolution returns ask
  const storedAnswers = new Map<string, StoredAnswer>();
  storedAnswers.set("desired_salary", {
    answer_value: "$160,000",
    answer_source: "USER_INTERVENTION",
    approved_by_user: 1,
    auto_fill_allowed: 0,
  });

  const runAnswers: Record<string, RunApprovedAnswer> = {
    [SALARY_FIELD.id!]: {
      questionId: SALARY_FIELD.id!,
      selector: SALARY_FIELD.selector,
      label: SALARY_FIELD.label!,
      answer: "$175,000",
      canonicalKey: "desired_salary",
      questionType: "salary",
    },
  };

  const plans = planFields({
    fields: [SALARY_FIELD],
    context: CONTEXT,
    knownVariants: variants,
    storedAnswers,
    runAnswers,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, "fill");
  if (plans[0].action === "fill") {
    assert.equal(plans[0].value, "$175,000");
    assert.equal(plans[0].source, "USER_INTERVENTION");
    assert.equal(plans[0].canonicalKey, "desired_salary");
  }
});

test("RUNANS-14: Optional voluntary demographic question not in runAnswers remains unblocked skip/ask", () => {
  const variants = new Map<string, { canonicalKey: string; type: QuestionType }>();
  variants.set("Gender Identity", {
    canonicalKey: "gender",
    type: "voluntary_demographic",
  });

  const plans = planFields({
    fields: [DEMOGRAPHIC_GENDER_FIELD],
    context: CONTEXT,
    knownVariants: variants,
    storedAnswers: NO_ANSWERS,
    runAnswers: {},
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, "ask");
  assert.equal(plans[0].field.required, false);

  const humanQuestions = collectHumanQuestions(plans, variants);
  assert.equal(humanQuestions.length, 0, "Optional demographic fields must never block or enter humanQuestions batch");
});
