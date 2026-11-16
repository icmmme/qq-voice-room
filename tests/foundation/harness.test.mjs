import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateHarness } from "../../tools/lib/harness-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function documents() {
  const read = (relative) => readFile(path.join(root, relative), "utf8");
  return {
    agents: await read("AGENTS.md"),
    workflow: await read(".harness/WORKFLOW.md"),
    projectState: await read(".harness/PROJECT_STATE.md"),
    currentTask: await read(".harness/CURRENT_TASK.md"),
    taskTemplate: await read(".harness/templates/TASK_CONTRACT.md"),
    reviewTemplate: await read(".harness/templates/REVIEW_REPORT.md")
  };
}

test("harness has exactly one active task and one canonical state", async () => {
  const result = validateHarness(await documents());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.match((await documents()).reviewTemplate, /## Owner handoff facts/);
});

test("current task labels the developer self-check and does not claim independent Review", async () => {
  const docs = await documents();
  assert.match(docs.currentTask, /SELF_CHECK/);
  assert.match(docs.currentTask, /not independent Review/i);
  assert.doesNotMatch(docs.currentTask, /independent\s+review\s*[:=]\s*pass/i);
});

test("negative: duplicate active task marker fails", async () => {
  const docs = await documents();
  docs.currentTask += "\n## Active Task\n";
  const result = validateHarness(docs);
  assert.ok(result.errors.some((error) => error.code === "HARNESS-MARKER-COUNT"));
});

test("negative: fake independent Review PASS fails", async () => {
  const docs = await documents();
  docs.currentTask += "\nIndependent Review: PASS\n";
  const result = validateHarness(docs);
  assert.ok(result.errors.some((error) => error.code === "HARNESS-FAKE-REVIEW"));
});

test("negative: task template missing candidate identity fails", async () => {
  const docs = await documents();
  docs.taskTemplate = docs.taskTemplate.replace("## Candidate identity", "## Candidate");
  const result = validateHarness(docs);
  assert.ok(result.errors.some((error) => error.code === "HARNESS-TASK-TEMPLATE"));
});

test("negative: current task without a self-check label fails", async () => {
  const docs = await documents();
  docs.currentTask = docs.currentTask.replace("SELF_CHECK - not independent Review", "");
  const result = validateHarness(docs);
  assert.ok(result.errors.some((error) => error.code === "HARNESS-SELF-CHECK-LABEL"));
});
