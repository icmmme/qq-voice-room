# qq-voice-room — Agent Instructions

This repository is the successor voice-room product repository. M1 is an
engineering-foundation phase only: it creates build, harness, feature-map,
architecture-guard, synthetic-contract and evidence capabilities. It does not
create product runtime behavior.

## Sources of truth

1. The active task contract is `.harness/CURRENT_TASK.md`. There is exactly one.
2. The canonical project state is the single `Canonical Current State` section
   in `.harness/PROJECT_STATE.md`.
3. The working rules are `.harness/WORKFLOW.md`.
4. The feature authority is `docs/architecture/feature-map.json`.
5. The direct-Node verifier `node tools/verify-foundation.mjs --clean` is the
   sole foundation authority, as approved by Contract Addendum 01.
   `npm.cmd run verify:foundation` is a non-authoritative compatibility check
   and cannot be QA or Review evidence.

Do not infer an active task from chat, memory, branch names or old reports.

## Roles and separation

- **Developer** implements, runs self-checks and freezes a candidate.
- **QA** independently verifies the same frozen candidate and input hashes.
- **Reviewer** independently reviews the same frozen candidate.

The implementer is never the final QA or Review author. A developer self-check
must be labeled as a self-check and must not be represented as independent
Review or as a PASS for acceptance.

## Candidate and evidence rules

- Every claim binds to a candidate identity: HEAD, tree, parent, dirty patch
  SHA256 and byte size.
- Every command record includes a logical cwd (`Q`, `P` or `Shared/...`), exit
  code and raw-log SHA256.
- A changed input, toolchain, command or candidate marks evidence stale.
- An old PASS never transfers to a new candidate.
- Until independent QA and Review bind to the same frozen candidate, the task
  status is `REVIEW_PENDING`.

## Enforcement map

| Rule | Enforced by |
| --- | --- |
| Sensitive environment files are denied after final-path resolution, including DOS 8.3 aliases | `tools/lib/env-read-guard.mjs`; `tests/foundation/architecture-guard.test.mjs`; `findSensitiveEnvFiles` preflight |
| Candidate command evidence uses logical cwd and candidate-specific raw logs | `evidence/command-records.json`; `tests/foundation/evidence.test.mjs`; `tools/freeze-evidence.mjs --check` |
| Owner handoff facts are structured, not a second dashboard | `.harness/templates/REVIEW_REPORT.md`; `tools/lib/harness-contract.mjs`; harness test |

## M1 boundaries

- Allowed new paths: `AGENTS.md`, `.harness/**`, `docs/architecture/**`,
  `evidence/**`, `tools/**`, `tests/**`.
- `package.json` may change only to add the reviewed `verify:foundation`
  script. `package-lock.json` may change only for a strictly required
  foundation dependency.
- Existing `src/**`, `scripts/**`, existing tests, `tsconfig.json`,
  `.gitignore`, README, examples and `.env.example` are read-only.
- Static typecheck/build compilation of existing `scripts/**` is allowed. It is
  not execution evidence: the foundation entry must not execute, spawn or
  import a legacy runtime/script for runtime behavior.
- Do not copy P history, private memory or protected assets into this
  repository.
- Do not add a second queue, gate manager, PM database, validator family or
  evidence system.

## Prohibited actions

- No real QQ/NapCat, model, TTS, network-provider or production database use.
- No `.env` read, secret read, production path, `3011` listener or running
  service restart.
- No stage, commit, push, deploy or cutover without separate authorization.
- No `npm test`, legacy lifecycle test, `room:doctor`, `room:qq` or `demo`
  invocation as foundation evidence.

## Commands

Use PowerShell and `npm.cmd` (the `npm.ps1` shim may be blocked by execution
policy). The approved install/check sequence is:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
node tools/verify-foundation.mjs --clean
```

The direct-Node verifier performs the bound TypeScript typecheck and build,
then runs only the fixed foundation test files listed in
`tools/lib/foundation-boundary.mjs`. It must not execute npm, a package script,
a shell, or a legacy script.

`npm.cmd run verify:foundation` prints
`FOUNDATION COMPAT PASS (NON-AUTHORITATIVE)`. It is for local compatibility
only, does not create acceptance evidence and must not be quoted as a QA or
Review pass.
