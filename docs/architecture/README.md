# Architecture Authority

`feature-map.json` is the M1 feature authority. It derives from the frozen
planning map and records:

- 61 unique source IDs;
- 56 frozen active capabilities;
- 5 historical exclusions (`VR2-021` is negative-only);
- 1 pending Web extension (`VR-EXT-WEB-001`);
- three inherited Q Web files that are not target Web-extension evidence.

The map is validated by `tools/lib/feature-map.mjs`. A synthetic change to any
count, classification or Web-extension obligation must fail with a stable
`FM-*` code.

Architecture boundaries and the legacy baseline are enforced by
`tools/architecture-guard.mjs`. The baseline records existing unlayered source
as debt with owner, reason, hash and exit phase. It is not proof that the
legacy tree satisfies the target architecture.

The foundation source scan has no rule-definition exemption. A foundation file
that imports legacy runtime or entry source fails with
`ARCH-FOUNDATION-RUNTIME-IMPORT`; the static execution-boundary evidence also
records zero legacy entry executions and zero environment-file reads.
