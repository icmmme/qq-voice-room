# qq-voice-room — Agent Instructions

This is the successor Voice Room product repository. M1 was the engineering
foundation phase. Its acceptance does not cover product runtime or product CI.

## Sources of truth

1. [Current task](.harness/CURRENT_TASK.md) registers exactly one active task
   and links to its governing contract.
2. The canonical project state is the single `Canonical Current State` section
   in `.harness/PROJECT_STATE.md`.
3. The working rules are `.harness/WORKFLOW.md`.
4. The feature authority is `docs/architecture/feature-map.json`.
5. The active contract selects the verification commands. M1 foundation
   acceptance is separate from product checks.

Do not infer an active task from chat, memory, branch names or old reports.

## Voice Room workflow

Before a Voice Room status report, handoff, substantive technical investigation,
fix, feature, refactor, or verification review, read
[`.agents/skills/voice-room-pstack/SKILL.md`](.agents/skills/voice-room-pstack/SKILL.md).
Plain-language requests are sufficient. When the user names a pstack skill, use
that skill for the task and read the entry for the project constraints.
Quick lookups and unrelated questions can skip the entry.

pstack supplies working methods. The active Harness contract still governs
allowed paths, checks, evidence, and acceptance.

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
- A frozen candidate remains `REVIEW_PENDING` while required verification,
  independent QA or Review, or the Owner's acceptance is incomplete. Record what
  passed and what remains unverified. Use `REVIEW_FAILED` for blocking review
  findings.

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

## Verification commands

On Windows, use PowerShell and `npm.cmd`. Follow the active contract. The
[product PR gate](.harness/CI_PRODUCT_PR_GATE.md#workflow) defines its own
sequence. Do not add a separate typecheck, Foundation verification, or
`npm test` to that sequence.

### M1 foundation only

Contract Addendum 01 approves the following sequence for the bound M1 foundation
candidate. The direct-Node verifier is the sole foundation acceptance authority:

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
