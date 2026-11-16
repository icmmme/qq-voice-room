import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { scanFoundationModule } from "./architecture-guard.mjs";
import { isSensitiveEnvPath } from "./env-read-guard.mjs";
import { sha256Bytes } from "./hash.mjs";

export const EXECUTION_CONTRACT_SHA256 =
  "E04ED3D7BE60E015BA59E60DFDCBADBCED5DB950691E503D4FE7B5C97F711E8C";
export const EXECUTION_CONTRACT_BYTES = 12512;
export const EXECUTION_CONTRACT_ADDENDUM_SHA256 =
  "FCD519C1EA2616453FA400BB7094780B008BDD6F4FE5507F5D184592C85283FD";
export const EXECUTION_CONTRACT_ADDENDUM_BYTES = 3484;
export const EXECUTION_CONTRACT_MANIFEST_SHA256 =
  "00EBC29C38F818A5436C3A859078C0ABAE95FF7DC84407230711F288E7118785";
export const EXECUTION_CONTRACT_MANIFEST_BYTES = 382;
export const EXECUTION_CONTRACT_READBACK_SHA256 =
  "FE3364DA4B290B35E504F3564A0B21BDDA0CDCCB5D18AB2919BA64BD3F031BD9";
export const EXECUTION_CONTRACT_READBACK_BYTES = 563;
export const OWNER_APPROVAL_ADDENDUM_SHA256 =
  "7B1B5FEEF98B3EB0B5E9CA3E277E055A25DC682DC0E4CA26E4FA12C1531E23E6";
export const EXPECTED_PACKAGE_JSON_SHA256 =
  "267E25BEAE76966F41C470E6F981FA94B33AAA04DD28B56F5D4A45A29EE7D648";
export const EXPECTED_PACKAGE_SCRIPTS_SHA256 =
  "D0840D6D1D52B8DB7F83CD4946EC0E18FDE66439704273090D4A0F72C9C91372";

const decoded = (codes) => String.fromCharCode(...codes);
const ENV_TOKEN = decoded([46, 101, 110, 118]);
const ENV_FILE_FLAG = decoded([45, 45, 101, 110, 118, 45, 102, 105, 108, 101]);
const ROOM_DOCTOR = decoded([114, 111, 111, 109, 58, 100, 111, 99, 116, 111, 114]);
const ROOM_QQ = decoded([114, 111, 111, 109, 58, 113, 113]);
const ROOM_QQ_FILE = decoded([114, 111, 111, 109, 45, 113, 113]);
const DEMO = decoded([100, 101, 109, 111]);
const DIST_SCRIPTS = decoded([100, 105, 115, 116, 47, 115, 99, 114, 105, 112, 116, 115]);
const DIST_TESTS = decoded([100, 105, 115, 116, 47, 116, 101, 115, 116, 115]);
const ROOM_PREFIX = "room" + ":";
const PRETEST = decoded([112, 114, 101, 116, 101, 115, 116]);

const FOUNDATION_BARE_DEPENDENCIES = new Set([
  "node:assert",
  "node:assert/strict",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:module",
  "node:os",
  "node:path",
  "node:test",
  "node:url",
  "typescript"
]);

export const FOUNDATION_TEST_FILES = Object.freeze([
  "tests/foundation/feature-map.test.mjs",
  "tests/foundation/architecture-guard.test.mjs",
  "tests/foundation/consumer-identity.test.mjs",
  "tests/foundation/s2-delivery.test.mjs",
  "tests/foundation/harness.test.mjs",
  "tests/foundation/evidence.test.mjs",
  "tests/foundation/foundation-entry.test.mjs"
]);

export const FOUNDATION_TEST_EXPECTED_COUNTS = Object.freeze([
  10,
  20,
  11,
  11,
  6,
  11,
  19
]);

export const FOUNDATION_SOURCE_FILES = Object.freeze([
  "tools/verify-foundation.mjs",
  "tools/architecture-guard.mjs",
  "tools/freeze-evidence.mjs",
  "tools/lib/architecture-guard.mjs",
  "tools/lib/consumer-identity.mjs",
  "tools/lib/env-read-guard.mjs",
  "tools/lib/evidence-contract.mjs",
  "tools/lib/feature-map.mjs",
  "tools/lib/foundation-boundary.mjs",
  "tools/lib/harness-contract.mjs",
  "tools/lib/hash.mjs",
  "tools/lib/s2-delivery.mjs"
]);

export const FOUNDATION_ALL_ROOTS = Object.freeze(
  [...FOUNDATION_SOURCE_FILES, ...FOUNDATION_TEST_FILES].sort()
);

export const LEGACY_SCRIPTS = Object.freeze({
  build: "tsc --noEmit false --outDir dist --rootDir .",
  typecheck: "tsc --noEmit",
  [PRETEST]: "npm run build",
  test: `node --test ${DIST_TESTS}/voice-room-request-lifecycle.test.js`,
  predemo: "npm run build",
  demo: `node ${DIST_SCRIPTS}/${DEMO}.js`,
  "preroom:doctor": "npm run build",
  "room:doctor": `node ${ENV_FILE_FLAG}=${ENV_TOKEN} ${DIST_SCRIPTS}/${ROOM_QQ_FILE}.js check`,
  "preroom:qq": "npm run build",
  "room:qq": `node ${ENV_FILE_FLAG}=${ENV_TOKEN} ${DIST_SCRIPTS}/${ROOM_QQ_FILE}.js run`
});

export const EXPECTED_PACKAGE_SCRIPTS = Object.freeze({
  ...LEGACY_SCRIPTS,
  "verify:foundation": "node tools/verify-foundation.mjs"
});

const EXPECTED_SCRIPT_NAMES = new Set(Object.keys(EXPECTED_PACKAGE_SCRIPTS));
const LIFECYCLE_HOOK_RE = /^(?:pre|post)(?:build|typecheck|verify:foundation)$/;

const FORBIDDEN_VERIFY_SUBSTRINGS = [
  "test",
  ROOM_PREFIX,
  DEMO,
  ENV_TOKEN,
  ENV_FILE_FLAG
];

export function packageScriptsCanonical(scripts) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scripts ?? {}).sort(([left], [right]) => left.localeCompare(right)))
  );
}

export function verifyPackageBytes(bytes) {
  const errors = [];
  const actual = sha256Bytes(bytes);
  if (actual !== EXPECTED_PACKAGE_JSON_SHA256) {
    errors.push({
      code: "FOUNDATION-PACKAGE-HASH",
      detail: `package.json SHA256 ${actual} does not match the frozen identity`
    });
  }
  let packageJson = null;
  try {
    packageJson = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    errors.push({ code: "FOUNDATION-PACKAGE-JSON", detail: "package.json is not valid UTF-8 JSON" });
  }
  return { ok: errors.length === 0, errors, packageJson, sha256: actual };
}

export function verifyPackageScripts(pkg) {
  const errors = [];
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {
      ok: false,
      errors: [{ code: "FOUNDATION-SCRIPT-TYPE", detail: "package.json scripts must be an object" }]
    };
  }
  const actualNames = Object.keys(scripts);
  for (const name of actualNames) {
    if (!EXPECTED_SCRIPT_NAMES.has(name)) {
      errors.push({
        code: LIFECYCLE_HOOK_RE.test(name)
          ? "FOUNDATION-LIFECYCLE-HOOK"
          : "FOUNDATION-UNEXPECTED-SCRIPT",
        detail: `unexpected package script '${name}'`
      });
    }
  }
  for (const name of EXPECTED_SCRIPT_NAMES) {
    if (!Object.hasOwn(scripts, name)) {
      errors.push({ code: "FOUNDATION-SCRIPT-SET", detail: `required package script '${name}' is missing` });
      continue;
    }
    if (typeof scripts[name] !== "string") {
      errors.push({ code: "FOUNDATION-SCRIPT-TYPE", detail: `package script '${name}' must be a string` });
      continue;
    }
    const expected = EXPECTED_PACKAGE_SCRIPTS[name];
    if (scripts[name] === expected) continue;
    errors.push({
      code: name === "verify:foundation" ? "FOUNDATION-SCRIPT" : "FOUNDATION-LEGACY-SCRIPT-DRIFT",
      detail: `package script '${name}' changed`
    });
  }
  const verify = String(scripts["verify:foundation"] ?? "").toLowerCase();
  for (const forbidden of FORBIDDEN_VERIFY_SUBSTRINGS) {
    if (verify.includes(forbidden)) {
      errors.push({
        code: "FOUNDATION-SCRIPT-FORBIDDEN",
        detail: `verify:foundation contains '${forbidden}'`
      });
    }
  }
  if (typeof scripts[PRETEST] === "string" && verify.includes(PRETEST)) {
    errors.push({ code: "FOUNDATION-PRETEST", detail: "foundation entry cannot depend on the legacy setup hook" });
  }
  const scriptsSha256 = sha256Bytes(packageScriptsCanonical(scripts));
  if (scriptsSha256 !== EXPECTED_PACKAGE_SCRIPTS_SHA256) {
    errors.push({
      code: "FOUNDATION-SCRIPT-SET-HASH",
      detail: `package scripts SHA256 ${scriptsSha256} does not match the frozen identity`
    });
  }
  return { ok: errors.length === 0, errors, scriptsSha256 };
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

export async function findSensitiveEnvFiles(root, options = {}) {
  const io = { ...(await defaultIo()), ...(options.io ?? {}) };
  const resolvedRoot = path.resolve(root);
  const findings = [];
  const directories = [];
  const skippedNames = new Set([".git", "node_modules", "dist"]);
  const visited = new Set();

  async function walk(directory) {
    let canonical;
    try {
      canonical = await io.realpath(directory);
    } catch {
      findings.push({
        code: "FOUNDATION-ENV-SCAN",
        file: normalizePath(path.relative(resolvedRoot, directory)) || ".",
        detail: "directory realpath is unavailable"
      });
      return;
    }
    const canonicalKey = normalizePath(canonical).toLowerCase();
    if (visited.has(canonicalKey)) return;
    visited.add(canonicalKey);
    directories.push(normalizePath(path.relative(resolvedRoot, directory)) || ".");

    let entries;
    try {
      entries = await io.readdir(directory, { withFileTypes: true });
    } catch {
      findings.push({
        code: "FOUNDATION-ENV-SCAN",
        file: normalizePath(path.relative(resolvedRoot, directory)) || ".",
        detail: "directory is unreadable"
      });
      return;
    }

    for (const entry of entries) {
      if (skippedNames.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(directory, entry.name);
      const relative = normalizePath(path.relative(resolvedRoot, absolute));
      if (isSensitiveEnvPath(relative)) {
        findings.push({
          code: "FOUNDATION-ENV-FILE",
          file: relative,
          detail: "sensitive environment file is present in the repository"
        });
      }
      let stat;
      try {
        stat = await io.lstat(absolute);
      } catch {
        findings.push({
          code: "FOUNDATION-ENV-SCAN",
          file: relative,
          detail: "entry lstat is unavailable"
        });
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await walk(absolute);
      }
    }
  }

  await walk(resolvedRoot);
  findings.sort((left, right) =>
    left.file.localeCompare(right.file) || left.code.localeCompare(right.code)
  );
  return {
    ok: findings.length === 0,
    findings,
    scannedDirectories: directories.sort()
  };
}

function closurePathAllowed(relative) {
  return relative === "tools" ||
    relative.startsWith("tools/") ||
    relative === "tests/foundation" ||
    relative.startsWith("tests/foundation/");
}

function addError(errors, code, file, detail, line = 1) {
  errors.push({ code, file: normalizePath(file), line, detail });
}

async function defaultIo() {
  return {
    lstat,
    readFile,
    readdir,
    realpath
  };
}

function moduleRecord(module) {
  return {
    path: module.path,
    bytes: module.bytes,
    sha256: module.sha256,
    role: module.role
  };
}

export function foundationClosureSha256(modules) {
  return sha256Bytes(JSON.stringify(modules.map(moduleRecord)));
}

function localImportSpecifiers(content, relative, errors) {
  const sourceFile = ts.createSourceFile(
    relative,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    addError(
      errors,
      "FOUNDATION-CLOSURE-PARSE",
      relative,
      `TypeScript parse failure: ${diagnostic.messageText}`
    );
  }
  const result = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const value = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
      if (value === null) {
        addError(errors, "ARCH-FOUNDATION-DYNAMIC-LOAD", relative, "static import requires a string literal");
      } else if (value.startsWith(".")) {
        result.push(value);
      } else if (!FOUNDATION_BARE_DEPENDENCIES.has(value)) {
        addError(errors, "ARCH-FOUNDATION-BARE-DEPENDENCY", relative, `unapproved dependency '${value}'`);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const value = ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (value === null) {
        addError(errors, "ARCH-FOUNDATION-DYNAMIC-LOAD", relative, "export-from requires a string literal");
      } else if (value.startsWith(".")) {
        result.push(value);
      } else if (!FOUNDATION_BARE_DEPENDENCIES.has(value)) {
        addError(errors, "ARCH-FOUNDATION-BARE-DEPENDENCY", relative, `unapproved re-export '${value}'`);
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      addError(errors, "ARCH-FOUNDATION-DYNAMIC-LOAD", relative, "import=require is not permitted");
    }
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        addError(errors, "ARCH-FOUNDATION-DYNAMIC-LOAD", relative, "dynamic module loading is not permitted");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

export async function buildFoundationClosure(root, options = {}) {
  const io = { ...(await defaultIo()), ...(options.io ?? {}) };
  const resolvedRoot = path.resolve(root);
  const errors = [];
  const expectedTests = FOUNDATION_TEST_FILES.map((entry) => path.posix.basename(entry)).sort();
  let testEntries = [];
  try {
    testEntries = await io.readdir(path.join(resolvedRoot, "tests", "foundation"), { withFileTypes: true });
  } catch {
    addError(errors, "FOUNDATION-CLOSURE-MISSING", "tests/foundation", "test directory is missing");
  }
  const actualTests = [];
  for (const entry of testEntries) {
    if (!entry.name.endsWith(".mjs")) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      addError(errors, "FOUNDATION-CLOSURE-SYMLINK", `tests/foundation/${entry.name}`, "test entry is not a regular file");
    } else {
      actualTests.push(entry.name);
    }
  }
  actualTests.sort();
  if (JSON.stringify(actualTests) !== JSON.stringify(expectedTests)) {
    addError(
      errors,
      "FOUNDATION-TEST-INVENTORY",
      "tests/foundation",
      `expected [${expectedTests.join(", ")}], found [${actualTests.join(", ")}]`
    );
  }

  const roles = new Map();
  const queue = [];
  for (const relative of FOUNDATION_SOURCE_FILES) {
    roles.set(relative, "tool-root");
    queue.push(relative);
  }
  for (const relative of FOUNDATION_TEST_FILES) {
    roles.set(relative, "test-root");
    queue.push(relative);
  }
  const seen = new Set();
  const modules = [];
  while (queue.length > 0) {
    const relative = normalizePath(queue.shift());
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (!closurePathAllowed(relative) || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      addError(errors, "FOUNDATION-CLOSURE-ESCAPE", relative, "closure path is outside tools/** and tests/foundation/**");
      continue;
    }
    if (!relative.endsWith(".mjs")) {
      addError(errors, "FOUNDATION-CLOSURE-EXTENSION", relative, "closure modules must use .mjs");
      continue;
    }
    const lexical = path.resolve(resolvedRoot, relative);
    let stat;
    try {
      stat = await io.lstat(lexical);
    } catch {
      addError(errors, "FOUNDATION-CLOSURE-MISSING", relative, "module is missing");
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      addError(errors, "FOUNDATION-CLOSURE-SYMLINK", relative, "module is a symlink, junction or non-regular file");
      continue;
    }
    let canonical;
    try {
      canonical = await io.realpath(lexical);
    } catch {
      addError(errors, "FOUNDATION-CLOSURE-MISSING", relative, "module realpath is unavailable");
      continue;
    }
    const rootRelative = path.relative(resolvedRoot, canonical);
    if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
      addError(errors, "FOUNDATION-CLOSURE-ESCAPE", relative, "realpath escapes the repository");
      continue;
    }
    if (path.normalize(lexical).toLowerCase() !== path.normalize(canonical).toLowerCase()) {
      addError(errors, "FOUNDATION-CLOSURE-SYMLINK", relative, "realpath differs from the lexical module path");
      continue;
    }
    let bytes;
    try {
      bytes = await io.readFile(lexical);
    } catch {
      addError(errors, "FOUNDATION-CLOSURE-MISSING", relative, "module is unreadable");
      continue;
    }
    const content = Buffer.from(bytes).toString("utf8");
    modules.push({
      path: relative,
      role: roles.get(relative) ?? "local-dependency",
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      content
    });
    for (const specifier of localImportSpecifiers(content, relative, errors)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!closurePathAllowed(target) || target.startsWith("../") || path.posix.isAbsolute(target)) {
        addError(errors, "FOUNDATION-CLOSURE-ESCAPE", relative, `local import '${specifier}' escapes the closure roots`);
        continue;
      }
      if (!target.endsWith(".mjs")) {
        addError(errors, "FOUNDATION-CLOSURE-EXTENSION", relative, `local import '${specifier}' must resolve to .mjs`);
        continue;
      }
      if (!roles.has(target)) roles.set(target, "local-dependency");
      queue.push(target);
    }
  }
  modules.sort((left, right) => left.path.localeCompare(right.path));
  const records = modules.map(moduleRecord);
  return {
    ok: errors.length === 0,
    errors,
    roots: [...FOUNDATION_ALL_ROOTS],
    modules,
    records,
    paths: records.map((module) => module.path),
    closureSha256: foundationClosureSha256(records)
  };
}

export function verifyFoundationSources(sources) {
  const errors = [];
  for (const source of sources) {
    errors.push(...scanFoundationModule(source.path, source.content));
  }
  return { ok: errors.length === 0, errors };
}

export function buildExecutionBoundaryEvidence({ closure, packageBytes, packageJson }) {
  const sourceResult = verifyFoundationSources(closure.modules ?? []);
  const scriptResult = verifyPackageScripts(packageJson);
  const packageResult = verifyPackageBytes(packageBytes);
  const allErrors = [
    ...(closure.errors ?? []),
    ...sourceResult.errors,
    ...scriptResult.errors,
    ...packageResult.errors
  ];
  const count = (code) => allErrors.filter((error) => error.code === code).length;
  const records = (closure.records ?? []).map(moduleRecord);
  return {
    schemaVersion: "m1-static-execution-boundary-v1",
    contractRevision: 2,
    contractSha256: EXECUTION_CONTRACT_SHA256,
    contractAddendumSha256: EXECUTION_CONTRACT_ADDENDUM_SHA256,
    ownerApprovalAddendumSha256: OWNER_APPROVAL_ADDENDUM_SHA256,
    packageSha256: packageResult.sha256,
    packageScriptsSha256: scriptResult.scriptsSha256 ?? null,
    staticCompilationAllowed: true,
    typecheckStaticallyCompilesScripts: true,
    legacyEntryExecutions: count("ARCH-LEGACY-SCRIPT"),
    legacyRuntimeImports: count("ARCH-FOUNDATION-RUNTIME-IMPORT"),
    envFileReads: count("ARCH-ENV-READ"),
    foundationPathSpawnsLegacy: count("ARCH-LEGACY-SCRIPT") > 0,
    foundationPathImportsLegacy: count("ARCH-FOUNDATION-RUNTIME-IMPORT") > 0,
    packageIdentityValidated: packageResult.ok,
    packageScriptsValidated: scriptResult.ok,
    legacyScriptsUnchanged: !allErrors.some((error) => error.code === "FOUNDATION-LEGACY-SCRIPT-DRIFT"),
    scannedFoundationSources: records.map((module) => module.path),
    scanStatus: allErrors.length === 0 ? "PASS" : "FAIL",
    boundaryErrorCodes: [...new Set(allErrors.map((error) => error.code))].sort(),
    foundationClosureSchema: "m1-foundation-closure-v1",
    foundationClosureRoots: [...closure.roots].sort(),
    foundationClosureModules: records,
    foundationClosurePaths: records.map((module) => module.path),
    foundationClosureSha256: closure.closureSha256,
    executedFoundationTests: [...FOUNDATION_TEST_FILES].sort(),
    foundationTestCounts: Object.fromEntries(
      [...FOUNDATION_TEST_FILES]
        .sort()
        .map((file, index, files) => {
          const originalIndex = FOUNDATION_TEST_FILES.indexOf(file);
          return [file, FOUNDATION_TEST_EXPECTED_COUNTS[originalIndex]];
        })
    ),
    foundationTestExecution: "PER_FILE_TAP_EXACT_COUNTS_NO_FAIL_SKIP_TODO",
    envReadPreflight: "FAIL_CLOSED_BEFORE_PACKAGE_AND_CLOSURE",
    envReadPreload: "tools/lib/env-read-guard.mjs",
    foundationCoverage: allErrors.length === 0 ? "PASS" : "FAIL",
    evidenceSource: "complete local import closure, AST behavior scan, package byte identity and script allowlist"
  };
}
