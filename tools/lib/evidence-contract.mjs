import {
  EXECUTION_CONTRACT_ADDENDUM_SHA256,
  EXECUTION_CONTRACT_MANIFEST_BYTES,
  EXECUTION_CONTRACT_MANIFEST_SHA256,
  EXECUTION_CONTRACT_READBACK_BYTES,
  EXECUTION_CONTRACT_READBACK_SHA256,
  EXECUTION_CONTRACT_SHA256,
  EXPECTED_PACKAGE_JSON_SHA256,
  EXPECTED_PACKAGE_SCRIPTS_SHA256,
  FOUNDATION_ALL_ROOTS,
  FOUNDATION_TEST_FILES,
  FOUNDATION_TEST_EXPECTED_COUNTS,
  OWNER_APPROVAL_ADDENDUM_SHA256,
  foundationClosureSha256
} from "./foundation-boundary.mjs";

const HASH_RE = /^[0-9A-F]{64}$/;
const SHARED_CWD_RE = /^Shared(?:\/[A-Za-z0-9._-]+)+$/;

function isHash(value) {
  return typeof value === "string" && HASH_RE.test(value.toUpperCase());
}

function isLogicalCwd(value) {
  return value === "Q" || value === "P" || SHARED_CWD_RE.test(value ?? "");
}

function add(errors, code, detail) {
  errors.push({ code, detail });
}

export function validateIdentity(identity) {
  const errors = [];
  if (!identity || identity.schemaVersion !== "m1-input-identity-v1") {
    add(errors, "EVIDENCE-IDENTITY-SCHEMA", "schemaVersion must be m1-input-identity-v1");
  }
  if (identity?.task !== "VR-PRODUCT-TAKEOVER-01/M1") {
    add(errors, "EVIDENCE-IDENTITY-TASK", "task identity mismatch");
  }
  const q = identity?.q ?? {};
  const base = q.baseIdentity ?? {};
  if (base.head !== "ec8db7ba6991e4ef61efc949eec6c48968b6ff49") add(errors, "EVIDENCE-Q-HEAD", "Q head mismatch");
  if (base.tree !== "d4fe1d8aee4682823b0bffa9c056f3606295cd67") add(errors, "EVIDENCE-Q-TREE", "Q tree mismatch");
  if (base.parent !== null) add(errors, "EVIDENCE-Q-PARENT", "Q parent must be null for the root commit");
  if (base.trackedCount !== 56) add(errors, "EVIDENCE-Q-COUNT", "Q tracked count must be 56");
  const paths = Array.isArray(base.trackedPaths) ? base.trackedPaths : [];
  if (paths.length !== 56) add(errors, "EVIDENCE-Q-PATHS", "Q tracked path list must contain 56 paths");
  if (new Set(paths).size !== paths.length) add(errors, "EVIDENCE-Q-PATHS-DUP", "Q tracked path list contains duplicates");
  for (const required of ["package.json", "src/voice-room/runtime.ts", "tests/voice-room-request-lifecycle.test.ts"]) {
    if (!paths.includes(required)) add(errors, "EVIDENCE-Q-PATHS-MISSING", `${required} missing from tracked paths`);
  }
  if (q.status !== undefined || q.startStatusEvidence !== undefined) {
    add(errors, "EVIDENCE-Q-LEGACY-STATUS", "Q identity must not conflate immutable base identity with worktree status");
  }
  const observation = q.worktreeObservation ?? {};
  if (observation.observationSource !== "git status --porcelain=v1 --untracked-files=normal") {
    add(errors, "EVIDENCE-Q-WORKTREE-SOURCE", "worktree observation source mismatch");
  }
  if (observation.head !== base.head || observation.tree !== base.tree) {
    add(errors, "EVIDENCE-Q-WORKTREE-BASE", "worktree observation must still point at the bound base HEAD/tree");
  }
  if (observation.stagedCount !== 0 || !Array.isArray(observation.stagedEntries) || observation.stagedEntries.length !== 0) {
    add(errors, "EVIDENCE-Q-WORKTREE-STAGED", "worktree observation must record zero staged entries");
  }
  if (JSON.stringify(observation.modifiedTrackedPaths) !== JSON.stringify(["package.json"])) {
    add(errors, "EVIDENCE-Q-WORKTREE-MODIFIED", "worktree observation must record exactly package.json as modified");
  }
  if (observation.untrackedCount !== 6) {
    add(errors, "EVIDENCE-Q-WORKTREE-UNTRACKED", "worktree observation must record six untracked entries");
  }
  if (
    JSON.stringify(observation.untrackedEntries) !==
    JSON.stringify([".harness/", "AGENTS.md", "docs/", "evidence/", "tests/foundation/", "tools/"])
  ) {
    add(errors, "EVIDENCE-Q-WORKTREE-UNTRACKED", "worktree untracked entry names do not match the observed worktree");
  }
  if (observation.clean !== false) {
    add(errors, "EVIDENCE-Q-WORKTREE-CLEAN", "worktree observation must not claim the development worktree is clean");
  }
  if (identity?.p?.readOnly !== true) add(errors, "EVIDENCE-P-READONLY", "P must be read-only");
  if (identity?.p?.head !== "442b34a286376ddd2457f93160e05dda89a99fd8") add(errors, "EVIDENCE-P-HEAD", "P head mismatch");
  if (identity?.p?.tree !== "0ff7d0dd57ed219849e82c320ed71305429e2cb6") add(errors, "EVIDENCE-P-TREE", "P tree mismatch");

  const inputs = identity?.inputs ?? {};
  for (const key of [
    "executionContract",
    "executionContractManifest",
    "executionContractReadback",
    "executionContractAddendum",
    "ownerApprovalAddendum",
    "ownerApproval",
    "implementationPlan",
    "featureMapPlanning",
    "s2DeliveryContract",
    "consumerIdentityRevision",
    "protectedAssetManifest"
  ]) {
    if (!inputs[key] || !isHash(inputs[key].sha256)) {
      add(errors, "EVIDENCE-INPUT-HASH", `${key} requires a SHA256`);
    }
  }
  if (inputs.executionContract?.sha256 !== EXECUTION_CONTRACT_SHA256) {
    add(errors, "EVIDENCE-CONTRACT-HASH", "execution contract hash mismatch");
  }
  if (inputs.executionContract?.bytes !== 12512) {
    add(errors, "EVIDENCE-CONTRACT-BYTES", "execution contract byte count mismatch");
  }
  if (inputs.executionContractManifest?.sha256 !== EXECUTION_CONTRACT_MANIFEST_SHA256) {
    add(errors, "EVIDENCE-CONTRACT-MANIFEST", "execution contract manifest hash mismatch");
  }
  if (inputs.executionContractManifest?.bytes !== EXECUTION_CONTRACT_MANIFEST_BYTES) {
    add(errors, "EVIDENCE-CONTRACT-MANIFEST-BYTES", "execution contract manifest byte count mismatch");
  }
  if (inputs.executionContractReadback?.sha256 !== EXECUTION_CONTRACT_READBACK_SHA256) {
    add(errors, "EVIDENCE-CONTRACT-READBACK", "execution contract readback hash mismatch");
  }
  if (inputs.executionContractReadback?.bytes !== EXECUTION_CONTRACT_READBACK_BYTES) {
    add(errors, "EVIDENCE-CONTRACT-READBACK-BYTES", "execution contract readback byte count mismatch");
  }
  if (inputs.executionContractAddendum?.sha256 !== EXECUTION_CONTRACT_ADDENDUM_SHA256) {
    add(errors, "EVIDENCE-CONTRACT-ADDENDUM", "execution contract addendum hash mismatch");
  }
  if (inputs.executionContractAddendum?.bytes !== 3484) {
    add(errors, "EVIDENCE-CONTRACT-ADDENDUM-BYTES", "execution contract addendum byte count mismatch");
  }
  if (inputs.ownerApprovalAddendum?.sha256 !== OWNER_APPROVAL_ADDENDUM_SHA256) {
    add(errors, "EVIDENCE-APPROVAL-ADDENDUM", "owner addendum approval hash mismatch");
  }
  if (inputs.ownerApproval?.sha256 !== "4B300AF089B99E5AAD365EBE3D65A6B5652498C567A1F77B21269887CAE27D1D") {
    add(errors, "EVIDENCE-APPROVAL-HASH", "owner approval hash mismatch");
  }
  if (inputs.implementationPlan?.sha256 !== "FC05273CAC123007A18F86F849E40CA1741863BB5146D0C478B5CC304B096560") {
    add(errors, "EVIDENCE-PLAN-HASH", "implementation plan hash mismatch");
  }
  if (!identity?.toolchain?.node || !identity?.toolchain?.npm || !identity?.toolchain?.git) {
    add(errors, "EVIDENCE-TOOLCHAIN", "toolchain identity is incomplete");
  }
  return { ok: errors.length === 0, errors };
}

export function validateSourceManifest(manifest, identity, currentHashes = null) {
  const errors = [];
  if (manifest?.schemaVersion !== "m1-source-manifest-v1") {
    add(errors, "EVIDENCE-MANIFEST-SCHEMA", "source manifest schema mismatch");
  }
  if (manifest?.baseTree !== "d4fe1d8aee4682823b0bffa9c056f3606295cd67") {
    add(errors, "EVIDENCE-MANIFEST-TREE", "source manifest base tree mismatch");
  }
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  if (entries.length !== 56) add(errors, "EVIDENCE-MANIFEST-COUNT", "source manifest must contain 56 entries");
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) add(errors, "EVIDENCE-MANIFEST-DUP", "duplicate manifest paths");
  const identityPaths = identity?.q?.baseIdentity?.trackedPaths ?? [];
  if (identityPaths.length === 56) {
    const expected = new Set(identityPaths);
    for (const entryPath of paths) if (!expected.has(entryPath)) add(errors, "EVIDENCE-MANIFEST-UNLISTED", `${entryPath} is not a tracked Q path`);
    for (const expectedPath of expected) if (!paths.includes(expectedPath)) add(errors, "EVIDENCE-MANIFEST-MISSING", `${expectedPath} is missing from the manifest`);
  }

  const modified = entries.filter((entry) => entry.status === "authorized-modified");
  const unauthorized = entries.filter((entry) => entry.status === "UNAUTHORIZED_MODIFIED");
  if (unauthorized.length > 0) add(errors, "EVIDENCE-MANIFEST-UNAUTHORIZED", `${unauthorized.length} unauthorized modifications`);
  if (modified.length !== 1 || modified[0]?.path !== "package.json") {
    add(errors, "EVIDENCE-MANIFEST-MODIFIED-SET", "only package.json may be authorized-modified");
  }
  for (const entry of entries) {
    if (!isHash(entry.baseSha256) || !isHash(entry.currentSha256)) {
      add(errors, "EVIDENCE-MANIFEST-HASH", `${entry.path} has an invalid hash`);
    }
    if (entry.status === "unchanged" && entry.baseSha256 !== entry.currentSha256) {
      add(errors, "EVIDENCE-MANIFEST-DRIFT", `${entry.path} is marked unchanged but hashes differ`);
    }
    if (currentHashes && currentHashes[entry.path] && currentHashes[entry.path] !== entry.currentSha256) {
      add(errors, "EVIDENCE-MANIFEST-STALE", `${entry.path} current hash does not match the frozen manifest`);
    }
  }
  if (modified[0] && !String(modified[0].treatment ?? "").includes("verify:foundation")) {
    add(errors, "EVIDENCE-MANIFEST-TREATMENT", "package.json treatment must name verify:foundation");
  }

  const protectedAssets = manifest?.protectedAssets ?? {};
  if (
    protectedAssets.groupCounts?.P !== 8 ||
    protectedAssets.groupCounts?.M !== 15 ||
    protectedAssets.groupCounts?.D !== 71 ||
    protectedAssets.groupCounts?.H !== 10 ||
    protectedAssets.total !== 104
  ) {
    add(errors, "EVIDENCE-PROTECTED-COUNTS", "protected asset groups must be P8/M15/D71/H10 = 104");
  }
  if (!Array.isArray(protectedAssets.pAssets) || protectedAssets.pAssets.length !== 8) {
    add(errors, "EVIDENCE-PROTECTED-P", "eight P protected assets are required");
  }
  if (manifest?.noPContentCopied !== true) add(errors, "EVIDENCE-P-COPY", "manifest must state no P content was copied");
  const legacy = Array.isArray(manifest?.legacyWebAssets) ? manifest.legacyWebAssets : [];
  if (legacy.length !== 3 || legacy.some((asset) => asset.evidenceAllowedForVR_EXT_WEB_001 !== false)) {
    add(errors, "EVIDENCE-LEGACY-WEB", "three legacy Web assets must be non-evidence");
  }
  return { ok: errors.length === 0, errors };
}

export function validateCommandRecords(records, logHashes = null) {
  const errors = [];
  if (!Array.isArray(records) || records.length === 0) {
    add(errors, "EVIDENCE-COMMANDS", "command records are required");
    return { ok: false, errors };
  }
  const ids = new Set();
  for (const record of records) {
    if (!record.commandId || ids.has(record.commandId)) add(errors, "EVIDENCE-COMMAND-ID", "commandId must be unique and present");
    ids.add(record.commandId);
    if (!record.command) add(errors, "EVIDENCE-COMMAND", `${record.commandId} command missing`);
    if (!isLogicalCwd(record.cwd)) {
      add(errors, "EVIDENCE-CWD", `${record.commandId} cwd must be Q, P or Shared/... logical ID`);
    }
    if (!Number.isInteger(record.exitCode)) add(errors, "EVIDENCE-EXIT", `${record.commandId} exitCode must be an integer`);
    if (!isHash(record.rawLogSha256)) add(errors, "EVIDENCE-LOG-HASH", `${record.commandId} rawLogSha256 invalid`);
    if (logHashes && logHashes[record.commandId] && logHashes[record.commandId] !== record.rawLogSha256) {
      add(errors, "EVIDENCE-LOG-STALE", `${record.commandId} raw log hash does not match`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateFoundationClosureEvidence(evidence, liveModules = null) {
  const errors = [];
  const expectedRoots = [...FOUNDATION_ALL_ROOTS].sort();
  if (evidence?.foundationClosureSchema !== "m1-foundation-closure-v1") {
    add(errors, "EVIDENCE-CLOSURE-SCHEMA", "foundation closure schema mismatch");
  }
  if (JSON.stringify(evidence?.foundationClosureRoots) !== JSON.stringify(expectedRoots)) {
    add(errors, "EVIDENCE-CLOSURE-ROOTS", "foundation closure roots are not the exact 19 fixed roots");
  }
  const modules = Array.isArray(evidence?.foundationClosureModules)
    ? evidence.foundationClosureModules
    : [];
  const paths = modules.map((module) => module?.path);
  if (new Set(paths).size !== paths.length) add(errors, "FOUNDATION-CLOSURE-DUPLICATE", "closure paths contain duplicates");
  if (!Array.isArray(evidence?.foundationClosurePaths) || JSON.stringify(evidence.foundationClosurePaths) !== JSON.stringify(paths)) {
    add(errors, "EVIDENCE-CLOSURE-PATHS", "foundationClosurePaths must equal module paths");
  }
  for (const testPath of FOUNDATION_TEST_FILES) {
    if (!paths.includes(testPath)) add(errors, "EVIDENCE-CLOSURE-TESTS", `${testPath} is missing from the closure`);
  }
  const roleSet = new Set(["tool-root", "test-root", "local-dependency"]);
  for (const module of modules) {
    if (typeof module?.path !== "string" || !module.path.endsWith(".mjs")) {
      add(errors, "EVIDENCE-CLOSURE-PATH", "closure module path is invalid");
    }
    if (!Number.isInteger(module?.bytes) || module.bytes < 0) {
      add(errors, "EVIDENCE-CLOSURE-BYTES", `${module?.path ?? "unknown"} byte count is invalid`);
    }
    if (!isHash(module?.sha256)) {
      add(errors, "EVIDENCE-CLOSURE-HASH", `${module?.path ?? "unknown"} hash is invalid`);
    }
    if (!roleSet.has(module?.role)) {
      add(errors, "EVIDENCE-CLOSURE-ROLE", `${module?.path ?? "unknown"} role is invalid`);
    }
  }
  const expectedHash = foundationClosureSha256(modules);
  if (evidence?.foundationClosureSha256 !== expectedHash) {
    add(errors, "EVIDENCE-CLOSURE-HASH", "foundation closure aggregate hash mismatch");
  }
  if (JSON.stringify(evidence?.executedFoundationTests) !== JSON.stringify([...FOUNDATION_TEST_FILES].sort())) {
    add(errors, "FOUNDATION-CLOSURE-EVIDENCE-MISMATCH", "executedFoundationTests must equal the frozen seven tests");
  }
  const expectedCounts = Object.fromEntries(
    [...FOUNDATION_TEST_FILES]
      .sort()
      .map((file) => [file, FOUNDATION_TEST_EXPECTED_COUNTS[FOUNDATION_TEST_FILES.indexOf(file)]])
  );
  if (JSON.stringify(evidence?.foundationTestCounts) !== JSON.stringify(expectedCounts)) {
    add(errors, "EVIDENCE-TEST-COUNTS", "foundationTestCounts must match the fixed per-file counts");
  }
  if (evidence?.foundationTestExecution !== "PER_FILE_TAP_EXACT_COUNTS_NO_FAIL_SKIP_TODO") {
    add(errors, "EVIDENCE-TEST-EXECUTION", "foundation test execution mode is not the fixed per-file TAP contract");
  }
  if (evidence?.envReadPreflight !== "FAIL_CLOSED_BEFORE_PACKAGE_AND_CLOSURE") {
    add(errors, "EVIDENCE-ENV-PREFLIGHT", "environment-file preflight order is not frozen");
  }
  if (evidence?.envReadPreload !== "tools/lib/env-read-guard.mjs") {
    add(errors, "EVIDENCE-ENV-PRELOAD", "environment-file preload identity is not frozen");
  }
  if (evidence?.foundationCoverage !== "PASS") {
    add(errors, "EVIDENCE-CLOSURE-COVERAGE", "foundationCoverage must be PASS");
  }
  if (liveModules) {
    const live = liveModules.map((module) => ({
      path: module.path,
      bytes: module.bytes,
      sha256: module.sha256,
      role: module.role
    })).sort((left, right) => left.path.localeCompare(right.path));
    const extra = paths.filter((modulePath) => !live.some((module) => module.path === modulePath));
    const missing = live.filter((module) => !paths.includes(module.path)).map((module) => module.path);
    for (const modulePath of extra) add(errors, "FOUNDATION-CLOSURE-EXTRA", `${modulePath} is not in the live closure`);
    for (const modulePath of missing) add(errors, "FOUNDATION-CLOSURE-MISSING", `${modulePath} is missing from evidence`);
    if (JSON.stringify(modules) !== JSON.stringify(live)) {
      add(errors, "FOUNDATION-CLOSURE-EVIDENCE-MISMATCH", "closure records do not match the live modules");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateStaticExecutionBoundary(evidence, liveModules = null) {
  const errors = [];
  const expected = {
    schemaVersion: "m1-static-execution-boundary-v1",
    contractRevision: 2,
    contractSha256: EXECUTION_CONTRACT_SHA256,
    contractAddendumSha256: EXECUTION_CONTRACT_ADDENDUM_SHA256,
    ownerApprovalAddendumSha256: OWNER_APPROVAL_ADDENDUM_SHA256,
    packageSha256: EXPECTED_PACKAGE_JSON_SHA256,
    packageScriptsSha256: EXPECTED_PACKAGE_SCRIPTS_SHA256,
    staticCompilationAllowed: true,
    typecheckStaticallyCompilesScripts: true,
    legacyEntryExecutions: 0,
    legacyRuntimeImports: 0,
    envFileReads: 0,
    foundationPathSpawnsLegacy: false,
    foundationPathImportsLegacy: false,
    packageIdentityValidated: true,
    packageScriptsValidated: true,
    legacyScriptsUnchanged: true,
    scanStatus: "PASS"
  };
  for (const [key, value] of Object.entries(expected)) {
    if (evidence?.[key] !== value) {
      add(errors, "EVIDENCE-EXECUTION-BOUNDARY", `${key} must be ${JSON.stringify(value)}`);
    }
  }
  if (!Array.isArray(evidence?.scannedFoundationSources) || evidence.scannedFoundationSources.length === 0) {
    add(errors, "EVIDENCE-EXECUTION-SOURCES", "scannedFoundationSources must be a non-empty array");
  }
  if (JSON.stringify(evidence?.scannedFoundationSources) !== JSON.stringify(evidence?.foundationClosurePaths)) {
    add(errors, "EVIDENCE-EXECUTION-SOURCES", "scannedFoundationSources must equal the complete closure paths");
  }
  if (!Array.isArray(evidence?.boundaryErrorCodes) || evidence.boundaryErrorCodes.length !== 0) {
    add(errors, "EVIDENCE-EXECUTION-ERRORS", "boundaryErrorCodes must be empty");
  }
  errors.push(...validateFoundationClosureEvidence(evidence, liveModules).errors);
  return { ok: errors.length === 0, errors };
}

export function evidenceStaleness(frozen, current) {
  const reasons = [];
  for (const field of ["head", "tree", "parent", "patchSha256", "patchBytes", "toolchainId"]) {
    if (frozen?.[field] !== current?.[field]) reasons.push(`${field} differs`);
  }
  const frozenInputs = frozen?.inputs ?? {};
  const currentInputs = current?.inputs ?? {};
  for (const key of new Set([...Object.keys(frozenInputs), ...Object.keys(currentInputs)])) {
    if (frozenInputs[key] !== currentInputs[key]) reasons.push(`input ${key} differs`);
  }
  const frozenCommands = frozen?.commands ?? {};
  const currentCommands = current?.commands ?? {};
  for (const key of new Set([...Object.keys(frozenCommands), ...Object.keys(currentCommands)])) {
    if (frozenCommands[key] !== currentCommands[key]) reasons.push(`command log ${key} differs`);
  }
  return { stale: reasons.length > 0, reasons };
}

export function passTransfersToCandidate(frozen, current) {
  return (
    frozen?.patchSha256 === current?.patchSha256 &&
    frozen?.head === current?.head &&
    frozen?.tree === current?.tree &&
    JSON.stringify(frozen?.inputs ?? {}) === JSON.stringify(current?.inputs ?? {})
  );
}

export function validateEvidenceContractText(text) {
  const errors = [];
  for (const [needle, code] of [
    ["candidate identity", "EVIDENCE-DOC-CANDIDATE"],
    ["cwd", "EVIDENCE-DOC-CWD"],
    ["exit code", "EVIDENCE-DOC-EXIT"],
    ["raw-log SHA256", "EVIDENCE-DOC-LOG"],
    ["stale", "EVIDENCE-DOC-STALE"],
    ["old PASS", "EVIDENCE-DOC-TRANSFER"],
    ["review checklist", "EVIDENCE-DOC-CHECKLIST"]
  ]) {
    if (!text.toLowerCase().includes(needle.toLowerCase())) {
      errors.push({ code, detail: `evidence contract is missing '${needle}'` });
    }
  }
  return { ok: errors.length === 0, errors };
}
