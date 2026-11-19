# Project State

## Canonical Current State

<!-- CANONICAL_STATE:BEGIN -->

- Phase: `M3 - Ambient Participation`
- Task: `VR-PRODUCT-TAKEOVER-01 / M3-AMBIENT-PARTICIPATION`
- Status: `CANDIDATE_REVISED_PENDING_QA`
- M2 predecessor:
  `C8588590837A03F30EF04AD86E5D78EC87D71D5ABCCCA1BC605FE2E73BDD3F1F`
  remains accepted only for the recorded offline single-`@` capability.
- Baseline: Q HEAD `82399bc3327e8e86925b0fc2cd79e249fc7417f5`, tree
  `6b0b736c34dbc370af89c22332bb0dab2d4ff8d5`.
- Active contract:
  `Shared/vr-product-takeover-01-m3-ambient-20261118/M3_AMBIENT_CONTRACT.md`
  SHA256 `D51EB20316A23565FE9A21C99292E2EC2FF5D08AB257039E2E22D64781D6167A`.
- Contract Addendum R1:
  `Shared/vr-product-takeover-01-m3-ambient-20261118/M3_AMBIENT_CONTRACT_ADDENDUM_R1.md`
  SHA256 `6A8E7E3807AB5CA71436F8613353DDA06F6B438247079439FCA1F55A1537BB93`;
  it authorizes the qq-server production assembly and corrects the Q worktree
  baseline statement without changing the original contract.
- M3 scope: one clean-room Ambient planner seam in the existing lifecycle,
  strict public/bounded input, exact five-minute initiation threshold,
  pre-call model budget charge, transactional paused admission, paused claims
  and schema-9 cursor persistence.
- Candidate paths (8): `src/voice-room/participation-planner.ts`,
  `src/voice-room/qq-server.ts`, `src/voice-room/runtime.ts`,
  `src/voice-room/store.ts`, `tests/voice-room-request-lifecycle.test.ts`,
  `.harness/CURRENT_TASK.md`, `.harness/PROJECT_STATE.md`,
  `evidence/architecture-baseline.json` (r4-authorized content; r5 baseline
  identity refresh pending).
- Read-only: all other `src/**`, `scripts/**`, package and lock files,
  `tsconfig.json`, `.gitignore`, and existing evidence, including
  `evidence/architecture-baseline.json`.
- Review `M3-AMBIENT-CLEANROOM-REVIEW-20261119`: FAIL `0/2/4`; P1-2, P2-3
  and P2-4 were revised, and P1-1 production wiring is now included under
  Addendum R1.
- r4 independent Review: FAIL `0/1/3`. The only code defect,
  P1-R4-COOLDOWN-BYPASS, is fixed by advancing the single authoritative
  ambient attempt timestamp before every real planner call. Skip, join,
  initiate, throw, timeout and invalid output all share that path.
- Architecture: r2 Option A covered the r4 bytes. r5 changes runtime/store
  bytes; the planner remains `LEGACY_UNLAYERED_DEBT`. A new exact-candidate
  identity authorization is pending; guard exit `1` with exactly two
  `ARCH-BASELINE-CHANGED` violations for runtime/store is expected.
  `evidence/architecture-baseline.json` remains the r2-authorized content and
  is not edited.
- The candidate remains pending independent QA and Review. No PASS is claimed,
  and M2/earlier PASS results do not transfer.
- Clean-room access record:
  `P_SOURCE_ACCESS=NONE; P_METADATA_REFERENCE_DISCLOSED`.
- Product runtime, live QQ/NapCat, model, TTS, production database, `.env`,
  `3011`, deployment and cutover remain not executed and not authorized.
- Handoff path:
  `Shared/vr-product-takeover-01-m3-ambient-20261118/cleanroom/**`.

<!-- CANONICAL_STATE:END -->

## Accepted M2 Canonical State

This section is historical; it is not the current phase.

- Task: `VR-PRODUCT-TAKEOVER-01 / M2-SINGLE-MENTION`
- Status: `ACCEPTED` for the offline single-`@` capability only.
- Candidate patch SHA256
  `C8588590837A03F30EF04AD86E5D78EC87D71D5ABCCCA1BC605FE2E73BDD3F1F`,
  `13482` bytes, prospective tree
  `d48a7d09fe3c1f8128515859f3a960b3b639c60f`.
- Acceptance record: `.harness/M2_SINGLE_MENTION.md`. Its independent
  QA/Review results bind only that exact accepted candidate.

## Accepted M1 Canonical State

This section is historical; it is not the current phase.

<!-- M1_CANONICAL_STATE:BEGIN -->

- Phase: `M1 - Engineering Foundation`
- Task: `VR-PRODUCT-TAKEOVER-01 / M1`
- Status: `ACCEPTED`
- Baseline: HEAD `ec8db7ba6991e4ef61efc949eec6c48968b6ff49`, tree
  `d4fe1d8aee4682823b0bffa9c056f3606295cd67`.
- Owner accepted M1 foundation candidate
  `CC7205DF8B0B1C390D5E14A144C89088544508E9390280B6F019876F0B2EDC19`
  on `2026-11-16 Asia/Shanghai`; the acceptance scope is foundation only.
  The record is `.harness/M1_ACCEPTANCE.md` and binds the candidate patch,
  38-path set, prospective tree and independent evidence.
- Foundation authority: the direct-Node verifier
  `node tools/verify-foundation.mjs --clean`.
  `npm.cmd run verify:foundation` is compatibility only and creates no
  acceptance evidence.
- Approved install/check sequence remains Addendum 01:
  `npm.cmd ci --ignore-scripts --no-audit --no-fund`, then the direct-Node
  verifier. `npm.cmd ci` is not an installation authority.
- Addendum 02, a custom installer and the 163-row matrix are not adopted.
  `RC-F22-01` through `RC-F22-05` are `DEFERRED_NOT_ADOPTED`, not `PASS`.
- Independent QA for the `299D2890...` plan is final `FAIL 0/2/3`:
  `Shared/pa-v2-takeover-01-m1-qa/qa-fix22-final-299D2890/QA_REPORT.md`
  SHA256 `514255791E480342D0F4A9B5516CF81496BA3E02265E1983E1DB69CFE0D9497A`.
- Candidate QA for historical patch `8AD50A71...` is `FAIL 0/1/1`; its report
  is
  `Shared/pa-v2-takeover-01-m1-qa/qa-fix22-candidate-8AD50A71/QA_REPORT.md`
  SHA256 `21AA92B70C838F2D555334D8925581F26AA7951C90498F78A688D510ACA6D3A8`.
  P1 command cwd is now logical; P2 Q status is now a dirty worktree
  observation separate from base identity.
- Architecture review P1 `RC-M1-ADS-01` for the same historical patch is
  repaired in the existing guard predicate; the synthetic `.env::$DATA`
  regression requires `ERR_ACCESS_DENIED` for read, loader, Blob and copy.
  The review report is
  `Shared/architecture-m1-addendum01-guard-20261116/M1_ADDENDUM01_GUARD_ARCH_REVIEW.md`
  current-file SHA256
  `F121CCF1AA3AAC56608D17A3E50F1014FB7430D2AB855463983E88381F788222`;
  the earlier `26597C7A...` observation is stale and must not be cited.
- RC-RV-02 command evidence now binds candidate-specific architecture and
  freeze stdout logs (`AAA7B825...` and `A4F2977B...`), not the old F845/r2
  logs.
- `RC-M1-02` has a second reproduced instance: DOS 8.3 `ENV~1` is a
  final-path alias to `.env`. The one guard now uses
  `fs.realpathSync.native` before its existing sensitive-name predicate and
  has a permanent ordinary/ADS/short-name regression; this is not a
  short-name table. The architecture test now uses a table for spelling cases
  and one parameterized matrix for read/loader/Blob/copy aliases, without
  changing the 20-test count.
- The repeated `RC-M1-02` class has two fault-injection proofs in the final
  candidate package: disabling the ordinary basename check fails two tests,
  and reverting native realpath fails the short-name case; the restored guard
  passes `20/20`. These prove the tests catch the two historical escapes, not
  that a candidate is accepted.
- Root-cause merge:
  `Shared/review-fix22-rootcause-20261116/REVIEW_ROOT_CAUSE_REPORT.md`
  SHA256 `3CA636AC577CD00737CB364C68F67EFF0859A9B7FE24ECAD8628BF16558A919A`.
- Current M1 controls add an environment-file preflight before package/closure
  checks, an `--import` runtime read guard for ordinary reads, loader, Blob and
  copy entries, a `realpath` alias check, a fixed narrow test read set, exact
  per-file TAP counts, and logical P/Shared input IDs. Details:
  `.harness/M1_ROOT_CAUSES.md`.
- Hardlink source creation outside the fixed read set is denied by the test
  permission baseline. Symlink construction remains `UNVERIFIED` on the current
  Windows permission shape; it is not reported as `PASS`.
- Hardlink/FileHandle, rename/directory-copy and symlink residuals are
  non-blocking within the preflight plus fixed-read-root scope only. The guard
  is not an OS sandbox and makes no inode-level guarantee.
- Synthetic executions prove guard behavior only; they are not a candidate
  `PASS`: `.harness/M1_BEHAVIOR_VERIFICATION.md`.
- The replacement candidate handoff is
  `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/HANDOFF.md`.
- Previous candidate
  `F845EC4D29AEF8538D8F36BB9BB11F570441587A0FF326F472241FE7D5C249B0`
  remains rejected. Failure evidence remains at
  `Shared/vr-product-takeover-01-m1-execution-20261116/review-f845ec4d`,
  `Shared/pa-v2-takeover-01-m1-qa/qa-f845ec4d`, and
  `Shared/vr-m1-r2-architecture-boundary-20261116`.
- Cross-repo P attribution: uncommitted Ambient additions in P
  (`src/voice-room/store.ts` and untracked
  `src/voice-room/participation-planner.ts`) are
  `ORIGIN_UNRESOLVED_UNASSIGNED_WIP`, not an approved candidate or part of the
  active reconnect task. Preserve them in place.
- Product runtime: not implemented or executed in M1. The four runtime
  migration paths are registered in `.harness/RUNTIME_MIGRATION_ACCEPTANCE.md`.
- Web extension `VR-EXT-WEB-001`: `PRODUCT_SPEC_PENDING`,
  `implementationObligation=false`, `cutoverRequired=true`.
- Real services, production database, secrets and the `3011` listener: not used.
- M1 foundation is `ACCEPTED` for the exact candidate in
  `.harness/M1_ACCEPTANCE.md`; this is not runtime or cutover acceptance.
  The `F60648CE...` architecture failure and every earlier failure remain
  preserved and do not transfer.

<!-- M1_CANONICAL_STATE:END -->

The M1 section above is retained as accepted history. Only the section marked
`CANONICAL_STATE` is the current project state; the M1 section does not
transfer a PASS to M2.
