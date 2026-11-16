# Runtime Migration Acceptance Register

Status: `REGISTERED_NOT_EXECUTED_IN_M1`

These are future runtime acceptance paths. M1 does not start QQ/NapCat, a
model, TTS, a database, or the `3011` listener, and no synthetic result may
close them.

| ID | User path | Required observable result | Real seams that must be exercised | Evidence still required |
| --- | --- | --- | --- | --- |
| `RT-MIG-01` | A single `@` reaches the migrated room | One authoritative admission, bounded generation and one platform send outcome are separately visible | inbound parser, consumer identity, admission, runtime/store, transport ACK | owner-authorized runtime log and client observation |
| `RT-MIG-02` | Dual `@` arrives close together | At most one physical send per admission; duplicate/late events do not create a second send | admission dedupe, in-flight state, transport, settlement | runtime log and independent observation |
| `RT-MIG-03` | Connection drops and reconnects | Recovery resumes admission without replaying an unsettled attempt or clearing `UNKNOWN` | reconnect handler, durable state, recovery decision | authorized reconnect test and raw logs |
| `RT-MIG-04` | Mode changes or cancellation occurs during a request | Cancellation stops new scheduling, preserves a started attempt as unsettled, and never replays it | mode state, cancellation, attempt lifecycle, delivery ledger | authorized runtime test and raw logs |

A platform ACK is not proof that a client heard audio. Real client voice
evidence must come from the Owner or an explicitly authorized tester.
