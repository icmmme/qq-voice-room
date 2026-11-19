# M3 Ambient Participation Acceptance

## Owner Decision

- Decision date: `2026-11-19 Asia/Shanghai`
- Decision: the offline Ambient participation capability is accepted and
  approved for commit, push and merge.
- Scope: offline synthetic capability only. It is not runtime migration,
  deployment, cutover or live acceptance and does not make `RT-MIG-01`
  complete.
- The Owner explicitly accepted the residual provenance limitation recorded
  below: the clean-room read log is reconstructed from thread history, not
  system-audited, and therefore cannot prove the absence of unlogged P reads.
  Decision record:
  `Shared/vr-product-takeover-01-m3-ambient-20261118/owner-decisions-r1/OWNER_DECISION_R6_MERGE.md`,
  SHA256 `4F2B2073787EA6A776F27A775F63B3FD73D90195D7E8F1E0D11B1028434404DD`,
  `2427` bytes.

## Frozen Candidate

- Repository: `D:\demo\qq-voice-room-cleanroom`
- Candidate patch:
  `Shared/vr-product-takeover-01-m3-ambient-20261118/cleanroom/combined-candidate-r6.patch`
- Patch SHA256:
  `FD858A3710AF70A0434AFF81C665837A194FAA0A1F6A701DC1678D350D488D6E`
- Patch bytes: `109822`
- Baseline HEAD: `82399bc3327e8e86925b0fc2cd79e249fc7417f5`
- Baseline tree: `6b0b736c34dbc370af89c22332bb0dab2d4ff8d5`
- Prospective tree: `9cb4ad45b740ec19a1758eebf1ee1fe81fbc3d83`
- Changed paths (`8`): `.harness/CURRENT_TASK.md`,
  `.harness/PROJECT_STATE.md`, `evidence/architecture-baseline.json`,
  `src/voice-room/participation-planner.ts`, `src/voice-room/qq-server.ts`,
  `src/voice-room/runtime.ts`, `src/voice-room/store.ts`,
  `tests/voice-room-request-lifecycle.test.ts`
- Candidate package: `164` files / `999151` bytes; manifest `163` entries /
  `B879926B71F8149D6AEE3B29A6F68ECD7F27217AA4E17C8D7046426B82C25541`;
  missing/bad/unlisted/duplicate = `0/0/0/0`.

The candidate is a clean-room implementation. The archived
provenance-unclean candidates (`2D4D1702...`, `5A3A55CB...`, tree
`d3846c82...`) are not reused and no old QA or Review result transfers.

## Inputs

| Input | SHA256 |
| --- | --- |
| M3 contract `Shared/vr-product-takeover-01-m3-ambient-20261118/M3_AMBIENT_CONTRACT.md` | `D51EB20316A23565FE9A21C99292E2EC2FF5D08AB257039E2E22D64781D6167A` |
| Contract Addendum R1 `Shared/vr-product-takeover-01-m3-ambient-20261118/M3_AMBIENT_CONTRACT_ADDENDUM_R1.md` | `6A8E7E3807AB5CA71436F8613353DDA06F6B438247079439FCA1F55A1537BB93` |
| Owner decision `.../owner-decisions-r1/OWNER_DECISION_R6_MERGE.md` | `4F2B2073787EA6A776F27A775F63B3FD73D90195D7E8F1E0D11B1028434404DD` |

Addendum R1 authorizes the `qq-server.ts` production assembly path and
corrects the Q worktree statement; the original contract bytes are unchanged.

## Independent Evidence

All evidence binds to the frozen candidate above and was produced by an owner
other than the Clean-room Implementer.

| Evidence | Path | SHA256 | Result |
| --- | --- | --- | --- |
| QA report | `Agents/agent-8d66ea9e-6df8-4c00-99c0-b2f0103968a9/private/rt-mig-01/m3-ambient-cleanroom-r6-qa-20261119-1400/deliverable/QA_REPORT.md` | `3E85057A42BDD0884A975FAC0EB859A8DC6C01BA0B82364C022AF12CAF125998` | `CONDITIONAL_PASS 0/0/1` |
| QA result | same directory `QA_RESULT.json` | `55EEE38A100A1D9BECDA24F357CE16FB8B1F60C900103980E0344942FEDBF94A` | `CONDITIONAL_PASS` |
| Review report | `Agents/agent-8e056aca-caf3-4cb0-b332-dd1566cd3b2c/m3-ambient-cleanroom-r6-review-20261119/REVIEW_REPORT.md` | `E1EE2FA246609E7F52F427B27FD6E0441A5013E89140822CAC3FFA6765BD7F93` | `CONDITIONAL PASS 0/0/1` |
| Review result | same directory `REVIEW_RESULT.json` | `0963D8D17ED703FDC197705065BC1AF72CA1AEEB3C6DBDDDF6A46725836B1484` | `CONDITIONAL PASS` |
| Provenance R3 | `Shared/vr-product-takeover-01-m3-ambient-20261118/provenance-boundary-review-r3/PROVENANCE_BOUNDARY_REVIEW_R3.md` | `9F05876DFD062DC79BDF31F9EB9E4BFB4382E78FA8E9A9771DA5E15EE21DC790` | `CONDITIONAL` |
| Provenance R3 readback | same directory `PACKAGE_READBACK.json` | `827E8F9125F0BEA7226E833BB71589EB794B98E4D1988A5CCB61FA6FB4FBB27F` | corrected totals only |

Author checks (not independent): guard exit `0` with `43` entries / `62`
files / `violations []`; typecheck `0`; build `0`; Ambient `17/17`;
full lifecycle `41/41`; `git diff --check` `0`.
Independent QA re-ran: guard, typecheck, build, Ambient `41/41`, lifecycle
`41/41`, independent probes `167/167`, including cooldown advancement on
skip, throw, timeout, invalid output, join and initiate.

Architecture baseline authorization:
`Shared/vr-product-takeover-01-m3-ambient-20261118/architecture-baseline-review-r3`
(`13` files / `93385` bytes; `SHA256SUMS`
`78A9016AD2C3204367290EAF46FF65CFEE7A39315B213CD948C5728F8272E6EB`).
It refreshed only `runtime.ts` and `store.ts` identity; the planner remains
`LEGACY_UNLAYERED_DEBT` with an M5 exit and the other `41` entries are
unchanged. Authorized next baseline:
`BE6DC87073B257208970BA12E9C5CA7ACB426D10197BD252BEDDA1D631076722`.

## Merge

- Pull request: `https://github.com/icmmme/qq-voice-room/pull/2`
- Merge commit: `0f53999f9c3e8adf90829d31eea5171f750264e8`
- `origin/main` tree after merge:
  `9cb4ad45b740ec19a1758eebf1ee1fe81fbc3d83` (independently re-derived)
- Diff `82399bc..0f53999`: exactly the `8` candidate paths.
- The previously local-only baseline commit `82399bc` (adds `.agents/`) was
  published to `main` first so the PR diff stays limited to the candidate.

## Acceptance Summary

| ID | Accepted synthetic result |
| --- | --- |
| `M3-AMB-01` | Opportunity comes from the latest real-human public message only after `ambientQuietMs`; before that `allowInitiate=false` and `initiate` is rejected. |
| `M3-AMB-02` | Planner input is bounded and public-only: one anchor, at most 12 history rows, configured public character metadata and fixed constraints. |
| `M3-AMB-03` | Output is strictly `skip`, `join` or `initiate`; join/initiate carry one or two distinct configured IDs; invented or duplicate IDs, wrong keys and extra fields fail closed. |
| `M3-AMB-04` | `skip` produces zero lifecycle requests and zero generation, TTS or dispatch calls. |
| `M3-AMB-05` | Valid `join`/`initiate` enters the existing lifecycle FIFO with the anchor row, configured-character order and selected delivery mode; no synthetic user row. |
| `M3-AMB-06` | Mode, paused, online, quiet threshold, cooldown, model budget and an existing active request remain hard gates; the planner cannot change them. |
| `M3-AMB-07` | Rejection, timeout, thrown error or invalid JSON records one `technical_defer` outcome, at most one planner call, and no generation, TTS or transport call. |
| `M3-AMB-08` | Concurrent or repeated opportunities are single-flight and idempotent; validated cursor and lifecycle admission both deduplicate the same anchor. |
| `M3-AMB-09` | Store stays schema version `9`; no new table or column; cursor survives reopen through `room_meta`. |
| `M3-AMB-10` | Existing single-`@`, lifecycle, cancellation, recovery and delivery tests remain green. |

## Exclusions And Residuals

- The open P2 from QA/Review is the reconstructed clean-room read log; it is
  accepted by the Owner as a disclosed traceability limitation, not as
  evidence of copying. The package contains `0` hard P-path hits.
- The Q main worktree `D:\demo\qq-voice-room` still carries `7` pre-existing
  dirty entries that this task did not create and did not modify; cleanup
  needs separate Owner approval.
- Not verified or authorized: real QQ/NapCat transport, live model/TTS
  providers, production database, any `.env` read, the `3011` listener,
  deploy, release replacement, cutover, and live listener observation.
- `RT-MIG-01` and `ConsumerIdentity` remain `UNVERIFIED`; the live contract
  line remains `DRAFT_R8_NOT_FROZEN` with live authorization `NONE`.
