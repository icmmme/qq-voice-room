# Project State

## Canonical Current State

<!-- CANONICAL_STATE:BEGIN -->

- Phase: `M2 - Runtime Migration, first capability`
- Task: `VR-PRODUCT-TAKEOVER-01 / M2-SINGLE-MENTION`
- Status: `ACCEPTED`
- Owner opened the formal M2 authorization node in chat on
  `2026-11-16 Asia/Shanghai`; the exact frozen candidate was accepted for the
  offline single-`@` capability on `2026-11-17 Asia/Shanghai`; complete runtime
  migration, deployment and production cutover remain separately gated.
- M1 predecessor: candidate
  `CC7205DF8B0B1C390D5E14A144C89088544508E9390280B6F019876F0B2EDC19`
  accepted; closeout Review `PASS 0/0/0`, report SHA256
  `45286C8DFD8EA207A9F2DEB2659EBDB467FD589231ED634412074A96257D2636`.
- Baseline: HEAD `ec8db7ba6991e4ef61efc949eec6c48968b6ff49`, accepted M1
  worktree snapshot `8d77ac22b37f4f7a330abe63eb72da9e7149e811`.
- M2 candidate: patch
  `C8588590837A03F30EF04AD86E5D78EC87D71D5ABCCCA1BC605FE2E73BDD3F1F`,
  `13482` bytes, prospective tree
  `d48a7d09fe3c1f8128515859f3a960b3b639c60f`; the acceptance record is
  `.harness/M2_SINGLE_MENTION.md`.
- Active contract:
  `Shared/vr-product-takeover-01-m2-single-mention-20261116/M2_SINGLE_MENTION_CONTRACT.md`
  SHA256 `2B4F80CD2395DCC7CBD643FE62D0C33F802F0018C94B8A6234B11EB53F3D29D3`.
- M2 scope: add one permanent repository test for the offline single-`@`
  vertical slice through the real parser, checked configuration, lifecycle
  admission, temporary SQLite, generation worker, target binding and one
  injected text dispatch.
- Read-only: all existing `src/**`, `scripts/**`, package and lock files,
  `tsconfig.json`, `.gitignore`, the accepted M1 candidate and its evidence.
- M2-SM-01 through M2-SM-07 are implemented in the permanent lifecycle
  test; independent QA and independent Review both report `PASS 0/0/0` for the
  exact frozen candidate. This is acceptance of the offline single-`@`
  capability only; it is not complete runtime migration, deployment or
  cutover acceptance.
- Candidate identity, command records and raw-log hashes are recorded in
  `Shared/vr-product-takeover-01-m2-single-mention-20261116/developer/SELF_CHECK.md`.
- The M1 foundation freeze tool remains evidence for the accepted M1 snapshot;
  it is not an M2 authority after the active Harness task changes.
- Product runtime, live QQ/NapCat, model, TTS, production database, `.env`,
  `3011`, deployment and cutover remain not executed and not authorized.
- P's uncommitted Ambient additions remain
  `ORIGIN_UNRESOLVED_UNASSIGNED_WIP` and are not part of M2.

<!-- CANONICAL_STATE:END -->

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
