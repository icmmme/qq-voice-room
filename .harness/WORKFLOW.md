# Repo Harness Workflow

## 1. Contract

Every task starts from one frozen contract linked from
`.harness/CURRENT_TASK.md`. The contract defines the scope, allowed paths,
acceptance criteria, checks, risks, and required candidate evidence.

## 2. Development

The Developer:

1. records the baseline identity and a first failure or premise;
2. implements only inside the contract scope;
3. runs the checks in the active contract in the specified order. Do not add
   M1 foundation checks to other tasks unless their contract requires them;
4. freezes one candidate patch and its prospective tree;
5. writes a handoff with commands, cwd, exit codes and raw-log hashes.

The Developer self-check is labeled `SELF_CHECK` and is not a Review verdict.

## 3. Freeze

A candidate is frozen only when:

- patch SHA256 and byte size are recorded;
- the prospective tree is computed;
- the base tree plus the patch reproduces the prospective tree;
- all required commands have exit `0` unless a documented expected-negative
  case requires non-zero;
- no unauthorized path changed.

After freeze, do not edit files in the candidate. A change to the patch or its
bound inputs requires new evidence. A later status update can cite results for
the original candidate, but those results do not verify the update.

## 4. Independent QA

QA receives the frozen patch and input hashes, applies the candidate, reruns the
agreed commands and records its own raw logs. QA may not modify the candidate.
Its report lists scope, commands, exit codes, test counts, unverified items and
findings.

## 5. Independent Review

Review receives the same frozen candidate and QA report. Review checks:

- architecture and contract conformance;
- negative controls fail for the intended reason;
- evidence binds to this candidate and input set;
- privacy, cancellation, retry and external-effect boundaries;
- unresolved items have an allowed phase.

Review is authored by someone other than the implementer.

## 6. Acceptance

Only the Owner accepts a phase. Independent QA and Review PASS is necessary but
not sufficient. Record which required checks remain unverified. Confirmation of
local results does not accept a task that also requires hosted validation. A
new candidate requires new QA and Review.

## 7. Status vocabulary

- `IN_PROGRESS` — implementation not frozen.
- `REVIEW_PENDING` — candidate frozen, with required verification, independent
  QA or Review, or Owner acceptance still pending.
- `REVIEW_FAILED` — independent review found blocking findings.
- `ACCEPTED` — the Owner accepted the phase.

Never write `PASS` for independent Review unless an independent reviewer
produced it.

## 8. User-path verification

A product capability is not verified by unit tests alone. Each capability
names at least one path from the real trigger to the observable result, linked
to the existing feature map or acceptance ID.

- Run the path through the real parser, policy, runtime, store and transport
  seams. Replace only the external model and platform boundaries.
- Record connection health, authoritative inbound acceptance, request
  acceptance, generation, platform ACK and client observation separately.
- A platform ACK is not proof that a person heard the audio.
- Real client voice evidence comes from the Owner or an explicitly authorized
  tester; a synthetic transport result cannot replace it.
- For the runtime migration, the required paths are single `@`, dual `@`,
  reconnect recovery, and mode cancellation. M1 only records these paths; it
  does not execute product runtime behavior. The register is
  `.harness/RUNTIME_MIGRATION_ACCEPTANCE.md`.

## 9. Repeated errors become structural constraints

When the same failure class appears in more than one review, merge the findings
under one root-cause ID before adding another control.

1. State the failing behavior and a minimal reproducible counterexample.
2. Choose the earliest enforceable layer: architecture boundary, type, static
   check, runtime guard, then behavior test. Documentation is the last layer,
   not the only proof.
3. Add one permanent positive/negative regression for that root cause.
4. Re-run only affected evidence. A new root cause or a cross-boundary change
   widens the rerun.
5. Do not add a matrix row merely because a reviewer phrased the same defect
   differently.

The root-cause ID and the affected controls belong in the task handoff and
Review report. Stale evidence remains historical evidence; it is never
relabelled as a current PASS. The current merge is
`.harness/M1_ROOT_CAUSES.md`.

## 10. Owner handoff

Keep the Owner-facing report short and reuse these facts rather than creating
another dashboard:

- current capability;
- remaining blockers, grouped by root cause;
- behavior verified, with the evidence boundary;
- what was not checked;
- next responsible role;
- decisions that only the Owner can make, with options, cost and a
  recommendation when a real choice exists.

Put candidate hashes and command logs in the evidence package, not in the
summary. A plan review, implementation test or platform ACK is not worded as
phase acceptance. Synthetic behavior evidence is indexed in
`.harness/M1_BEHAVIOR_VERIFICATION.md`.
