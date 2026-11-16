# Independent Review Report Template

## Candidate identity

- HEAD:
- Tree:
- Parent:
- Patch SHA256 and bytes:
- Input hashes:

## Reviewer independence

- Reviewer:
- Statement that the reviewer is not the implementer:
- Statement that this report binds only to the candidate above:

## Scope

- Paths reviewed:
- Paths explicitly out of scope:

## Commands run

| Command | CWD | Exit | Raw log SHA256 |
| --- | --- | --- | --- |

## Findings

| ID | Root-cause ID | Severity | Finding | Evidence | Disposition |
| --- | --- | --- | --- | --- | --- |

## Behavior verification

- User path exercised:
- Real seams exercised:
- External boundaries substituted:
- Observed result:
- Evidence boundary:
- Synthetic behavior index: `.harness/M1_BEHAVIOR_VERIFICATION.md`

## Root-cause merge

- Duplicate findings grouped:
- Earliest enforceable layer:
- Regression added or required:
- Evidence rerun scope:
- Root-cause map: `.harness/M1_ROOT_CAUSES.md`

## Unverified items

- Item:
- Allowed phase:

## Owner handoff facts

- Current capability:
- Remaining blockers, grouped by root cause:
- Behavior verified, with the evidence boundary:
- Acceptance criteria and status:
- Not checked:
- Next responsible role:
- Owner-only decisions: none, or option / cost / recommendation.
- Source: `.harness/WORKFLOW.md` section 10 and the candidate handoff; do not
  create a second dashboard.
- Candidate hashes and command logs stay in the evidence package rather than
  being repeated here.

## Result

- Independent Review result: `PASS` or `FAIL`
- Blocking findings:
- Non-blocking findings:
- Statement that this result cannot transfer to a different candidate:
- Owner report remains a short summary, not a new acceptance dashboard.
