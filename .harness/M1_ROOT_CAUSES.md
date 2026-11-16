# M1 Root Causes

This file merges repeated findings by failure mechanism. Addendum 02 was not
adopted by the Owner; its five plan root causes remain deferred and must not be
reported as `PASS`.

## F22 plan roots

| Root cause | Status | Current control | Evidence | Blocks current candidate | Minimal target | Rerun scope |
| --- | --- | --- | --- | --- | --- | --- |
| `RC-F22-01` | `DEFERRED_NOT_ADOPTED` | Owner keeps Addendum 01; no custom installer or matrix | QA final `51425579...`; root-cause report `3CA636AC...` | No, because Addendum 02 is not adopted | None; keep `npm.cmd ci` out of the installation-authority role | None |
| `RC-F22-02` | `DEFERRED_NOT_ADOPTED` | No installer-first path is authorized | Synthetic v3 `05-gate-malicious` and `06-gate-clean` only | No, because no custom installer is adopted | None outside the deferred plan | None |
| `RC-F22-03` | `DEFERRED_NOT_ADOPTED` | No package-tree receipt schema is introduced | Root-cause report `RC-F22-03` | No | None outside the deferred plan | None |
| `RC-F22-04` | `DEFERRED_NOT_ADOPTED` | The 163-row matrix is not executed or extended | Root-cause report `RC-F22-04` | No | None outside the deferred plan | None |
| `RC-F22-05` | `DEFERRED_NOT_ADOPTED` | PATH `npm.cmd` is not an acceptance prerequisite | Synthetic toolchain compatibility only | No | None outside the deferred plan | None |

## M1 implementation roots

| Root cause | Control | Evidence | Blocks freeze | Minimal fix | Rerun scope |
| --- | --- | --- | --- | --- | --- |
| `RC-M1-01` stale task/QA state | `.harness/CURRENT_TASK.md`, `.harness/PROJECT_STATE.md` | QA final `514255791...`; this task record | Yes | Record QA `FAIL 0/2/3`, the Owner decision, preserved F845 evidence, and P WIP | Harness contract tests plus candidate facts review |
| `RC-M1-02` environment-file reads are not fail-closed | `findSensitiveEnvFiles(root)` before package/closure; `tools/lib/env-read-guard.mjs` preload for ordinary reads, loader, Blob and copy entries; one canonical basename predicate; final-path `fs.realpathSync.native` canonicalization for DOS 8.3 aliases; fixed narrow test read set for hardlink identity; per-file permission/TAP runs | `.harness/M1_BEHAVIOR_VERIFICATION.md`; architecture review `C9A3DE40C1ECDEF9D507FF2CC314CD0F087DC536691C6E526CDE0ACEE504EDFF`; fault injection `ordinary-name-disabled` and `native-realpath-reverted`; `evidence/static-execution-boundary.json` | Yes | Resolve the final path before the one sensitive-name predicate; reject ordinary, ADS and `ENV~1` aliases before content is exposed | Foundation authority, guard entry probes, ordinary/ADS/short-name regression, two fault-injection controls, trailing-dot/space and drive-relative probes, allowed template/file controls, clean-clone authority |
| `RC-M1-03` P/Shared ownership depends on host paths | Logical `Q`, `P`, and `Shared/...` IDs in input and evidence files; command-record cwd validator accepts only logical roots and rejects host-absolute paths | `evidence/m1-input-identity.json`, `evidence/command-records.json`, `evidence/source-manifest.json`, `docs/architecture/feature-map.json` | Yes | Preserve hashes/bytes and raw-log identity while replacing host-specific paths | Evidence check, evidence tests, candidate input-hash review |
| `RC-M1-04` mutable worktree status is conflated with immutable base identity | `q.baseIdentity` is the fixed HEAD/tree; `q.worktreeObservation` records staged, modified and untracked entries separately and cannot claim clean | `evidence/m1-input-identity.json`; candidate QA F22-CAND-02 | No (P2), but required for an accurate handoff | Keep the dirty observation explicit (`1` modified, `6` untracked, `0` staged) | Evidence check, evidence tests, worktree observation probe |
| `RC-M1-ADS-01` Windows NTFS default-stream spelling bypasses the environment predicate | The one `isSensitiveEnvPath` predicate normalizes `::$DATA`, trailing dot/space and equivalent basenames before wrapped read/loader/Blob/copy calls | Architecture review `M1_ADDENDUM01_GUARD_ARCH_REVIEW.md` current-file SHA256 `F121CCF1AA3AAC56608D17A3E50F1014FB7430D2AB855463983E88381F788222`; synthetic ADS regression in `architecture-guard.test.mjs` | Yes | Reject ADS and equivalent aliases before content is exposed; keep a permanent `ERR_ACCESS_DENIED`/no-marker regression | Guard core test, foundation-entry, clean authority |
| `RC-RV-02` command records can cite stale or superseded raw logs | Candidate-specific architecture and freeze stdout logs are retained with the package and their SHA256 values are bound in `evidence/command-records.json` | Current values `AAA7B825...` and `A4F2977B...`; clean-clone replay logs | Yes | Preserve exit and raw-log identity, rebind records, and re-freeze a new patch | Architecture guard, freeze check, foundation authority, candidate evidence review |

`RC-M1-02` has two independently reproduced instances: the earlier ordinary
function alias plus `path.join`, and the architecture review's DOS 8.3
`ENV~1` alias. They share the same failure mechanism: the guard was checking
the spelling before resolving the final path. The control is now the single
native final-path canonicalization followed by the existing predicate, not a
short-name table. The same root cause includes `process.loadEnvFile`,
`fs.openAsBlob`, `fs.cp*` and `RC-M1-ADS-01` escapes; they are not new matrix
rows. The highest executable layer was chosen: one architecture-level
canonicalizer and one existing predicate, rather than separate tests for
`ENV~1`, each API or each spelling. The permanent tests were de-duplicated to
table-driven spellings and a parameterized alias/API matrix. Fault injection
proves the retained tests fail on both former escapes and pass after restore.
Symlink construction remains `UNVERIFIED` on the current Windows permission
shape, and the guard does not claim inode-level hardlink detection.
Hardlink/FileHandle, rename/directory-copy and symlink residuals are
non-blocking only under the preflight plus fixed-read-root scope; this is not
an OS-isolation claim.
`RC-M1-03` is a provenance identity issue, not a product runtime behavior
claim.
The earlier architecture-review hash `26597C7A...` is an expired observation;
the current file at the same logical path is `F121CCF1...`.
