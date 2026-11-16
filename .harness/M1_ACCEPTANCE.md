# M1 Foundation Acceptance

## Owner Decision

- Decision date: `2026-11-16 Asia/Shanghai`
- Decision: M1 foundation candidate accepted; no runtime migration or cutover
  is included.
- Accepted candidate: `CC7205DF8B0B1C390D5E14A144C89088544508E9390280B6F019876F0B2EDC19`
- Patch bytes: `308038`
- Changed paths: `38`
- Path-set SHA256:
  `F24289A3C57C020F4DB84EDB7418BBCFBE2622159E95204F65A0AC38042C35C8`
- Prospective tree: `95ca9ca9e33127f9a339a87cb2e44b46e2d604d8`
- Candidate handoff:
  `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/HANDOFF.md`
  SHA256 `9EFC54EE064BD8DCBDB0073CE1B6CE52364940A1A286F93EEB77F3E3695EEEEF`
- Candidate package manifest:
  `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/SHA256SUMS`
  SHA256 `A91754F1A3395336E89ED997A4334935FE11D917B7F42E731CB6C4C617B79E1E`

The acceptance is bound to the exact patch, path set and prospective tree
above. It does not transfer an earlier result to another candidate and does
not authorize a live-service, production, M2 or cutover action.

## Independent Evidence

The following independent results all bind to the same accepted patch and
prospective tree:

| Evidence | Path | SHA256 | Result |
| --- | --- | --- | --- |
| QA | `Shared/pa-v2-takeover-01-m1-qa/qa-fix22-candidate-CC7205DF/QA_REPORT.md` | `EF700AAFF3E32C6DBE90A9C4E0EDFED2CC227D0C62AAD1279398FED375E08A66` | `PASS 0/0/0` |
| Architecture | `Shared/architecture-fix22-candidate-CC7205DF/ARCH_REVIEW.md` | `59394F7B20CB8EEF2A16DAC43DF526B4FEC8FFFA28549B203A0D0683C8722C86` | `PASS 0/0/0` |
| Review | `Shared/review-fix22-candidate-CC7205DF/REVIEW_REPORT.md` | `9AC3E64586F4E8B4F1EF37E97B1AC3E13CF121841DF3B55005CEC754A36BDC57` | `PASS 0/0/0` |

These are independent evidence for this candidate. The developer
`SELF_CHECK - not independent Review` label remains unchanged; self-check
material is not promoted to independent Review.

## Acceptance Summary

| Item | Disposition | Accepted foundation summary |
| --- | --- | --- |
| M1-AC-01 Independence | PASS | Q/P identities are exact; no P path is copied into the 38-path candidate; the synthetic foundation boundary records no legacy runtime execution, no legacy runtime import and no environment-file read. |
| M1-AC-02 History and preservation | PASS | Q root base and 56 tracked paths are bound; the candidate is additive/modified only within the declared paths; history and protected assets are preserved. |
| M1-AC-03 Clean verification | PASS | `npm.cmd ci --ignore-scripts --no-audit --no-fund` and the direct-Node foundation authority pass in the clean clone; the preflight fails before package/closure/tests for a synthetic root environment file. |
| M1-AC-04 Harness | PASS | Exactly one active task and one canonical state are present; templates and role separation are validated; the developer self-check is labelled separately. |
| M1-AC-05 Feature Map | PASS | The 61-ID map remains 56 active, 5 historical, one pending Web extension; `VR2-021` remains negative-only. |
| M1-AC-06 Architecture Guard | PASS | The architecture guard and its registered baseline pass; the final-path environment check covers the tested ordinary, ADS and DOS short-name aliases. |
| M1-AC-07 Evidence identity | PASS | Candidate inputs, command cwd/exit/raw-log hashes, patch/path-set/tree identity and the separate dirty-worktree observation are machine-checked. |
| M1-AC-08 Synthetic ConsumerIdentity and S2 | PASS | Pure injected-state tests cover normal/abnormal/UNKNOWN recovery, late ACK, owner death, empty `dataDir` and no-replay behavior without network or child-process use. |
| M1-AC-09 Review separation | PASS | QA, architecture and Review bind to the same candidate; the implementer self-check is not used as the independent Review. |

## Known Limits

- Symlink construction and read remains `UNVERIFIED` on the tested Windows
  permission shape; it is not a PASS.
- Hardlink/FileHandle, rename/directory-copy and junction behavior are not an
  operating-system inode-isolation guarantee. They are bounded only by the
  fail-closed preflight and fixed test read roots.
- DOS 8.3 `ENV~1` evidence is bound to the current test host and synthetic
  fixture; it is not a claim for every Windows volume or filesystem.
- The live runtime, product transport, client, service, model, TTS, database
  and `3011` listener were not executed or contacted.
- P working-tree content was not reviewed. Its uncommitted Ambient additions
  remain `ORIGIN_UNRESOLVED_UNASSIGNED_WIP` and were preserved in place.

## Preserved History

- The historical F845 candidate remains rejected; its failure evidence is
  preserved and does not transfer.
- The historical F60648CE architecture failure, including the short-name
  finding, remains preserved and does not transfer to this candidate.
- The stale final2 package and all earlier QA plan/candidate failures remain
  historical evidence only; they are not relabelled PASS and do not bind to
  this acceptance.
- Addendum 02, a custom installer and the 163-row matrix remain
  `DEFERRED_NOT_ADOPTED`; this acceptance keeps Addendum 01 as the approved
  install/check sequence and the direct-Node verifier as the foundation
  authority.

## Runtime Boundary

The four later runtime migration paths are registered only in
`.harness/RUNTIME_MIGRATION_ACCEPTANCE.md`. This acceptance does not execute
them and does not authorize runtime migration, cutover, release replacement,
real QQ/NapCat, model, TTS, database or the `3011` listener.
