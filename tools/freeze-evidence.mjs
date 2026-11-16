#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitBlobSha1, sha256Bytes, stableJson } from "./lib/hash.mjs";
import { RULESET_ID } from "./lib/architecture-guard.mjs";
import { validateCommandRecords } from "./lib/evidence-contract.mjs";
import {
  EXECUTION_CONTRACT_ADDENDUM_BYTES,
  EXECUTION_CONTRACT_ADDENDUM_SHA256,
  EXECUTION_CONTRACT_MANIFEST_BYTES,
  EXECUTION_CONTRACT_MANIFEST_SHA256,
  EXECUTION_CONTRACT_READBACK_BYTES,
  EXECUTION_CONTRACT_READBACK_SHA256,
  EXECUTION_CONTRACT_SHA256,
  OWNER_APPROVAL_ADDENDUM_SHA256,
  buildFoundationClosure,
  buildExecutionBoundaryEvidence
} from "./lib/foundation-boundary.mjs";
import { REQUIRED_LEGACY_Q_WEB_SOURCES } from "./lib/feature-map.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const Q_BASE_HEAD = "ec8db7ba6991e4ef61efc949eec6c48968b6ff49";
const Q_BASE_TREE = "d4fe1d8aee4682823b0bffa9c056f3606295cd67";

const P_IDENTITY = {
  repo: "P",
  head: "442b34a286376ddd2457f93160e05dda89a99fd8",
  tree: "0ff7d0dd57ed219849e82c320ed71305429e2cb6",
  branch: "feat/web-context-v2",
  readOnly: true,
  mode: "READ_ONLY"
};

const INPUTS = {
  executionContract: {
    path: "Shared/vr-product-takeover-01-m1-execution-20261116/M1_EXECUTION_CONTRACT.md",
    sha256: EXECUTION_CONTRACT_SHA256,
    bytes: 12512
  },
  executionContractManifest: {
    path: "Shared/vr-product-takeover-01-m1-execution-20261116/SHA256SUMS",
    sha256: EXECUTION_CONTRACT_MANIFEST_SHA256,
    bytes: EXECUTION_CONTRACT_MANIFEST_BYTES
  },
  executionContractReadback: {
    path: "Shared/vr-product-takeover-01-m1-execution-20261116/READBACK.txt",
    sha256: EXECUTION_CONTRACT_READBACK_SHA256,
    bytes: EXECUTION_CONTRACT_READBACK_BYTES
  },
  executionContractAddendum: {
    path: "Shared/vr-product-takeover-01-m1-execution-20261116/M1_EXECUTION_CONTRACT_ADDENDUM_01.md",
    sha256: EXECUTION_CONTRACT_ADDENDUM_SHA256,
    bytes: EXECUTION_CONTRACT_ADDENDUM_BYTES
  },
  ownerApprovalAddendum: {
    path: "Shared/vr-product-takeover-01-m1-execution-20261116/OWNER_APPROVAL_ADDENDUM_01.json",
    sha256: OWNER_APPROVAL_ADDENDUM_SHA256
  },
  ownerApproval: {
    path: "Shared/vr-product-takeover-01-m1-execution-20261116/OWNER_APPROVAL.json",
    sha256: "4B300AF089B99E5AAD365EBE3D65A6B5652498C567A1F77B21269887CAE27D1D"
  },
  implementationPlan: {
    path: "Shared/vr-product-takeover-01-20261115/m1/M1_IMPLEMENTATION_PLAN.md",
    sha256: "FC05273CAC123007A18F86F849E40CA1741863BB5146D0C478B5CC304B096560"
  },
  featureMapPlanning: {
    path: "Shared/vr-product-takeover-01-20261115/m1/FEATURE_MAP_PLANNING.json",
    sha256: "11AD010B773691AC869AF383BEFDEA79175B7A8E173FB6DD969224F8DC869F91"
  },
  s2DeliveryContract: {
    path: "Shared/vr-product-takeover-01-20261115/contracts/S2_DELIVERY_CONTRACT.md",
    sha256: "C4FA44B903985981EDB061F3BB3EB4707874A3EDBB054A60F384819D6F7E2FB7"
  },
  consumerIdentityRevision: {
    path: "Shared/vr-product-takeover-01-20261115/contracts/CONSUMER_IDENTITY_LIVENESS_REVISION.md",
    sha256: "3FCD5ED726F10D488107740929146DC0D2177735F7D543116E67F561CE481556"
  },
  protectedAssetManifest: {
    path: "Shared/vr-audit-01-closure-20261115/ASSET_MANIFEST_FINAL.json",
    sha256: "D45E84EC6B4DFABEBA45634C0DFF7E141C8CB24D66D4B02D941C8B0AEAAE964A"
  }
};

const TOOLCHAIN_IDENTITY = Object.freeze({
  node: "v24.21.0",
  npm: "11.19.0",
  git: "git version 2.49.0.windows.1",
  powershell: "5.1.26100.8457",
  platform: "win32",
  arch: "x64"
});

const PROTECTED_P_ASSETS = [
  { path: "src/voice-room/participation-planner.ts", bytes: 7056, sha256: "3E9BB8375CC29EEB8EDD8753C0653DC6BDD1AD8AB3668B75BC2C4252082331C4" },
  { path: ".harness/CURRENT_TASK.md", bytes: 16240, sha256: "85F20673A2FF96A0877658599848C73BD28A2F7FBB1175D82FA9919F316C0851" },
  { path: ".harness/PROJECT_STATE.md", bytes: 54276, sha256: "E10A5321926B69E966E4A92B11D40B714853D508A32A17B7E45501D392D8DA75" },
  { path: "docs/operations/VOICE_ROOM_SETUP.md", bytes: 12503, sha256: "3D3308E76C3E732607D7B75CDE989E3941AD70786E04C441C1F182B134D1C97E" },
  { path: "docs/product/DECISIONS.md", bytes: 22044, sha256: "DAA97852E3F1CF755A42283EAFD397C682018416C37CB58BFF9D10ACA6EDC27D" },
  { path: "docs/product/IMPLEMENTATION_SPEC.md", bytes: 18884, sha256: "314DF4F4A6A0C5E99FA2AE887D5F2A6CB4455DCD85612F6C9EF533CD59342EEE" },
  { path: "docs/product/PRD.md", bytes: 28379, sha256: "D6FA76702E21250321BA94059BC5014E379908050F0BA8AB97E1233C33508F0F" },
  { path: "src/voice-room/store.ts", bytes: 202592, sha256: "F6C5CC4D088E5309B420CAD7F6D98F7AF3AA8313F6929A4332151F9BC9EB21DE" }
];

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function parentOfHead() {
  const parts = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : null;
}

function trackedPaths() {
  return git(["ls-tree", "-r", "--name-only", "HEAD"]).trim().split(/\r?\n/).filter(Boolean);
}

function worktreeObservation() {
  const status = git(["status", "--porcelain=v1", "--untracked-files=normal"])
    .replaceAll("\r\n", "\n")
    .replace(/^\n+|\n+$/g, "");
  const lines = status ? status.split("\n") : [];
  const stagedEntries = [];
  const modifiedTrackedPaths = [];
  const untrackedEntries = [];
  for (const line of lines) {
    const entryPath = line.slice(3);
    if (line.startsWith("?? ")) {
      untrackedEntries.push(entryPath);
    } else {
      modifiedTrackedPaths.push(entryPath);
      if (line[0] !== " ") stagedEntries.push(entryPath);
    }
  }
  return {
    observationSource: "git status --porcelain=v1 --untracked-files=normal",
    head: git(["rev-parse", "HEAD"]).trim(),
    tree: git(["rev-parse", "HEAD^{tree}"]).trim(),
    stagedCount: stagedEntries.length,
    stagedEntries,
    modifiedTrackedPaths,
    untrackedCount: untrackedEntries.length,
    untrackedEntries,
    clean: lines.length === 0
  };
}

function blob(pathAtHead) {
  return git(["cat-file", "blob", `HEAD:${pathAtHead}`], "buffer");
}

async function buildSourceManifest() {
  const entries = [];
  for (const entryPath of trackedPaths()) {
    const baseBytes = blob(entryPath);
    const baseSha256 = sha256Bytes(baseBytes);
    let currentBytes;
    try {
      currentBytes = await readFile(path.join(root, entryPath));
    } catch {
      currentBytes = null;
    }
    const currentSha256 = currentBytes ? sha256Bytes(currentBytes) : null;
    let status = currentBytes ? "unchanged" : "MISSING";
    if (currentBytes && currentSha256 !== baseSha256) {
      status = entryPath === "package.json" ? "authorized-modified" : "UNAUTHORIZED_MODIFIED";
    }
    entries.push({
      path: entryPath.replaceAll("\\", "/"),
      gitMode: "100644",
      baseBlobSha1: gitBlobSha1(baseBytes),
      baseSha256,
      baseBytes: baseBytes.length,
      currentSha256,
      currentBytes: currentBytes ? currentBytes.length : 0,
      status,
      treatment:
        entryPath === "package.json"
          ? "M1: add scripts['verify:foundation'] only; all legacy scripts unchanged"
          : "M1 read-only; byte-identical"
    });
  }
  return {
    schemaVersion: "m1-source-manifest-v1",
    baseHead: Q_BASE_HEAD,
    baseTree: Q_BASE_TREE,
    trackedCount: entries.length,
    entries,
    protectedAssets: {
      manifestPath: INPUTS.protectedAssetManifest.path,
      manifestSha256: INPUTS.protectedAssetManifest.sha256,
      groupCounts: { P: 8, M: 15, D: 71, H: 10 },
      total: 104,
      pAssets: PROTECTED_P_ASSETS
    },
    legacyWebAssets: REQUIRED_LEGACY_Q_WEB_SOURCES.map((asset) => ({
      ...asset,
      classification: "INHERITED_LEGACY_ASSET_NOT_TARGET_WEB_EXTENSION",
      evidenceAllowedForVR_EXT_WEB_001: false
    })),
    noPContentCopied: true,
    historyPreserved: true
  };
}

function buildArchitectureBaseline() {
  const paths = trackedPaths().filter(
    (entryPath) => entryPath.startsWith("src/") && entryPath.endsWith(".ts")
  );
  const entries = [];
  for (const entryPath of paths.sort()) {
    const bytes = blob(entryPath);
    entries.push({
      path: entryPath.replaceAll("\\", "/"),
      classification: "LEGACY_UNLAYERED_DEBT",
      owner: "Architecture migration owner (M2/M3)",
      reason: "Inherited unlayered source in the approved base tree; layering is not established in M1",
      exitPhase: "M2/M3",
      m1Treatment: "READ_ONLY_INVENTORY_ONLY",
      gitBlobSha1: gitBlobSha1(bytes),
      bytes: bytes.length,
      sha256: sha256Bytes(bytes)
    });
  }
  return {
    schemaVersion: "m1-architecture-baseline-v1",
    rulesetId: RULESET_ID,
    baseHead: Q_BASE_HEAD,
    baseTree: Q_BASE_TREE,
    entryCount: entries.length,
    policy: {
      baselineScope: "per-file inventory of the fixed legacy Q tree",
      newUnlayeredSource: "FAIL",
      changedBaselineSource: "FAIL",
      blanketDirectoryExemption: false,
      testsBlanketExemption: false,
      typeOnlyCyclePolicy: "explicit-fail-with-distinct-code",
      ruleDefinitionSources: [],
      ruleDefinitionSourceExemptions: false
    },
    entries
  };
}

async function buildIdentity() {
  return {
    schemaVersion: "m1-input-identity-v1",
    task: "VR-PRODUCT-TAKEOVER-01/M1",
    phase: "M1_ENGINEERING_FOUNDATION",
    generatedAtUtc: new Date().toISOString(),
    q: {
      repo: "Q",
      branch: "main",
      baseIdentity: {
        head: Q_BASE_HEAD,
        tree: Q_BASE_TREE,
        parent: null,
        trackedCount: 56,
        trackedPaths: trackedPaths()
      },
      worktreeObservation: worktreeObservation()
    },
    p: P_IDENTITY,
    toolchain: TOOLCHAIN_IDENTITY,
    inputs: INPUTS
  };
}

function buildProtectedAssetsIndex() {
  const lines = [
    "# Protected Assets Index — M1",
    "",
    "This index records the protected-asset manifest used by M1. It does not copy",
    "P content, history or private memory into Q.",
    "",
    `- Manifest: \`${INPUTS.protectedAssetManifest.path}\``,
    `- SHA256: \`${INPUTS.protectedAssetManifest.sha256}\``,
    "- Groups: P=8, M=15, D=71, H=10; total=104",
    "",
    "## P protected assets (8)",
    "",
    "| Path | Bytes | SHA256 |",
    "| --- | ---: | --- |"
  ];
  for (const asset of PROTECTED_P_ASSETS) {
    lines.push(`| \`${asset.path}\` | ${asset.bytes} | \`${asset.sha256}\` |`);
  }
  lines.push(
    "",
    "## Treatment",
    "",
    "- P is read-only in M1.",
    "- No P history, private memory or protected asset is copied into Q.",
    "- The three inherited Q Web files are legacy assets, not `VR-EXT-WEB-001`",
    "  evidence: `src/voice-room/websearch.ts`, `src/web.ts`, `src/web-task.ts`.",
    ""
  );
  return lines.join("\n");
}

async function readExisting(relative) {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const commandRecords = JSON.parse(
    await readFile(path.join(root, "evidence", "command-records.json"), "utf8")
  );
  const commandValidation = validateCommandRecords(commandRecords);
  if (!commandValidation.ok) {
    throw new Error(
      `command evidence is invalid: ${commandValidation.errors
        .map((error) => `${error.code}:${error.detail}`)
        .join(",")}`
    );
  }
  const manifest = await buildSourceManifest();
  const baseline = buildArchitectureBaseline();
  const identity = await buildIdentity();
  const protectedIndex = buildProtectedAssetsIndex();
  const closure = await buildFoundationClosure(root);
  if (!closure.ok) {
    throw new Error(
      `foundation closure is invalid: ${closure.errors.map((error) => `${error.code}:${error.file}:${error.line}`).join(",")}`
    );
  }
  const packageBytes = await readFile(path.join(root, "package.json"));
  const packageJson = JSON.parse(packageBytes.toString("utf8"));
  const executionBoundary = buildExecutionBoundaryEvidence({
    closure,
    packageBytes,
    packageJson
  });
  if (executionBoundary.scanStatus !== "PASS" || executionBoundary.foundationCoverage !== "PASS") {
    throw new Error(
      `foundation execution boundary failed: ${executionBoundary.boundaryErrorCodes.join(",")}`
    );
  }
  const desired = {
    "evidence/m1-input-identity.json": stableJson(identity),
    "evidence/source-manifest.json": stableJson(manifest),
    "evidence/architecture-baseline.json": stableJson(baseline),
    "evidence/protected-assets-index.md": protectedIndex,
    "evidence/static-execution-boundary.json": stableJson(executionBoundary)
  };

  if (checkOnly) {
    const failures = [];
    for (const [relative, content] of Object.entries(desired)) {
      const existing = await readExisting(relative);
      if (existing === null) {
        failures.push(`${relative}: missing`);
        continue;
      }
      if (relative.endsWith(".json")) {
        const left = JSON.parse(existing);
        const right = JSON.parse(content);
        delete left.generatedAtUtc;
        delete right.generatedAtUtc;
        if (stableJson(left) !== stableJson(right)) failures.push(`${relative}: stale or modified`);
      } else if (existing !== content) {
        failures.push(`${relative}: stale or modified`);
      }
    }
    if (failures.length > 0) {
      process.stderr.write(`EVIDENCE CHECK FAILED\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("EVIDENCE CHECK PASS\n");
    return;
  }

  for (const [relative, content] of Object.entries(desired)) {
    await writeFile(path.join(root, relative), content, "utf8");
  }
  process.stdout.write(`EVIDENCE WRITTEN\n`);
}

main().catch((error) => {
  process.stderr.write(`EVIDENCE TOOL FAILED: ${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
