import assert from "node:assert/strict";
import test from "node:test";
import { checkRoomConfig } from "../src/voice-room/config.js";
import {
  FORWARD_CARD_CHAR_THRESHOLD,
  FORWARD_CARD_SEGMENT_THRESHOLD,
  shouldDeliverAsForwardCard,
} from "../src/voice-room/delivery-policy.js";
import {
  AMBIENT_IDLE_THRESHOLD_MS,
  buildAmbientPlannerInput,
  checkedAmbientPlannerDecision,
  createAmbientPlannerPrompt,
} from "../src/voice-room/participation-planner.js";
import { ParticipationPolicy } from "../src/voice-room/participation-policy.js";
import type { RoomConfig, RoomMessage } from "../src/voice-room/types.js";

function sampleRoomConfig(): ReturnType<typeof checkRoomConfig> {
  const raw: RoomConfig = {
    roomId: "synthetic-tuning",
    groupId: "10000",
    ownerId: "10001",
    ingressAccountKey: "account-a",
    deliveryMode: "both",
    characters: [
      { id: "character-a", accountKey: "account-a", selfId: "10002", name: "Character A", voiceKey: "voice-a" },
      { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
    ],
  };
  return checkRoomConfig(raw);
}

test("delivery-policy keeps short witty banter and meme-link replies as chat bubbles", () => {
  assert.equal(FORWARD_CARD_CHAR_THRESHOLD, 280);
  assert.equal(FORWARD_CARD_SEGMENT_THRESHOLD, 3);

  assert.equal(
    shouldDeliverAsForwardCard({
      text: "笑死，这仓库 README 比代码还长",
      segmentCount: 1,
      hasWebEvidence: true,
      deep: false,
    }),
    false,
  );

  assert.equal(
    shouldDeliverAsForwardCard({
      text: "这波属于自己给自己挖坑了\n\n不过能跑就行",
      segmentCount: 2,
      hasWebEvidence: true,
      deep: true,
    }),
    false,
  );

  // Exact 280 Unicode code points (including non-BMP emoji) stays a normal bubble
  const exact280 = `${"啊".repeat(279)}😂`;
  assert.equal([...exact280].length, 280);
  assert.equal(
    shouldDeliverAsForwardCard({
      text: exact280,
      segmentCount: 2,
      hasWebEvidence: true,
      deep: true,
    }),
    false,
  );
});

test("delivery-policy packs long researched answers into forward cards with Strategy A", () => {
  const over280 = "啊".repeat(281);
  assert.equal(
    shouldDeliverAsForwardCard({
      text: over280,
      segmentCount: 1,
      hasWebEvidence: false,
      deep: false,
    }),
    true,
  );

  assert.equal(
    shouldDeliverAsForwardCard({
      text: "第一点\n\n第二点\n\n第三点",
      segmentCount: 3,
      hasWebEvidence: false,
      deep: false,
    }),
    true,
  );

  // Trimmed whitespace does not falsely push 280-char text over threshold
  assert.equal(
    shouldDeliverAsForwardCard({
      text: `  ${"字".repeat(280)} \n `,
      segmentCount: 2,
      hasWebEvidence: true,
      deep: true,
    }),
    false,
  );

  assert.equal(
    shouldDeliverAsForwardCard({
      text: "   ",
      segmentCount: 1,
      hasWebEvidence: true,
      deep: true,
    }),
    false,
  );
});

test("ambient planner prompt preserves JSON contract and enforces natural non-preachy group vibe", () => {
  const characters = [
    { id: "character-a", name: "Character A", persona: "public-a" },
    { id: "character-b", name: "Character B", persona: "public-b" },
  ] as const;

  const input = buildAmbientPlannerInput("这脚本跑起来居然不报错了？", [], characters, AMBIENT_IDLE_THRESHOLD_MS);
  const prompt = createAmbientPlannerPrompt(input);
  const combined = `${prompt.systemPrompt}\n${prompt.messages[0].content}`;

  const roundTrip = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(combined));
  assert.equal(roundTrip, combined);
  assert.equal(combined.includes("\uFFFD"), false);
  assert.equal(prompt.tools.length, 0);

  // Required invariants
  assert.match(prompt.systemPrompt, /你是公开群聊的 Ambient 参与度规划器/);
  assert.match(prompt.systemPrompt, /只返回一个 JSON 对象/);
  assert.match(prompt.systemPrompt, /\{"kind":"skip"\}/);
  assert.match(prompt.systemPrompt, /join/);
  assert.match(prompt.systemPrompt, /initiate/);

  // Group-vibe tuning invariants
  assert.match(prompt.systemPrompt, /熟人/);
  assert.match(prompt.systemPrompt, /群管/);
  assert.match(prompt.systemPrompt, /说教/);
  assert.match(prompt.systemPrompt, /泼冷水/);

  assert.deepEqual(checkedAmbientPlannerDecision({ kind: "join", characterIds: ["character-a"] }, input), {
    kind: "join",
    characterIds: ["character-a"],
  });
  const noInitInput = buildAmbientPlannerInput("hi", [], characters, 1000);
  assert.equal(checkedAmbientPlannerDecision({ kind: "initiate", characterIds: ["character-a"] }, noInitInput), null);
});

test("participation policy keeps low-signal filler silent while admitting natural topics", () => {
  const cfg = sampleRoomConfig();
  const policy = new ParticipationPolicy(cfg);
  const now = Date.parse("2026-11-26T04:00:00Z");

  const msg = (id: number, text: string, speakerId = "20001"): RoomMessage => ({
    id,
    speakerType: "user",
    speakerId,
    accountKey: "account-a",
    targetId: null,
    text,
    platformId: String(90000 + id),
    createdAt: now - 5000,
  });

  const baseCtx = {
    now,
    observedAt: now - 5000,
    lastAttemptAt: null,
    online: new Set(["account-a", "account-b"]),
    paused: false,
    stopped: false,
    busy: false,
    blockedTarget: false,
    hasBudget: true,
  };

  for (const filler of ["嗯嗯", "666", "2333", "笑死", "收到", "哈哈哈哈哈"]) {
    const decision = policy.decide({ ...baseCtx, history: [msg(1, filler)], pendingIds: [1] });
    assert.equal(decision.shouldReply, false, `expected ${filler} to stay silent`);
    assert.equal(decision.reason, "trivial", `expected ${filler} to be trivial`);
  }

  const noSignal = policy.decide({ ...baseCtx, history: [msg(2, "哈哈真行")], pendingIds: [2] });
  assert.equal(noSignal.shouldReply, false);
  assert.equal(noSignal.reason, "no-signal");

  const publicQ = policy.decide({ ...baseCtx, history: [msg(3, "这个新功能大家用着顺手吗？")], pendingIds: [3] });
  assert.equal(publicQ.shouldReply, true);
  assert.equal(publicQ.reason, "public-question");

  const openQ = policy.decide({ ...baseCtx, history: [msg(4, "这套方案跑起来会不会太慢？")], pendingIds: [4] });
  assert.equal(openQ.shouldReply, true);
  assert.equal(openQ.reason, "open-question");
});
