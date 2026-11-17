---
name: voice-room-pstack
description: "Route QQ Voice Room progress, handoff, technical investigation, bugs, features, refactors, and verification to pstack. 在语音房项目里汇报进度、交接、调查、修缺陷、做功能、重构或验收时使用。 Skip unrelated questions and quick lookups."
---

# Voice Room pstack

Read the repository's `AGENTS.md`, the Active Task block of
`.harness/CURRENT_TASK.md`, the Canonical Current State block of
`.harness/PROJECT_STATE.md`, and the relevant part of `.harness/WORKFLOW.md`.
Use the current contract's scope and verification commands. An accepted
candidate does not authorize new changes beside it.

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

Follow [the Codex tool mapping](references/codex.md) for upstream steps that
assume Cursor tools or external actions. If a needed file or capability is
unavailable, carry on with the contract where possible and identify the material
gap. Keep read-only requests read-only. Use the user's language.
