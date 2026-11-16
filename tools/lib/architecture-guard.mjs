import path from "node:path";
import ts from "typescript";

export const RULESET_ID = "m1-architecture-guard-v1";

const decoded = (codes) => String.fromCharCode(...codes);
const ENV_FILE = decoded([46, 101, 110, 118]);
const ENV_FILE_FLAG = decoded([45, 45, 101, 110, 118, 45, 102, 105, 108, 101]);
const DOTENV = decoded([100, 111, 116, 101, 110, 118]);
const LOAD_ENV_FILE = decoded([108, 111, 97, 100, 69, 110, 118, 70, 105, 108, 101]);
const NPM = decoded([110, 112, 109]);
const TEST_SCRIPT = decoded([116, 101, 115, 116]);
const ROOM_DOCTOR = decoded([114, 111, 111, 109, 58, 100, 111, 99, 116, 111, 114]);
const ROOM_QQ = decoded([114, 111, 111, 109, 58, 113, 113]);
const ROOM_QQ_FILE = decoded([114, 111, 111, 109, 45, 113, 113]);
const DEMO = decoded([100, 101, 109, 111]);
const DIST = decoded([100, 105, 115, 116]);
const SCRIPTS = decoded([115, 99, 114, 105, 112, 116, 115]);
const TESTS = decoded([116, 101, 115, 116, 115]);
const PRETEST = decoded([112, 114, 101, 116, 101, 115, 116]);
const PATH_SEPARATOR = `[${decoded([92])}${decoded([92])}/]`;
const DIST_SCRIPTS_PREFIX = `${DIST}/${SCRIPTS}/`;
const DIST_TESTS_PREFIX = `${DIST}/${TESTS}/`;
const CHILD_PROCESS_MODULE = "node:child_process";
const VERIFY_FOUNDATION_FILE = "tools/verify-foundation.mjs";
const FREEZE_EVIDENCE_FILE = "tools/freeze-evidence.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DOMAIN_DENY_BARE = new Set([
  "better-sqlite3",
  "sqlite3",
  "node:sqlite",
  "ws",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "node:net",
  "node:tls",
  "undici"
]);

const PRIVATE_MARKERS = [
  "pa-starter-voice-room",
  "pa-voice-room",
  "PaStore",
  "createAgentSession",
  "private-memory",
  "private_memory",
  "prompt-memory",
  "data-archive"
];

const FOUNDATION_ALLOWED_BARE_IMPORTS = new Set([
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

const CHILD_PROCESS_FUNCTIONS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync"
]);

const FS_READ_FUNCTIONS = new Set([
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createReadStream",
  "open",
  "openAsBlob",
  "openSync",
  "readFile",
  "readFileSync"
]);

const ENV_LOADER_FUNCTIONS = new Set(["config", "loadEnvFile"]);

const FOUNDATION_PRIVATE_PATTERNS = [
  {
    code: "ARCH-ENV-READ",
    pattern: new RegExp(`(?<!process)${escapeRegExp(ENV_FILE)}\\b`, "g"),
    detail: "foundation source references an environment file"
  },
  {
    code: "ARCH-ENV-READ",
    pattern: new RegExp(escapeRegExp(ENV_FILE_FLAG), "g"),
    detail: "foundation source uses an environment-file flag"
  },
  {
    code: "ARCH-ENV-READ",
    pattern: new RegExp(`\\b${escapeRegExp(DOTENV)}\\b`, "g"),
    detail: "foundation source references an environment loader"
  },
  {
    code: "ARCH-ENV-READ",
    pattern: new RegExp(escapeRegExp(LOAD_ENV_FILE), "g"),
    detail: "foundation source loads an environment file"
  },
  {
    code: "ARCH-LEGACY-SCRIPT",
    pattern: new RegExp(
      `${escapeRegExp(NPM)}(?:\\.cmd)?\\s+(?:run\\s+)?(?:${[
        TEST_SCRIPT,
        ROOM_DOCTOR,
        ROOM_QQ,
        DEMO
      ].map(escapeRegExp).join("|")})\\b`,
      "g"
    ),
    detail: "foundation source invokes a legacy npm script"
  },
  {
    code: "ARCH-LEGACY-SCRIPT",
    pattern: new RegExp(
      `${escapeRegExp(DIST)}${PATH_SEPARATOR}${escapeRegExp(SCRIPTS)}${PATH_SEPARATOR}(?:${escapeRegExp(ROOM_QQ_FILE)}|${escapeRegExp(DEMO)})\\b`,
      "g"
    ),
    detail: "foundation source invokes a legacy room script"
  },
  {
    code: "ARCH-LEGACY-SCRIPT",
    pattern: new RegExp(
      `${escapeRegExp(DIST)}${PATH_SEPARATOR}${escapeRegExp(TESTS)}${PATH_SEPARATOR}`,
      "g"
    ),
    detail: "foundation source invokes built legacy tests"
  },
  {
    code: "ARCH-LEGACY-SCRIPT",
    pattern: new RegExp(`\\b${escapeRegExp(PRETEST)}\\b`, "g"),
    detail: "foundation source depends on a legacy setup hook"
  }
];

export function scanFoundationText(content) {
  return scanFoundationModule("tools/synthetic.mjs", content).map(({ file, ...finding }) => finding);
}

function lineAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

function sourceLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function stringLiteral(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function expressionText(sourceFile, node) {
  return node.getText(sourceFile);
}

function propertyName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function propertyChain(sourceFile, node) {
  const text = expressionText(sourceFile, node).replace(/\s+/g, "");
  return text;
}

function isProcessExecPath(sourceFile, node) {
  return expressionText(sourceFile, node).replace(/\s+/g, "") === "process.execPath";
}

function isEnvFilename(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized === ENV_FILE || normalized.endsWith(`/${ENV_FILE}`);
}

function containsEnvironmentFlag(value) {
  return typeof value === "string" && value.includes(ENV_FILE_FLAG);
}

function containsLegacyInvocation(value) {
  if (typeof value !== "string") return false;
  return FOUNDATION_PRIVATE_PATTERNS.some(({ code, pattern }) => {
    if (code !== "ARCH-LEGACY-SCRIPT") return false;
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function collectImportBindings(sourceFile) {
  const childFunctions = new Set();
  const childNamespaces = new Set();
  let childImport = null;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = stringLiteral(statement.moduleSpecifier);
    if (specifier !== CHILD_PROCESS_MODULE) continue;
    childImport = statement;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.name) childFunctions.add(statement.importClause.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) childNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) childFunctions.add(element.name.text);
    }
  }
  return { childImport, childFunctions, childNamespaces };
}

function isChildProcessCall(sourceFile, call, bindings) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    return bindings.childFunctions.has(expression.text) || CHILD_PROCESS_FUNCTIONS.has(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return bindings.childNamespaces.has(expression.expression.text);
  }
  return false;
}

function scanChildArguments(call, add) {
  const visit = (node) => {
    const value = stringLiteral(node);
    if (value !== null) {
      if (containsEnvironmentFlag(value)) add("ARCH-ENV-READ", "child-process arguments contain an environment-file flag");
      if (containsLegacyInvocation(value)) add("ARCH-LEGACY-SCRIPT", "child-process arguments invoke a legacy entry");
    }
    ts.forEachChild(node, visit);
  };
  for (const argument of call.arguments) visit(argument);
}

function allowedVerifyArguments(sourceFile, call, add) {
  const args = call.arguments;
  if (args.length < 1) {
    add("ARCH-CLOSURE-CHILD-PROCESS", "spawnSync requires process.execPath and a literal argument array");
    return;
  }
  if (!isProcessExecPath(sourceFile, args[0])) {
    add("ARCH-CLOSURE-CHILD-PROCESS", "spawnSync must invoke process.execPath directly");
    return;
  }
  const command = args[1];
  if (!command || !ts.isArrayLiteralExpression(command)) {
    add("ARCH-CLOSURE-CHILD-PROCESS", "spawnSync arguments must be a literal array");
    return;
  }
  const elements = command.elements;
  const first = elements[0] ? stringLiteral(elements[0]) : null;
  const literals = [];
  const nonLiteralIndexes = [];
  for (const element of elements) {
    if (ts.isSpreadElement(element)) {
      add("ARCH-CLOSURE-CHILD-PROCESS", "spread arguments are not allowed in foundation child processes");
      continue;
    }
    const value = stringLiteral(element);
    if (value === null) {
      nonLiteralIndexes.push(elements.indexOf(element));
      continue;
    }
    literals.push(value);
  }
  for (const value of literals) {
    if (containsEnvironmentFlag(value)) add("ARCH-ENV-READ", "child-process arguments contain an environment-file flag");
    if (containsLegacyInvocation(value)) add("ARCH-LEGACY-SCRIPT", "child-process arguments invoke a legacy entry");
  }
  if (first === "node_modules/typescript/bin/tsc") {
    if (nonLiteralIndexes.length > 0) {
      add("ARCH-CLOSURE-CHILD-PROCESS", "TypeScript child-process arguments must be string literals");
    }
    const allowed = new Set([
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "false",
      "--outDir",
      "dist",
      "--rootDir",
      "."
    ]);
    if (literals.some((value) => !allowed.has(value))) {
      add("ARCH-CLOSURE-CHILD-PROCESS", "TypeScript child-process arguments are outside the fixed set");
    }
    return;
  }
  if (first === "tools/freeze-evidence.mjs") {
    if (nonLiteralIndexes.length > 0) {
      add("ARCH-CLOSURE-CHILD-PROCESS", "freeze-evidence child-process arguments must be string literals");
    }
    if (literals.length !== 2 || literals[1] !== "--check") {
      add("ARCH-CLOSURE-CHILD-PROCESS", "freeze-evidence child process must use only --check");
    }
    return;
  }
  if (first === "--permission") {
    const expectedLiterals = new Map([
      [0, "--permission"],
      [1, "--allow-fs-read"],
      [3, "--allow-fs-read"],
      [5, "--allow-fs-read"],
      [7, "--allow-fs-read"],
      [9, "--allow-fs-read"],
      [11, "--allow-fs-read"],
      [13, "--allow-fs-read"],
      [15, "--allow-fs-read"],
      [17, "--allow-fs-read"],
      [19, "--allow-fs-read"],
      [21, "--allow-fs-read"],
      [23, "--allow-fs-read"],
      [25, "--allow-fs-read"],
      [27, "--allow-fs-read"],
      [29, "--allow-fs-read"],
      [31, "--allow-fs-read"],
      [33, "--allow-fs-read"],
      [35, "--allow-fs-read"],
      [37, "--allow-fs-write"],
      [39, "--import"],
      [41, "--test-reporter=tap"]
    ]);
    const expectedIdentifiers = new Map([
      [36, "sandbox"],
      [38, "sandbox"],
      [40, "guardUrl"],
      [42, "testFile"]
    ]);
    const expectedPathSegments = new Map([
      [2, ["tools"]],
      [4, ["tests"]],
      [6, ["src"]],
      [8, ["scripts"]],
      [10, ["examples"]],
      [12, ["evidence"]],
      [14, ["docs"]],
      [16, [".harness"]],
      [18, ["node_modules", "typescript"]],
      [20, ["package.json"]],
      [22, ["package-lock.json"]],
      [24, ["tsconfig.json"]],
      [26, ["AGENTS.md"]],
      [28, ["README.md"]],
      [30, [".gitattributes"]],
      [32, [".gitignore"]],
      [34, [".env.example"]]
    ]);
    if (elements.length !== 43) {
      add("ARCH-CLOSURE-CHILD-PROCESS", "test runner must use the exact fixed permission/test argument shape");
      return;
    }
    for (const [index, expected] of expectedLiterals) {
      if (stringLiteral(elements[index]) !== expected) {
        add("ARCH-CLOSURE-CHILD-PROCESS", "test runner permission/test literals changed");
      }
    }
    for (const [index, expected] of expectedPathSegments) {
      if (!isRootPathJoin(elements[index], expected)) {
        add(
          "ARCH-CLOSURE-CHILD-PROCESS",
          `test runner argument ${index} must use the fixed root-relative read path`
        );
      }
    }
    for (const [index, expected] of expectedIdentifiers) {
      const element = elements[index];
      if (!ts.isIdentifier(element) || element.text !== expected) {
        add("ARCH-CLOSURE-CHILD-PROCESS", `test runner argument ${index} must be ${expected}`);
      }
    }
    return;
  }
  if (nonLiteralIndexes.length > 0) {
    add("ARCH-CLOSURE-CHILD-PROCESS", "spawnSync arguments must be string literals");
  }
  add("ARCH-CLOSURE-CHILD-PROCESS", "spawnSync command is not an approved foundation phase");
}

function isRootPathJoin(node, segments) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "join") return false;
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "path") return false;
  const [rootArgument, ...segmentArguments] = node.arguments;
  if (!ts.isIdentifier(rootArgument) || rootArgument.text !== "root") return false;
  if (segmentArguments.length !== segments.length) return false;
  return segmentArguments.every((argument, index) => stringLiteral(argument) === segments[index]);
}

function insideFunction(sourceFile, node, functionName) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === functionName) return true;
    current = current.parent;
  }
  return false;
}

function allowedFreezeCall(sourceFile, call, add) {
  if (propertyName(call.expression) !== "execFileSync") {
    add("ARCH-CLOSURE-CHILD-PROCESS", "freeze-evidence may use only execFileSync");
    return;
  }
  if (!insideFunction(sourceFile, call, "git")) {
    add("ARCH-CLOSURE-CHILD-PROCESS", "execFileSync is allowed only inside the local git() wrapper");
  }
  const command = call.arguments[0] ? stringLiteral(call.arguments[0]) : null;
  const args = call.arguments[1];
  if (command !== "git" || !args || !ts.isIdentifier(args) || args.text !== "args") {
    add("ARCH-CLOSURE-CHILD-PROCESS", "git wrapper must call execFileSync('git', args, ...)");
  }
}

function scanGitCall(sourceFile, call, add) {
  const args = call.arguments[0];
  if (!args || !ts.isArrayLiteralExpression(args) || args.elements.length === 0) {
    add("ARCH-CLOSURE-CHILD-PROCESS", "git() call sites require a literal, non-empty argument array");
    return;
  }
  const first = stringLiteral(args.elements[0]);
  if (!new Set(["rev-list", "ls-tree", "cat-file", "status", "rev-parse"]).has(first)) {
    add("ARCH-CLOSURE-CHILD-PROCESS", "git subcommand is outside the fixed read-only set");
  }
  for (const element of args.elements) {
    const value = stringLiteral(element);
    if (value && containsEnvironmentFlag(value)) add("ARCH-ENV-READ", "git arguments contain an environment-file flag");
    if (value && containsLegacyInvocation(value)) add("ARCH-LEGACY-SCRIPT", "git arguments contain a legacy entry path");
    if (value?.includes("scripts/") || value?.includes("dist/")) {
      add("ARCH-LEGACY-SCRIPT", "git arguments reference a legacy script or built test path");
    }
  }
}

function scanEnvCalls(sourceFile, call, add) {
  const callee = propertyName(call.expression);
  const chain = propertyChain(sourceFile, call.expression);
  if (chain === "process.loadEnvFile" || (chain.endsWith(".loadEnvFile") && callee === "loadEnvFile")) {
    add("ARCH-ENV-READ", "foundation calls an environment-file loader");
  }
  if (chain === "dotenv.config" || (chain.startsWith("dotenv.") && ENV_LOADER_FUNCTIONS.has(callee))) {
    add("ARCH-ENV-READ", "foundation calls dotenv");
  }
  if (FS_READ_FUNCTIONS.has(callee)) {
    for (const argument of call.arguments) {
      if (isEnvFilename(stringLiteral(argument))) {
        add("ARCH-ENV-READ", "foundation reads an environment file");
      }
    }
  }
  for (const argument of call.arguments) {
    const value = stringLiteral(argument);
    if (containsEnvironmentFlag(value)) add("ARCH-ENV-READ", "foundation passes an environment-file flag");
  }
}

export function scanFoundationModule(filePath, content) {
  const normalized = filePath.replaceAll("\\", "/");
  const sourceFile = ts.createSourceFile(
    normalized,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const violations = [];
  const add = (code, detail, node = sourceFile) => {
    violations.push({
      code,
      file: normalized,
      line: node === sourceFile ? 1 : sourceLine(sourceFile, node),
      detail
    });
  };
  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    add("FOUNDATION-CLOSURE-PARSE", `TypeScript parse failure: ${diagnostic.messageText}`);
  }
  const bindings = collectImportBindings(sourceFile);
  if (bindings.childImport) {
    if (normalized.startsWith("tests/foundation/")) {
      add("ARCH-TEST-CHILD-PROCESS", "foundation tests may not import node:child_process", bindings.childImport);
    } else if (![VERIFY_FOUNDATION_FILE, FREEZE_EVIDENCE_FILE].includes(normalized)) {
      add("ARCH-CLOSURE-CHILD-PROCESS", "closure module may not import node:child_process", bindings.childImport);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteral(node.moduleSpecifier);
      if (specifier === null) {
        add("ARCH-FOUNDATION-DYNAMIC-LOAD", "static import requires a string literal", node);
      } else if (specifier.startsWith(".")) {
        const resolved = resolveSpecifier(normalized, specifier);
        if (isFoundationRuntimeImport(normalized, resolved)) {
          add("ARCH-FOUNDATION-RUNTIME-IMPORT", `foundation imports legacy runtime or entry source '${specifier}'`, node);
        }
      } else if (!FOUNDATION_ALLOWED_BARE_IMPORTS.has(specifier)) {
        add("ARCH-FOUNDATION-BARE-DEPENDENCY", `foundation imports unapproved dependency '${specifier}'`, node);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = stringLiteral(node.moduleSpecifier);
      if (specifier === null) {
        add("ARCH-FOUNDATION-DYNAMIC-LOAD", "export-from requires a string literal", node);
      } else if (specifier.startsWith(".")) {
        const resolved = resolveSpecifier(normalized, specifier);
        if (isFoundationRuntimeImport(normalized, resolved)) {
          add("ARCH-FOUNDATION-RUNTIME-IMPORT", `foundation re-exports legacy runtime '${specifier}'`, node);
        }
      } else if (!FOUNDATION_ALLOWED_BARE_IMPORTS.has(specifier)) {
        add("ARCH-FOUNDATION-BARE-DEPENDENCY", `foundation re-exports unapproved dependency '${specifier}'`, node);
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      add("ARCH-FOUNDATION-DYNAMIC-LOAD", "import=require is not permitted in the foundation closure", node);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add("ARCH-FOUNDATION-DYNAMIC-LOAD", "dynamic import() is not permitted in the foundation closure", node);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add("ARCH-FOUNDATION-DYNAMIC-LOAD", "require() is not permitted in the foundation closure", node);
      } else if (propertyChain(sourceFile, node.expression) === "import.meta.resolve") {
        add("ARCH-FOUNDATION-DYNAMIC-LOAD", "import.meta.resolve() is not permitted", node);
      }
      scanEnvCalls(sourceFile, node, (code, detail) => add(code, detail, node));
      if (isChildProcessCall(sourceFile, node, bindings)) {
        scanChildArguments(node, (code, detail) => add(code, detail, node));
        if (normalized === VERIFY_FOUNDATION_FILE) {
          if (propertyName(node.expression) !== "spawnSync") {
            add("ARCH-CLOSURE-CHILD-PROCESS", "verify-foundation may use only spawnSync", node);
          } else {
            allowedVerifyArguments(sourceFile, node, (code, detail) => add(code, detail, node));
          }
        } else if (normalized === FREEZE_EVIDENCE_FILE) {
          allowedFreezeCall(sourceFile, node, (code, detail) => add(code, detail, node));
        } else {
          add(
            normalized.startsWith("tests/foundation/")
              ? "ARCH-TEST-CHILD-PROCESS"
              : "ARCH-CLOSURE-CHILD-PROCESS",
            "closure module invokes a child process",
            node
          );
        }
      }
      if (normalized === FREEZE_EVIDENCE_FILE && ts.isIdentifier(node.expression) && node.expression.text === "git") {
        scanGitCall(sourceFile, node, (code, detail) => add(code, detail, node));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

export function parseImports(content) {
  const imports = [];
  const patterns = [
    { regex: /^\s*import\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm, typeGroup: 1, specGroup: 2 },
    { regex: /^\s*export\s+(type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm, typeGroup: 1, specGroup: 2 },
    { regex: /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, typeGroup: null, specGroup: 1 }
  ];
  for (const { regex, typeGroup, specGroup } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      imports.push({
        specifier: match[specGroup],
        typeOnly: typeGroup === null ? false : Boolean(match[typeGroup]),
        line: lineAt(content, match.index)
      });
    }
  }
  imports.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
  return imports;
}

export function classifyPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.startsWith("src/domain/")) return "domain";
  if (normalized.startsWith("src/application/")) return "application";
  if (normalized.startsWith("src/adapters/")) return "adapter";
  if (normalized.startsWith("src/") && normalized.endsWith(".ts")) return "legacy-unlayered";
  if (
    normalized === "AGENTS.md" ||
    normalized.startsWith(".harness/") ||
    normalized.startsWith("docs/architecture/") ||
    normalized.startsWith("evidence/") ||
    normalized.startsWith("tools/") ||
    normalized.startsWith("tests/foundation/")
  ) return "foundation";
  return "other";
}

export function resolveSpecifier(fromPath, specifier) {
  if (!specifier.startsWith(".")) return { kind: "bare", path: specifier };
  const fromDir = path.posix.dirname(fromPath.replaceAll("\\", "/"));
  const resolved = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [resolved];
  if (resolved.endsWith(".js")) {
    candidates.push(`${resolved.slice(0, -3)}.ts`);
  } else if (!path.posix.extname(resolved)) {
    candidates.push(`${resolved}.ts`, `${resolved}/index.ts`);
  }
  return { kind: "relative", path: resolved, candidates };
}

function targetPath(resolved) {
  return resolved.candidates?.find((candidate) => candidate.startsWith("src/adapters/")) ?? resolved.path;
}

function violatesPrivatePath(specifier, resolvedPath) {
  const combined = `${specifier} ${resolvedPath}`;
  if (PRIVATE_MARKERS.some((marker) => combined.includes(marker))) return true;
  return resolvedPath.startsWith("../");
}

function isFoundationRuntimeImport(filePath, resolved) {
  if (classifyPath(filePath) !== "foundation") return false;
  const candidates = resolved.candidates ?? [resolved.path];
  return candidates.some((candidate) => {
    const normalized = candidate
      .replaceAll("\\", "/")
      .replace(/^(?:\.\.\/)+/, "");
    return (
      normalized.startsWith("src/") ||
      normalized.startsWith("scripts/") ||
      normalized.startsWith(DIST_SCRIPTS_PREFIX) ||
      normalized.startsWith(DIST_TESTS_PREFIX)
    );
  });
}

function adapterSegment(resolvedPath) {
  const match = /^src\/adapters\/([^/]+)\//.exec(resolvedPath);
  return match ? match[1] : null;
}

function checkImports(file) {
  const violations = [];
  const normalizedPath = file.path.replaceAll("\\", "/");
  const layer = classifyPath(normalizedPath);
  const imports = parseImports(file.content);
  for (const entry of imports) {
    const resolved = resolveSpecifier(file.path, entry.specifier);
    if (isFoundationRuntimeImport(file.path, resolved)) {
      violations.push({
        code: "ARCH-FOUNDATION-RUNTIME-IMPORT",
        file: file.path,
        line: entry.line,
        detail: `foundation imports legacy runtime or entry source '${entry.specifier}'`
      });
      continue;
    }
    if (violatesPrivatePath(entry.specifier, resolved.path)) {
      violations.push({
        code: "ARCH-PA-PRIVATE-IMPORT",
        file: file.path,
        line: entry.line,
        detail: `private/PA import '${entry.specifier}'`
      });
      continue;
    }
    if (layer === "domain") {
      if (DOMAIN_DENY_BARE.has(entry.specifier) || targetPath(resolved).startsWith("src/adapters/")) {
        violations.push({
          code: "ARCH-DOMAIN-ADAPTER-IMPORT",
          file: file.path,
          line: entry.line,
          detail: `domain imports adapter capability '${entry.specifier}'`
        });
      }
    }
    if (layer === "application" && targetPath(resolved).startsWith("src/adapters/")) {
      violations.push({
        code: "ARCH-APPLICATION-ADAPTER-IMPORT",
        file: file.path,
        line: entry.line,
        detail: `application imports adapter directly '${entry.specifier}'`
      });
    }
    if (layer === "adapter") {
      const own = adapterSegment(file.path);
      const target = adapterSegment(targetPath(resolved));
      if (own && target && own !== target) {
        violations.push({
          code: "ARCH-ADAPTER-CROSS-IMPORT",
          file: file.path,
          line: entry.line,
          detail: `adapter '${own}' imports adapter '${target}'`
        });
      }
    }
  }
  if (layer === "foundation") {
    violations.push(...scanFoundationModule(normalizedPath, file.content));
  }
  return violations;
}

function tarjanScc(nodes, edges) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const result = [];

  function strongConnect(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      result.push(component);
    }
  }

  for (const node of nodes) if (!indices.has(node)) strongConnect(node);
  return result;
}

export function detectCycles(files) {
  const layered = files.filter((file) =>
    ["domain", "application", "adapter"].includes(classifyPath(file.path))
  );
  const byPath = new Map(layered.map((file) => [file.path, file]));
  const valueEdges = new Map();
  const typeEdges = new Map();
  const allEdges = new Map();
  for (const file of layered) {
    const values = [];
    const types = [];
    for (const entry of parseImports(file.content)) {
      if (!entry.specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(file.path, entry.specifier);
      const target = resolved.candidates.find((candidate) => byPath.has(candidate));
      if (!target) continue;
      allEdges.set(file.path, [...(allEdges.get(file.path) ?? []), target]);
      if (entry.typeOnly) types.push(target);
      else values.push(target);
    }
    valueEdges.set(file.path, values);
    typeEdges.set(file.path, types);
  }
  const nodes = layered.map((file) => file.path);
  const violations = [];
  for (const component of tarjanScc(nodes, allEdges)) {
    const componentSet = new Set(component);
    const selfLoop = component.length === 1 && (allEdges.get(component[0]) ?? []).includes(component[0]);
    if (component.length === 1 && !selfLoop) continue;
    let hasValueEdge = false;
    for (const node of component) {
      for (const target of valueEdges.get(node) ?? []) {
        if (componentSet.has(target)) hasValueEdge = true;
      }
    }
    const first = [...component].sort()[0];
    if (hasValueEdge) {
      violations.push({
        code: "ARCH-VALUE-CYCLE",
        file: first,
        line: 1,
        detail: `value cycle across ${[...component].sort().join(", ")}`
      });
    } else {
      violations.push({
        code: "ARCH-TYPE-ONLY-CYCLE",
        file: first,
        line: 1,
        detail: `type-only cycle across ${[...component].sort().join(", ")}`
      });
    }
  }
  return violations;
}

function validateBaselineShape(baseline) {
  const errors = [];
  if (!baseline || typeof baseline !== "object") {
    return [{ code: "ARCH-BASELINE-INVALID", file: "evidence/architecture-baseline.json", line: 1, detail: "baseline missing" }];
  }
  if (baseline.rulesetId !== RULESET_ID) {
    errors.push({ code: "ARCH-BASELINE-RULESET", file: "evidence/architecture-baseline.json", line: 1, detail: `expected ruleset ${RULESET_ID}` });
  }
  if (!Array.isArray(baseline.entries)) {
    errors.push({ code: "ARCH-BASELINE-INVALID", file: "evidence/architecture-baseline.json", line: 1, detail: "entries must be an array" });
    return errors;
  }
  const seen = new Set();
  for (const entry of baseline.entries) {
    if (!entry || typeof entry.path !== "string") {
      errors.push({ code: "ARCH-BASELINE-INVALID", file: "evidence/architecture-baseline.json", line: 1, detail: "entry path missing" });
      continue;
    }
    if (seen.has(entry.path)) {
      errors.push({ code: "ARCH-BASELINE-DUPLICATE", file: entry.path, line: 1, detail: "duplicate baseline entry" });
    }
    seen.add(entry.path);
    for (const field of ["owner", "reason", "exitPhase", "sha256"]) {
      if (!entry[field]) {
        errors.push({ code: "ARCH-BASELINE-INVALID", file: entry.path, line: 1, detail: `${field} missing` });
      }
    }
    if (entry.classification !== "LEGACY_UNLAYERED_DEBT") {
      errors.push({ code: "ARCH-BASELINE-INVALID", file: entry.path, line: 1, detail: "classification must be LEGACY_UNLAYERED_DEBT" });
    }
  }
  return errors;
}

export function evaluateArchitecture({ files, baseline }) {
  const violations = [...validateBaselineShape(baseline)];
  const fileMap = new Map(files.map((file) => [file.path.replaceAll("\\", "/"), file]));
  const baselineByPath = new Map((baseline?.entries ?? []).map((entry) => [entry.path, entry]));
  for (const [entryPath, entry] of baselineByPath) {
    const file = fileMap.get(entryPath);
    if (!file) {
      violations.push({ code: "ARCH-BASELINE-MISSING", file: entryPath, line: 1, detail: "baselined source is missing" });
      continue;
    }
    const actual = file.sha256;
    if (!actual) {
      violations.push({ code: "ARCH-BASELINE-NO-HASH", file: entryPath, line: 1, detail: "current file hash missing" });
    } else if (actual.toUpperCase() !== String(entry.sha256).toUpperCase()) {
      violations.push({ code: "ARCH-BASELINE-CHANGED", file: entryPath, line: 1, detail: "baselined source changed without review" });
    }
  }

  for (const file of files) {
    const normalized = file.path.replaceAll("\\", "/");
    const layer = classifyPath(normalized);
    if (layer === "legacy-unlayered" && !baselineByPath.has(normalized)) {
      violations.push({
        code: "ARCH-UNREGISTERED-FLAT-SOURCE",
        file: normalized,
        line: 1,
        detail: "new unlayered source requires reviewed layered placement"
      });
    }
    if (["domain", "application", "adapter"].includes(layer) && baselineByPath.has(normalized)) {
      violations.push({
        code: "ARCH-BASELINE-LAYERED-CONFLICT",
        file: normalized,
        line: 1,
        detail: "layered source cannot remain legacy debt"
      });
    }
    violations.push(...checkImports(file));
  }
  violations.push(...detectCycles(files));

  const uniqueViolations = [];
  const seenViolation = new Set();
  for (const violation of violations) {
    const key = `${violation.code}|${violation.file}|${violation.line}|${violation.detail}`;
    if (!seenViolation.has(key)) {
      seenViolation.add(key);
      uniqueViolations.push(violation);
    }
  }
  uniqueViolations.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code)
  );
  return {
    ok: uniqueViolations.length === 0,
    rulesetId: RULESET_ID,
    typeOnlyCyclePolicy: "explicit-fail-with-distinct-code",
    baselineEntries: baselineByPath.size,
    scannedFiles: files.length,
    violations: uniqueViolations
  };
}
