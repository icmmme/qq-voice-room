# Current Task

## Active Task

<!-- ACTIVE_TASK:BEGIN -->

- Task: `VR-PRODUCT-TAKEOVER-01 / M3-AMBIENT-PARTICIPATION`
- Contract revision: `1 + Addendum R1`
- Status: `CANDIDATE_REVISED_PENDING_QA`
- Author of self-check: Developer
- Self-check label: `SELF_CHECK - not independent Review`
- Contract:
  `Shared/vr-product-takeover-01-m3-ambient-20261118/M3_AMBIENT_CONTRACT.md`
- Contract SHA256:
  `D51EB20316A23565FE9A21C99292E2EC2FF5D08AB257039E2E22D64781D6167A`
- Contract Addendum R1:
  `Shared/vr-product-takeover-01-m3-ambient-20261118/M3_AMBIENT_CONTRACT_ADDENDUM_R1.md`
  SHA256
  `6A8E7E3807AB5CA71436F8613353DDA06F6B438247079439FCA1F55A1537BB93`;
  original contract bytes unchanged.
- Owner/Product direction: candidate implementation only for M3 Ambient; no
  live run, merge, deployment or cutover is authorized.
- Baseline: Q HEAD `82399bc3327e8e86925b0fc2cd79e249fc7417f5`, tree
  `6b0b736c34dbc370af89c22332bb0dab2d4ff8d5`.
- Predecessor: M2 offline single-`@` candidate
  `C8588590837A03F30EF04AD86E5D78EC87D71D5ABCCCA1BC605FE2E73BDD3F1F`
  remains accepted only for its recorded capability.
- Candidate paths (8): `src/voice-room/participation-planner.ts`,
  `src/voice-room/qq-server.ts`, `src/voice-room/runtime.ts`,
  `src/voice-room/store.ts`, `tests/voice-room-request-lifecycle.test.ts`,
  `.harness/CURRENT_TASK.md`, `.harness/PROJECT_STATE.md`,
  `evidence/architecture-baseline.json` (r4-authorized content; r5 baseline
  identity refresh pending).
- Handoff: `Shared/vr-product-takeover-01-m3-ambient-20261118/cleanroom/**`.
- Acceptance: `M3-AMB-01` through `M3-AMB-10`, including exact 300000 ms
  threshold, pre-call model spend, transactional paused admission, pause
  fence/real-pump resume, transactional stale-anchor rejection, valid-UTF-8
  planner prompt, cooldown advancement on every real planner attempt, strict
  public planner input and schema-9 cursor persistence.
- Read-only: all other `src/**`, `scripts/**`, package and lock files,
  `tsconfig.json`, `.gitignore`, and existing evidence, including
  `evidence/architecture-baseline.json`.
- Independent Review `M3-AMBIENT-CLEANROOM-REVIEW-20261119` returned FAIL
  `0/2/4`; that revision fixed P1-2 (pause lifecycle fence and resume pump),
  P2-3 (stale-anchor admission recheck) and P2-4 (prompt UTF-8 regression
  test). Under Owner-approved Addendum R1, P1-1 production `ambientPlanner`
  wiring is now included in `qq-server.ts`; `scripts/demo.ts` remains
  unchanged because it is an offline synthetic-worker demo.
- The r4 independent Review returned FAIL `0/1/3`. This r5 revision fixes
  P1-R4-COOLDOWN-BYPASS by advancing the single store-owned ambient attempt
  timestamp before every real planner call and adds a permanent skip/throw
  cooldown test. The two P2 documentation corrections cite Addendum R1 and
  the actual Q-versus-cleanroom worktree state.
- Architecture: the r2 exact-candidate authorization covered r4 and its
  byte-identical r3 business bytes. r5 changes runtime/store bytes after that
  baseline; the planner remains `LEGACY_UNLAYERED_DEBT`. A new exact-candidate
  baseline refresh is pending. Guard exit `1` with exactly two
  `ARCH-BASELINE-CHANGED` violations for runtime/store is expected and must
  not be bypassed. `evidence/architecture-baseline.json` is not edited in r5.
- Required checks: architecture guard (blocker recorded), typecheck, build,
  Ambient-focused lifecycle tests, full lifecycle test file and
  `git diff --check`.
- Explicitly forbidden: reading P/protected assets or unclean candidates;
  real QQ/NapCat, model, TTS, provider, production database, `.env`, `3011`,
  deployment, stage, commit, push or PR.
- Developer self-check is not independent QA or Review. This candidate remains
  pending both, and no PASS is claimed.
- Clean-room access record:
  `P_SOURCE_ACCESS=NONE; P_METADATA_REFERENCE_DISCLOSED`.

<!-- ACTIVE_TASK:END -->

## Accepted M2 Task Record

This section is historical; it is not the active task.

- Task: `VR-PRODUCT-TAKEOVER-01 / M2-SINGLE-MENTION`
- Status: `ACCEPTED` for the offline single-`@` capability only.
- Candidate patch SHA256
  `C8588590837A03F30EF04AD86E5D78EC87D71D5ABCCCA1BC605FE2E73BDD3F1F`,
  `13482` bytes, prospective tree
  `d48a7d09fe3c1f8128515859f3a960b3b639c60f`.
- Acceptance record: `.harness/M2_SINGLE_MENTION.md`. Independent QA/Review
  bind only that exact candidate and do not transfer to M3.

## Accepted M1 Task Record

This section is historical; it is not the active task.

<!-- M1_TASK_RECORD:BEGIN -->

- Task: `VR-PRODUCT-TAKEOVER-01 / M1`
- Contract revision: `2 + Addendum 01`
- Status: `ACCEPTED`
- Author of self-check: Developer
- Self-check status: historical; see `.harness/M1_ACCEPTANCE.md`
- Contract:
  `Shared/vr-product-takeover-01-m1-execution-20261116/M1_EXECUTION_CONTRACT.md`
- Contract SHA256:
  `E04ED3D7BE60E015BA59E60DFDCBADBCED5DB950691E503D4FE7B5C97F711E8C`
- Addendum 01:
  `Shared/vr-product-takeover-01-m1-execution-20261116/M1_EXECUTION_CONTRACT_ADDENDUM_01.md`
- Addendum 01 SHA256:
  `FCD519C1EA2616453FA400BB7094780B008BDD6F4FE5507F5D184592C85283FD`
- Owner approval:
  `Shared/vr-product-takeover-01-m1-execution-20261116/OWNER_APPROVAL_ADDENDUM_01.json`
- Owner approval SHA256:
  `7B1B5FEEF98B3EB0B5E9CA3E277E055A25DC682DC0E4CA26E4FA12C1531E23E6`
- Baseline HEAD: `ec8db7ba6991e4ef61efc949eec6c48968b6ff49`
- Baseline tree: `d4fe1d8aee4682823b0bffa9c056f3606295cd67`
- Allowed new paths: `AGENTS.md`, `.harness/**`, `docs/architecture/**`,
  `evidence/**`, `tools/**`, `tests/**`
- Conditional path: `package.json` only for `verify:foundation`
- Read-only paths: existing `src/**`, `scripts/**`, existing tests,
  `tsconfig.json`, `.gitignore`, README, examples, `.env.example`
- Acceptance: `M1-AC-01` through `M1-AC-09`
- Foundation authority: `node tools/verify-foundation.mjs --clean`
- Approved install/check sequence:
  `npm.cmd ci --ignore-scripts --no-audit --no-fund`, then
  `node tools/verify-foundation.mjs --clean`. Only the direct-Node verifier is
  the foundation authority; `npm.cmd ci` is not an installation authority.
- Compatibility only: `npm.cmd run verify:foundation`; it is
  non-authoritative and creates no candidate evidence.

## Closeout Acceptance

- Owner accepted the exact M1 foundation candidate
  `CC7205DF8B0B1C390D5E14A144C89088544508E9390280B6F019876F0B2EDC19`
  on `2026-11-16 Asia/Shanghai`; scope is M1 foundation only.
- Acceptance record: `.harness/M1_ACCEPTANCE.md`. It records the accepted
  patch bytes, 38-path set, prospective tree, QA/architecture/Review evidence
  and M1-AC-01 through M1-AC-09.
- The developer self-check remains labelled as such and is not an independent
  Review; independent QA, architecture and Review results are bound only to
  the accepted candidate in that record and do not transfer to another patch.

## Current remediation

- Candidate QA for historical patch
  `8AD50A71480AC85BB6B36F78832B3FBDD39190F89CA2482CF1D799A758E19BC5`:
  `FAIL 0/1/1`, report
  `Shared/pa-v2-takeover-01-m1-qa/qa-fix22-candidate-8AD50A71/QA_REPORT.md`
  SHA256 `21AA92B70C838F2D555334D8925581F26AA7951C90498F78A688D510ACA6D3A8`.
- Architecture review for the same historical patch: P1-ARCH-01/RC-M1-ADS-01,
  report
  `Shared/architecture-m1-addendum01-guard-20261116/M1_ADDENDUM01_GUARD_ARCH_REVIEW.md`
  current-file SHA256
  `F121CCF1AA3AAC56608D17A3E50F1014FB7430D2AB855463983E88381F788222`.
  The earlier `26597C7A...` observation was overwritten and must not be cited
  as the current file version.
- Candidate architecture review for `RC-M1-02`, report
  `Shared/architecture-fix22-candidate-F60648CE/M1_ARCHITECTURE_CANDIDATE_REVIEW.md`
  SHA256
  `C9A3DE40C1ECDEF9D507FF2CC314CD0F087DC536691C6E526CDE0ACEE504EDFF`.
  It independently reproduced the second instance: Windows DOS 8.3 `ENV~1`
  reached the synthetic `PROBE_VALUE` through a plain `path.join` alias.
- F22-CAND-01 is repaired by logical command-record cwd and a validator that
  accepts `Q`, `P` or `Shared/...` and rejects host-absolute `C:\...`,
  `D:\...` and `/...` cwd. The permanent regression is in
  `tests/foundation/evidence.test.mjs`.
- F22-CAND-02 is repaired by separating immutable `q.baseIdentity` from a
  live `q.worktreeObservation` (`1` modified tracked path, `6` untracked
  entries, `0` staged). The observation is not described as clean.
- P1-ARCH-01/RC-M1-ADS-01 is repaired in the existing `isSensitiveEnvPath`
  predicate by normalizing NTFS ADS, trailing dot/space and equivalent
  basenames before the wrapped read, loader, Blob and copy entries. The
  permanent synthetic regression in `architecture-guard.test.mjs` requires
  `ERR_ACCESS_DENIED` and no copied marker for `.env::$DATA`; guard behavior
  is otherwise unchanged.
- RC-RV-02 is repaired by binding `evidence/command-records.json` to
  candidate-specific architecture and freeze stdout logs. The current raw
  stdout SHA256 values are `AAA7B825...` (architecture) and `A4F2977B...`
  (freeze check); the raw files are in the replacement candidate package.
  The old F845/r2 logs are not reused as current-candidate evidence.
- RC-M1-02 has a second independently reproduced instance: Windows DOS 8.3
  `ENV~1` reaches the ordinary `path.join` alias class. The guard now resolves
  the final path with `fs.realpathSync.native` before its one sensitive-name
  predicate; it is not a short-name special case. The `architecture-guard`
  spelling cases are table-driven and the ordinary/ADS/short-name
  read/loader/Blob/copy cases are one parameterized matrix. The permanent
  regression still has 20 TAP tests and covers all three alias classes.
  Architecture review SHA256
  `C9A3DE40C1ECDEF9D507FF2CC314CD0F087DC536691C6E526CDE0ACEE504EDFF`.
- Two deliberate fault-injection runs prove the retained tests catch both real
  instances. Disabling the ordinary sensitive-basename check fails the
  predicate and ordinary-read tests (`18` pass, `2` fail); replacing
  `realpathSync.native` with the short-name-unaware function fails the
  short-name matrix case (`19` pass, `1` fail). Restoring the guard returns
  `20/20`. Raw TAP, exits and hashes are in the final candidate package under
  `fault-injection/`.
- Independent QA final:
  `Shared/pa-v2-takeover-01-m1-qa/qa-fix22-final-299D2890/QA_REPORT.md`
  SHA256 `514255791E480342D0F4A9B5516CF81496BA3E02265E1983E1DB69CFE0D9497A`;
  result `FAIL 0/2/3`.
- Root-cause merge:
  `Shared/review-fix22-rootcause-20261116/REVIEW_ROOT_CAUSE_REPORT.md`
  SHA256 `3CA636AC577CD00737CB364C68F67EFF0859A9B7FE24ECAD8628BF16558A919A`;
  map SHA256
  `B8FED2F577FB607ED84C6B248FDFD9ADCAFAD00FE4FCA1B1FF6E91E9F501F2C8`.
- Owner decision: Addendum 02, a custom installer and the 163-row matrix are
  not adopted. The five F22 plan root causes are
  `DEFERRED_NOT_ADOPTED`, never `PASS`.
- Current work: the M1 facts are synchronized; the environment-file preflight,
  runtime guard, narrowed test read set, exact per-file TAP counts and logical
  P/Shared input IDs are implemented.
- Guard closure includes ordinary fs reads, `process.loadEnvFile`,
  `fs.openAsBlob`, copy entries and native final-path alias resolution. The
  test process no longer receives the whole repo as a read root. A synthetic
  hardlink source outside the fixed read set is denied. Symlink construction
  remains `UNVERIFIED` on the current Windows permission shape; it is not
  `PASS`.
- The guard is defence-in-depth, not OS isolation. Hardlink/FileHandle,
  rename/directory-copy and symlink residuals remain limited by the
  fail-closed preflight and fixed test read roots; no inode-level guarantee is
  claimed.
- Synthetic behavior evidence, not a candidate `PASS`, is indexed in
  `.harness/M1_BEHAVIOR_VERIFICATION.md`. The frozen candidate handoff is
  `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/HANDOFF.md`.
- New root causes and controls: `.harness/M1_ROOT_CAUSES.md`.
- Synthetic behavior evidence only: `.harness/M1_BEHAVIOR_VERIFICATION.md`.
- Later runtime acceptance, not executed in M1:
  `.harness/RUNTIME_MIGRATION_ACCEPTANCE.md`.

## Preserved history

- Previous candidate
  `F845EC4D29AEF8538D8F36BB9BB11F570441587A0FF326F472241FE7D5C249B0`
  (245,706 B, 34 paths, prospective tree
  `47396b0ad970fe20d13c6a6ee31c3445c277166a`) remains rejected.
- Preserved failure evidence:
  `Shared/vr-product-takeover-01-m1-execution-20261116/review-f845ec4d`,
  `Shared/pa-v2-takeover-01-m1-qa/qa-f845ec4d`, and
  `Shared/vr-m1-r2-architecture-boundary-20261116`.
- P is read-only at HEAD
  `442b34a286376ddd2457f93160e05dda89a99fd8`, tree
  `0ff7d0dd57ed219849e82c320ed71305429e2cb6`. Its uncommitted Ambient
  additions are `ORIGIN_UNRESOLVED_UNASSIGNED_WIP`; preserve them in place.
- M1-AC-09 is complete for the accepted patch: independent QA, architecture
  and Review are recorded in `.harness/M1_ACCEPTANCE.md`; the self-check label
  remains separate. This does not extend to runtime.
- Not verified: real platform behavior, native ConsumerIdentity/Win32 behavior,
  and product runtime; these are outside M1 foundation acceptance.
- Historical QA, architecture and Review outcomes remain historical and do
  not transfer to a different patch or to runtime acceptance.

This task does not authorize M2, real QQ/NapCat, model, TTS, Pi SDK, production
database, data migration, release replacement, cutover, stage, commit, push or
deploy.

<!-- M1_TASK_RECORD:END -->
