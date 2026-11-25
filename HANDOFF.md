# VoiceRoom Phase 2 → Phase 3 Handoff

## 1. Current State (Verified Baseline)
- **Repo**: `D:\proj\VoiceRoom\repo\qq-voice-room` (`origin/main`, remote `https://github.com/icmmme/qq-voice-room.git`)
- **Verified Commit**: `1e78326` (all Phase 1 + Phase 2 work landed and verified)
- **Tests**: `npm.cmd run build && node dist/scripts/demo.js && node --test dist/tests/voice-room-request-lifecycle.test.js` → **156/156 PASS**
- **Live Release**: `D:\proj\VoiceRoom\releases\m5-fix4-d7b79fd-20261125\app` (`dist/` + `skills/` synced; keep `m5-fix3-aa4c5d2-20261121-1755` untouched for instant rollback)
- **Live Launch Command** (never read/print `.env` files; pass paths only):
  ```powershell
  & "C:\Program Files\nodejs\node.exe" `
    "--env-file=D:\demo\pa-starter-voice-room\local\voice-room\room.env" `
    "--env-file=D:\demo\pa-starter-voice-room\local\voice-room\fish.env" `
    "D:\proj\VoiceRoom\releases\m5-fix4-d7b79fd-20261125\app\dist\scripts\room-qq.js" "run" `
    "--config" "D:\demo\output\a03-4-live-20261105\private\pa-v2-lifecycle-rollout-20261114\room.lifecycle.json"
  ```
- **SQLite**: Schema v9 (`D:\demo\output\a03-4-live-20261105\private\pa-v2-lifecycle-rollout-20261114\data\room.sqlite`) — must remain backwards-compatible.
- **Ops**: Clash Verge (`127.0.0.1:7892`) has QQ/NapCat `DIRECT` bypass rules configured on the host.

## 2. Phase 1 + Phase 2 Delivered & Verified Decisions
1. **Repo Cleanup (`f62a168`)**: Removed dead M1 governance/legacy/worker-test scaffolding (-47k lines). Single clean lifecycle runtime.
2. **Quality-First Budgets & Smart Thinking (`20457da`, `341983c`)**:
   - `SAFE_ROOM_CONTEXT_WINDOW = 65536`, default `PA_CONTEXT_WINDOW = 32768` (accepts up to `262144`), default `PA_MAX_TOKENS = 4096`.
   - Casual chat: `1024` tokens, `1–2` segments, thinking disabled on DeepSeek toggle models for speed.
   - Deep / URL replies: `4096–6144` tokens, up to `12` segments (`4000` chars/segment), native thinking enabled (`PA_THINKING=auto`), schema-tolerant `parseDeepLifecycleAnswer`.
3. **Overnight Context Cutoff (`src/voice-room/context.ts`)**:
   - 45-min gap cutoff (`ROOM_HISTORY_GAP_MS`) + 25-row soft cap (`ROOM_HISTORY_MAX_ROWS`) + readable `currentTime` & relative `ago`.
   - Explicit `replyToMessageId` to an older message injects ONLY `quotedMessage` without resurrecting last night's thread.
4. **Web Fetch + Search (`src/voice-room/web.ts`)**:
   - Routing: GitHub REST API → FxTwitter API (`api.fxtwitter.com`, handles tweets/quotes/X Articles) → Jina Reader (`r.jina.ai`) → direct HTML cleaner fallback, with SSRF protection & dynamic 75%/25% token-aware truncation.
   - Search providers (native tool-calling up to 3 rounds in deep mode): `BOCHA_API_KEY` > `EXA_API_KEY` > `TAVILY_API_KEY`.
   - Privacy (`src/privacy.ts`, `src/voice-room/public-policy.ts`): URL numeric IDs exempt from PII regex; Luhn-validated `BANK_CARD`; technical terms allowed while real secrets/paths/QQ IDs/PII stay fail-closed.
5. **QQ Forward Cards + Voice Strategy A (`src/qq-peer.ts`, `src/voice-room/qq-server.ts`, `src/voice-room/runtime.ts`)**:
   - Direct replies with `>200` chars, `>=3` segments, or fetched `webEvidence` pack into 1 atomic `text` segment delivered via OneBot v11 `send_group_forward_msg` with **zero TTS voice**. Short casual replies continue using bubbles + Fish Audio TTS.
6. **Hot-Reload Open-Standard Skills (`skills/<name>/SKILL.md`, `src/voice-room/skills.ts`)**:
   - Agent Skills YAML frontmatter + progressive disclosure (`listRoomSkills()` / `loadRoomSkill()`), `mtime` hot-reload (edit `SKILL.md` directly without rebuild), judgment-first v2 prompts (`deep-link-analysis`, `deep-tech-qa`, `casual-chat`).
7. **Phase 2 Track A — Module 3 Natural Ambient Participation (`1e78326`, `participation-policy.ts`, `participation-planner.ts`, `runtime.ts`)**:
   - Added `"named-mention"`, `"open-question"`, and `"natural-topic"` triggers, expanded `ambientHumanBatch` window from 2s to 2 min, upgraded `createAmbientPlannerPrompt`, and filtered planner characters to online accounts only.
8. **Phase 2 Track B — NapCat Resilience & Graceful Degradation (`1e78326`, `runtime.ts`, `qq-server.ts`)**:
   - Single-account survival (`ready` requires `ingressAccountKey` online; secondary offline drops only offline character and settles turns as `account_offline`), 15s single-account startup fallback, 10s ingress blink grace window, and 30s offline group alert.

## 3. Key Files Map
- Runtime & Prompting: `src/voice-room/runtime.ts`, `src/voice-room/context.ts`, `src/voice-room/model.ts`, `src/voice-room/skills.ts`
- Ambient: `src/voice-room/participation-policy.ts`, `src/voice-room/participation-planner.ts`
- Web & Privacy: `src/voice-room/web.ts`, `src/privacy.ts`, `src/voice-room/public-policy.ts`
- QQ Transport & Store: `src/qq-peer.ts`, `src/voice-room/qq-server.ts`, `src/voice-room/store.ts`, `scripts/room-qq.ts`
- Skills: `skills/deep-link-analysis/SKILL.md`, `skills/deep-tech-qa/SKILL.md`, `skills/casual-chat/SKILL.md`
- Tests: `tests/voice-room-request-lifecycle.test.ts`

## 4. Phase 3 Next Tracks & Recommended Orchestration
- **Dev Orchestration**: `Orchestrator (Gemini 4 Neon)` — `Medium` for single-module fixes/tuning, `High`/`Extra High` for complex design, and **Swarm mode (`/teamwork` or `/swarm`)** with isolated `share` workspaces for parallel multi-track features.
- **Track 1 — Search Key & Live Skill Tuning**:
  - Optional search provider keys (`BOCHA_API_KEY` / `EXA_API_KEY` / `TAVILY_API_KEY`) in `room.env`, and iterative tuning of `skills/*/SKILL.md` based on live QQ feedback.
- **Track 2 — Read-Only MCP Client Integration**:
  - Lightweight read-only MCP client bridge to expose external tools/knowledge safely inside the public-room privacy boundary.
- **Track 3 — Scoped Long-Term Memory**:
  - Cross-day topic/fact memory store with clean retrieval boundaries that never reintroduces overnight chat pollution.
