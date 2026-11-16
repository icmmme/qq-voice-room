# Evidence Contract — M1

Every M1 claim is bound to one candidate identity and one input set. A report
without that binding is not M1 evidence.

The current package identity is the approved revision-2 base contract plus
`M1_EXECUTION_CONTRACT_ADDENDUM_01.md`; the updated package manifest and
readback are recorded in `evidence/m1-input-identity.json`.

## Candidate identity

A candidate identity contains:

- HEAD;
- tree;
- parent (or `ROOT` for a root commit);
- dirty patch SHA256 and byte size;
- prospective tree from base tree plus patch;
- toolchain identity.

QA and Review must receive the same candidate identity and the same input
hashes. A different patch, tree, input or toolchain is a different candidate.

## Command records

Each command record contains:

- a stable `commandId`;
- the exact command text;
- the logical repository cwd (`Q`, `P`, or `Shared/...`);
- the exit code;
- the raw-log SHA256.

Host-absolute `C:\...`, `D:\...` and `/...` working directories are not evidence
identity. The raw log is kept with the developer handoff. A command without a
logical cwd, exit code or raw-log SHA256 is incomplete.

## Input identity

`evidence/m1-input-identity.json` separates the immutable `q.baseIdentity`
(HEAD, tree, parent and tracked paths) from `q.worktreeObservation` (staged,
modified and untracked entries at observation time). A dirty development
worktree does not change the bound base identity, and the evidence must not
describe a dirty worktree as clean.

## Staleness

Evidence is stale when any of these changes after freeze:

- candidate HEAD, tree, parent, patch hash or patch size;
- any input hash;
- toolchain identity;
- command text, cwd, exit code or raw-log hash.

A stale record is not repaired by editing the report. The candidate must be
refrozen and re-verified.

## Old PASS rule

An old PASS cannot transfer to a new candidate. A PASS is valid only for the
exact candidate identity and input set named in its report. Reusing a PASS
after any source, test, evidence or toolchain change is a failure.

## Recomputability

The source manifest and architecture baseline are recomputable from the fixed
base tree and the current worktree. `node tools/freeze-evidence.mjs --check`
recomputes them without writing and fails on drift.

## Static compilation versus execution

`node tools/verify-foundation.mjs --clean` is the sole authoritative clean
entry. It validates the immutable `package.json` bytes and exact script set,
scans the complete local import closure before execution, runs TypeScript
typecheck/build directly, and executes only the fixed foundation tests.
`npm.cmd run verify:foundation` remains a non-authoritative compatibility check
and must not create evidence.

TypeScript typecheck/build may statically compile the existing `scripts/**` set
through `tsconfig.json`. That is not execution. The authority records zero
legacy entry executions, zero runtime imports of legacy source, and zero
environment-file reads in `evidence/static-execution-boundary.json`.

## Review checklist

- Is the candidate patch hash and byte size recorded?
- Does the prospective tree equal base tree plus patch?
- Is every command bound to a logical cwd, exit code and raw-log SHA256?
- Do input and toolchain hashes match the approved inputs?
- Are all negative controls failing for the intended reason?
- Is the old PASS rule respected?
- Is stale evidence rejected?
- Is static compilation explicitly separated from legacy execution and `.env`
  access?
- Does the report state unverified items and their allowed phase?
- Is the report authored by someone other than the implementer?

## Boundaries

- The foundation entry does not read `.env` or invoke legacy lifecycle,
  `room:doctor`, `room:qq` or `demo`.
- No real QQ/NapCat, model, TTS, network provider, production database, secret
  or `3011` listener is used.
- No P path is an M1 build input.
