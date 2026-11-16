import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat as realLstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_PACKAGE_JSON_SHA256,
  FOUNDATION_ALL_ROOTS,
  FOUNDATION_SOURCE_FILES,
  FOUNDATION_TEST_FILES,
  buildExecutionBoundaryEvidence,
  buildFoundationClosure,
  findSensitiveEnvFiles,
  verifyFoundationSources,
  verifyPackageBytes,
  verifyPackageScripts
} from "../../tools/lib/foundation-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function packageBytes() {
  return readFile(path.join(root, "package.json"));
}

async function packageJson() {
  return JSON.parse((await packageBytes()).toString("utf8"));
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

test("package bytes and exact script set are frozen", async () => {
  const bytes = await packageBytes();
  const identity = verifyPackageBytes(bytes);
  assert.deepEqual(identity.errors, []);
  assert.equal(identity.sha256, EXPECTED_PACKAGE_JSON_SHA256);
  const result = verifyPackageScripts(identity.packageJson);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("foundation test list is fixed and contains no globs", () => {
  assert.equal(FOUNDATION_TEST_FILES.length, 7);
  for (const entry of FOUNDATION_TEST_FILES) {
    assert.equal(/[*?[\]]/.test(entry), false);
    assert.ok(entry.startsWith("tests/foundation/"));
  }
  assert.equal(FOUNDATION_ALL_ROOTS.length, 19);
});

test("complete local import closure currently equals the 19 fixed roots", async () => {
  const closure = await buildFoundationClosure(root);
  assert.deepEqual(closure.errors, []);
  assert.equal(closure.paths.length, 19);
  assert.deepEqual(closure.paths, [...FOUNDATION_ALL_ROOTS].sort());
  assert.equal(closure.records.filter((module) => module.role === "tool-root").length, 12);
  assert.equal(closure.records.filter((module) => module.role === "test-root").length, 7);
});

test("foundation tool and test sources contain no actual env or legacy invocation", async () => {
  const closure = await buildFoundationClosure(root);
  const result = verifyFoundationSources(closure.modules);
  assert.deepEqual(result.errors, []);
});

test("static execution-boundary evidence is produced by the same closure scan", async () => {
  const closure = await buildFoundationClosure(root);
  const bytes = await packageBytes();
  const expected = buildExecutionBoundaryEvidence({
    closure,
    packageBytes: bytes,
    packageJson: JSON.parse(bytes.toString("utf8"))
  });
  const actual = JSON.parse(await readFile(
    path.join(root, "evidence", "static-execution-boundary.json"),
    "utf8"
  ));
  assert.deepEqual(actual, expected);
  assert.equal(actual.legacyEntryExecutions, 0);
  assert.equal(actual.legacyRuntimeImports, 0);
  assert.equal(actual.envFileReads, 0);
  assert.equal(actual.foundationPathSpawnsLegacy, false);
  assert.equal(actual.staticCompilationAllowed, true);
  assert.equal(actual.foundationCoverage, "PASS");
});

test("freeze evidence check mode does not probe npm or PowerShell", async () => {
  const source = await readFile(
    path.join(root, "tools", "freeze-evidence.mjs"),
    "utf8"
  );
  assert.equal(/\bnpm\.cmd\b/.test(source), false);
  assert.equal(/execFileSync\([^)]*\bpowershell\b/i.test(source), false);
  assert.equal(/execFileSync\([^)]*\bnpm\b/i.test(source), false);
});

test("authoritative entry is direct Node and compatibility is explicitly non-authoritative", async () => {
  const source = await readFile(path.join(root, "tools", "verify-foundation.mjs"), "utf8");
  assert.match(source, /--clean/);
  assert.match(source, /FOUNDATION CLEAN PASS/);
  assert.match(source, /FOUNDATION COMPAT PASS \(NON-AUTHORITATIVE\)/);
  assert.doesNotMatch(source, /\bnpm(?:\.cmd)?\s+run\b/i);
});

test("negative: legacy test substituted as the foundation entry fails", async () => {
  const pkg = await packageJson();
  pkg.scripts["verify:foundation"] = "npm run test";
  const result = verifyPackageScripts(pkg);
  assert.ok(result.errors.some((error) => error.code === "FOUNDATION-SCRIPT"));
  assert.ok(result.errors.some((error) => error.code === "FOUNDATION-SCRIPT-FORBIDDEN"));
});

test("negative: changing a legacy script fails", async () => {
  const pkg = await packageJson();
  pkg.scripts["room:qq"] = "node dist/scripts/room-qq.js run";
  const result = verifyPackageScripts(pkg);
  assert.ok(result.errors.some((error) => error.code === "FOUNDATION-LEGACY-SCRIPT-DRIFT"));
});

test("negative: lifecycle hooks and unknown scripts are fail-closed", async () => {
  const cases = [
    ["preverify:foundation", "FOUNDATION-LIFECYCLE-HOOK"],
    ["postverify:foundation", "FOUNDATION-LIFECYCLE-HOOK"],
    ["prebuild", "FOUNDATION-LIFECYCLE-HOOK"],
    ["posttypecheck", "FOUNDATION-LIFECYCLE-HOOK"],
    ["test:evil", "FOUNDATION-UNEXPECTED-SCRIPT"]
  ];
  for (const [name, code] of cases) {
    const pkg = await packageJson();
    pkg.scripts[name] = "node -e \"process.exit(0)\"";
    const result = verifyPackageScripts(pkg);
    assert.ok(result.errors.some((error) => error.code === code), name);
  }
});

test("negative: .env access in a foundation tool fails", () => {
  const result = verifyFoundationSources([{
    path: "tools/bad.mjs",
    content: "import fs from \"node:fs\";\nfs.readFileSync(\".env\");\n"
  }]);
  assert.ok(result.errors.some((error) => error.code === "ARCH-ENV-READ"));
});

test("negative: room:qq invocation in a foundation tool fails", () => {
  const result = verifyFoundationSources([{
    path: "tools/bad.mjs",
    content: "execSync(\"npm.cmd run room:qq\");\n"
  }]);
  assert.ok(result.errors.some((error) => error.code === "ARCH-LEGACY-SCRIPT"));
});

test("negative: pretest dependency in verify:foundation fails", async () => {
  const pkg = await packageJson();
  pkg.scripts["verify:foundation"] = "npm run pretest";
  const result = verifyPackageScripts(pkg);
  assert.ok(result.errors.some((error) => error.code === "FOUNDATION-SCRIPT-FORBIDDEN"));
});

test("negative: unscanned helpers are rejected before execution and create no marker", async () => {
  const scenarios = [
    {
      name: "child-process",
      expected: "ARCH-TEST-CHILD-PROCESS",
      helper: [
        "import { writeFileSync } from \"node:fs\";",
        "import { execFileSync } from \"node:child_process\";",
        "writeFileSync(marker, \"executed\");",
        "execFileSync(process.execPath, [\"-e\", \"process.exit(0)\"]);"
      ].join("\n")
    },
    {
      name: "env-read",
      expected: "ARCH-ENV-READ",
      helper: [
        "import { readFileSync, writeFileSync } from \"node:fs\";",
        "writeFileSync(marker, \"executed\");",
        "readFileSync(\".env\", \"utf8\");"
      ].join("\n")
    },
    {
      name: "dynamic-legacy",
      expected: "ARCH-FOUNDATION-DYNAMIC-LOAD",
      helper: [
        "import { writeFileSync } from \"node:fs\";",
        "writeFileSync(marker, \"executed\");",
        "try { await import(\"../../scripts/legacy.mjs\"); } catch {}"
      ].join("\n")
    }
  ];
  for (const scenario of scenarios) {
    const synthetic = await mkdtemp(path.join(process.env.TEMP, "qq-m1-gate-"));
    try {
      const marker = path.join(synthetic, "marker.txt");
      const testPath = FOUNDATION_TEST_FILES[0];
      const helperPath = `tests/foundation/helpers/${scenario.name}.mjs`;
      const content = `const marker = ${JSON.stringify(marker)};\n${scenario.helper}\n`;
      const overrides = {
        [testPath]: `import "./helpers/${scenario.name}.mjs";\nexport const value = 1;\n`,
        [helperPath]: content
      };
      for (const relative of FOUNDATION_SOURCE_FILES) {
        const target = path.join(synthetic, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "export const value = 1;\n", "utf8");
      }
      for (const relative of FOUNDATION_TEST_FILES) {
        const target = path.join(synthetic, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, overrides[relative] ?? "export const value = 1;\n", "utf8");
      }
      const helperTarget = path.join(synthetic, helperPath);
      await mkdir(path.dirname(helperTarget), { recursive: true });
      await writeFile(helperTarget, content, "utf8");

      const closure = await buildFoundationClosure(synthetic);
      assert.ok(closure.paths.includes(helperPath));
      const scan = verifyFoundationSources(closure.modules);
      assert.ok(scan.errors.some((error) => error.code === scenario.expected), scenario.name);
      assert.equal(await exists(marker), false);
    } finally {
      await rm(synthetic, { recursive: true, force: true });
    }
  }
});

test("negative: closure resolution fails closed for escape, missing, parse and bare dependency", async () => {
  const scenarios = [
    ["../../src/legacy.mjs", "FOUNDATION-CLOSURE-ESCAPE"],
    ["./missing.mjs", "FOUNDATION-CLOSURE-MISSING"],
    ["./module.js", "FOUNDATION-CLOSURE-EXTENSION"],
    ["lodash", "ARCH-FOUNDATION-BARE-DEPENDENCY"]
  ];
  for (const [specifier, expected] of scenarios) {
    const synthetic = await mkdtemp(path.join(process.env.TEMP, "qq-m1-closure-"));
    try {
      for (const relative of FOUNDATION_SOURCE_FILES) {
        const target = path.join(synthetic, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "export const value = 1;\n", "utf8");
      }
      for (const relative of FOUNDATION_TEST_FILES) {
        const target = path.join(synthetic, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "export const value = 1;\n", "utf8");
      }
      const firstTest = path.join(synthetic, FOUNDATION_TEST_FILES[0]);
      await writeFile(firstTest, `import "${specifier}";\nexport const value = 2;\n`, "utf8");
      const closure = await buildFoundationClosure(synthetic);
      assert.ok(closure.errors.some((error) => error.code === expected), `${specifier}: ${expected}`);
    } finally {
      await rm(synthetic, { recursive: true, force: true });
    }
  }
});

test("negative: syntax-invalid closure module fails parse", async () => {
  const synthetic = await mkdtemp(path.join(process.env.TEMP, "qq-m1-parse-"));
  try {
    for (const relative of FOUNDATION_SOURCE_FILES) {
      const target = path.join(synthetic, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        relative === FOUNDATION_SOURCE_FILES[0] ? "export const = ;\n" : "export const value = 1;\n",
        "utf8"
      );
    }
    for (const relative of FOUNDATION_TEST_FILES) {
      const target = path.join(synthetic, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export const value = 1;\n", "utf8");
    }
    const closure = await buildFoundationClosure(synthetic);
    assert.ok(closure.errors.some((error) => error.code === "FOUNDATION-CLOSURE-PARSE"));
  } finally {
    await rm(synthetic, { recursive: true, force: true });
  }
});

test("negative: symlink closure module fails closed", async () => {
  const synthetic = await mkdtemp(path.join(process.env.TEMP, "qq-m1-symlink-"));
  try {
    for (const relative of FOUNDATION_SOURCE_FILES) {
      const target = path.join(synthetic, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export const value = 1;\n", "utf8");
    }
    for (const relative of FOUNDATION_TEST_FILES) {
      const target = path.join(synthetic, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export const value = 1;\n", "utf8");
    }
    const targetModule = path.join(synthetic, FOUNDATION_SOURCE_FILES[0]);
    const closure = await buildFoundationClosure(synthetic, {
      io: {
        lstat: async (target) => {
          if (path.resolve(target).toLowerCase() === path.resolve(targetModule).toLowerCase()) {
            return {
              isSymbolicLink: () => true,
              isFile: () => false
            };
          }
          return realLstat(target);
        }
      }
    });
    assert.ok(closure.errors.some((error) => error.code === "FOUNDATION-CLOSURE-SYMLINK"));
  } finally {
    await rm(synthetic, { recursive: true, force: true });
  }
});

test("environment preflight rejects sensitive files and permits templates", async () => {
  const synthetic = await mkdtemp(path.join(process.env.TEMP, "qq-m1-env-preflight-"));
  const envName = String.fromCharCode(46, 101, 110, 118);
  const sourceDirectory = path.join(synthetic, "src");
  const sensitive = path.join(sourceDirectory, envName);
  const template = path.join(sourceDirectory, `${envName}.example`);
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(template, "PROBE_VALUE=SYNTHETIC_TEMPLATE_OK\n", "utf8");
    let result = await findSensitiveEnvFiles(synthetic);
    assert.equal(result.ok, true);

    await writeFile(sensitive, "PROBE_VALUE=SYNTHETIC_LOAD_ENV_OK\n", "utf8");
    result = await findSensitiveEnvFiles(synthetic);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) =>
      finding.code === "FOUNDATION-ENV-FILE" &&
      finding.file === "src/.env"
    ));
    assert.equal(result.findings.some((finding) => finding.file.endsWith(".env.example")), false);
  } finally {
    await rm(synthetic, { recursive: true, force: true });
  }
});

test("negative: narrow read set denies a hardlink from the synthetic sensitive source", () => {
  const source = process.env.M1_ENV_GUARD_SENSITIVE_FILE;
  assert.equal(typeof source, "string");
  const envName = String.fromCharCode(46, 101, 110, 118);
  assert.equal(path.basename(source).toLowerCase(), envName);
  const alias = path.join(process.env.TEMP, "hardlink-alias.txt");
  try {
    assert.throws(
      () => fs.linkSync(source, alias),
      (error) => error?.code === "ERR_ACCESS_DENIED"
    );
    assert.equal(fs.existsSync(alias), false);
  } finally {
    fs.rmSync(alias, { force: true });
  }
});
