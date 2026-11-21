# M5 Fix-3 · Prompt Cache and Body Retention

## Task

- Task: `VR-PRODUCT-TAKEOVER-01 / M5-FIX3-RETENTION-CACHE`
- Risk: `L3` because the change covers private prompt/text retention, expiry, cancellation and persisted delivery state.
- Baseline: `6b6a4502031b1b1168d7854e96adb00808bc808f`, tree `b0d4c2c8ef9f3dc97b56073bdd072f837eb65d8d`.
- Predecessor: M5 Fix-2 R2 is merged and deployed; it does not authorize this task's merge or deployment.

## Scope

- Make the in-memory `lifecyclePrompts` entry follow the lifetime required by a lifecycle request.
- Inventory the active and compatibility SQLite columns that retain message bodies, generated text or voice translations.
- Add an idempotent, transactional cleanup path for synthetic/old room databases using the existing seven-day room-history window as the body-retention boundary.
- Preserve request IDs, turn and segment IDs, timestamps, outcomes, reasons, attempt identities, receipts and relational integrity.
- Do not change schema version 9, package dependencies, runtime configuration or live production data in this candidate.
- Do not run the cleanup against the live database. The first implementation and verification use copies with synthetic data.

## Acceptance

| ID | Input and required result |
| --- | --- |
| `B3-01` | A pure text lifecycle request completes with no retained prompt-cache entry after its generation or settlement path finishes. |
| `B3-02` | A multi-segment `both` request retains only the prompt needed for its remaining voice translation and releases every entry after the final segment or terminal path. |
| `B3-03` | Failure, cancellation, expiry, pause/revision change and mode switch release prompt-cache entries; no stale entry survives sequential requests. |
| `B3-04` | The body inventory identifies every active/compatibility table and column that can recover body text after `room_messages` cleanup. No body is hidden in a column omitted by the inventory. |
| `B3-05` | Cleanup removes or nulls only body-bearing fields older than the configured room-history window. It preserves IDs, times, outcomes, reasons, attempts, receipts and FK validity. |
| `B3-06` | Cleanup is transactional and idempotent: a repeated invocation changes no additional rows, a crash cannot leave a half-cleaned request, and reopen preserves the result. |
| `B3-07` | In-flight, unexpired requests and unknown-send evidence remain intact. Expired/terminal requests can be cleaned while unrelated current work continues. |
| `B3-08` | Cleanup reports aggregate counters/reasons without message bodies, prompt text, generated text, voice translations, tokens or platform person identifiers. |

## Verification

- Reproduce the current behavior with deterministic failures using a copied SQLite database.
- Verify prompt cache size for sequential text and multi-segment voice requests, including each terminal path.
- Verify body cleanup on old DB copies before and after the seven-day boundary, repeated invocation, reopen, in-flight and unknown delivery cases.
- Run typecheck, build, focused lifecycle retention tests, full lifecycle tests, architecture guard, `git diff --check`, and the synthetic database probes.
- Record a backup/restore drill and the exact data discarded by the candidate cleanup.
- Freeze one patch, prospective tree, postimages and command evidence. Independent QA and Review must bind to that exact candidate.

## Implementation Record

### Body inventory for B3-04

| Table and column | Recoverable plaintext | Retained fact |
| --- | --- | --- |
| `room_messages.text` | User or bot message body | Row ID, speaker, account, target, platform ID, timestamp and medium |
| `room_deliveries.semantic_text` | Generated semantic text | Delivery ID, state, character, account, receipt IDs and timestamp |
| `room_deliveries.voice_text` | Voice translation | Voice language and delivery metadata |
| `room_work_items.payload_json.input.text` | Accepted request body | Work ID, event key, sender key, IDs, status, reason, epoch, attempts and timestamps |
| `room_lifecycle_requests.payload_json.input.text` | Accepted lifecycle request body | Request ID, event key, sender key, IDs, status, reason, epoch, expiry and timestamps |
| `room_lifecycle_segments.semantic_text` | Generated segment text | Segment ID, delivery mode, state, reason and timestamps |
| `room_lifecycle_segments.voice_text` | Generated voice translation | Voice language and all segment identifiers |

The following text-like or JSON values are metadata and do not contain recoverable body text: `room_state.voice`, `room_deliveries.voice_key`, `room_deliveries.text_id`, `room_deliveries.voice_language`, `room_deliveries.worker_text_row_id`, `room_deliveries.worker_binding`, `room_deliveries.worker_projection`, `room_work_items.payload_version`, `room_bursts.worker_obligations`, `room_seen.control_result`, and `room_lifecycle_segments.voice_language`. Worker binding and projection JSON retain identifiers and hashes only.

### B3-05 through B3-07 semantics

- The cutoff is exactly `now - 604800000` milliseconds. A row created at the cutoff remains. A row created before it is eligible.
- No history or audit row is deleted. Non-nullable body fields become the fixed marker `[redacted:retention]`. Nullable delivery and translation fields become `NULL`.
- Work payload redaction preserves the existing decoded schema, including `senderKey`, `characterIds` and `messageRowId`. `workItem()` decodes redacted rows before and after reopen.
- Lifecycle request payload redaction preserves the existing decoded schema. Work and lifecycle terminal-update triggers are restored in the same transaction after payload rewriting.
- Active lifecycle requests with an expiry after `now` keep their bodies. Active legacy delivery states keep their bodies. Expired lifecycle requests, terminal requests and all unknown, uncertain, interrupted or receiptless records are cleaned after the boundary.
- Attempt IDs, start times, owner tokens, committed row IDs, ACK rows and the lifecycle audio fence remain unchanged. Status and reason strings remain unchanged.
- The operation uses one `BEGIN IMMEDIATE` transaction, verifies the inventory against schema 9, checks the postconditions and relational references, and returns only aggregate counters plus the fixed `age` reason and `cutoff`.

### Exact data discarded by this candidate cleanup

The synthetic copied-database probe starts with bodies outside the seven-day cutoff and retains exact-cutoff and unexpired in-flight bodies. Its expected aggregate result is six message bodies, two legacy delivery bodies, one work payload, three lifecycle request payloads and three lifecycle segment bodies. The discarded values are the original message text, generated semantic text, voice translation, accepted request text and work request text. No platform identifier, owner token, attempt, receipt, fence, timestamp, status or reason is discarded.

### Backup and restore drill

1. Use a service-stopped synthetic `room.sqlite` with no open writer. Create a consistent copy with SQLite `VACUUM INTO` into a new directory whose file name remains `room.sqlite`, then record the source and backup SHA256 hashes.
2. Apply the cleanup only to the copied database. The focused boundary test creates a separate copy and installs a temporary SQLite trigger that aborts after earlier body updates. The raised error must roll back every earlier update, restore the `room_work_terminal` trigger and leave all original bodies readable.
3. Remove the fault-only trigger and rerun cleanup on the synthetic copy. A second invocation must return `changed=false` and zero counters. Close and reopen schema version 9, call `workItem()` for the redacted work row, query schema 9 and require `PRAGMA foreign_key_check` to return no rows.
4. For restore, keep the service offline, move the affected synthetic `room.sqlite`, copy the hashed backup back under the same name, remove stale `-wal` and `-shm` sidecars for that synthetic copy, then reopen with a connection-only store. Require schema version 9, successful inventory/relationship validation and the same row metadata before declaring restoration complete.

No live database, `3011` listener, release directory, Git remote or production credential is used by this drill.

## Allowed paths

- `src/voice-room/runtime.ts`
- `src/voice-room/store.ts`
- `src/voice-room/types.ts`
- `tests/voice-room-request-lifecycle.test.ts`
- `evidence/architecture-baseline.json`
- `.harness/CURRENT_TASK.md`
- `.harness/PROJECT_STATE.md`
- `.harness/M5_FIX3_RETENTION_CACHE.md`

All other paths are read-only for this task. Merge, production cleanup, release and cutover require separate Owner authorization after independent QA and Review.
