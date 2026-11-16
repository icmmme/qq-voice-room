# M2 Single-`@` Acceptance

## Owner Decision

- Decision date: `2026-11-17 Asia/Shanghai`
- Decision: the offline single-`@` capability is accepted.
- Scope: this acceptance covers the permanent synthetic vertical slice only.
  It is not complete runtime migration, deployment or cutover acceptance and
  does not make `RT-MIG-01` complete.

## Frozen Candidate

- Repository: `D:\demo\qq-voice-room`
- Candidate patch:
  `Shared/vr-product-takeover-01-m2-single-mention-20261116/developer/candidate.patch`
- Patch SHA256:
  `C8588590837A03F30EF04AD86E5D78EC87D71D5ABCCCA1BC605FE2E73BDD3F1F`
- Patch bytes: `13482`
- Baseline HEAD: `ec8db7ba6991e4ef61efc949eec6c48968b6ff49`
- Accepted M1 worktree tree:
  `8d77ac22b37f4f7a330abe63eb72da9e7149e811`
- Prospective tree: `d48a7d09fe3c1f8128515859f3a960b3b639c60f`
- Changed paths (`3`):
  `.harness/CURRENT_TASK.md`, `.harness/PROJECT_STATE.md` and
  `tests/voice-room-request-lifecycle.test.ts`

The candidate is the exact patch applied to the accepted M1 worktree tree. No
old candidate or old QA/Review result transfers to this identity.

## Inputs

| Input | SHA256 |
| --- | --- |
| M2 contract `Shared/vr-product-takeover-01-m2-single-mention-20261116/M2_SINGLE_MENTION_CONTRACT.md` | `2B4F80CD2395DCC7CBD643FE62D0C33F802F0018C94B8A6234B11EB53F3D29D3` |
| Independent checklist `Shared/vr-product-takeover-01-m2-single-mention-20261116/INDEPENDENT_CHECKLIST.md` | `0DDD3C554092BD752B9D4287B33CF625438F98D109A2680463C5C93C58422CAA` |

## Independent Evidence

All evidence binds to the frozen candidate above and was produced by an owner
other than the Developer.

| Evidence | Path | SHA256 | Result |
| --- | --- | --- | --- |
| QA report | `Shared/vr-product-takeover-01-m2-single-mention-20261116/qa/QA_REPORT.md` | `8C0C585E8860E8C185A85ED890E41EEF3C5AAF8F0705A314058DC941BB070502` | `PASS 0/0/0` |
| QA result | `Shared/vr-product-takeover-01-m2-single-mention-20261116/qa/QA_RESULT.json` | `CDF8F5F29B329741194295EA23FB5F259A4C2C54A35EA70D921DE0E135890FB1` | `PASS` |
| Review report | `Shared/review-m2-single-mention-C8588590-20261116/REVIEW_REPORT.md` | `067B5712DA938D3857FA69C67B3A65752F56C5F40B31AB9E1D58812763635D01` | `PASS 0/0/0` |
| Review result | `Shared/review-m2-single-mention-C8588590-20261116/REVIEW_RESULT.json` | `22E98058D5A2E9034C71DAC2A72E4796C1A719071E2205EBB6D2EEE7B8D41B71` | `PASS` |

The QA and Review verdicts are candidate-scoped. The Developer self-check
remains `SELF_CHECK - not independent Review` and is not promoted to either
verdict.

## Acceptance Summary

| ID | Accepted synthetic result |
| --- | --- |
| `M2-SM-01` | The real parser accepts exactly one configured `@10002` mention, trims `" hello "` to `"hello"` and preserves platform message ID `800001`. |
| `M2-SM-02` | Lifecycle admission creates exactly one request and completes one `character-a` turn with one segment. |
| `M2-SM-03` | The prompt `targetId` equals the admitted SQLite message row, whose `platformId` is `800001`. |
| `M2-SM-04` | Exactly one model call and one text dispatch occur; the prompt exposes zero tools and the dispatch contains the synthetic reply. |
| `M2-SM-05` | Replaying the same parsed event returns `duplicate` and adds zero requests or dispatches. |
| `M2-SM-06` | An unmentioned parsed message returns `observed` with zero added requests or dispatches; `@all` parses to `null` and is not a character mention. |
| `M2-SM-07` | The test uses temporary SQLite, injected model and injected text dispatch only; no external service, network provider, production database or environment file is used. |

## Prerequisites

The accepted M1 predecessor is
`CC7205DF8B0B1C390D5E14A144C89088544508E9390280B6F019876F0B2EDC19`. Its
closeout Review is
`Shared/review-m1-closeout-CC7205DF-20261116/REVIEW_REPORT.md`, SHA256
`45286C8DFD8EA207A9F2DEB2659EBDB467FD589231ED634412074A96257D2636`,
`PASS 0/0/0`. That Review is historical M1 evidence and does not transfer to
the M2 candidate.

## Exclusions And Residuals

The following were not verified or authorized by this acceptance:

- real QQ/NapCat transport and live model or TTS providers;
- production database, any `.env` read and the `3011` listener;
- deploy, release replacement or cutover;
- dual-`@`, reconnect recovery and mode cancellation;
- a platform ACK or client observation of a person hearing audio;
- OS-level packet capture and the complete runtime migration path.

The M1 foundation freeze tool is not an M2 authority. P's uncommitted Ambient
additions remain `ORIGIN_UNRESOLVED_UNASSIGNED_WIP` and are not part of M2.
