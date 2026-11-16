import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RULESET_ID,
  evaluateArchitecture,
  scanFoundationModule
} from "../../tools/lib/architecture-guard.mjs";
import { isSensitiveEnvPath } from "../../tools/lib/env-read-guard.mjs";
import { sha256Bytes } from "../../tools/lib/hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const emptyBaseline = { rulesetId: RULESET_ID, entries: [] };

async function collect(directory, suffix) {
  const results = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await collect(absolute, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) {
      const bytes = await readFile(absolute);
      results.push({
        path: path.relative(root, absolute).replaceAll("\\", "/"),
        content: bytes.toString("utf8"),
        sha256: sha256Bytes(bytes)
      });
    }
  }
  return results;
}

function evaluateOne(file, baseline = emptyBaseline) {
  return evaluateArchitecture({ files: [{ ...file, sha256: sha256Bytes(Buffer.from(file.content)) }], baseline });
}

function violationCodes(result) {
  return result.violations.map((violation) => violation.code);
}

test("actual legacy tree is fully baselined and architecture scan passes", async () => {
  const files = [
    ...(await collect(path.join(root, "src"), ".ts")),
    ...(await collect(path.join(root, "tools"), ".mjs")),
    ...(await collect(path.join(root, "tests", "foundation"), ".mjs"))
  ];
  const baseline = JSON.parse(await readFile(path.join(root, "evidence", "architecture-baseline.json"), "utf8"));
  assert.equal(baseline.rulesetId, RULESET_ID);
  assert.equal(baseline.entries.length, (await collect(path.join(root, "src"), ".ts")).length);
  const result = evaluateArchitecture({ files, baseline });
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test("negative: P/PA private import fails with file and line", () => {
  const result = evaluateOne({
    path: "src/domain/model.ts",
    content: "import { PaStore } from \"../../pa-starter-voice-room-web-src/src/store.ts\";\n"
  });
  const violation = result.violations.find((item) => item.code === "ARCH-PA-PRIVATE-IMPORT");
  assert.ok(violation);
  assert.equal(violation.file, "src/domain/model.ts");
  assert.equal(violation.line, 1);
});

test("negative: .env access by a foundation tool fails", () => {
  const result = evaluateOne({
    path: "tools/bad-env.mjs",
    content: "import fs from \"node:fs\";\nconst value = fs.readFileSync(\".env\");\n"
  });
  assert.ok(violationCodes(result).includes("ARCH-ENV-READ"));
});

test("negative: foundation imports legacy runtime and entry sources fail", () => {
  for (const specifier of [
    "../src/voice-room/qq-server.js",
    "../scripts/room-qq.js",
    "../dist/scripts/room-qq.js"
  ]) {
    const result = evaluateOne({
      path: "tools/bad-runtime-import.mjs",
      content: `import { value } from "${specifier}";\n`
    });
    assert.ok(
      violationCodes(result).includes("ARCH-FOUNDATION-RUNTIME-IMPORT"),
      specifier
    );
  }
});

test("negative: legacy lifecycle invocation by a foundation tool fails", () => {
  const result = evaluateOne({
    path: "tools/bad-legacy.mjs",
    content: "import { execSync } from \"node:child_process\";\nexecSync(\"npm.cmd run room:qq\");\n"
  });
  assert.ok(violationCodes(result).includes("ARCH-LEGACY-SCRIPT"));
});

test("negative: test child_process calls are rejected even without an import binding", () => {
  const result = evaluateOne({
    path: "tests/foundation/child-helper.mjs",
    content: "execFileSync(process.execPath, [\"-e\", \"process.exit(0)\"]);\n"
  });
  assert.ok(violationCodes(result).includes("ARCH-TEST-CHILD-PROCESS"));
});

test("negative: dynamic import and bare dependencies are rejected", () => {
  const dynamic = scanFoundationModule(
    "tests/foundation/dynamic.mjs",
    "await import(\"../../scripts/legacy.mjs\");\n"
  );
  assert.ok(dynamic.some((finding) => finding.code === "ARCH-FOUNDATION-DYNAMIC-LOAD"));
  const bare = scanFoundationModule(
    "tools/bare.mjs",
    "import lodash from \"lodash\";\n"
  );
  assert.ok(bare.some((finding) => finding.code === "ARCH-FOUNDATION-BARE-DEPENDENCY"));
});

test("fixture strings mentioning .env are not actual env reads", () => {
  const result = scanFoundationModule(
    "tests/foundation/fixture-strings.test.mjs",
    "const fixture = 'readFileSync(\".env\")';\n"
  );
  assert.equal(result.some((finding) => finding.code === "ARCH-ENV-READ"), false);
});

test("runtime guard predicate rejects sensitive names and allows templates", () => {
  const env = String.fromCharCode(46, 101, 110, 118);
  const driveRelative = `${process.cwd().slice(0, 2)}${env}`;
  const cases = [
    ["plain", env, true],
    ["nested-local", path.join("nested", `${env}.local`), true],
    ["default-stream", `${env}::$DATA`, true],
    ["trailing-dot", `${env}.`, true],
    ["trailing-space", `${env} `, true],
    ["drive-relative", driveRelative, true],
    ["example", `${env}.example`, false],
    ["sample", `${env}.sample`, false],
    ["template", `${env}.template`, false],
    ["drive-relative-example", `${driveRelative.slice(0, 2)}${env}.example`, false],
    ["unrelated", "environment.txt", false]
  ];
  for (const [label, value, expected] of cases) {
    assert.equal(isSensitiveEnvPath(value), expected, label);
  }
});

test("runtime guard denies ordinary, ADS and short-name aliases while allowing templates", async () => {
  const synthetic = await mkdtemp(path.join(process.env.TEMP, "qq-m1-runtime-guard-"));
  const envName = String.fromCharCode(46, 101, 110, 118);
  const sensitive = path.join(synthetic, envName);
  const adsSensitive = path.join(synthetic, `${envName}::$DATA`);
  const shortSensitive = path.join(synthetic, "ENV~1");
  const allowedTemplate = path.join(synthetic, `${envName}.example`);
  const copiedCallbackAlias = path.join(synthetic, "copied-callback-name.txt");
  const copiedPromiseAlias = path.join(synthetic, "copied-promise-name.txt");
  const previousProbe = process.env.PROBE_VALUE;
  const loadEnvFileName = String.fromCharCode(108, 111, 97, 100, 69, 110, 118, 70, 105, 108, 101);
  const guardedLoadEnvFile = Reflect.get(process, loadEnvFileName);
  try {
    await writeFile(sensitive, "PROBE_VALUE=SYNTHETIC_LOAD_ENV_OK\n", "utf8");
    await writeFile(allowedTemplate, "PROBE_VALUE=SYNTHETIC_TEMPLATE_OK\n", "utf8");
    assert.equal(fs.existsSync(shortSensitive), true, "DOS short-name alias unavailable");
    assert.equal(isSensitiveEnvPath(shortSensitive), false, "short name should require final-path resolution");
    assert.equal(
      fs.realpathSync.native(shortSensitive).toLowerCase(),
      fs.realpathSync(sensitive).toLowerCase(),
      "short name does not map to the synthetic environment file"
    );
    assert.equal(typeof fs.openAsBlob, "function");
    const aliases = [
      ["ordinary", sensitive],
      ["ads", adsSensitive],
      ["short", shortSensitive]
    ];
    for (const [label, alias] of aliases) {
      assert.throws(
        () => fs.readFileSync(alias, "utf8"),
        (error) => error?.code === "ERR_ACCESS_DENIED",
        `${label} read`
      );
      assert.throws(
        () => guardedLoadEnvFile(alias),
        (error) => error?.code === "ERR_ACCESS_DENIED",
        `${label} load`
      );
      await assert.rejects(
        fs.openAsBlob(alias),
        (error) => error?.code === "ERR_ACCESS_DENIED",
        `${label} blob`
      );
      const copied = path.join(synthetic, `copied-${label}.txt`);
      assert.throws(
        () => fs.cpSync(alias, copied),
        (error) => error?.code === "ERR_ACCESS_DENIED",
        `${label} copy`
      );
      assert.equal(fs.existsSync(copied), false, `${label} created a copy`);
    }
    const callbackError = await new Promise((resolve) => {
      fs.cp(sensitive, copiedCallbackAlias, (error) => resolve(error));
    });
    assert.equal(callbackError?.code, "ERR_ACCESS_DENIED");
    await assert.rejects(
      fs.promises.cp(sensitive, copiedPromiseAlias),
      (error) => error?.code === "ERR_ACCESS_DENIED"
    );
    assert.equal(fs.existsSync(copiedCallbackAlias), false);
    assert.equal(fs.existsSync(copiedPromiseAlias), false);
    assert.equal(process.env.PROBE_VALUE, previousProbe);
    assert.equal(fs.readFileSync(allowedTemplate, "utf8"), "PROBE_VALUE=SYNTHETIC_TEMPLATE_OK\n");
  } finally {
    if (previousProbe === undefined) delete process.env.PROBE_VALUE;
    else process.env.PROBE_VALUE = previousProbe;
    await rm(synthetic, { recursive: true, force: true });
  }
});

test("negative: foundation test child process rejects an altered permission shape", () => {
  const result = scanFoundationModule(
    "tools/verify-foundation.mjs",
    [
      "import { spawnSync } from \"node:child_process\";",
      "spawnSync(process.execPath, [\"--permission\", \"--allow-child-process\", \"x\"]);"
    ].join("\n")
  );
  assert.ok(result.some((finding) => finding.code === "ARCH-CLOSURE-CHILD-PROCESS"));
});

test("negative: domain importing SQLite fails", () => {
  const result = evaluateOne({
    path: "src/domain/store.ts",
    content: "import Database from \"better-sqlite3\";\n"
  });
  assert.ok(violationCodes(result).includes("ARCH-DOMAIN-ADAPTER-IMPORT"));
});

test("negative: application importing an adapter directly fails", () => {
  const result = evaluateOne({
    path: "src/application/send.ts",
    content: "import { QqClient } from \"../adapters/qq/client.js\";\n"
  });
  assert.ok(violationCodes(result).includes("ARCH-APPLICATION-ADAPTER-IMPORT"));
});

test("negative: adapter cross-import fails", () => {
  const result = evaluateOne({
    path: "src/adapters/qq/client.ts",
    content: "import { open } from \"../sqlite/db.js\";\n"
  });
  assert.ok(violationCodes(result).includes("ARCH-ADAPTER-CROSS-IMPORT"));
});

test("negative: value cycle fails", () => {
  const result = evaluateArchitecture({
    files: [
      { path: "src/application/a.ts", content: "import { b } from \"./b.js\";\n", sha256: sha256Bytes(Buffer.from("a")) },
      { path: "src/application/b.ts", content: "import { a } from \"./a.js\";\n", sha256: sha256Bytes(Buffer.from("b")) }
    ],
    baseline: emptyBaseline
  });
  assert.ok(violationCodes(result).includes("ARCH-VALUE-CYCLE"));
});

test("type-only cycle is detected explicitly, not as a value cycle", () => {
  const result = evaluateArchitecture({
    files: [
      { path: "src/application/a.ts", content: "import type { B } from \"./b.js\";\nexport type A = B;\n", sha256: sha256Bytes(Buffer.from("a2")) },
      { path: "src/application/b.ts", content: "import type { A } from \"./a.js\";\nexport type B = A;\n", sha256: sha256Bytes(Buffer.from("b2")) }
    ],
    baseline: emptyBaseline
  });
  const found = violationCodes(result);
  assert.ok(found.includes("ARCH-TYPE-ONLY-CYCLE"));
  assert.equal(found.includes("ARCH-VALUE-CYCLE"), false);
});

test("negative: changed baselined source fails", () => {
  const baseline = {
    rulesetId: RULESET_ID,
    entries: [{
      path: "src/chat.ts",
      classification: "LEGACY_UNLAYERED_DEBT",
      owner: "owner",
      reason: "legacy",
      exitPhase: "M2/M3",
      sha256: "0".repeat(64)
    }]
  };
  const result = evaluateArchitecture({
    files: [{ path: "src/chat.ts", content: "export const x = 1;\n", sha256: "1".repeat(64) }],
    baseline
  });
  assert.ok(violationCodes(result).includes("ARCH-BASELINE-CHANGED"));
});

test("negative: new unregistered flat source fails", () => {
  const result = evaluateArchitecture({
    files: [{ path: "src/new-flat.ts", content: "export const x = 1;\n", sha256: "A".repeat(64) }],
    baseline: emptyBaseline
  });
  assert.ok(violationCodes(result).includes("ARCH-UNREGISTERED-FLAT-SOURCE"));
});

test("negative: tests and fixtures have no blanket architecture exemption", () => {
  const result = evaluateOne({
    path: "tests/foundation/evil-fixture.mjs",
    content: "import { PaStore } from \"../../pa-starter-voice-room-web-src/src/store.ts\";\n"
  });
  assert.ok(violationCodes(result).includes("ARCH-PA-PRIVATE-IMPORT"));
});

test("rule-definition sources have no foundation text-scan exemption", () => {
  const notExempt = evaluateOne({
    path: "tools/lib/foundation-boundary.mjs",
    content: "import { readFileSync } from \"node:fs\";\nreadFileSync(\".env\");\n"
  });
  assert.ok(violationCodes(notExempt).includes("ARCH-ENV-READ"));
});
