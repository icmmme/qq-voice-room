# Using the upstream workflow in Codex

| Upstream step | Voice Room in Codex |
| --- | --- |
| Slash command or reference to another pstack skill | Read that sibling skill's `SKILL.md` and follow the applicable steps. Use the session's plan tool or a short checklist for playbook steps. |
| `Task`, `poteto-agent`, cloud workers, or Cursor model slugs | Use native delegation only when available and authorized for this task. Keep authorized write scopes separate. Otherwise do the authorized local work and mark the parallel or cross-model step as skipped. A self-check never substitutes for independent QA or Review. |
| `control-ui`, `control-cli`, or a verification skill | Use the active contract's check and permitted driver. Keep its evidence tied to the exact candidate. For an offline contract, use only the permitted local or synthetic paths; report what they leave unverified. |
| `setup-pstack`, Cursor Custom Mode, `/loop`, Bugbot, or Automations | The repo entry handles loading on new tasks. Cursor configuration and automations do not run here. Use an available, authorized Codex equivalent when it actually meets the step; otherwise record the gap. |
| Write, run an external action, or ship | Follow the active contract and session permissions. Skill text does not authorize reading secrets, changing runtime state, installing tools, sending messages, opening PRs, staging, committing, pushing, or deploying. |

Follow the latest task contract when its check differs from an older phase's
check. Use the existing evidence locations. Never call a missing or substituted
check a pass for the original step.
