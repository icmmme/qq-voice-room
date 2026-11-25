# Project State

## Canonical Current State

<!-- CANONICAL_STATE:BEGIN -->

- Phase: `Product CI`
- Active task: `VR-CI-01 / PRODUCT-PR-GATE`
- Active status: `REVIEW_PENDING`. Local QA and Review are complete. The full
  contract is not accepted.
- Active contract: [Product CI for pull requests](CI_PRODUCT_PR_GATE.md)
- Baseline: `3767178596ced9019c8f2f2936a95ac87b55ff62`, tree
  `3e0700348b08124503782af82768e22bcb83bd8e`.
- Candidate: [Product CI PR](https://github.com/icmmme/qq-voice-room/pull/9),
  head `7fc54b6cf9e972e535b06db44fe0ece747643f07`. GitHub squash-merged it
  into `main` as `f4408e7f4505fe7269aa3a14826eb39ce548e69b`. The merged tree
  `17567aac6a8b922f8c989a012dad6c25132e6328` matches the tested candidate.
  The [M5 Fix-3 offline closeout](#m5-fix-3-offline-closeout) remains the
  accepted predecessor.
- Verified: independent local QA and Review cover this frozen candidate. The
  [first hosted run](https://github.com/icmmme/qq-voice-room/actions/runs/45560564520)
  used the same tree and passed all 114 tests and the architecture guard. It
  installed from a cache miss and saved the cache. The closed
  [control PR](https://github.com/icmmme/qq-voice-room/pull/10) verified all
  three expected failures and same-PR cancellation. None of its fault
  injections entered the candidate.
- Unverified: docs-only PR triggering, isolation between concurrently active
  PRs, and a hosted npm cache hit. Do not make the check required before the
  contract's hosted verification is complete and the Owner authorizes it.
- Owner decision: on `2026-11-25` (`Asia/Shanghai`), the Owner confirmed the
  local result and separately authorized the hosted runs, the workflow merge,
  and this docs-only PR. Those decisions do not accept the full task or
  authorize required checks, deployment, or production changes.
- Evidence: `Shared/vr-ci-01-product-pr-gate/`. Candidate and report hashes
  remain in the evidence package. Evidence for the frozen candidate does not
  transfer to a later documentation patch.

<!-- CANONICAL_STATE:END -->

## M5 Fix-3 offline closeout

- Decision: on `2026-11-24 Asia/Shanghai`, the Owner replied `确认离线结案`
  in the task conversation to confirm acceptance of the offline contract only.
- Accepted implementation: `e97a3ef1dd4c459c34b53c59bff8340cb6534779`.
  The existing merge commit `aa4c5d2dce803ee7f398940809d19ef0861b24a4`
  has the same tree `e78df6eecf5dc77c14f3d1f7f36a5a09cb4b584b`.
- Frozen patch: `candidate-fix3.diff`, `108093` bytes, SHA256
  `2960F0E97CB44131FFEBE8347DA4B865E99ACD09AEA0389EE35EFD6091294886`.
  Replay from the baseline reproduced the accepted tree and matched all seven
  declared postimages by Git blob, byte count and SHA256.
- Evidence package: `Shared/vr-product-takeover-01-m5-fix3-20261121`.
  The root, QA and Review manifests matched all listed files (`45/45`,
  `18/18` and `19/19`, respectively).

| Evidence in package | SHA256 | Result |
| --- | --- | --- |
| `qa/QA_REPORT.md` | `F33235115C338569463D1736FCC84B5CF055026A3258169EBD02F4C951F8FB00` | Independent QA `PASS`; B3-01 through B3-08; focused `12/12`, full `114/114`; no P0/P1/P2 findings |
| `review/REVIEW_REPORT.md` | `C1D48188AE050507D59B5A1DAD15DA5D2E3A184E59082CB28827C6F5941FB40F` | Independent Review `PASS` for the same patch and tree; no P0/P1/P2 findings |
| `qa/16-r2-independent-database-probe.log` | `C111AC5408E29E5ED30FF87653D5E2DEDD04E7961AC69530E3BD234CCB216895` | Exit `0`; synthetic backup and restore reopened schema 9 with seven readable body fields and no foreign-key violations |

This section records a post-acceptance decision. It is not part of the frozen
candidate and does not transfer the PASS to the current working tree. The
cutover report's historical `READY` result is separate. This decision does not
verify live client delivery or authorize production cleanup, scheduling, release,
cutover or task activation.

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
