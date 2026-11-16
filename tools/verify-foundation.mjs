#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FOUNDATION_TEST_EXPECTED_COUNTS,
  FOUNDATION_TEST_FILES,
  buildExecutionBoundaryEvidence,
  buildFoundationClosure,
  findSensitiveEnvFiles,
  verifyFoundationSources,
  verifyPackageBytes,
  verifyPackageScripts
} from "./lib/foundation-boundary.mjs";
import { stableJson } from "./lib/hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanMode = process.argv.includes("--clean");

function fail(message, details = []) {
  process.stderr.write(`FOUNDATION FAIL: ${message}\n`);
  for (const detail of details) process.stderr.write(`- ${detail}\n`);
  process.exit(1);
}

function failFindings(findings) {
  fail(
    "foundation static boundary violation",
    findings.map((finding) => `${finding.code}: ${finding.file}:${finding.line}: ${finding.detail}`)
  );
}

function writeChildOutput(label, child) {
  process.stdout.write(`[${label}] exit=${child.status ?? "null"}\n`);
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
}

function childEnvironment() {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME
  };
}

const decoded = (codes) => String.fromCharCode(...codes);
const ENV_TOKEN = decoded([46, 101, 110, 118]);

function parseTapCounts(output) {
  const fields = new Map();
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    fields.set(match[1], Number(match[2]));
  }
  return Object.fromEntries(fields);
}

function verifyTapOutput(label, child, expectedCount) {
  const counts = parseTapCounts(child.stdout ?? "");
  const required = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
  const missing = required.filter((field) => !Number.isInteger(counts[field]));
  if (missing.length > 0) {
    fail(`${label} TAP summary is incomplete`, [`missing: ${missing.join(", ")}`]);
  }
  if (counts.tests !== expectedCount || counts.pass !== expectedCount) {
    fail(
      `${label} TAP count mismatch`,
      [`expected tests=pass=${expectedCount}; found tests=${counts.tests}, pass=${counts.pass}`]
    );
  }
  for (const field of ["fail", "cancelled", "skipped", "todo"]) {
    if (counts[field] !== 0) {
      fail(`${label} TAP ${field} must be zero`, [`found ${field}=${counts[field]}`]);
    }
  }
  process.stdout.write(
    `[${label}] exit=${child.status} tests=${counts.tests} pass=${counts.pass} ` +
    `fail=${counts.fail} skipped=${counts.skipped} todo=${counts.todo}\n`
  );
}

async function main() {
  process.stdout.write(`foundation-mode=${cleanMode ? "CLEAN_AUTHORITATIVE" : "COMPAT_NON_AUTHORITATIVE"}\n`);
  const envScan = await findSensitiveEnvFiles(root);
  if (!envScan.ok) {
    fail(
      "sensitive environment file preflight failed",
      envScan.findings.map((finding) => `${finding.code}: ${finding.file}: ${finding.detail}`)
    );
  }
  process.stdout.write(`[env-preflight] ${envScan.scannedDirectories.length} directories scanned before package/closure\n`);

  const packageBytes = await readFile(path.join(root, "package.json"));
  const packageResult = verifyPackageBytes(packageBytes);
  if (!packageResult.ok) fail("package identity is not frozen", packageResult.errors.map((error) => `${error.code}: ${error.detail}`));
  const scripts = verifyPackageScripts(packageResult.packageJson);
  if (!scripts.ok) {
    fail("package scripts are outside the foundation boundary", scripts.errors.map((error) => `${error.code}: ${error.detail}`));
  }
  process.stdout.write("[package] immutable bytes and exact script set passed\n");

  const closure = await buildFoundationClosure(root);
  if (!closure.ok) {
    fail("foundation import closure is invalid", closure.errors.map((error) => `${error.code}: ${error.file}:${error.line}: ${error.detail}`));
  }
  const sources = verifyFoundationSources(closure.modules);
  if (!sources.ok) failFindings(sources.errors);
  process.stdout.write(`[closure] ${closure.paths.length} modules scanned before execution\n`);

  if (cleanMode) {
    const expectedBoundary = buildExecutionBoundaryEvidence({
      closure,
      packageBytes,
      packageJson: packageResult.packageJson
    });
    const frozenBoundaryText = await readFile(
      path.join(root, "evidence", "static-execution-boundary.json"),
      "utf8"
    );
    let frozenBoundary;
    try {
      frozenBoundary = JSON.parse(frozenBoundaryText);
    } catch {
      fail("frozen execution-boundary evidence is not valid JSON");
    }
    if (stableJson(frozenBoundary) !== stableJson(expectedBoundary)) {
      fail("frozen execution-boundary evidence does not equal the live closure");
    }
    process.stdout.write("[closure-evidence] live closure equals frozen evidence\n");
  }

  if (cleanMode) {
    const freezeCheck = spawnSync(
      process.execPath,
      ["tools/freeze-evidence.mjs", "--check"],
      { cwd: root, encoding: "utf8", env: childEnvironment() }
    );
    writeChildOutput("freeze-check", freezeCheck);
    if (freezeCheck.status !== 0) fail("frozen evidence does not match the working candidate");

    const typecheck = spawnSync(
      process.execPath,
      ["node_modules/typescript/bin/tsc", "--noEmit"],
      { cwd: root, encoding: "utf8", env: childEnvironment() }
    );
    writeChildOutput("typecheck", typecheck);
    if (typecheck.status !== 0) fail("TypeScript typecheck failed");

    const build = spawnSync(
      process.execPath,
      ["node_modules/typescript/bin/tsc", "--noEmit", "false", "--outDir", "dist", "--rootDir", "."],
      { cwd: root, encoding: "utf8", env: childEnvironment() }
    );
    writeChildOutput("build", build);
    if (build.status !== 0) fail("TypeScript build failed");
  }

  const sandbox = await mkdtemp(path.join(os.tmpdir(), "qq-m1-foundation-"));
  const sensitiveRoot = await mkdtemp(path.join(os.tmpdir(), "qq-m1-sensitive-"));
  const sensitiveFile = path.join(sensitiveRoot, ENV_TOKEN);
  await writeFile(sensitiveFile, "PROBE_VALUE=SYNTHETIC_LOAD_ENV_OK\n", "utf8");
  const sandboxEnvironment = {
    ...childEnvironment(),
    TEMP: sandbox,
    TMP: sandbox,
    HOME: sandbox,
    M1_ENV_GUARD_SENSITIVE_FILE: sensitiveFile
  };
  const guardUrl = pathToFileURL(path.join(root, "tools", "lib", "env-read-guard.mjs")).href;
  try {
    for (const [index, testFile] of FOUNDATION_TEST_FILES.entries()) {
      const label = `test:${testFile}`;
      const child = spawnSync(
        process.execPath,
        [
          "--permission",
          "--allow-fs-read", path.join(root, "tools"),
          "--allow-fs-read", path.join(root, "tests"),
          "--allow-fs-read", path.join(root, "src"),
          "--allow-fs-read", path.join(root, "scripts"),
          "--allow-fs-read", path.join(root, "examples"),
          "--allow-fs-read", path.join(root, "evidence"),
          "--allow-fs-read", path.join(root, "docs"),
          "--allow-fs-read", path.join(root, ".harness"),
          "--allow-fs-read", path.join(root, "node_modules", "typescript"),
          "--allow-fs-read", path.join(root, "package.json"),
          "--allow-fs-read", path.join(root, "package-lock.json"),
          "--allow-fs-read", path.join(root, "tsconfig.json"),
          "--allow-fs-read", path.join(root, "AGENTS.md"),
          "--allow-fs-read", path.join(root, "README.md"),
          "--allow-fs-read", path.join(root, ".gitattributes"),
          "--allow-fs-read", path.join(root, ".gitignore"),
          "--allow-fs-read", path.join(root, ".env.example"),
          "--allow-fs-read", sandbox,
          "--allow-fs-write", sandbox,
          "--import", guardUrl,
          "--test-reporter=tap",
          testFile
        ],
        { cwd: root, encoding: "utf8", env: sandboxEnvironment }
      );
      writeChildOutput(label, child);
      if (child.status !== 0) fail(`${label} exited ${child.status ?? "null"}`);
      verifyTapOutput(label, child, FOUNDATION_TEST_EXPECTED_COUNTS[index]);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(sensitiveRoot, { recursive: true, force: true });
  }

  if (cleanMode) process.stdout.write("FOUNDATION CLEAN PASS\n");
  else process.stdout.write("FOUNDATION COMPAT PASS (NON-AUTHORITATIVE)\n");
}

main().catch((error) => fail("unexpected foundation error", [String(error?.message ?? error)]));
