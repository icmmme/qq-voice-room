# VoiceRoom Phase 4 Handoff

## 1. Current State (Verified Baseline)
- **Repo**: `D:\proj\VoiceRoom\repo\qq-voice-room` (`origin/main`, remote `https://github.com/icmmme/qq-voice-room.git`)
- **Verified Code Commit**: `50c613f` (all Phase 1–4 + resilience work landed and verified)
- **Tests**:
  ```powershell
  npm.cmd run build; if ($LASTEXITCODE -eq 0) { node dist/scripts/demo.js }; if ($LASTEXITCODE -eq 0) { node --test dist/tests/voice-room-memory.test.js dist/tests/voice-room-image-context.test.js dist/tests/voice-room-tuning.test.js dist/tests/voice-room-request-lifecycle.test.js }
  ```
  → **185 / 185 PASS** (`4 image-context + 6 memory + 4 tuning + 171 lifecycle`, `fail 0`)
- **Live Release**: `D:\proj\VoiceRoom\releases\m5-fix4-d7b79fd-20261125\app` (`dist/` + `skills/` synced; keep `m5-fix3-aa4c5d2-20261121-1755` untouched for instant rollback)
- **Live Launch Command** (never read/print `.env` files; pass paths only):
  ```powershell
  & "C:\Program Files\nodejs\node.exe" `
    "--env-file=D:\demo\pa-starter-voice-room\local\voice-room\room.env" `
    "--env-file=D:\demo\pa-starter-voice-room\local\voice-room\fish.env" `
    "D:\proj\VoiceRoom\releases\m5-fix4-d7b79fd-20261125\app\dist\scripts\room-qq.js" "run" `
    "--config" "D:\demo\output\a03-4-live-20261105\private\pa-v2-lifecycle-rollout-20261114\room.lifecycle.json"
  ```
- **SQLite**: Schema v9 (`D:\demo\output\a03-4-live-20261105\private\pa-v2-lifecycle-rollout-20261114\data\room.sqlite`) — backwards-compatible; long-term memory is isolated in `<dataDir>\room-memory.json`.
- **Host / NapCat Config**:
  - Clash Verge (`127.0.0.1:7892`) has QQ/NapCat `DIRECT` bypass rules configured on the host.
  - `C:\ProgramData\NapCatQQ Desktop\config\bot.json` has `offlineAutoRestart: true` enabled for both bots.
  - `C:\ProgramData\NapCatQQ Desktop\config\app-settings.json` has `onebotOfflineNotice` + `relogin` configured for private owner notifications (note: local OneBot HTTP servers in `bot.json` are disabled `[]`, check NapCat Desktop notice settings if private QR push is needed).

## 2. Delivered Architecture (Phases 1 – 4)
1. **Quality-First Budgets & Tolerant JSON (`20457da`, `341983c`, `83ebca6`)**:
   - `SAFE_ROOM_CONTEXT_WINDOW = 65536`, default `PA_CONTEXT_WINDOW = 32768` (up to `262144`), default `PA_MAX_TOKENS = 4096`, native thinking (`PA_THINKING=auto`).
   - `parseDeepLifecycleAnswer` repairs unescaped control chars/quotes/trailing commas and invalid escapes; tool-enabled rounds automatically retry once with `response_format: { type: "json_object" }` on `invalid-json`.
2. **Overnight Context Isolation + Scoped Long-Term Memory (`src/voice-room/context.ts`, `src/voice-room/memory.ts`, `b3e7da5`)**:
   - 45-min gap cutoff (`ROOM_HISTORY_GAP_MS`) + 25-row soft cap + `quotedMessage` single-parent injection prevents overnight chat pollution.
   - `RoomMemoryStore` persists `room` / `member` scoped facts in atomic `room-memory.json` (max 80 entries, `PrivacyGuard` + raw QQ ID rejection, token-budgeted relevance retrieval) with owner commands `/room remember`, `/room forget`, `/room memory`.
3. **Autonomous Web Search & Fetch (`src/voice-room/web.ts`, `7fb79cf`)**:
   - Direct `@` requests autonomously receive `web_search` (`BOCHA_API_KEY` > `EXA_API_KEY` > `TAVILY_API_KEY`) and `web_fetch` (GitHub REST API → FxTwitter API → Jina Reader → HTML fallback, SSRF-hardened, 75%/25% token truncation).
4. **Multimodal Vision & Recent Image Context (`src/voice-room/image.ts`, `src/voice-room/image-context.ts`, `11e5126`, `b3e7da5`)**:
   - Primary vision enabled by default (dedicated `PA_VISION_MODEL` optional fallback); SSRF-safe bounded fetcher (`cap=4`), zero image URL/byte persistence in SQLite.
   - In-memory `RecentImageCache` (max 8 entries, 10-min TTL, cleared on `close()`) + unmentioned observed image cache enables follow-up `"刚才那张图"` / quoted recall and `[图片]` history placeholders.
5. **Intent-Aware Hot-Reload Skills & Delivery Tuning (`skills/*/SKILL.md`, `src/voice-room/skills.ts`, `src/voice-room/delivery-policy.ts`, `bfdda83`, `b3e7da5`)**:
   - Intent triage distinguishes casual banter / meme links (`1–2` tight segments) from deep technical articles / repos (`Analytical Lens`, `3–4` dense segments) and enforces bilingual search queries for overseas drama/projects.
   - `shouldDeliverAsForwardCard` keeps `<=280` char & `<=2` segment replies as natural chat bubbles + voice, reserving QQ forward cards (`send_group_forward_msg`, Strategy A zero TTS) for longer/multi-paragraph answers.
   - Layer-2 persona few-shot guide available in `docs/persona-style-guide.md`.
6. **Module 3 Ambient Participation & NapCat Dual-Account Resilience (`1e78326`, `50c613f`)**:
   - Natural ambient participation (`named-mention`, `open-question`, `natural-topic`, `2min` batch window, non-preachy planner prompt, reaction-spam filter).
   - Periodic `get_status` zombie-account probe (`60s`) + `800ms` dual-account ingress failover (`activeIngressAccountKey()`) so either healthy account keeps the room ready if the other silently expires or disconnects.

## 3. Key Files Map
- Runtime & Prompting: `src/voice-room/runtime.ts`, `src/voice-room/context.ts`, `src/voice-room/model.ts`, `src/voice-room/skills.ts`, `src/voice-room/memory.ts`, `src/voice-room/delivery-policy.ts`
- Vision & Image Recall: `src/voice-room/image.ts`, `src/voice-room/image-context.ts`, `src/voice-room/qq-message.ts`
- Ambient: `src/voice-room/participation-policy.ts`, `src/voice-room/participation-planner.ts`
- Web & Privacy: `src/voice-room/web.ts`, `src/privacy.ts`, `src/voice-room/public-policy.ts`
- QQ Transport & Store: `src/qq-peer.ts`, `src/voice-room/qq-server.ts`, `src/voice-room/store.ts`, `scripts/room-qq.ts`
- Skills & Docs: `skills/deep-link-analysis/SKILL.md`, `skills/deep-tech-qa/SKILL.md`, `skills/casual-chat/SKILL.md`, `docs/persona-style-guide.md`
- Tests: `tests/voice-room-request-lifecycle.test.ts`, `tests/voice-room-memory.test.ts`, `tests/voice-room-image-context.test.ts`, `tests/voice-room-tuning.test.ts`

## 4. Optional Future Directions
1. **Bounded Dual-Bot Banter**: Allow 1 controlled follow-up turn between the two characters on interesting topics/jokes (strictly capped at 1 hop to prevent loops).
2. **Proactive Daily Topic Radar**: Scheduled 1x/day curated high-signal topic opener in-character.
3. **Expressive Voice Strip Tuning**: Spoken pauses, natural interjections, and tighter voice-translation phrasing for Fish Audio TTS.
4. **Layer-2 Private Persona Examples**: Add 3–5 concrete group-chat lines to each private persona file following `docs/persona-style-guide.md`.
