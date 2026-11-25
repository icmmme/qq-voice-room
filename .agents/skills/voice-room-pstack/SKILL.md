---
name: voice-room-pstack
description: "Route QQ Voice Room progress, handoff, technical investigation, bugs, features, refactors, and verification to pstack. 在语音房项目里汇报进度、交接、调查、修缺陷、做功能、重构或验收时使用。 Skip unrelated questions and quick lookups."
---

# Voice Room pstack

Read [AGENTS.md](../../../AGENTS.md), then the [active task](../../../.harness/CURRENT_TASK.md),
its linked contract, and the [canonical state](../../../.harness/PROJECT_STATE.md).
Use the relevant steps in the [Harness workflow](../../../.harness/WORKFLOW.md).

The contract selects the allowed paths, checks, and evidence. Read only the
skill that matches the request and the references you need. A skill does not
authorize repository writes, external actions, or a different check. Use
verification evidence only for the candidate and scope it covers.

Select one starting point:

- When the user names a pstack skill, read `../<skill-name>/SKILL.md` and use
  it for the requested purpose. The optional `pstack:` prefix is a picker
  label, not part of the directory name.
- For a progress or handoff summary, read [ketchup](../ketchup/SKILL.md).
  Ground the summary in current Harness and candidate records; give the
  verified state, next responsible role, and any real owner decision. If
  asked to resume the work, use the general route below.
- For a request specifically about what an existing diff can break, read
  [blast-radius](../blast-radius/SKILL.md). For a recurring agent or review
  error, read [correct](../correct/SKILL.md) and use the existing Harness
  root-cause process.
- For other substantive project work, read [poteto-mode](../poteto-mode/SKILL.md).
  Use its own task classification to choose the playbook or workflow skill,
  then read the files it calls for as their steps become relevant.

Follow [the tool mapping](references/codex.md) when an upstream step assumes
Cursor. Use an available, authorized equivalent only when it meets the contract.
Otherwise, record the gap. Keep read-only requests read-only. Use the user's
language.
