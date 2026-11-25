# VoiceRoom Phase 1 → Phase 2 Handoff

## 1. Current State (Verified Baseline)
- **Repo**: `D:\proj\VoiceRoom\repo\qq-voice-room` (`origin/main`, remote `https://github.com/icmmme/qq-voice-room.git`)
- **Tests**: `npm.cmd run build && node dist/scripts/demo.js && node --test dist/tests/voice-room-request-lifecycle.test.js` → **154/154 PASS**
- **Live Release**: `D:\proj\VoiceRoom\releases\m5-fix4-d7b79fd-20261125\app` (keep `m5-fix3-aa4c5d2-20261121-1755` untouched for instant rollback)
- **Live Launch Command** (never read/print `.env` files; pass paths only):
  ```powershell
  & "C:\Program Files\nodejs\node.exe" `
    "--env-file=D:\demo\pa-starter-voice-room\local\voice-room\room.env" `
    "--env-file=D:\demo\pa-starter-voice-room\local\voice-room\fish.env" `
    "D:\proj\VoiceRoom\releases\m5-fix4-d7b79fd-20261125\app\dist\scripts\room-qq.js" "run" `
    "--config" "D:\demo\output\a03-4-live-20261105\private\pa-v2-lifecycle-rollout-20261114\room.lifecycle.json"
  ```
- **SQLite**: Schema v9 (`D:\demo\output\a03-4-live-20261105\private\pa-v2-lifecycle-rollout-20261114\data\room.sqlite`) — must remain backwards-compatible.

## 2. Phase 1 Delivered & Verified Decisions
1. **Repo Cleanup (`f62a168`)**: Removed dead M1 governance/legacy/worker-test scaffolding (-47k lines). Single clean lifecycle runtime.
2. **Quality-First Budgets (`20457da`, `341983c`)**:
   - `SAFE_ROOM_CONTEXT_WINDOW = 65536`, default `PA_CONTEXT_WINDOW = 32768` (accepts up to `262144`), default `PA_MAX_TOKENS = 4096`.
   - Casual chat: `1024` tokens, `1–2` segments, thinking disabled on DeepSeek toggle models for speed.
   - Deep / URL replies: `4096–6144` tokens, up to `12` segments (`4000` chars/segment), native thinking enabled (`PA_THINKING=auto`).
3. **Overnight Context Cutoff (`src/voice-room/context.ts`)**:
   - 45-min gap cutoff (`ROOM_HISTORY_GAP_MS`) + 25-row soft cap (`ROOM_HISTORY_MAX_ROWS`) + readable `currentTime` & relative `ago`.
   - Explicit `replyToMessageId` to an older message injects ONLY `quotedMessage` without resurrecting last night's thread.
4. **Web Fetch + Search (`src/voice-room/web.ts`)**:
   - Routing: GitHub REST API → FxTwitter API (`api.fxtwitter.com`, handles tweets/quotes/X Articles) → Jina Reader (`r.jina.ai`) → direct HTML cleaner fallback, with SSRF protection & dynamic 75%/25% token-aware truncation.
   - Search providers (native tool-calling up to 3 rounds in deep mode): `BOCHA_API_KEY` > `EXA_API_KEY` > `TAVILY_API_KEY`.
   - Privacy (`src/privacy.ts`, `src/voice-room/public-policy.ts`): URL numeric IDs exempt from PII regex; Luhn-validated `BANK_CARD`; removed false-positive tech-word keyword filter while keeping real secrets/paths/QQ IDs/PII fail-closed.
5. **QQ Forward Cards + Voice Strategy A (`src/qq-peer.ts`, `src/voice-room/qq-server.ts`, `src/voice-room/runtime.ts`)**:
   - Direct replies with `>200` chars, `>=3` segments, or fetched `webEvidence` pack into 1 atomic `text` segment delivered via OneBot v11 `send_group_forward_msg` with **zero TTS voice**. Short casual replies continue using bubbles + Fish Audio TTS.
6. **Hot-Reload Open-Standard Skills (`skills/<name>/SKILL.md`, `src/voice-room/skills.ts`)**:
   - Agent Skills YAML frontmatter + progressive disclosure (`listRoomSkills()` / `loadRoomSkill()`), `mtime` hot-reload (no rebuild needed when editing `SKILL.md`), judgment-first v2 prompts.

## 3. Key Files Map
- Runtime & Prompting: `src/voice-room/runtime.ts`, `src/voice-room/context.ts`, `src/voice-room/model.ts`, `src/voice-room/skills.ts`
- Web & Privacy: `src/voice-room/web.ts`, `src/privacy.ts`, `src/voice-room/public-policy.ts`
- QQ Transport & Store: `src/qq-peer.ts`, `src/voice-room/qq-server.ts`, `src/voice-room/store.ts`, `scripts/room-qq.ts`
- Ambient (Phase 2 target): `src/voice-room/participation-policy.ts`, `src/voice-room/participation-planner.ts`
- Skills: `skills/deep-link-analysis/SKILL.md`, `skills/deep-tech-qa/SKILL.md`, `skills/casual-chat/SKILL.md`
- Tests: `tests/voice-room-request-lifecycle.test.ts`

## 4. Recommended Phase 2 Orchestration & Next Tracks
- **Dev Orchestration**: `Orchestrator (Gemini 4 Neon)` with `Medium` for routine changes, `High`/`Extra High` for complex state/architecture, and **Swarm mode (`/teamwork` or `/swarm`)** with isolated `share` workspaces for parallel Phase 2 tracks.
- **Ops Prerequisite (NapCat Login Stability)**:
  - Root cause found in `C:\ProgramData\NapCatQQ Desktop\logs\bots\bots\*.log`: Clash Verge (`127.0.0.1:7892`) lacked QQ/NapCat bypass rules, causing simultaneous ~2h TCP resets (`10060`/`10053`) and QQ ticket invalidation (`你的用户身份已失效`).
  - Fix on host: Clash Verge Rule mode + `DIRECT` rules for `NapCatWinBootMain.exe`, `NapCatQQ-Desktop.exe`, `QQ.exe`, `qq.com`, `tencent.com`, `qpic.cn`, `gtimg.cn` (plus System Proxy Bypass).
- **Parallel Phase 2 Tracks**:
  1. **Track A — Module 3: Natural Ambient Participation (`src/voice-room/participation-policy.ts`, `src/voice-room/participation-planner.ts`, `src/voice-room/runtime.ts`)**:
     - Diagnose why ambient chiming rarely triggers in live QQ; relax overly strict multi-person/quiet-window gates while keeping anti-spam cooldowns and natural topic relevance.
  2. **Track B — NapCat Resilience & Graceful Degradation (`src/voice-room/runtime.ts`, `src/voice-room/qq-server.ts`)**:
     - **Single-account degradation**: keep room `ready` when ingress account is online even if the secondary account drops (skip only the offline character; auto-restore when it reconnects).
     - **Short reconnect grace window (~15s)**: do not immediately cancel in-flight generation on brief 1–2s WS blinks.
     - **Offline alert (>30s)**: surface clear offline warning via online sibling account (or structured notice) when one account stays disconnected.
  3. **Track C — Deferred (Phase 3 after Track A/B verified)**:
     - Optional search provider keys (`BOCHA_API_KEY` / `EXA_API_KEY` / `TAVILY_API_KEY`), lightweight read-only MCP client bridge, and scoped cross-day topic memory without overnight chat pollution.
