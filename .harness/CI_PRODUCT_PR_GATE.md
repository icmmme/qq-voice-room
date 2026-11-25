# Product CI for pull requests

- Task: `VR-CI-01 / PRODUCT-PR-GATE`
- Risk: `L2`. The workflow runs PR code on GitHub-hosted Windows runners. It has read-only repository access, uses no secrets, and cannot deploy.
- Owner decision: approved the draft on `2026-11-24` and authorized registering it as the active task on `2026-11-25` (`Asia/Shanghai`). Registration does not authorize implementation or remote execution.
- Baseline HEAD: `3767178596ced9019c8f2f2936a95ac87b55ff62`
- Baseline tree: `3e0700348b08124503782af82768e22bcb83bd8e`
- Predecessor: [M5 Fix-3 offline closeout](PROJECT_STATE.md#m5-fix-3-offline-closeout), merged into `main`. Its independent QA and Review apply only to the accepted M5 Fix-3 candidate.

## Goal and scope

Run the full offline product regression and the standalone architecture guard for every PR targeting `main`. Install locked dependencies and compile once per run. Keep the historical M1 foundation acceptance separate.

| Path or action | Scope |
| --- | --- |
| `.harness/CI_PRODUCT_PR_GATE.md`, `.harness/CURRENT_TASK.md`, `.harness/PROJECT_STATE.md` | Register the approved contract as the sole active task and preserve the M5 closeout. |
| `.github/workflows/product-ci.yml` | The only permitted implementation file after the Owner authorizes implementation. |
| `src/**`, `tests/**`, `tools/**`, `package.json`, `package-lock.json`, `evidence/**` | Read-only. Do not remove tests, change package scripts, or refresh frozen evidence. Test negative controls only in disposable copies. |
| Git and GitHub writes | Staging, committing, pushing, the first remote run, changing rulesets or branch protection, merging, release, deployment, and cutover require separate authorization. |

All other repository paths are read-only for this task.

## Workflow

Use a GitHub-hosted Windows runner with an exact, verified installable Node 24 patch version. Name the workflow `Product CI` and the job `Windows / Node 24`. Use `pull_request` targeting `main`, without path filters. Cancel obsolete runs for the same PR when new commits arrive. Do not cancel runs for other PRs.

Set only `contents: read`. Do not use repository secrets, `pull_request_target`, self-hosted runners, or production environments. Cache npm downloads based on `package-lock.json`, not `node_modules` or `dist`. Install on cache hits as well as misses.

Run these as four separate steps in order. Record each step's duration and fail the check on a nonzero exit code.

| Step | Command |
| --- | --- |
| Install locked dependencies | `npm.cmd ci --ignore-scripts --no-audit --no-fund` |
| Compile, including TypeScript checking | `npm.cmd run build` |
| Run the complete compiled lifecycle suite | `node --test --test-reporter=tap dist/tests/voice-room-request-lifecycle.test.js` |
| Run the standalone architecture guard | `node tools/architecture-guard.mjs` |

Do not run `typecheck` separately or use `npm test`. The build already checks types, and `npm test` would run `pretest` and compile again. Keep build output, test databases, and WebSocket fixtures on the disposable runner. Use synthetic model, TTS, and platform inputs. Do not read `.env`, connect to real QQ or NapCat, access production databases, or listen on port `3011`.

The product check does not run, replace, or renew M1 foundation acceptance. The direct-Node foundation verifier remains authoritative for the bound M1 candidate. The current product checkout is not that candidate. Do not change its evidence to make the old gate pass, and do not report `npm.cmd run verify:foundation` as acceptance evidence.

## Acceptance

| ID | Required result |
| --- | --- |
| `CI-01` Execution chain | All four steps succeed on a clean checkout. Logs identify the actual tested SHA and tree, Node and npm versions, one install, one compile, the lifecycle test summary, and the architecture result. |
| `CI-02` Test coverage | Run the full compiled test file without filtering. The current reference is 114 tests passed and none skipped. With unchanged source and tests, initial verification should match it. Do not hard-code the count into CI. |
| `CI-03` Failure propagation | In separate disposable copies, introduce a type error, a failing test assertion, and an architecture violation. Each must fail at the respective step with a nonzero exit code. No negative-control changes enter the candidate. |
| `CI-04` Trigger and scheduling | A regular PR and a docs-only PR to `main` produce the same check name. A newer submission cancels an older run on the same PR and still gets its own check. Verify only after separate authorization for remote runs. Mark unobserved behavior as unverified. |
| `CI-05` Timing and cache | Record each stage's elapsed time and the npm cache hit or miss. A cache miss must pass. Local reference timings of about 9 seconds for compilation and 30 seconds for tests are not a CI SLA. |
| `CI-06` Boundary | The candidate does not change product code, tests, package scripts, or frozen evidence. The workflow has no release permissions, production credentials, or real service calls. |

## Evidence and enablement

Use the [existing Harness workflow](WORKFLOW.md) and the logical evidence location `Shared/vr-ci-01-product-pr-gate/`. Bind evidence to the candidate HEAD, tree, parent, and patch SHA256 and byte count. Record commands, logical working directories, exit codes, raw-log SHA256 values, and toolchain versions. Mark Developer checks `SELF_CHECK`. Independent QA and Review must verify the same frozen candidate and inputs. When GitHub tests a synthetic PR merge commit, record that actual SHA and tree, not just the PR head.

Verify the first authorized remote runs before requesting required-check status. Confirm the exact check name, positive and negative outcomes, and trigger behavior. The Owner must authorize required-check status separately. If a merge queue is enabled, verify that `merge_group` runs the corresponding check before making it required. This task does not include CD.
