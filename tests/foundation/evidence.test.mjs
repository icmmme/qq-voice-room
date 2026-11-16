import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../../tools/lib/hash.mjs";
import {
  evidenceStaleness,
  passTransfersToCandidate,
  validateCommandRecords,
  validateEvidenceContractText,
  validateFoundationClosureEvidence,
  validateIdentity,
  validateStaticExecutionBoundary,
  validateSourceManifest
} from "../../tools/lib/evidence-contract.mjs";
import {
  buildFoundationClosure,
  foundationClosureSha256
} from "../../tools/lib/foundation-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

async function currentHashes(identity) {
  const hashes = {};
  for (const entryPath of identity.q.baseIdentity.trackedPaths) {
    hashes[entryPath] = sha256Bytes(await readFile(path.join(root, entryPath)));
  }
  return hashes;
}

test("input identity, source manifest and command records validate", async () => {
  const identity = await json("evidence/m1-input-identity.json");
  const manifest = await json("evidence/source-manifest.json");
  const records = await json("evidence/command-records.json");
  const identityResult = validateIdentity(identity);
  assert.deepEqual(identityResult.errors, []);
  const manifestResult = validateSourceManifest(manifest, identity, await currentHashes(identity));
  assert.deepEqual(manifestResult.errors, []);
  const commandResult = validateCommandRecords(records);
  assert.deepEqual(commandResult.errors, []);
  assert.ok(records.every((record) => record.cwd === "Q"));
  assert.deepEqual(identity.q.worktreeObservation.modifiedTrackedPaths, ["package.json"]);
  assert.equal(identity.q.worktreeObservation.stagedCount, 0);
  assert.equal(identity.q.worktreeObservation.untrackedCount, 6);
  assert.equal(identity.q.worktreeObservation.clean, false);
});

test("static execution-boundary evidence validates and records zero legacy actions", async () => {
  const boundary = await json("evidence/static-execution-boundary.json");
  const closure = await buildFoundationClosure(root);
  const result = validateStaticExecutionBoundary(boundary, closure.records);
  assert.deepEqual(result.errors, []);
  assert.equal(boundary.legacyEntryExecutions, 0);
  assert.equal(boundary.legacyRuntimeImports, 0);
  assert.equal(boundary.envFileReads, 0);
});

test("closure evidence exact-list relationships and live hashes validate", async () => {
  const boundary = await json("evidence/static-execution-boundary.json");
  const closure = await buildFoundationClosure(root);
  const result = validateFoundationClosureEvidence(boundary, closure.records);
  assert.deepEqual(result.errors, []);
  assert.equal(boundary.foundationClosureModules.length, closure.records.length);
  assert.deepEqual(boundary.foundationClosurePaths, closure.paths);
  assert.equal(boundary.foundationClosureSha256, foundationClosureSha256(closure.records));
});

test("negative: closure evidence extra, missing, duplicate and executed-test drift fail", async () => {
  const boundary = await json("evidence/static-execution-boundary.json");
  const closure = await buildFoundationClosure(root);

  const extra = structuredClone(boundary);
  extra.foundationClosureModules.push({
    path: "tests/foundation/helpers/extra.mjs",
    bytes: 1,
    sha256: "0".repeat(64),
    role: "local-dependency"
  });
  extra.foundationClosureModules.sort((left, right) => left.path.localeCompare(right.path));
  extra.foundationClosurePaths = extra.foundationClosureModules.map((module) => module.path);
  extra.foundationClosureSha256 = foundationClosureSha256(extra.foundationClosureModules);
  assert.ok(
    validateFoundationClosureEvidence(extra, closure.records).errors.some(
      (error) => error.code === "FOUNDATION-CLOSURE-EXTRA"
    )
  );

  const missing = structuredClone(boundary);
  missing.foundationClosureModules = missing.foundationClosureModules.filter(
    (module) => module.path !== "tools/verify-foundation.mjs"
  );
  missing.foundationClosurePaths = missing.foundationClosureModules.map((module) => module.path);
  missing.foundationClosureSha256 = foundationClosureSha256(missing.foundationClosureModules);
  assert.ok(
    validateFoundationClosureEvidence(missing, closure.records).errors.some(
      (error) => error.code === "FOUNDATION-CLOSURE-MISSING"
    )
  );

  const duplicate = structuredClone(boundary);
  duplicate.foundationClosureModules.push({ ...duplicate.foundationClosureModules[0] });
  duplicate.foundationClosurePaths = duplicate.foundationClosureModules.map((module) => module.path);
  duplicate.foundationClosureSha256 = foundationClosureSha256(duplicate.foundationClosureModules);
  assert.ok(
    validateFoundationClosureEvidence(duplicate).errors.some(
      (error) => error.code === "FOUNDATION-CLOSURE-DUPLICATE"
    )
  );

  const testDrift = structuredClone(boundary);
  testDrift.executedFoundationTests = testDrift.executedFoundationTests.slice(1);
  assert.ok(
    validateFoundationClosureEvidence(testDrift).errors.some(
      (error) => error.code === "FOUNDATION-CLOSURE-EVIDENCE-MISMATCH"
    )
  );
});

test("manifest records 56 files and exactly one authorized modification", async () => {
  const manifest = await json("evidence/source-manifest.json");
  assert.equal(manifest.entries.length, 56);
  assert.equal(manifest.entries.filter((entry) => entry.status === "authorized-modified").length, 1);
  assert.equal(manifest.entries.find((entry) => entry.status === "authorized-modified").path, "package.json");
  assert.equal(manifest.entries.filter((entry) => entry.status === "unchanged").length, 55);
});

test("evidence contract text names candidate binding, command identity and stale rules", async () => {
  const text = await readFile(path.join(root, "evidence", "evidence-contract.md"), "utf8");
  const result = validateEvidenceContractText(text);
  assert.deepEqual(result.errors, []);
});

test("negative: a changed input marks candidate evidence stale", () => {
  const frozen = {
    head: "a",
    tree: "b",
    parent: "c",
    patchSha256: "d",
    patchBytes: 1,
    toolchainId: "e",
    inputs: { contract: "1" },
    commands: { build: "2" }
  };
  const current = structuredClone(frozen);
  current.inputs.contract = "9";
  const result = evidenceStaleness(frozen, current);
  assert.equal(result.stale, true);
  assert.ok(result.reasons.some((reason) => reason.includes("contract")));
});

test("negative: old PASS cannot transfer to a new candidate", () => {
  const frozen = { head: "a", tree: "b", patchSha256: "c", inputs: { contract: "1" } };
  const changed = { head: "a", tree: "b", patchSha256: "z", inputs: { contract: "1" } };
  assert.equal(passTransfersToCandidate(frozen, frozen), true);
  assert.equal(passTransfersToCandidate(frozen, changed), false);
});

test("negative: manifest drift is detected", async () => {
  const identity = await json("evidence/m1-input-identity.json");
  const manifest = await json("evidence/source-manifest.json");
  const hashes = await currentHashes(identity);
  hashes["src/voice-room/runtime.ts"] = "0".repeat(64);
  const result = validateSourceManifest(manifest, identity, hashes);
  assert.ok(result.errors.some((error) => error.code === "EVIDENCE-MANIFEST-STALE"));
});

test("negative: missing tracked path fails identity validation", async () => {
  const identity = await json("evidence/m1-input-identity.json");
  identity.q.baseIdentity.trackedPaths = identity.q.baseIdentity.trackedPaths.slice(1);
  const result = validateIdentity(identity);
  assert.ok(result.errors.some((error) => error.code === "EVIDENCE-Q-PATHS"));
  const cleanClaim = structuredClone(identity);
  cleanClaim.q.worktreeObservation.clean = true;
  assert.ok(
    validateIdentity(cleanClaim).errors.some(
      (error) => error.code === "EVIDENCE-Q-WORKTREE-CLEAN"
    )
  );
});

test("negative: command cwd must be logical and log hash must be present", async () => {
  const records = await json("evidence/command-records.json");
  assert.equal(validateCommandRecords([{ ...records[0], cwd: "Q" }]).ok, true);
  for (const cwd of ["C:\\repo", "D:\\demo\\qq-voice-room", "/repo"]) {
    const result = validateCommandRecords([{ ...records[0], cwd }]);
    assert.ok(result.errors.some((error) => error.code === "EVIDENCE-CWD"));
  }
  const broken = structuredClone(records);
  broken[0].rawLogSha256 = "not-a-hash";
  const result = validateCommandRecords(broken);
  assert.ok(result.errors.some((error) => error.code === "EVIDENCE-LOG-HASH"));
});
