import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceRoom, type SyntheticWorkerPort } from "../src/voice-room/runtime.js";
import type { RoomQueuePolicy } from "../src/voice-room/store.js";
import type { RoomConfig, RoomDependencies, RoomDelivery, RoomInput, RoomPrompt } from "../src/voice-room/types.js";
import type { RoomGitHubReadPayload, RoomGitHubTarget } from "../src/voice-room/github.js";

export const ROOM_FIXTURE: RoomConfig = {
  roomId: "synthetic-room", groupId: "10000", ownerId: "10001", ingressAccountKey: "account-a",
  characters: [
    { id: "character-a", accountKey: "account-a", selfId: "10002", name: "合成角色甲", voiceKey: "voice-a" },
    { id: "character-b", accountKey: "account-b", selfId: "10003", name: "合成角色乙", voiceKey: "voice-b" },
  ],
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** Explicit synthetic Worker helper. The existing roomFixture remains Legacy by default. */
export function workerFixture(config: RoomConfig = ROOM_FIXTURE) {
  const forbiddenCalls: string[] = [];
  const forbidden = (name: string): never => { forbiddenCalls.push(name); throw new Error("synthetic-forbidden-" + name); };
  const h = roomFixture({ generate: async () => forbidden("generate"), translateVoice: async () => forbidden("translate"),
    synthesize: async () => forbidden("tts"), sendText: async () => forbidden("text"), sendAudio: async () => forbidden("audio") }, config);
  return { ...h, forbiddenCalls,
    get room() { return h.room; }, get now() { return h.now; }, set now(value: number) { h.now = value; },
    start(port: SyntheticWorkerPort = { execute: async () => ({ status: "completed", reason: "synthetic_completed" }) }) {
      return h.room.startWorkerForTest(port);
    },
    startPlanned(port: import("../src/voice-room/types.js").SyntheticResponsePort) { return h.room.startPlannedWorkerForTest(port); },
    unpause() { h.room.store.setPaused(false); h.room.wakeWorkerForTest(); },
    control(action: import("../src/voice-room/types.js").RoomControlAction,
      fields: Partial<RoomInput> = {}, mode?: import("../src/voice-room/types.js").RoomParticipationMode) {
      return h.room.handleControl(action, h.input("/room " + action, fields), mode);
    },
    enqueue(id: number, fields: Partial<RoomInput> = {}, policy: RoomQueuePolicy = { capacity: 20, memberLimit: 20, memberWindowMs: 1000, ttlMs: 10000 }) {
      return h.room.acceptWorkForTest(h.input("合成队列问题", { messageId: String(id), mentions: ["10003", "10002"], ...fields }), policy);
    },
  };
}
export const flush = () => new Promise<void>(resolve => setImmediate(resolve));

export function roomFixture(overrides: Partial<RoomDependencies> = {}, config: RoomConfig = ROOM_FIXTURE) {
  const root = mkdtempSync(join(tmpdir(), "pa-room-synthetic-"));
  const file = join(root, "room.sqlite");
  let now = Date.parse("2026-10-28T00:00:00Z"), sequence = 0;
  const prompts: RoomPrompt[] = [], texts: RoomDelivery[] = [], audios: RoomDelivery[] = [], synthesis: RoomDelivery[] = [];
  const githubCalls: RoomGitHubTarget[] = [];
  const defaultGitHubRead: RoomDependencies["githubRead"] = async (target: RoomGitHubTarget): Promise<RoomGitHubReadPayload> =>
    ({ data: { full_name: `${target.owner}/${target.repo}`, description: "合成仓库", default_branch: "main",
      stargazers_count: 1, forks_count: 2, updated_at: "2026-11-08T00:00:00Z", html_url: target.htmlUrl },
      htmlUrl: target.htmlUrl });
  const deps: RoomDependencies = {
    now: () => now,
    persona: c => `# ${c.name}\n这是仅用于测试的公开虚构人设。`,
    generate: async prompt => { prompts.push(prompt); return { kind: "reply", text: `合成台词${prompts.length}` }; },
    synthesize: async delivery => { synthesis.push(delivery); return new Uint8Array([1, 2, 3]); },
    sendText: async delivery => { texts.push(delivery); return `text-${texts.length}`; },
    sendAudio: async delivery => { audios.push(delivery); return `audio-${audios.length}`; },
    permitsText: text => !text.includes("SYNTHETIC_SECRET"), ...overrides,
  };
  deps.githubRead = overrides.githubRead ?? (async (target, signal) => {
    githubCalls.push(target); return defaultGitHubRead!(target, signal);
  });
  let room = new VoiceRoom(file, config, deps);
  function online() { for (const c of config.characters) room.setOnline(c.accountKey, true); }
  online();
  const input = (text: string, fields: Partial<RoomInput> = {}): RoomInput => ({ accountKey: "account-a", selfId: "10002",
    groupId: "10000", senderId: "10001", messageId: String(++sequence), text, ...fields });
  return { root, file, deps, prompts, texts, audios, synthesis, githubCalls, input,
    get room() { return room; }, get now() { return now; }, set now(value: number) { now = value; },
    resume() { return room.receive(input("/room resume")); },
    async reopen() { await room.close(); room = new VoiceRoom(file, config, deps); online(); },
    async close() { await room.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
