function countOccurrences(text, needle) {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function requireSingle(errors, text, needle, label) {
  const count = countOccurrences(text, needle);
  if (count !== 1) {
    errors.push({ code: "HARNESS-MARKER-COUNT", detail: `${label} must appear exactly once (found ${count})` });
  }
}

function requireText(errors, text, needle, code, detail) {
  if (!text.includes(needle)) errors.push({ code, detail });
}

export function validateHarness(input) {
  const errors = [];
  const {
    agents = "",
    workflow = "",
    projectState = "",
    currentTask = "",
    taskTemplate = "",
    reviewTemplate = ""
  } = input;

  requireSingle(errors, projectState, "## Canonical Current State", "canonical state heading");
  requireSingle(errors, projectState, "<!-- CANONICAL_STATE:BEGIN -->", "canonical state begin marker");
  requireSingle(errors, projectState, "<!-- CANONICAL_STATE:END -->", "canonical state end marker");
  requireSingle(errors, currentTask, "## Active Task", "active task heading");
  requireSingle(errors, currentTask, "<!-- ACTIVE_TASK:BEGIN -->", "active task begin marker");
  requireSingle(errors, currentTask, "<!-- ACTIVE_TASK:END -->", "active task end marker");

  requireText(errors, currentTask, "SELF_CHECK", "HARNESS-SELF-CHECK-LABEL", "current task must label the self-check");
  requireText(
    errors,
    currentTask,
    "not independent Review",
    "HARNESS-SELF-CHECK-CLAIM",
    "current task must state that self-check is not independent Review"
  );
  if (/independent\s+review\s*[:=]\s*pass/i.test(currentTask)) {
    errors.push({ code: "HARNESS-FAKE-REVIEW", detail: "current task cannot claim an independent Review PASS" });
  }

  requireText(errors, agents, "implementer is never the final QA or Review author", "HARNESS-ROLE-SEPARATION", "AGENTS.md must separate implementation from QA/Review");
  requireText(errors, agents, "REVIEW_PENDING", "HARNESS-STATUS", "AGENTS.md must define REVIEW_PENDING");
  requireText(errors, workflow, "candidate", "HARNESS-CANDIDATE", "workflow must define candidate freeze");
  requireText(errors, workflow, "raw-log", "HARNESS-LOG-HASH", "workflow must require raw-log hashes");
  requireText(errors, workflow, "REVIEW_PENDING", "HARNESS-STATUS", "workflow must define REVIEW_PENDING");

  for (const field of ["Scope", "Acceptance", "Tests", "Risks", "Evidence", "Candidate identity"]) {
    requireText(errors, taskTemplate, field, "HARNESS-TASK-TEMPLATE", `task template is missing ${field}`);
  }
  for (const field of ["Commands run", "Scope", "Unverified items", "Findings", "Candidate identity", "Reviewer independence", "Owner handoff facts"]) {
    requireText(errors, reviewTemplate, field, "HARNESS-REVIEW-TEMPLATE", `review template is missing ${field}`);
  }
  requireText(errors, reviewTemplate, "cannot transfer", "HARNESS-CANDIDATE-TRANSFER", "review template must forbid candidate transfer");

  return { ok: errors.length === 0, errors };
}
