import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { roomPublicPolicy } from "../src/voice-room/public-policy.js";
import { readRoomQqSettings } from "../src/voice-room/qq-config.js";
import { VoiceRoom } from "../src/voice-room/runtime.js";
import type { RoomInput } from "../src/voice-room/types.js";

async function main() {
  const config = "examples/voice-room/room.example.json";
  const settings = readRoomQqSettings(config, {
    ROOM_QQ_A_TOKEN: "offline-demo-token-a",
    ROOM_QQ_B_TOKEN: "offline-demo-token-b",
  });
  const queue = settings.workerQueue;
  if (!queue) throw new Error("The demo requires the V2 worker queue");
  const root = mkdtempSync(join(tmpdir(), "voice-room-demo-"));
  const policy = roomPublicPolicy({ ...settings, dataDir: root }, {
    baseUrl: "https://model.invalid/v1", modelId: "offline-demo", apiKey: "offline-demo-key",
    contextWindow: 8192, maxTokens: 256, requestTimeoutMs: 1000,
  }, config);
  const unused = async (): Promise<never> => { throw new Error("Legacy delivery is not part of this demo"); };
  const room = new VoiceRoom(join(root, "room.sqlite"), settings.room, {
    ...policy, now: Date.now, generate: unused, synthesize: unused, sendText: unused, sendAudio: unused,
  }, { execution: "lifecycle" });
  try {
    const [first, second] = settings.room.characters;
    if (!first || !second) throw new Error("The demo requires two fictional characters");
    for (const character of [first, second]) room.setOnline(character.accountKey, true);
    const delivered: string[] = [];
    await room.startLifecycleProductionWorker({
      model: { generate: async () => ({ kind: "reply", segments: ["你好！我听到了。"] }) },
      apiTimeoutMs: 100,
      closePolicy: { observationCapacity: 32, perAccountCapacity: 16, drainMs: 100, releaseMs: 100, writeWaitMs: 50 },
      dispatch: async request => {
        request.beforeSend();
        const messageId = String(90000 + delivered.length);
        await request.observe({ kind: "ack", messageId });
        request.released();
        delivered.push(request.item.character.id);
        console.log(`${request.item.character.name}: ${request.item.segment.text}`);
        return messageId;
      },
      beginClose: () => {},
      sealObservations: async () => {},
    });
    const message: RoomInput = {
      accountKey: first.accountKey, selfId: first.selfId, groupId: settings.room.groupId,
      senderId: settings.room.ownerId, messageId: "12345", text: "两位好！", mentions: [first.selfId, second.selfId],
    };
    assert.equal(room.store.lifecycleControlState().mode, "mention_only");
    assert.equal(room.receiveLifecycle(message, queue), "scheduled");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && room.store.lifecycleRequests()[0]?.status !== "completed") {
      await setTimeout(10);
    }
    assert.equal(room.store.lifecycleRequests()[0]?.status, "completed");
    assert.deepEqual(delivered, [first.id, second.id]);
    console.log("V2 离线演示完成：两个角色按 @ 顺序回复；模型和投递均为模拟。");
  } finally {
    await room.close();
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
