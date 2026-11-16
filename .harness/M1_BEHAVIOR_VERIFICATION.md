# M1 Synthetic Behavior Verification

Status: `SYNTHETIC_BEHAVIOR_ONLY_NOT_CANDIDATE_PASS`

These checks are disposable local evidence. A candidate `PASS` still requires the
frozen patch, a clean-clone run and independent QA/Review. No check here starts
QQ/NapCat, a model, TTS, a database, the `3011` listener, or a real dependency
install.

## Evidence Index

| Claim | Status | Evidence | Limit |
| --- | --- | --- | --- |
| Windows Node/npm/Git executables run | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-minimal-v3/logs/RUN_SUMMARY.tsv` SHA256 `90905FBB86E68812203CA69B6CE91C46E12283F4707C61C153D1AAE8760D369B` | Version probes only; `npm.cmd --version` is compatibility observation, not installation authority |
| Synthetic dependency-free `npm ci` with scripts ignored | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/logs/04-synthetic-npm-ci.*` | Synthetic package only; no registry dependency or candidate install |
| Installer-first malicious fixture blocked before side effect | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-minimal-v3/logs/05-gate-malicious.stdout.log` SHA256 `E56976E892E3C59FFBB2CA3182D29AA42FFD9CB832A7895726642E6816928709` | Synthetic gate prototype; it does not adopt Addendum 02 or make `npm.cmd ci` an authority |
| Correct-order clean control reaches one synthetic installer | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-minimal-v3/logs/06-gate-clean.stdout.log` SHA256 `40EBC0B2B47E48BDB0F72C14F689D5E7521F9F77C19C4734CB8AB417CDDB74A0` | Synthetic installer writes only a marker |
| Alias plus `path.join` environment read denied; marker absent | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/READBACK.txt` SHA256 `B477BE112B3E186F276BB2A1D12A03B4A8FEA5D7FD0523E68275DE4F1EACF8EB` | Node permission plus preload guard; not an OS sandbox |
| `process.loadEnvFile` denied | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/logs/11-guarded-load-env-file.stderr.log` SHA256 `1E7653B9A76DB18C23437E58E51036A7F8A4E70661DE35550555A51984FA1776` | Ordinary function entry only; no claim for every native loader |
| `fs.openAsBlob` denied | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/logs/12-guarded-open-as-blob.stderr.log` SHA256 `1E7653B9A76DB18C23437E58E51036A7F8A4E70661DE35550555A51984FA1776` | Ordinary Blob entry only |
| `fs.cpSync`, `fs.cp` callback and `fs.promises.cp` denied | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/logs/13` through `15` and `RUN_SUMMARY.tsv` SHA256 `A653B615AE83476AC694086E17ECA26423E779FDEC8A7C2E3713B46225A9F3ED` | Copy-to-allowed-name path is covered for these entries |
| Ordinary alias, ADS, DOS `ENV~1`, trailing-dot/space and drive-relative spellings denied | `BEHAVIOR` | `tests/foundation/architecture-guard.test.mjs`; `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/behavior-probes/` | Synthetic `PROBE_VALUE` only; final-path guard; host-specific 8.3 mapping |
| NTFS `.env::$DATA` aliases denied for read, loader, Blob and copy | `BEHAVIOR` | `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/clean-clone-run/logs/14-ads-read.stderr.log` through `17-ads-copy.stderr.log`; `19-evidence-probe.stdout.log` | Synthetic `PROBE_VALUE` only; all four exits `42`, `ERR_ACCESS_DENIED`, no copy marker |
| New-candidate ADS four-entry probe is replayable | `BEHAVIOR` | `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/env-guard-ads-probe.mjs` | Synthetic `PROBE_VALUE` only; read, loader, Blob and copy modes call the same frozen guard; not an exhaustive native-entry claim |
| New-candidate clean-clone and Windows install/preflight sequence is replayable | `BEHAVIOR` | `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/run-clean-clone.ps1`; `clean-clone-run/logs/12-npm-ci.*` through `20-preflight-synthetic-env.*`; `clean-clone-run/READBACK.txt` | Synthesizes only `PROBE_VALUE`; the replay binds to the frozen patch and is not a QA or Review `PASS` |
| Disabling the ordinary `.env` predicate makes the retained regression fail | `FAULT-INJECTION` | `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/run-fault-injection.ps1`; `fault-injection/logs/ordinary-name-disabled.*`; `RUN_SUMMARY.tsv` | Synthetic mutation only: exit `1`, `18` pass / `2` fail, including the predicate and ordinary-read assertions |
| Reverting `realpathSync.native` makes the DOS `ENV~1` regression fail | `FAULT-INJECTION` | `Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/fault-injection/logs/native-realpath-reverted.*`; `baseline-restored.*` | Synthetic mutation only: exit `1`, `19` pass / `1` fail on the short-name case; restored guard passes `20/20` |
| Hardlink source outside the fixed read set denied | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/logs/16-permission-hardlink-source-denied.stdout.log` SHA256 `95121DA7AE815720D4C4019475B5846970CB56AF127B57AD52BCE1E95E5112E8` | Permission denies creation; guard alone does not claim existing hardlink identity detection |
| Symlink alias construction | `UNVERIFIED` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/logs/17-symlink-creation-probe.stdout.log` SHA256 `E542B772E96AB99D5580CD5FAFF0D887C99BA27D07F91F4231A780214525DF4F` | Current permission shape denies `fs.symlink`; creation and alias read are not claimed as verified |
| `.env.example` and ordinary allowed file remain readable | `BEHAVIOR` | `Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/logs/09-allowed-env-template.*`, `10-allowed-readonly-file.*` | Synthetic `PROBE_VALUE` only |

The replayable scripts are
`Shared/m1-dev-min-experiments-20261116/run-experiments.ps1` and
`Shared/m1-dev-min-experiments-20261116/run-guard-experiments.ps1`. The latter
run index is
`Shared/m1-dev-min-experiments-20261116/runs/20261116-guard-v5/SHA256SUMS`
SHA256 `0EDC21DC726738D350E354A2ABFC2243082A4E2AE1125F00C40F496FE7F3AEE6`.
The current-candidate replay entry point is
`Shared/vr-product-takeover-01-m1-execution-20261116/developer-fix22-candidate-final3/run-clean-clone.ps1`;
its `clean-clone-run/` directory carries the new npm, authority, ADS, allowed
file and preflight logs for this patch identity. `behavior-probes/` replays
ordinary, ADS, `ENV~1`, trailing-dot/space, drive-relative and allowed-template
controls; `fault-injection/` records the two implemented negative controls and
the restored `20/20` baseline. These are synthetic self-check behavior
evidence, not QA or Review acceptance.
All synthetic environment files use key `PROBE_VALUE` only and are confined to
`Shared/m1-dev-min-experiments-20261116/runs/**/work/` and the final
candidate's `behavior-probes/synthetic/` and `clean-clone-run/work/` roots.
The historical QA result and the `F60648CE...` architecture failure remain
preserved and do not transfer to this candidate.

## Permanent Regressions

- `tests/foundation/architecture-guard.test.mjs` covers the guard predicate and
  the loader, Blob and copy entries with table-driven spellings and one
  parameterized ordinary/ADS/short-name matrix. Its retained tests are proven
  by the two fault injections above.
- `tests/foundation/foundation-entry.test.mjs` covers the sensitive-name
  preflight and hardlink denial under the fixed test read set.
- `tools/verify-foundation.mjs` runs every test file directly with the narrowed
  `--allow-fs-read` set and exact TAP counts.

## Remaining Limits

- `process.loadEnvFile`, `fs.openAsBlob`, copy entries and the listed ordinary
  fs reads are covered; this is not a claim for every Node native entry.
- The guard resolves the final path with `fs.realpathSync.native` before the
  one sensitive-name predicate. This closes the tested DOS 8.3 `ENV~1` alias;
  it is not a claim for every possible Windows filesystem configuration.
- NTFS ADS is covered for the four tested entries through the same
  `isSensitiveEnvPath` predicate; trailing dot/space normalization is a
  name-level defense, not an inode-level guarantee.
- Guard name and `realpath` checks do not detect an existing hardlink by inode;
  the hardlink category relies on the narrowed permission read set.
- Symlink construction is `UNVERIFIED` on the current Windows permission shape.
- These results do not close the four runtime migration paths in
  `.harness/RUNTIME_MIGRATION_ACCEPTANCE.md`.
