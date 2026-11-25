# M5 Fix-4 · Personalized Participation

## Task

- Task: `VR-PRODUCT-TAKEOVER-01 / M5-FIX4-PERSONALIZED-PARTICIPATION`
- Risk: `L3` because the change covers automatic participation, public personas, quoted continuations and per-member quotas.
- Baseline: `aa4c5d2dce803ee7f398940809d19ef0861b24a4`, tree `e78df6eecf5dc77c14f3d1f7f36a5a09cb4b584b`.
- Predecessor: Fix-3 R3 is merged and deployed.

## Product defaults

- `mention_only` remains the startup mode and never initiates from unrelated group messages.
- Passive participation is available only in owner-selected `ambient` mode.
- An explicit `@` to a configured character has priority over a quoted continuation.
- A quoted bot message can continue a conversation only inside the same room and only with a clear follow-up or question.
- Group-question participation remains one character and one short text segment.
- Autonomous new-topic creation is excluded from this task.
- The per-member limit counts actual direct trigger attempts by that member, not ordinary room messages.
- Ambient model evaluation leaves one model-budget slot available for a direct request. A `null` model limit remains unlimited.

## Acceptance

| ID | Input and required result |
| --- | --- |
| `B4-01` | Each selected character's validated public persona is present in the final lifecycle prompt. The prompt contains only the selected character's persona and remains tools-free and privacy-valid. |
| `B4-02` | A human quote of a bot message in this room with a clear question or follow-up routes to that bot character even when the quote arrived through the other account. Parent walking stops at the original human row and cycles fail closed. |
| `B4-03` | Quote and explicit `@` in one message create exactly one request and explicit `@` wins. A duplicate event creates no second request. |
| `B4-04` | Ambient evaluation uses the real unblocked human-message batch within the configured quiet window. `group-question` can see the required distinct speakers and still rejects a message explicitly aimed at another group member. |
| `B4-05` | Group-question participation creates at most one character turn and one short text segment. A second character remains excluded for this conservative mode. New messages after selection still invalidate a stale candidate before send. |
| `B4-06` | The per-member quota counts only actual direct attempts by that member. Seven ordinary ambient observations before the first explicit `@` do not consume that member's direct quota; duplicate and rejected attempts follow the documented N-boundary semantics. |
| `B4-07` | Ambient planner and generation paths preserve at least one model-budget unit for a direct request. Ambient exhaustion records a silent reason without turning the Worker into a fault. |
| `B4-08` | Notices and audit can distinguish quoted-direct, ambient group-question and no-trigger outcomes using fixed codes and internal references without message bodies or platform person identifiers. |

## Exclusions

- No active new-topic initiation.
- No quote propagation beyond the first bot character and original human row.
- No private memory, tools, web search, new model provider or schema migration.
- Merge, deployment, real QQ/NapCat, model and TTS verification require separate later authorization.

## Verification

- Preserve deterministic red cases at the pinned baseline and rerun the same cases after implementation.
- Verify final model prompts contain exactly the selected character's public persona.
- Exercise quote continuations through both accounts and quote plus explicit `@` in one event.
- Exercise a real multi-speaker pending batch, explicit other-person addressing, rapid topic changes and stale-candidate cancellation.
- Exercise ordinary-message quota isolation, direct-attempt boundaries, duplicate events and one reserved model slot.
- Run typecheck, build, focused tests, full lifecycle tests, architecture guard and `git diff --check`.
- Freeze one patch/tree and require independent QA and Review against that exact candidate.

## Revision History

- R1 failed independent QA with P1 `0/2/0`. The short quoted follow-up `继续` was not admitted, and completed direct audit rows did not preserve quote provenance.
- R2 recognizes a narrow explicit-continuation vocabulary, records `explicit_direct` or `quoted_direct` in the existing lifecycle turn reason, and preserves that reason after successful generation. A formal B4-08 regression covers direct provenance and the ambient no-trigger notice without message bodies or platform identities.
- R2 passed independent QA but failed independent Review with P1 `0/1/0`: admission provenance and terminal cause shared `room_lifecycle_turns.reason`, so pause/resume, failure, cancellation and stale transitions could lose provenance or weaken group-question limits.
- R3 stores admission provenance separately in the existing lifecycle request `payload_json`, exposes it as `admissionReason` in requests and audit, and leaves `turn.reason` dedicated to terminal cause. Pre-R3 payloads without the field remain readable as `null`.
- R3 passed independent QA but failed independent Review with P1 `0/1/0`: the ambient batch lower bound used evaluation time minus the quiet window, so messages earlier than the anchor but inside the window were excluded, especially when the timer fired a few milliseconds late.
- R4 derives the batch lower bound from `anchor.createdAt - ambientQuietMs` and adds distinct-timestamp regressions for exact and delayed quiet-boundary evaluation.
- R4 passed independent QA but failed independent Review with P1/P2 `0/1/1`: a continuation regex accepted the `继续` prefix in `继续教育报名已经结束。`, and configuration accepted an `ambientMessages` threshold above the 500-row read cap.
- R5 requires a token boundary after short continuation commands and makes configuration, runtime reads and history-page validation share one 500-row cap.
- R5 failed independent QA with P1 `0/1/0`: quote admission still reused the broad ambient question/follow-up keyword sets, so unrelated declarations containing words such as `建议`, `喜欢` or a demonstrative could trigger a direct reply.
- R6 gives quote continuation its own strict question/command predicate. Ambient policy keeps its broader classifier, while quote admission accepts only terminal question punctuation, an explicit interrogative opening, a bounded follow-up command or a bounded continuation command.
- R6 failed independent QA with P1 `0/1/0`: interrogative-word and second-person openings still admitted statements such as `如何申请宿舍是迎新手册的第二章。` and `你说的那家面包店已经搬走了。`.
- R7 removes those opening heuristics. Quote admission now accepts only terminal question punctuation, a bounded continuation command, or an explicit `请/麻烦` explanation command.
- R7 failed independent QA with P1 `0/1/0`: command regexes accepted a sentence-internal `！` and ignored following narrative, so `继续！是海报上印的口号。` and `请说明！这三个字是旧模板的默认标题。` still routed.
- R8 anchors command patterns to the complete trimmed message. Only the command plus optional terminal punctuation can qualify, and any trailing prose makes the quote an ordinary observation.
- R8 passed independent QA but failed independent Review with P1/P2 `0/2/0`: a question mark inside a reported title was treated as a question, an explanation command with an object was rejected, and an Ambient question addressed by a self-introduced member name without `你` was not treated as another-member conversation.
- R9 requires an explicit interrogative tail before question punctuation, rejects title/name declarations that merely contain a quoted question, accepts combined terminal question punctuation, and permits a bounded explanation object without comma-separated narrative.
- R9 also extracts self-introduced member names from public history and fails closed when a later turn begins with that name and addresses the member, while configured characters and public group address remain eligible.
- R10 freezes the combined R9 quote and named-address repair after the complete-message, ambient-address, R3 admission, R4 timing and R5 cap probes all pass on one candidate.
- R10 failed independent QA with P1 `0/2/0`: another title-reporting form and a why-question at the start of a quote were misclassified, while one-character self-introductions and address preambles were missed in Ambient addressing.
- R11 combines sentence-ending question punctuation with either a question-word opening or tail, expands title context, extracts one-to-six-character self-introductions, recognizes address preambles such as `顺便问一下阿宁`, and removes name-length guessing so ordinary time/discourse openers do not become false other-person addresses.
- R11 failed independent QA with P1 `0/2/0`: a qualified reported title still looked like a question, a why-question about a title was suppressed, a `问下阿鹭` preamble was missed, and a quoted script line beginning `我叫方案` created a false identity.
- R12 recognizes reported titles by a title-class word followed by a colon, accepts otherwise well-formed terminal questions, recognizes `问下` preambles, and extracts self-introductions only at the beginning of a message.
- R12 failed independent QA with P1 `0/1/0`: reported speech introduced by `问/说 + colon` was still treated as a direct question, while a why-question about a reported title was suppressed.
- R13 classifies reported questions by either a title-class or question/speech verb followed by a colon. A message beginning with a direct interrogative takes precedence, so `为什么…？` remains eligible even when it discusses a title.
- R13 failed independent QA with P1 `0/2/0`: a multi-line reported question escaped the colon check, a direct `你能不能…：` question was suppressed, and a self-introduction marked as script dialogue created a false nickname.
- R14 makes reported-reason matching newline-safe, accepts second-person question openings such as `你能不能`, and refuses to learn self-introductions from messages carrying script/dialogue markers.
- R14 failed independent QA with P1 `0/2/0`: a long reported body exceeded the fixed capture length, and the stage-marker heuristic misread `今天第一个到场` as a script scene.
- R15 removes the reported-body length cap and restricts scene markers to `第 + numerals + 场`.
- R15 failed independent QA with P1 `0/3/0`: reading a script or reciting dialogue was not recognized as a report, a prior title-only line swallowed a later direct question, and spaced scene markers such as `第 12 场` were missed.
- R16 evaluates the final question line and explicitly reported prefix lines separately, recognises reading/recitation verbs, and permits spaces inside numeric scene markers.
- R16 failed independent QA with P1 `0/2/0`: plain report labels such as `剧本选段：` and `对白内容如下：` had no reporting verb and escaped the line-aware check.
- R17 treats the dialogue/report markers themselves as prefix reports, while preserving the line-aware distinction that allows a later independent direct question.
- R17 failed independent QA with P1 `0/2/0`: a single-line `剧本选段：…？` was admitted, while a clear `请问…？` after a multi-line script block was suppressed.
- R18 evaluates report status on the final question line and prior report context separately. A report label on the question line fails closed, while an explicit direct-question opening on the final line wins over an earlier dialogue block.
- R18 passed independent QA but failed independent Review with P1/P2 `0/1/1`: a final-line report label could be overridden by an earlier position of `请问`, while `顺便问一下：…？` after a script block was suppressed. Pinned-baseline red evidence was also absent.
- R19 gives final-line report state an absolute veto. A direct-question opening may bypass an earlier report block only when the final line itself is not a report. Performative question introducers are separated from reported speech.
- R19 passed independent QA but failed independent Review with P1/P2 `0/1/1`: opener-plus-direct-interrogative questions were suppressed, while final scene and qualified dialogue labels were admitted.
- R20 normalizes the final line once after removing a performative opener and its delimiter, then derives report and direct-question state from that same normalized line. Qualified dialogue labels, scene labels and direct questions about reported material now share one precedence model.
- R20 passed independent QA but failed independent Review with P1 `0/1/0`: scene markers with preceding qualifiers and standalone speaker prefixes were not part of report state.
- R21 recognizes optional qualifiers before scene markers and short actor/speaker prefixes as final-line report state. Common request openers remain direct before that classification.
- R21 passed independent QA but failed independent Review with P1 `0/1/0`: long scene qualifiers, whitespace before a speaker colon, and non-LF line separators remained outside report parsing.
- R22 finds scene labels anywhere on the final line, allows whitespace inside a bounded speaker prefix, and splits LF, CRLF, CR, U+2028 and U+2029 consistently.
- R22 passed independent QA but failed independent Review with P1/P2 `0/1/1`: report nouns with prefixes over the remaining 24-character bound and long scene post-qualifiers still bypassed the final-line veto.
- R23 removes report-label text bounds. Dialogue/report nouns and scene units are recognized with arbitrary same-line prefix or postqualifier text up to the following colon.
- R23 passed developer checks but its extended independent matrix found remaining text bounds between title/speech markers and their colons, plus a prior-colon dialogue-label case.
- R24 removes those title/speech bounds and recognizes a dialogue/report noun after an earlier same-line colon. The 268-case extended matrix becomes a permanent regression.
- R24 passed independent QA but failed independent Review with P1/P2 `0/1/1`: natural performative questions such as `我只是想知道：备用钥匙放在哪里？` were mistaken for reported speech, and the QA matrix did not cover that clear-question family.
- R25 recognizes explicit personal, request and confirmation preambles as direct-question context before evaluating report state, while preserving reported speaker, title and dialogue negatives.
- R25 passed developer checks but failed independent QA with P1/P2 `0/1/1`: `我有个问题：…`, `我想问个问题：…` and `打扰一下：…` still entered the speaker-prefix path and created no quoted request.
- R26 replaces the enumerated personal opening with a structural rule: a first-person or attention preamble before a colon must also carry an explicit question/request intent. The remaining line still passes through report-title and reported-speech vetoes.
- R26 passed developer checks but failed independent QA with P1/P2 `0/1/1`: a comma-separated short speaker label inside the preamble, such as `我有个问题，甲：…`, was consumed as part of the direct opening.
- R27 strips only matched direct-question phrases, then strips trailing punctuation before evaluating the remainder. A following `甲：`, `客服 ：`, `他：` or member name remains visible to the report parser and fails closed. It also covers the QA extension's `我还有个问题：…` and `我想再确认一下：…` forms.
- R27 passed developer checks but failed independent QA with P1/P1/P2 `0/2/1`: period, semicolon and exclamation separators could still hide a speaker label, while `我这边有个问题：…` and `帮我确认一下：…` were suppressed.
- R28 consumes all common sentence and clause separators after each recognized direct opening, and recognizes first-person context plus help/confirmation requests. The remaining speaker label is still checked by the report parser.
- R29 generalizes separator removal to Unicode punctuation and symbols and broadens the same direct-opening structure to temporal first-person context, polite help forms and variable whitespace.
- R29 passed independent QA but failed independent Review with P1 `0/1/0`: a separator-shaped nested speaker label and an over-24-character speaker prefix escaped the bounded speaker regex.
- R30 makes the remaining final-line colon prefix structural and unbounded, so separator-shaped or long speaker/report prefixes cannot be rescued by direct-opening stripping. This intentionally supersedes R22's old acceptance of a 25-character speaker prefix, which is now fail-closed.
- R30 passed developer checks but failed independent QA with P1 P1/P2 `0/2/1`: Unicode colon-like characters and a speaker label alone on a preceding line still escaped the report veto.
- R31 recognizes the Unicode colon-like family and treats colon-terminated historical speaker lines as report context. Indented or line-separated direct openings remain accepted.
- R31 failed the newly extended QA with mixed invisible formatting characters and indentation: a zero-width suffix could hide a speaker block, while leading spaces, tabs, NBSP or BOM could hide an explicit direct opening.
- R32 strips Unicode format controls before quote parsing and trims the final question line before opening classification.
- R32 failed independent QA with P2 `0/0/1`: U+0085 NEXT LINE before a direct opener was not treated as a line separator by ECMAScript trimming.
- R33 adds U+0085 to line splitting so speaker-block and direct-opening classification behave consistently.
- R33 failed the extended QA symmetry check with P2 `0/0/1`: trailing U+0085 could prevent terminal question recognition.
- R34 trims all ECMAScript whitespace plus U+0085 from both ends of the parse-only text.
- R34 passed independent QA but failed independent Review with P1/P1/P2 `0/2/1`: U+FE30 was missing from the colon-like family, and `麻烦问下禾，…` escaped ambient other-member addressing.
- R35 expands colon-like delimiters to the named Unicode family and recognizes polite address preambles before a known member name.
- R35 failed independent QA with P1 `0/1/0`: colon-like delimiters after a known member name and stacked polite preambles (`请麻烦问下禾`, `请问请问禾`) still bypassed the other-member veto.
- R36 parses repeated polite/question address prefixes before the member name and accepts the full colon-like delimiter family after that name.
- R36 passed the named R35 cases. Independent QA found that polite connectors, Unicode whitespace and punctuation between address tokens still bypassed the veto. Its command ledger also referenced 14 probe sources missing from the bundle.
- R37 consolidates the address findings under `RC-B4-04` and carries the referenced probe sources in the frozen bundle.
- R37 passed independent QA. Review reproduced an `RC-B4-04` miss when the same visible member name or polite token contained U+2060 WORD JOINER.
- R38 applies the same parse-only format removal to the anchor and to self-introductions. Whitespace remains a token boundary.

## Implementation Record

- Resolved direct selections travel as `LifecycleAcceptOptions.characterIds`. A configured explicit mention wins over a quoted continuation, and quote continuity requires a clear question or follow-up.
- Short quoted continuations use a line-aware complete-message predicate. Reported title, speech and dialogue shapes are rejected through fixed markers unless the final question line begins with an explicit direct-question opening.
- R18 scopes dialogue labels to colon-delimited report prefixes and scene markers, avoiding suppression when the word `台词` appears in ordinary prose. The final direct-question opening is evaluated on the final line rather than the start of the full multi-line message.
- R19 records deterministic red cases on the pinned baseline and reruns the same cases on the candidate. Final-line report markers always fail closed, and both `请问` and `顺便问一下` remain explicit direct-question openers after an earlier report block.
- R20 recognizes optional `一下/下` on performative openers, removes a following comma or colon before classification, and treats qualified dialogue labels or final scene labels as report state. The Review 28-case precedence matrix becomes a permanent regression source.
- R21 extends scene-label detection across leading qualifiers and adds a bounded speaker-prefix rule. The R20 Review 24-case final-line state matrix is rerun as a permanent candidate regression.
- R22 removes the qualifier-length dependency for scene labels, treats spaces before a speaker colon as part of that label, and normalizes all common Unicode line boundaries before final-line classification.
- R23 makes report-noun and scene-label recognition structural rather than length-bounded. The R22 Review full-path matrix is rerun as a permanent candidate regression.
- R24 makes title and speech marker classification line-structural as well, and allows a report noun after an earlier colon on the final line to keep the report veto.
- R25 extends the performative-question opening to natural desire, request, confirmation and addressing forms, and adds the independent Review's 12 positive and 4 negative natural-question controls.
- R26 adds the independent QA's three real-path counterexamples as permanent lifecycle controls, including nested title and reported-speech negative cases.
- R27 adds the R26 QA comma-plus-speaker counterexamples as permanent real-lifecycle negatives while retaining repeatable direct-open phrase stripping. It also adds the QA extension's `我还有个问题` and `我想再确认一下` positive controls.
- R28 adds the R27 QA period/semicolon/exclamation speaker reports, help-phrase speaker reports, `我这边有个问题` and `帮我确认一下` as permanent real-lifecycle controls.
- R29 adds ellipsis-separated speaker reports plus `麻烦你帮我…` and `能不能帮我…` direct positives to the permanent matrix.
- R30 adds separator-shaped nested speakers and an over-24-character speaker prefix as real lifecycle negatives while preserving earlier multi-line title context followed by an independent direct question.
- R31 adds the R30 QA colon-like speaker controls and all common line separators between a speaker label and the final question.
- R32 adds zero-width/BOM speaker-block negatives and whitespace/NBSP-indented direct positives.
- R33 adds U+0085 speaker-block and indented-direct lifecycle controls.
- R34 adds trailing-U+0085 predicate and real-lifecycle positive controls.
- R35 adds U+FE30 report/direct controls and `麻烦问下<member>，…` ambient other-member coverage.
- R36 extends the permanent polite-address regression to colon-like delimiters and stacked prefixes.
- R37 consumes polite preambles and separators before checking the target name. Its lifecycle regression covers `请你问下禾` and a normalized, punctuation-separated form. The open group-question control remains eligible.
- R38 extends the same address regression with format controls inside a target name, request token and introduced name.
- R22 removes the qualifier-length dependency for scene labels, treats spaces before a speaker colon as part of that label, and normalizes all common Unicode line boundaries before final-line classification.
- Cross-account quotes resolve only through a room-local bot row backed by an ACK or delivered receipt. Parent traversal must terminate at the original human row and fails closed on cycles.
- Ambient eligibility reads the contiguous unblocked human run ending at the anchor. Its lower bound is anchored to the anchor timestamp, never the delayed evaluation clock. The existing dedup ledger stores a discriminated direct-attempt or ambient-observation marker, so this decision survives restart without a schema change.
- Ambient other-member detection recognizes configured `X，你` address, confirmed one-to-six-character self-introduced names, address preambles including `问下`, QQ mentions and common public address. Self-introductions must begin the message or follow a narrow greeting/introduction prefix, and script/dialogue markers prevent identity learning.
- The accepted `ambientMessages` threshold, runtime page reads and store validation use the same 500-row limit.
- A group-question request is admitted with `admissionReason: "ambient_group_question"`; generation uses one short segment. Admission still rechecks mode, pause, ownership and the current anchor before insert, while generation and send recheck staleness through the existing lifecycle fences.
- Admission metadata lives independently in the existing lifecycle request `payload_json` and audit exposes `admissionReason`. Terminal failures, cancellation and stale outcomes continue to use `turn.reason`, so audit can distinguish `explicit_direct`, `quoted_direct` and `ambient_group_question` throughout pause/resume and terminal transitions.
- Direct member limits count distinct `lifecycle_direct_attempt` markers for that member. Ordinary observations, duplicates and other members do not consume the quota.
- Ambient model spends reserve one model-budget row for direct work. `null` remains unlimited. Exhaustion records a silent technical defer or skipped turn without faulting the Worker.
- The candidate is frozen in `Shared/vr-product-takeover-01-m5-fix4-20261121` with the patch, prospective tree, postimages, command logs and self-check identity.

## Allowed paths

- `src/voice-room/config.ts`
- `src/voice-room/participation-policy.ts`
- `src/voice-room/runtime.ts`
- `src/voice-room/store.ts`
- `src/voice-room/types.ts`
- `tests/voice-room-request-lifecycle.test.ts`
- `evidence/architecture-baseline.json`
- `.harness/CURRENT_TASK.md`
- `.harness/M5_FIX4_PARTICIPATION.md`
- `.harness/PROJECT_STATE.md`

All other paths are read-only for this task.
