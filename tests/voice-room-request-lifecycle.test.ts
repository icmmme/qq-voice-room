import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { QqPeer, type QqAttemptOptions } from "../src/qq-peer.js";
import type { ModelConfig } from "../src/config.js";
import { checkRoomConfig, ROOM_HISTORY_PAGE_LIMIT } from "../src/voice-room/config.js";
import { parseRoomQqMessage } from "../src/voice-room/qq-message.js";
import { readRoomQqSettings, type RoomQqSettings } from "../src/voice-room/qq-config.js";
import { startRoomQq, type RoomQqNotice } from "../src/voice-room/qq-server.js";
import { roomPublicPolicy } from "../src/voice-room/public-policy.js";
import {
  VoiceRoom,
  WORKER_EXPLICIT_NO_ANSWER_FALLBACK,
  type RoomLifecycleDispatch,
  type RoomLifecycleWorker,
} from "../src/voice-room/runtime.js";
import { RoomStore, type RoomQueuePolicy } from "../src/voice-room/store.js";
import { RoomSendError, type RoomConfig, type RoomDependencies, type RoomInput } from "../src/voice-room/types.js";
import type { RoomLifecycleAnswer } from "../src/voice-room/model.js";
import {
  AMBIENT_IDLE_THRESHOLD_MS,
  ambientInitiationAllowed,
  ambientPlannerContextKey,
  buildAmbientPlannerInput,
  checkedAmbientPlannerDecision,
  createAmbientPlannerPrompt,
  type AmbientPlannerInput,
  type RoomAmbientPlanner,
} from "../src/voice-room/participation-planner.js";
import { isQuotedContinuation } from "../src/voice-room/participation-policy.js";
import { deferred } from "./voice-room-fixture.js";

const QUEUE: RoomQueuePolicy = { capacity: 20, memberLimit: 20, memberWindowMs: 1000, ttlMs: 10000 };

function roomConfig(overrides: Partial<RoomConfig> = {}): RoomConfig {
  return {
    roomId: "synthetic-lifecycle",
    groupId: "10000",
    ownerId: "10001",
    ingressAccountKey: "account-a",
    deliveryMode: "text",
    characters: [
      { id: "character-a", accountKey: "account-a", selfId: "10002", name: "Character A", voiceKey: "voice-a" },
      { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
    ],
    ...overrides,
  };
}

function roomInput(messageId: string, text: string, mentions: readonly string[] = [],
  overrides: Partial<RoomInput> = {}): RoomInput {
  return {
    accountKey: "account-a",
    selfId: "10002",
    groupId: "10000",
    senderId: "10001",
    messageId,
    text,
    mentions: [...mentions],
    ...overrides,
  };
}

const POLICY_DATA_DIR = "C:\\synthetic-private-room-data";
const POLICY_CONFIG_FILE = "C:\\synthetic-private-room-config.json";

function lifecyclePolicy(config: RoomConfig = roomConfig()) {
  const room = checkRoomConfig(config);
  const settings: RoomQqSettings = {
    room,
    dataDir: POLICY_DATA_DIR,
    port: 0,
    apiTimeoutMs: 100,
    accounts: room.characters.map((character, index) => ({
      accountKey: character.accountKey,
      token: `synthetic-token-${index}-12345`,
      personaFile: `C:\\synthetic-private-persona-${index}.md`,
    })),
  };
  const model: ModelConfig = {
    baseUrl: "https://model.invalid/v1",
    modelId: "fixture-model",
    apiKey: "fixture-key",
    contextWindow: 8192,
    maxTokens: 256,
    requestTimeoutMs: 1000,
    tavilyApiKey: "synthetic-tavily-key",
  };
  return roomPublicPolicy(settings, model, POLICY_CONFIG_FILE);
}

async function waitFor(predicate: () => boolean, label = "synthetic-condition", timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function lifecyclePromptCacheSize(room: VoiceRoom): number {
  return (room as unknown as {
    readonly lifecycleTranslationPrompts: ReadonlyMap<string, unknown>;
  }).lifecycleTranslationPrompts.size;
}

interface DispatchRecord {
  readonly characterId: string;
  readonly medium: "text" | "audio";
  readonly text: string;
  readonly requestId: string;
}

interface LifecycleHarness {
  readonly root: string;
  readonly checkedConfig: ReturnType<typeof checkRoomConfig>;
  readonly room: VoiceRoom;
  readonly prompts: Parameters<RoomLifecycleWorker["model"]["generate"]>[0][];
  readonly ambientPlannerCalls: AmbientPlannerInput[];
  readonly dispatches: DispatchRecord[];
  readonly synthesisCalls: number;
  receive(messageId: string, text: string, mentions?: readonly string[],
    overrides?: Partial<RoomInput>): ReturnType<VoiceRoom["receiveLifecycle"]>;
  close(): Promise<void>;
}

async function lifecycleHarness(t: TestContext, options: {
  config?: RoomConfig;
  model: RoomLifecycleWorker["model"];
  translateVoice?: RoomDependencies["translateVoice"];
  synthesize?: RoomDependencies["synthesize"];
  dispatch?: (request: RoomLifecycleDispatch, record: (value: DispatchRecord) => void) => Promise<string>;
  ambientPlanner?: RoomAmbientPlanner;
  deps?: Partial<RoomDependencies>;
}): Promise<LifecycleHarness> {
  const root = mkdtempSync(join(tmpdir(), "pa-lifecycle-test-"));
  const checkedConfig = checkRoomConfig(options.config ?? roomConfig());
  let sent = 0;
  let synthesisCalls = 0;
  const prompts: LifecycleHarness["prompts"] = [];
  const ambientPlannerCalls: AmbientPlannerInput[] = [];
  const dispatches: DispatchRecord[] = [];
  let closed = false;
  const forbidden = async (): Promise<never> => { throw new Error("synthetic-legacy-dependency-forbidden"); };
  const deps: RoomDependencies = {
    now: () => Date.parse("2026-11-13T00:00:00Z"),
    persona: character => `# ${character.name}\nSynthetic public persona.`,
    generate: forbidden,
    translateVoice: options.translateVoice,
    synthesize: options.synthesize ?? (async () => {
      synthesisCalls++;
      return new Uint8Array([1, 2, 3]);
    }),
    sendText: forbidden,
    sendAudio: forbidden,
    permitsText: () => true,
    permitsPrompt: () => true,
    ...options.deps,
  };
  const room = new VoiceRoom(join(root, "room.sqlite"), checkedConfig, deps, { execution: "lifecycle" });
  const wrappedModel = {
    generate: async (prompt: Parameters<RoomLifecycleWorker["model"]["generate"]>[0],
      signal: AbortSignal, maxChars: number): Promise<RoomLifecycleAnswer> => {
      prompts.push(prompt);
      return options.model.generate(prompt, signal, maxChars);
    },
  };
  const ambientPlanner = options.ambientPlanner === undefined ? undefined : {
    plan: async (input: AmbientPlannerInput, prompt: Parameters<RoomAmbientPlanner["plan"]>[1],
      signal: AbortSignal): Promise<unknown> => {
      ambientPlannerCalls.push(input);
      return options.ambientPlanner!.plan(input, prompt, signal);
    },
  };
  const record = (value: DispatchRecord) => { dispatches.push(value); };
  const defaultDispatch = async (request: RoomLifecycleDispatch): Promise<string> => {
    const messageId = String(700000 + ++sent);
    request.beforeSend();
    await request.observe({ kind: "ack", messageId });
    request.released();
    return messageId;
  };
  const dispatch = async (request: RoomLifecycleDispatch): Promise<string> => {
    record({
      characterId: request.item.character.id,
      medium: request.medium,
      text: request.item.segment.text,
      requestId: request.item.request.requestId,
    });
    return options.dispatch ? options.dispatch(request, record) : defaultDispatch(request);
  };
  for (const character of checkedConfig.characters) room.setOnline(character.accountKey, true);
  await room.startLifecycleProductionWorker({
    model: wrappedModel,
    ambientPlanner,
    apiTimeoutMs: 100,
    closePolicy: { observationCapacity: 32, perAccountCapacity: 16, drainMs: 100, releaseMs: 100, writeWaitMs: 50 },
    dispatch,
    beginClose: () => {},
    sealObservations: async () => {},
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    await room.close();
    rmSync(root, { recursive: true, force: true });
  };
  t.after(close);
  return {
    root,
    checkedConfig,
    room,
    prompts,
    ambientPlannerCalls,
    dispatches,
    get synthesisCalls() { return synthesisCalls; },
    receive: (messageId, text, mentions = [], overrides = {}) =>
      room.receiveLifecycle(roomInput(messageId, text, mentions, overrides), QUEUE),
    close,
  };
}

test("lifecycle control is owner-only, duplicate-safe, mention-only at startup and old controls are unreachable", async t => {
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["unused"] }) },
  });
  assert.equal(h.room.store.lifecycleControlState().mode, "mention_only");
  assert.equal(h.receive("40", "/room resume"), "rejected");
  const initial = h.room.store.lifecycleControlState();
  assert.equal(initial.mode, "mention_only");

  assert.equal(h.receive("41", "/room mode ambient", [], { senderId: "20002" }), "rejected");
  assert.equal(h.room.store.lifecycleControlState().executionRevision, initial.executionRevision);

  assert.equal(h.receive("42", "/room mode ambient"), "control");
  const ambient = h.room.store.lifecycleControlState();
  assert.equal(ambient.mode, "ambient");
  assert.equal(ambient.executionRevision, initial.executionRevision + 1);

  assert.equal(h.receive("42", "/room mode ambient"), "duplicate");
  const duplicated = h.room.store.lifecycleControlState();
  assert.equal(duplicated.mode, "ambient");
  assert.equal(duplicated.executionRevision, ambient.executionRevision);
  assert.equal(h.receive("430", "/room status", [], { senderId: "20002" }), "rejected");
  assert.equal(h.receive("431", "/room status"), "control");
  assert.equal(h.room.store.lifecycleControlState().executionRevision, ambient.executionRevision);
  assert.equal(h.receive("432", "/room stop", [], { senderId: "20002" }), "rejected");
  assert.equal(h.receive("433", "/room stop"), "control");
  assert.equal(h.room.store.lifecycleControlState().mode, "ambient");
  assert.equal(h.room.store.lifecycleControlState().executionRevision, ambient.executionRevision + 1);
  assert.equal(h.receive("433", "/room stop"), "duplicate");
  assert.equal(h.receive("44", "/room pause"), "rejected");
  assert.equal(h.receive("45", "/room session"), "rejected");
});

test("a duplicate mode event is receipt-only and never cancels newer generation", async t => {
  const first = deferred<RoomLifecycleAnswer>();
  const second = deferred<RoomLifecycleAnswer>();
  const signals: AbortSignal[] = [];
  const h = await lifecycleHarness(t, {
    model: {
      generate: async (_prompt, signal) => {
        signals.push(signal);
        return signals.length === 1 ? first.promise : second.promise;
      },
    },
  });

  assert.equal(h.receive("900", "old request", ["10002"]), "scheduled");
  await waitFor(() => signals.length === 1, "first generation");
  assert.equal(h.receive("901", "/room mode ambient"), "control");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "cancelled", "old request cancellation");
  first.resolve({ kind: "reply", segments: ["must not send"] });
  await flush();

  assert.equal(h.receive("902", "new request", ["10002"]), "scheduled");
  await waitFor(() => signals.length === 2, "second generation");
  const beforeReplay = h.room.store.lifecycleControlState();
  const requestsBeforeReplay = h.room.store.lifecycleRequests();

  assert.equal(h.receive("901", "/room mode ambient"), "duplicate");
  const afterReplay = h.room.store.lifecycleControlState();
  assert.equal(afterReplay.mode, "ambient");
  assert.equal(afterReplay.executionRevision, beforeReplay.executionRevision);
  assert.equal(signals[1]!.aborted, false);
  assert.deepEqual(h.room.store.lifecycleRequests(), requestsBeforeReplay);

  second.resolve({ kind: "reply", segments: ["new reply"] });
  await h.room.whenIdle();
  assert.deepEqual(h.room.store.lifecycleRequests().map(request => request.status), ["cancelled", "completed"]);
  assert.deepEqual(h.dispatches.map(item => item.text), ["new reply"]);
});

test("a historical mode event replayed after a newer revision preserves live work", async t => {
  const first = deferred<RoomLifecycleAnswer>();
  const second = deferred<RoomLifecycleAnswer>();
  const signals: AbortSignal[] = [];
  const h = await lifecycleHarness(t, {
    model: {
      generate: async (_prompt, signal) => {
        signals.push(signal);
        return signals.length === 1 ? first.promise : second.promise;
      },
    },
  });

  assert.equal(h.receive("910", "older request", ["10002"]), "scheduled");
  await waitFor(() => signals.length === 1, "older generation");
  assert.equal(h.receive("911", "/room mode ambient"), "control");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "cancelled", "older cancellation");
  first.resolve({ kind: "reply", segments: ["must not send"] });
  await flush();

  assert.equal(h.receive("912", "/room mode mention_only"), "control");
  assert.equal(h.receive("913", "current request", ["10002"]), "scheduled");
  await waitFor(() => signals.length === 2, "current generation");
  const beforeReplay = h.room.store.lifecycleControlState();
  const requestsBeforeReplay = h.room.store.lifecycleRequests();

  assert.equal(h.receive("911", "/room mode ambient"), "duplicate");
  const afterReplay = h.room.store.lifecycleControlState();
  assert.equal(afterReplay.mode, "mention_only");
  assert.equal(afterReplay.executionRevision, beforeReplay.executionRevision);
  assert.equal(signals[1]!.aborted, false);
  assert.deepEqual(h.room.store.lifecycleRequests(), requestsBeforeReplay);

  second.resolve({ kind: "reply", segments: ["current reply"] });
  await h.room.whenIdle();
  assert.deepEqual(h.room.store.lifecycleRequests().map(request => request.status), ["cancelled", "completed"]);
  assert.deepEqual(h.dispatches.map(item => item.text), ["current reply"]);
});

test("real empty-text mentions create ordered obligations and every character produces one or two segments", async t => {
  let call = 0;
  const policy = lifecyclePolicy();
  const h = await lifecycleHarness(t, {
    model: {
      generate: async () => {
        call++;
        return call === 1
          ? { kind: "reply", segments: ["A first", "A second"] }
          : { kind: "reply", segments: ["B only"] };
      },
    },
    deps: { permitsText: policy.permitsText, permitsPrompt: policy.permitsPrompt },
  });
  assert.equal(h.receive("50", "", ["10002", "10003"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.prompts.length, 2);
  assert.ok(h.prompts.every(prompt => prompt.tools.length === 0));
  assert.deepEqual(h.dispatches.map(item => [item.characterId, item.text]), [
    ["character-a", "A first"],
    ["character-a", "A second"],
    ["character-b", "B only"],
  ]);
  const request = h.room.store.lifecycleRequests()[0]!;
  assert.equal(request.status, "completed");
  assert.deepEqual(h.room.store.lifecycleTurns(request.requestId).map(turn => turn.characterId),
    ["character-a", "character-b"]);
  assert.deepEqual(h.room.store.lifecycleTurns(request.requestId).map(turn => turn.segmentCount), [2, 1]);
});

test("real public policy accepts tools-free both delivery and the Rin translation prompt", async t => {
  const config = roomConfig({
    deliveryMode: "both",
    characters: [
      { id: "character-a", accountKey: "account-a", selfId: "10002", name: "Character A", voiceKey: "voice-a" },
      { id: "rin", accountKey: "account-b", selfId: "10003", name: "Rin", voiceKey: "voice-rin" },
    ],
  });
  const policy = lifecyclePolicy(config);
  const spoken: string[] = [];
  let translations = 0;
  const h = await lifecycleHarness(t, {
    config,
    model: { generate: async () => ({ kind: "reply", segments: ["中文台词"] }) },
    translateVoice: async prompt => {
      translations++;
      assert.equal(prompt.tools.length, 0);
      return "にほんごのせりふ";
    },
    synthesize: async delivery => {
      spoken.push(delivery.voiceText ?? "");
      return new Uint8Array([7, 8, 9]);
    },
    deps: { permitsText: policy.permitsText, permitsPrompt: policy.permitsPrompt },
  });
  assert.equal(h.receive("150", "翻译这句", ["10003"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(translations, 1);
  assert.deepEqual(spoken, ["にほんごのせりふ"]);
  assert.deepEqual(h.dispatches.map(item => [item.characterId, item.medium]), [
    ["rin", "text"],
    ["rin", "audio"],
  ]);
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "completed");
});

test("cached Rin translation input remains acceptable to public policy on the next segment", async t => {
  const config = roomConfig({
    deliveryMode: "both",
    characters: [
      { id: "rin", accountKey: "account-a", selfId: "10002", name: "Rin", voiceKey: "voice-rin" },
      { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
    ],
  });
  const policy = lifecyclePolicy(config);
  const translations: string[] = [];
  let sent = 0;
  const h = await lifecycleHarness(t, {
    config,
    model: { generate: async () => ({ kind: "reply", segments: ["中文第一句", "中文第二句"] }) },
    translateVoice: async prompt => {
      const payload = JSON.parse(prompt.messages[0].content) as {
        voiceTranslation?: { sourceText?: unknown };
      };
      translations.push(String(payload.voiceTranslation?.sourceText));
      return "にほんごのへんじ";
    },
    dispatch: async request => {
      request.beforeSend();
      const id = String(750000 + ++sent);
      await request.observe({ kind: "ack", messageId: id });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      return id;
    },
    deps: { permitsText: policy.permitsText, permitsPrompt: policy.permitsPrompt },
  });
  assert.equal(h.receive("151", "翻译两段", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.deepEqual(translations, ["中文第一句", "中文第二句"]);
  const request = h.room.store.lifecycleRequests()[0]!;
  const turn = h.room.store.lifecycleTurns(request.requestId)[0]!;
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text", "audio", "text", "audio"],
    JSON.stringify({ request, segments: h.room.store.lifecycleSegments(turn.turnId) }));
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "completed");
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
});

test("real public policy blocks synthetic secrets, identities and private paths before model or send", async t => {
  const policy = lifecyclePolicy();
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["must not run"] }) },
    deps: { permitsText: policy.permitsText, permitsPrompt: policy.permitsPrompt },
  });
  for (const [index, text] of [
    "fixture-key",
    "10001",
    POLICY_DATA_DIR,
    "https://model.invalid/v1",
    "手机号13812345678",
  ].entries()) assert.equal(h.receive(String(160 + index), text, ["10002"]), "rejected");
  await h.room.whenIdle();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.room.store.counts().model, 0);
});

test("explicit mention skip becomes one honest fallback and invalid zero-or-three segments fail closed", async t => {
  let call = 0;
  const h = await lifecycleHarness(t, {
    model: {
      generate: async () => {
        call++;
        if (call === 1) return { kind: "skip" };
        return { kind: "reply", segments: call === 2 ? [] : ["1", "2", "3"] } as RoomLifecycleAnswer;
      },
    },
  });
  assert.equal(h.receive("51", "hi", ["10002"]), "scheduled");
  await h.room.whenIdle();
  const skipped = h.room.store.lifecycleRequests()[0]!;
  const skippedTurn = h.room.store.lifecycleTurns(skipped.requestId)[0]!;
  assert.equal(skippedTurn.status, "completed");
  assert.equal(skippedTurn.reason, WORKER_EXPLICIT_NO_ANSWER_FALLBACK.reason);
  assert.equal(h.room.store.lifecycleSegments(skippedTurn.turnId).length, 1);
  assert.equal(h.dispatches[0]!.text, WORKER_EXPLICIT_NO_ANSWER_FALLBACK.text);

  assert.equal(h.receive("52", "again", ["10002"]), "scheduled");
  await h.room.whenIdle();
  const invalidEmpty = h.room.store.lifecycleRequests()[1]!;
  assert.equal(invalidEmpty.status, "failed");
  assert.equal(h.room.store.lifecycleTurns(invalidEmpty.requestId)[0]!.reason, "lifecycle_answer_invalid");

  assert.equal(h.receive("53", "again", ["10002"]), "scheduled");
  await h.room.whenIdle();
  const invalidThree = h.room.store.lifecycleRequests()[2]!;
  assert.equal(invalidThree.status, "failed");
  assert.equal(h.room.store.lifecycleTurns(invalidThree.requestId)[0]!.reason, "lifecycle_answer_invalid");
  assert.equal(h.dispatches.length, 1);
});

test("dual-character and cross-request generations overlap while one FIFO delivery preserves mention and segment order", async t => {
  const calls: Array<ReturnType<typeof deferred<RoomLifecycleAnswer>>> = [];
  const h = await lifecycleHarness(t, {
    model: {
      generate: async () => {
        const pending = deferred<RoomLifecycleAnswer>();
        calls.push(pending);
        return pending.promise;
      },
    },
  });
  assert.equal(h.receive("60", "both", ["10002", "10003"]), "scheduled");
  assert.equal(h.receive("61", "next", ["10002"]), "scheduled");
  await waitFor(() => calls.length === 3, "three parallel generation calls");

  calls[2]!.resolve({ kind: "reply", segments: ["request-2 A"] });
  await flush();
  assert.equal(h.dispatches.length, 0);

  calls[0]!.resolve({ kind: "reply", segments: ["request-1 A1", "request-1 A2"] });
  calls[1]!.resolve({ kind: "reply", segments: ["request-1 B"] });
  await h.room.whenIdle();
  assert.deepEqual(h.dispatches.map(item => [item.characterId, item.text]), [
    ["character-a", "request-1 A1"],
    ["character-a", "request-1 A2"],
    ["character-b", "request-1 B"],
    ["character-a", "request-2 A"],
  ]);
  assert.deepEqual(h.room.store.lifecycleRequests().map(request => request.status), ["completed", "completed"]);
});

test("reversed double-mention input keeps actual mention order when generation finishes out of order", async t => {
  const calls: Array<ReturnType<typeof deferred<RoomLifecycleAnswer>>> = [];
  const h = await lifecycleHarness(t, {
    model: {
      generate: async () => {
        const pending = deferred<RoomLifecycleAnswer>();
        calls.push(pending);
        return pending.promise;
      },
    },
  });
  assert.equal(h.receive("62", "", ["10003", "10002"]), "scheduled");
  await waitFor(() => calls.length === 2, "two ordered generation calls");

  calls[1]!.resolve({ kind: "reply", segments: ["A finished first"] });
  await flush();
  assert.equal(h.dispatches.length, 0, "the later mention cannot overtake the first");
  calls[0]!.resolve({ kind: "reply", segments: ["B remains first"] });
  await h.room.whenIdle();

  assert.deepEqual(h.dispatches.map(item => [item.characterId, item.text]), [
    ["character-b", "B remains first"],
    ["character-a", "A finished first"],
  ]);
});

test("a mode switch cancels a generation that ignores Abort without later delivery", async t => {
  let modelSignal: AbortSignal | undefined;
  const pending = deferred<RoomLifecycleAnswer>();
  const h = await lifecycleHarness(t, {
    model: {
      generate: async (_prompt, signal) => {
        modelSignal = signal;
        return pending.promise;
      },
    },
  });
  assert.equal(h.receive("70", "hold", ["10002"]), "scheduled");
  await waitFor(() => modelSignal !== undefined, "model start");
  assert.equal(h.receive("71", "/room mode ambient"), "control");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "cancelled", "generation cancellation");
  assert.equal(modelSignal!.aborted, true);
  pending.resolve({ kind: "reply", segments: ["late"] });
  await h.room.whenIdle();
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "cancelled");
});

test("cancellation during a translation that ignores Abort never reaches TTS or audio dispatch", async t => {
  const translated = deferred<string>();
  let translationStarted = false;
  let synthesisCalls = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "both",
      characters: [
        { id: "character-a", accountKey: "account-a", selfId: "10002", name: "Character A", voiceKey: "voice-a" },
        { id: "rin", accountKey: "account-b", selfId: "10003", name: "Rin", voiceKey: "voice-rin" },
      ],
    }),
    model: { generate: async () => ({ kind: "reply", segments: ["keep this text"] }) },
    translateVoice: async () => {
      translationStarted = true;
      return translated.promise;
    },
    synthesize: async () => {
      synthesisCalls++;
      return new Uint8Array([1]);
    },
  });
  assert.equal(h.receive("74", "translate", ["10003"]), "scheduled");
  await waitFor(() => translationStarted, "translation start");
  assert.equal(h.receive("75", "/room mode ambient"), "control");
  await waitFor(() => {
    const status = h.room.store.lifecycleRequests()[0]?.status;
    return status !== undefined && !["queued", "generating", "delivering"].includes(status);
  }, "translation cancellation");
  translated.resolve("遅れて生成された音声です。");
  await h.room.whenIdle();

  assert.deepEqual(h.dispatches.map(item => item.medium), ["text"]);
  assert.equal(synthesisCalls, 0);
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "failed");
  assert.equal(h.room.store.lifecycleRequests()[0]!.outcomeReason, "mode_changed");
});

test("cancellation during TTS that ignores Abort never dispatches late audio", async t => {
  const audio = deferred<Uint8Array>();
  let synthesisStarted = false;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken text"] }) },
    synthesize: async () => {
      synthesisStarted = true;
      return audio.promise;
    },
  });
  assert.equal(h.receive("76", "speak", ["10002"]), "scheduled");
  await waitFor(() => synthesisStarted, "TTS start");
  assert.equal(h.receive("77", "/room mode ambient"), "control");
  await waitFor(() => {
    const status = h.room.store.lifecycleRequests()[0]?.status;
    return status !== undefined && !["queued", "generating", "delivering"].includes(status);
  }, "TTS cancellation");
  audio.resolve(new Uint8Array([7, 8, 9]));
  await h.room.whenIdle();

  assert.deepEqual(h.dispatches.map(item => item.medium), ["text"]);
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "failed");
  assert.equal(h.room.store.lifecycleRequests()[0]!.outcomeReason, "mode_changed");
});

test("prompt cache releases text-only requests and never leaks one into a later both request", async t => {
  let modelCalls = 0;
  let sent = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "text",
      characters: [
        { id: "character-a", accountKey: "account-a", selfId: "10002", name: "Character A", voiceKey: "voice-a" },
        { id: "rin", accountKey: "account-b", selfId: "10003", name: "Rin", voiceKey: "voice-rin" },
      ],
    }),
    model: {
      generate: async (): Promise<RoomLifecycleAnswer> => {
        modelCalls++;
        return modelCalls === 1
          ? { kind: "reply", segments: ["text one", "text two"] }
          : { kind: "reply", segments: ["voice one", "voice two"] };
      },
    },
    translateVoice: async () => "にほんごのへんじ",
    dispatch: async request => {
      request.beforeSend();
      const id = String(840000 + ++sent);
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });

  assert.equal(h.receive("130", "text only", ["10003"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "completed");
  assert.equal(lifecyclePromptCacheSize(h.room), 0);

  h.room.store.setDeliveryMode("both");
  assert.equal(h.receive("131", "voice now", ["10003"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests()[1]!.status, "completed");
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
});

test("a multi-segment both request keeps its prompt until the final voice segment settles", async t => {
  let sent = 0;
  let translations = 0;
  let modelCalls = 0;
  const secondTurnStarted = deferred<void>();
  const releaseSecondTurn = deferred<void>();
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "both",
      limits: { turnsPerMinute: 12 },
      characters: [
        { id: "rin-a", accountKey: "account-a", selfId: "10002", name: "Rin", voiceKey: "voice-rin-a" },
        { id: "rin-b", accountKey: "account-b", selfId: "10003", name: "Rin", voiceKey: "voice-rin-b" },
      ],
    }),
    model: { generate: async () => {
      modelCalls++;
      return modelCalls === 1
        ? { kind: "reply", segments: ["A first", "A second"] }
        : { kind: "reply", segments: ["B first", "B second"] };
    } },
    translateVoice: async () => {
      translations++;
      return "にほんごのへんじ";
    },
    dispatch: async request => {
      if (request.item.turn.characterId === "rin-b" && request.item.segment.segmentIndex === 0
        && request.medium === "text") {
        secondTurnStarted.resolve();
        await releaseSecondTurn.promise;
      }
      request.beforeSend();
      const id = String(850000 + ++sent);
      await request.observe({ kind: "ack", messageId: id });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      return id;
    },
  });

  assert.equal(h.receive("132", "speak twice", ["10002", "10003"]), "scheduled");
  await secondTurnStarted.promise;
  assert.equal(translations, 2);
  assert.equal(lifecyclePromptCacheSize(h.room), 1);

  releaseSecondTurn.resolve();
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "completed");
  assert.equal(translations, 4);
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
});

test("voice failures keep the translation prompt only for the remaining segment", async t => {
  for (const failure of ["translation", "synthesis"] as const) {
    await t.test(failure, async subtest => {
      let sent = 0;
      let translations = 0;
      let synthesisCalls = 0;
      const secondTextStarted = deferred<void>();
      const releaseSecondText = deferred<void>();
      const h = await lifecycleHarness(subtest, {
        config: roomConfig({
          deliveryMode: "both",
          characters: [
            { id: "rin", accountKey: "account-a", selfId: "10002", name: "Rin", voiceKey: "voice-rin" },
            { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
          ],
        }),
        model: { generate: async () => ({ kind: "reply", segments: ["first failure", "second success"] }) },
        translateVoice: async () => {
          translations++;
          if (failure === "translation" && translations === 1) {
            throw new Error("voice_translation_unavailable");
          }
          return "にほんごのへんじ";
        },
        synthesize: async () => {
          synthesisCalls++;
          if (failure === "synthesis" && synthesisCalls === 1) throw new Error("fish-tts-network");
          return new Uint8Array([1, 2, 3]);
        },
        dispatch: async request => {
          if (request.item.segment.segmentIndex === 1 && request.medium === "text") {
            secondTextStarted.resolve();
            await releaseSecondText.promise;
          }
          request.beforeSend();
          const id = String(860000 + ++sent);
          await request.observe({ kind: "ack", messageId: id });
          request.released();
          return id;
        },
      });

      assert.equal(h.receive("133", "fail once", ["10002"]), "scheduled");
      await secondTextStarted.promise;
      assert.equal(lifecyclePromptCacheSize(h.room), 1);

      releaseSecondText.resolve();
      await h.room.whenIdle();
      const request = h.room.store.lifecycleRequests()[0]!;
      assert.equal(request.status, "completed");
      assert.equal(translations, 2);
      assert.deepEqual(h.dispatches.map(item => item.medium), ["text", "text", "audio"]);
      assert.equal(lifecyclePromptCacheSize(h.room), 0);
    });
  }
});

test("a terminal audio transport failure releases the prompt cache", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "both",
      characters: [
        { id: "rin", accountKey: "account-a", selfId: "10002", name: "Rin", voiceKey: "voice-rin" },
        { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
      ],
    }),
    model: { generate: async () => ({ kind: "reply", segments: ["first voice", "second voice"] }) },
    translateVoice: async () => "にほんごのへんじ",
    dispatch: async request => {
      request.beforeSend();
      if (request.medium === "audio") throw new Error("transport_unknown");
      await request.observe({ kind: "ack", messageId: "755001" });
      request.released();
      return "755001";
    },
  });
  assert.equal(h.receive("138", "unknown audio result", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "failed");
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
});

test("a mode revision change releases a cached prompt immediately", async t => {
  let translationStarted = false;
  const translation = deferred<string>();
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "both",
      characters: [
        { id: "rin", accountKey: "account-a", selfId: "10002", name: "Rin", voiceKey: "voice-rin" },
        { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
      ],
    }),
    model: { generate: async () => ({ kind: "reply", segments: ["first voice", "second voice"] }) },
    translateVoice: async () => {
      translationStarted = true;
      return translation.promise;
    },
  });

  assert.equal(h.receive("134", "translate before mode change", ["10002"]), "scheduled");
  await waitFor(() => translationStarted, "translation start");
  assert.equal(lifecyclePromptCacheSize(h.room), 1);

  assert.equal(h.receive("135", "/room mode ambient"), "control");
  await waitFor(() => {
    const status = h.room.store.lifecycleRequests()[0]?.status;
    return status !== undefined && !["queued", "generating", "delivering"].includes(status);
  }, "mode cancellation");
  assert.equal(lifecyclePromptCacheSize(h.room), 0);

  translation.resolve("まちがったおそいほんやく");
  await h.room.whenIdle();
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
});

test("pause releases the cached prompt and resume can still translate the next voice segment", async t => {
  let translations = 0;
  let translationStarted = false;
  const firstTranslation = deferred<string>();
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "both",
      characters: [
        { id: "rin", accountKey: "account-a", selfId: "10002", name: "Rin", voiceKey: "voice-rin" },
        { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
      ],
    }),
    model: { generate: async () => ({ kind: "reply", segments: ["first voice", "second voice"] }) },
    translateVoice: async () => {
      translations++;
      if (translations === 1) {
        translationStarted = true;
        return firstTranslation.promise;
      }
      return "にほんごのへんじ";
    },
  });

  assert.equal(h.receive("136", "pause then resume", ["10002"]), "scheduled");
  await waitFor(() => translationStarted, "first translation start");
  assert.equal(lifecyclePromptCacheSize(h.room), 1);

  h.room.store.setPaused(true);
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
  firstTranslation.resolve("とりけされたほんやく");
  await flush();

  h.room.store.setPaused(false);
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed", "resumed completion");
  assert.equal(translations, 3);
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
});

test("expiry releases a cached prompt even when the request has a failed terminal outcome", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "both",
      characters: [
        { id: "rin", accountKey: "account-a", selfId: "10002", name: "Rin", voiceKey: "voice-rin" },
        { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
      ],
    }),
    model: { generate: async () => ({ kind: "reply", segments: ["first voice", "second voice"] }) },
    translateVoice: async () => "にほんごのへんじ",
    deps: { now: () => now },
    dispatch: async request => {
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: "871001" });
      request.released();
      return "871001";
    },
  });

  assert.equal(h.receive("137", "expire before delivery", ["10002"]), "scheduled");
  await waitFor(() => h.prompts.length === 1, "generation before expiry");
  now += QUEUE.ttlMs + 1_000;
  await h.room.whenIdle();
  assert.equal(lifecyclePromptCacheSize(h.room), 0);
});

test("observer release cannot clear an audio fence before physical send completion", async t => {
  const audioEntered = deferred<void>();
  let physicalSettled: (() => void) | undefined;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["physical fence"] }) },
    dispatch: async request => {
      request.beforeSend();
      if (request.medium === "text") {
        await request.observe({ kind: "ack", messageId: "770001" });
        request.released();
        return "770001";
      }
      physicalSettled = (request as RoomLifecycleDispatch & { physicalSettled?: () => void }).physicalSettled;
      request.released();
      audioEntered.resolve();
      throw new Error("synthetic-uncertain");
    },
  });
  assert.equal(h.receive("80", "speak with a fence", ["10002"]), "scheduled");
  await audioEntered.promise;
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "failed", "unknown audio settlement");

  const audioAttempt = h.room.store.lifecycleAudit().find(row => row.medium === "audio");
  assert.ok(audioAttempt?.attemptId);
  assert.equal(h.room.store.lifecycleAudioFence(), audioAttempt.attemptId);
  assert.equal(typeof physicalSettled, "function");
  physicalSettled!();
  assert.equal(h.room.store.lifecycleAudioFence(), null);
});

test("a synchronous socket send throw settles not-sent and releases FIFO for the next audio fence", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const connected = deferred<QqPeer>();
  server.once("connection", socket => connected.resolve(new QqPeer(socket, 100, () => {})));
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const peer = await connected.promise;
  t.after(async () => {
    peer.close();
    client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  (peer.socket as unknown as { send(): void }).send = () => { throw new Error("synthetic-send-throw"); };

  const secondAudio = deferred<RoomLifecycleDispatch>();
  const releaseSecondAudio = deferred<void>();
  let audioDispatches = 0;
  let messageId = 780000;
  let firstAudioAttemptId = "";
  let notSentCalls = 0;
  let firstPhysicalSettlements = 0;
  const firstAudioObservations: string[] = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["fifo audio"] }) },
    dispatch: async request => {
      if (request.medium === "text") {
        request.beforeSend();
        const id = String(++messageId);
        await request.observe({ kind: "ack", messageId: id });
        request.released();
        return id;
      }
      audioDispatches++;
      if (audioDispatches === 1) {
        firstAudioAttemptId = request.attempt.attemptId;
        const dispatch = request as RoomLifecycleDispatch & { notSent?: () => void };
        const options = {
          attemptId: request.attempt.attemptId,
          beforeSend: request.beforeSend,
          observe: async value => {
            firstAudioObservations.push(value.kind);
            await request.observe(value);
          },
          released: request.released,
          physicalSettled: () => {
            firstPhysicalSettlements++;
            request.physicalSettled();
          },
          notSent: () => {
            notSentCalls++;
            dispatch.notSent?.();
          },
        } as QqAttemptOptions & { physicalSettled(): void; notSent(): void };
        try {
          return await peer.requestAttempt("send_group_msg", {}, options);
        } catch {
          throw new RoomSendError("rejected");
        }
      }
      request.beforeSend();
      secondAudio.resolve(request);
      await releaseSecondAudio.promise;
      const id = String(++messageId);
      await request.observe({ kind: "ack", messageId: id });
      request.physicalSettled();
      request.released();
      return id;
    },
  });

  assert.equal(h.receive("90", "first audio", ["10002"]), "scheduled");
  assert.equal(h.receive("91", "second audio", ["10002"]), "scheduled");
  const next = await secondAudio.promise;
  assert.equal(notSentCalls, 1);
  assert.equal(firstPhysicalSettlements, 0);
  assert.deepEqual(firstAudioObservations, []);
  assert.equal(h.room.store.lifecycleAudioFence(), next.attempt.attemptId);
  assert.equal(h.room.store.hasUnresolvedLifecycleDelivery(), true);

  const firstRequest = h.room.store.lifecycleRequests()[0]!;
  const firstTurn = h.room.store.lifecycleTurns(firstRequest.requestId)[0]!;
  assert.equal(h.room.store.lifecycleAttempt(firstAudioAttemptId)?.startedAt !== null, true);
  assert.deepEqual(h.room.store.lifecycleReceipts(firstAudioAttemptId), []);
  assert.equal(firstRequest.status, "failed");
  assert.equal(firstTurn.reason, "delivery_not_sent");

  releaseSecondAudio.resolve();
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleAudioFence(), null);
});

test("restart repairs a persisted not-sent settlement that lost fence cleanup", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const connected = deferred<QqPeer>();
  server.once("connection", socket => connected.resolve(new QqPeer(socket, 100, () => {})));
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const peer = await connected.promise;
  t.after(async () => {
    peer.close();
    client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  (peer.socket as unknown as { send(): void }).send = () => { throw new Error("synthetic-send-throw"); };

  const config = roomConfig({ deliveryMode: "both" });
  let firstAudioAttemptId = "";
  const h = await lifecycleHarness(t, {
    config,
    model: { generate: async () => ({ kind: "reply", segments: ["durable not-sent"] }) },
    dispatch: async request => {
      if (request.medium === "text") {
        request.beforeSend();
        await request.observe({ kind: "ack", messageId: "790001" });
        request.released();
        return "790001";
      }
      firstAudioAttemptId = request.attempt.attemptId;
      const dispatch = request as RoomLifecycleDispatch & { notSent?: () => void };
      return peer.requestAttempt("send_group_msg", {}, {
        attemptId: request.attempt.attemptId,
        beforeSend: request.beforeSend,
        observe: request.observe,
        released: request.released,
        physicalSettled: request.physicalSettled,
        notSent: () => dispatch.notSent?.(),
      }).catch(() => { throw new RoomSendError("rejected"); });
    },
  });

  const faultStore = h.room.store as unknown as {
    finishLifecycleAttemptNotSent?: (attemptId: string, ownerToken: string, now: number) => void;
    releaseLifecycleAudioFenceNotSent?: (attemptId: string, ownerToken: string) => boolean;
  };
  if (typeof faultStore.finishLifecycleAttemptNotSent === "function") {
    // Simulate a process-storage interruption after settlement but before the atomic helper returns.
    faultStore.finishLifecycleAttemptNotSent = (attemptId, ownerToken, now) => {
      h.room.store.finishLifecycleAttempt(attemptId, "failed", "delivery_not_sent", ownerToken, now);
      throw new Error("synthetic-not-sent-restart-window");
    };
  } else if (typeof faultStore.releaseLifecycleAudioFenceNotSent === "function") {
    // Reproduce the old two-transaction window on the pre-fix implementation.
    faultStore.releaseLifecycleAudioFenceNotSent = () => {
      throw new Error("synthetic-not-sent-restart-window");
    };
  } else {
    assert.fail("missing lifecycle not-sent settlement seam");
  }

  assert.equal(h.receive("92", "durable audio", ["10002"]), "scheduled");
  await waitFor(() => {
    const request = h.room.store.lifecycleRequests()[0];
    return request?.status === "failed" && h.room.store.lifecycleAudioFence() === firstAudioAttemptId;
  }, "persisted not-sent settlement and fence");

  const firstRequest = h.room.store.lifecycleRequests()[0]!;
  const firstTurn = h.room.store.lifecycleTurns(firstRequest.requestId)[0]!;
  const firstAttempt = h.room.store.lifecycleAttempt(firstAudioAttemptId);
  assert.equal(firstTurn.reason, "delivery_not_sent");
  assert.equal(firstAttempt?.startedAt !== null, true);
  assert.equal(h.room.store.lifecycleAudioFence(), firstAudioAttemptId);
  await h.room.close();

  let reopened: VoiceRoom | undefined;
  try {
    const now = Date.parse("2026-11-13T00:00:00Z");
    const forbidden = async (): Promise<never> => { throw new Error("synthetic-legacy-dependency-forbidden"); };
    reopened = new VoiceRoom(join(h.root, "room.sqlite"), config, {
      now: () => now,
      persona: character => `# ${character.name}\nSynthetic public persona.`,
      generate: forbidden,
      synthesize: async () => new Uint8Array([9, 8, 7]),
      sendText: forbidden,
      sendAudio: forbidden,
      permitsText: () => true,
      permitsPrompt: () => true,
    }, { execution: "lifecycle" });
    for (const character of config.characters) reopened.setOnline(character.accountKey, true);

    const nextAudio = deferred<RoomLifecycleDispatch>();
    const releaseNextAudio = deferred<void>();
    await reopened.startLifecycleProductionWorker({
      model: { generate: async () => ({ kind: "reply", segments: ["recovered audio"] }) },
      apiTimeoutMs: 100,
      closePolicy: { observationCapacity: 32, perAccountCapacity: 16, drainMs: 100, releaseMs: 100, writeWaitMs: 50 },
      dispatch: async request => {
        request.beforeSend();
        if (request.medium === "text") {
          await request.observe({ kind: "ack", messageId: "791001" });
          request.released();
          return "791001";
        }
        nextAudio.resolve(request);
        await releaseNextAudio.promise;
        await request.observe({ kind: "ack", messageId: "791002" });
        request.physicalSettled();
        request.released();
        return "791002";
      },
      beginClose: () => {},
      sealObservations: async () => {},
    });

    assert.equal(reopened.store.lifecycleAudioFence(), null);
    assert.equal(reopened.store.hasUnresolvedLifecycleDelivery(), false);
    assert.equal(reopened.receiveLifecycle(roomInput("93", "after restart", ["10002"]), QUEUE), "scheduled");
    const next = await nextAudio.promise;
    assert.equal(reopened.store.lifecycleAudioFence(), next.attempt.attemptId);
    releaseNextAudio.resolve();
    await reopened.whenIdle();
    assert.equal(reopened.store.lifecycleAudioFence(), null);
  } finally {
    await reopened?.close();
  }
});

test("cancellation before beforeSend keeps the attempt unsent and never calls the transport", async t => {
  const entered = deferred<RoomLifecycleDispatch>();
  const release = deferred<void>();
  let sent = false;
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["pending send"] }) },
    dispatch: async request => {
      entered.resolve(request);
      await release.promise;
      return "synthetic-not-sent";
    },
  });
  assert.equal(h.receive("78", "hold before send", ["10002"]), "scheduled");
  const request = await entered.promise;
  assert.equal(h.receive("79", "/room mode ambient"), "control");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "cancelled", "pre-send cancellation");
  assert.throws(() => {
    request.beforeSend();
    sent = true;
  }, /rejected/);
  release.resolve();
  await h.room.whenIdle();

  assert.equal(sent, false);
  assert.equal(h.dispatches.length, 1, "the adapter entered dispatch but no external send was committed");
  const audit = h.room.store.lifecycleAudit();
  assert.equal(audit.filter(row => row.attemptId !== null).length, 1);
  assert.equal(audit.find(row => row.attemptId !== null)!.startedAt, null);
});

test("a started send cancelled during dispatch remains unknown, keeps the late ACK as evidence and is never retried", async t => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let listens = 0;
  let modelSignal: AbortSignal | undefined;
  const h = await lifecycleHarness(t, {
    model: {
      generate: async (_prompt, signal) => {
        modelSignal = signal;
        return { kind: "reply", segments: ["started reply"] };
      },
    },
    dispatch: async request => {
      listens++;
      request.beforeSend();
      entered.resolve();
      await release.promise;
      await request.observe({ kind: "ack", messageId: "880001" });
      request.released();
      return "880001";
    },
  });
  assert.equal(h.receive("72", "send", ["10002"]), "scheduled");
  await entered.promise;
  assert.equal(h.receive("73", "/room mode ambient"), "control");
  await waitFor(() => h.room.store.lifecycleTurns(h.room.store.lifecycleRequests()[0]!.requestId)[0]?.status === "unknown",
    "started send unknown settlement");
  release.resolve();
  await waitFor(() => h.room.store.lifecycleAudit().some(row => row.receipts.includes("ack")), "late ACK");
  await h.room.whenIdle();
  const turn = h.room.store.lifecycleTurns(h.room.store.lifecycleRequests()[0]!.requestId)[0]!;
  assert.equal(turn.status, "unknown");
  assert.equal(listens, 1);
  assert.equal(modelSignal?.aborted, false);
});

test("same-process reconnect keeps the selected mode, discards old work and accepts only new inbound work", async t => {
  const first = deferred<RoomLifecycleAnswer>();
  let calls = 0;
  const h = await lifecycleHarness(t, {
    model: {
      generate: async () => {
        calls++;
        return calls === 1 ? first.promise : { kind: "reply", segments: ["new inbound"] };
      },
    },
  });
  assert.equal(h.receive("80", "/room mode ambient"), "control");
  assert.equal(h.receive("81", "old", ["10002"]), "scheduled");
  await waitFor(() => calls === 1, "old generation");
  h.room.setOnline("account-a", false);
  first.resolve({ kind: "reply", segments: ["discarded"] });
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "cancelled", "disconnect cancellation");
  h.room.setOnline("account-a", true);
  assert.equal(h.room.store.lifecycleControlState().mode, "ambient");
  assert.equal(h.receive("82", "new", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests().length, 2);
  assert.equal(h.room.store.lifecycleRequests()[1]!.status, "completed");
  assert.deepEqual(h.dispatches.map(item => item.text), ["new inbound"]);
});

test("a privacy rejection for one character fails closed while its sibling and the next FIFO request deliver", async t => {
  let promptChecks = 0;
  let modelCalls = 0;
  const h = await lifecycleHarness(t, {
    model: {
      generate: async () => {
        modelCalls++;
        return { kind: "reply", segments: [modelCalls === 1 ? "sibling survives" : "next request"] };
      },
    },
    deps: {
      permitsPrompt: () => {
        promptChecks++;
        return promptChecks !== 1;
      },
    },
  });
  assert.equal(h.receive("92", "both", ["10002", "10003"]), "scheduled");
  assert.equal(h.receive("93", "next", ["10002"]), "scheduled");
  await h.room.whenIdle();

  assert.equal(modelCalls, 2, "the rejected character must not invoke the model");
  assert.deepEqual(h.dispatches.map(item => item.text), ["sibling survives", "next request"]);
  const requests = h.room.store.lifecycleRequests();
  assert.equal(requests[0]!.status, "failed");
  assert.equal(requests[1]!.status, "completed");
  const rejected = h.room.store.lifecycleTurns(requests[0]!.requestId)
    .find(turn => turn.status === "failed")!;
  assert.equal(rejected.reason, "lifecycle_privacy_rejected");
});

test("one character failure is settled independently while the sibling and the next FIFO request deliver", async t => {
  let calls = 0;
  const h = await lifecycleHarness(t, {
    model: {
      generate: async () => {
        calls++;
        if (calls === 1) throw new Error("synthetic_generation_failed");
        return { kind: "reply", segments: [calls === 2 ? "sibling survives" : "next request"] };
      },
    },
  });
  assert.equal(h.receive("90", "both", ["10002", "10003"]), "scheduled");
  assert.equal(h.receive("91", "next", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(calls, 3);
  assert.deepEqual(h.dispatches.map(item => item.text), ["sibling survives", "next request"]);
  const requests = h.room.store.lifecycleRequests();
  assert.equal(requests[0]!.status, "failed");
  assert.equal(requests[1]!.status, "completed");
  const turns = h.room.store.lifecycleTurns(requests[0]!.requestId);
  assert.equal(turns.find(turn => turn.characterId === "character-a")!.status, "failed");
  assert.equal(turns.find(turn => turn.characterId === "character-b")!.status, "completed");
});

test("text plus voice is tools-free, text-only skips TTS, and translation failure preserves the sent text", async t => {
  const spoken: string[] = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["semantic text"] }) },
    deps: {
      webProvider: { search: async () => { throw new Error("synthetic-web-forbidden"); } } as never,
      githubRead: async () => { throw new Error("synthetic-github-forbidden"); },
    },
    synthesize: async delivery => {
      spoken.push(delivery.voiceText ?? "");
      return new Uint8Array([4, 5, 6]);
    },
  });
  assert.equal(h.receive("100", "voice", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.deepEqual(h.dispatches.map(item => [item.medium, item.text]), [
    ["text", "semantic text"],
    ["audio", "semantic text"],
  ]);
  assert.deepEqual(spoken, ["semantic text"]);
  assert.ok(h.prompts.every(prompt => prompt.tools.length === 0));
  assert.equal(h.room.store.history().filter(row => row.speakerType === "bot" && row.text === "semantic text").length, 2);
  await h.close();

  const textOnly = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["text only"] }) },
  });
  assert.equal(textOnly.receive("101", "text", ["10002"]), "scheduled");
  await textOnly.room.whenIdle();
  assert.deepEqual(textOnly.dispatches.map(item => item.medium), ["text"]);
  assert.equal(textOnly.synthesisCalls, 0);
  await textOnly.close();

  const translated = await lifecycleHarness(t, {
    config: roomConfig({
      deliveryMode: "both",
      characters: [
        { id: "character-a", accountKey: "account-a", selfId: "10002", name: "Character A", voiceKey: "voice-a" },
        { id: "rin", accountKey: "account-b", selfId: "10003", name: "Rin", voiceKey: "voice-rin" },
      ],
    }),
    model: { generate: async () => ({ kind: "reply", segments: ["text retained"] }) },
    translateVoice: async () => { throw new Error("voice_translation_unavailable"); },
  });
  assert.equal(translated.receive("102", "translate", ["10003"]), "scheduled");
  await translated.room.whenIdle();
  assert.deepEqual(translated.dispatches.map(item => item.medium), ["text"]);
  assert.equal(translated.synthesisCalls, 0);
  const request = translated.room.store.lifecycleRequests()[0]!;
  const turn = translated.room.store.lifecycleTurns(request.requestId)[0]!;
  assert.equal(turn.status, "completed");
  assert.equal(translated.room.store.lifecycleSegments(turn.turnId)[0]!.reason,
    "tts_text_only_voice_translation_unavailable");
  assert.ok(translated.room.store.history().some(row => row.speakerType === "bot" && row.text === "text retained"));
});

test("lifecycle ingress rejects other accounts and duplicates, and audit exposes lifecycle facts without message bodies", async t => {
  let calls = 0;
  const h = await lifecycleHarness(t, {
    model: { generate: async () => { calls++; return { kind: "reply", segments: ["body-secret-never-audited"] }; } },
  });
  assert.equal(h.receive("110", "foreign", ["10003"], {
    accountKey: "account-b", selfId: "10003",
  }), "rejected");
  assert.equal(h.receive("111", "hello", ["10002"]), "scheduled");
  assert.equal(h.receive("111", "hello", ["10002"]), "duplicate");
  await h.room.whenIdle();
  assert.equal(calls, 1);
  assert.equal(h.room.store.lifecycleRequests().length, 1);
  const audit = JSON.stringify(h.room.store.lifecycleAudit());
  assert.doesNotMatch(audit, /body-secret-never-audited/);
  assert.match(audit, /completed/);
});

test("offline single @ acceptance path joins real parser, checked config, lifecycle SQLite, generation and one text dispatch", async t => {
  const config = roomConfig();
  const h = await lifecycleHarness(t, {
    config,
    model: { generate: async () => ({ kind: "reply", segments: ["synthetic single-mention reply"] }) },
  });
  const qqEvent = (messageId: number, message: unknown[]) => ({
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    self_id: 10002,
    group_id: 10000,
    user_id: 10001,
    message_id: messageId,
    sender: { user_id: 10001 },
    message,
  });

  const parsed = parseRoomQqMessage(qqEvent(800001, [
    { type: "at", data: { qq: "10002" } },
    { type: "text", data: { text: " hello " } },
  ]), "account-a", h.checkedConfig);
  assert.ok(parsed, "the real parser must accept one configured character mention");
  assert.deepEqual(parsed.mentions, ["10002"]);
  assert.equal(parsed.text, "hello");
  assert.equal(parsed.messageId, "800001");
  assert.equal(parsed.accountKey, "account-a");
  assert.equal(parsed.selfId, "10002");
  assert.equal(parsed.groupId, "10000");
  assert.equal(parsed.senderId, "10001");

  assert.equal(h.room.receiveLifecycle(parsed, QUEUE), "scheduled");
  await h.room.whenIdle();

  const requests = h.room.store.lifecycleRequests();
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.status, "completed");
  assert.equal(request.source, "direct");
  assert.equal(request.input.messageId, "800001");
  assert.equal(request.input.text, "hello");
  assert.deepEqual(request.input.mentions, ["10002"]);

  const target = h.room.store.historyMessage(request.messageRowId);
  assert.ok(target, "the admitted message row must still exist");
  assert.equal(target.speakerType, "user");
  assert.equal(target.platformId, "800001");

  const turns = h.room.store.lifecycleTurns(request.requestId);
  assert.equal(turns.length, 1);
  const turn = turns[0]!;
  assert.equal(turn.characterId, "character-a");
  assert.equal(turn.status, "completed");
  assert.equal(turn.segmentCount, 1);
  const segments = h.room.store.lifecycleSegments(turn.turnId);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.state, "completed");

  assert.equal(h.prompts.length, 1);
  const prompt = h.prompts[0]!;
  assert.equal(prompt.characterId, "character-a");
  assert.equal(prompt.targetId, request.messageRowId);
  assert.equal(prompt.tools.length, 0);

  assert.equal(h.dispatches.length, 1);
  assert.deepEqual(h.dispatches[0], {
    characterId: "character-a",
    medium: "text",
    text: "synthetic single-mention reply",
    requestId: request.requestId,
  });
  const textAttempts = h.room.store.lifecycleAudit().filter(row => row.medium === "text");
  assert.equal(textAttempts.length, 1);
  assert.equal(textAttempts[0]!.requestId, request.requestId);
  assert.deepEqual(textAttempts[0]!.receipts, ["ack"]);

  const requestsBeforeDuplicate = h.room.store.lifecycleRequests().length;
  const dispatchesBeforeDuplicate = h.dispatches.length;
  assert.equal(h.room.receiveLifecycle(parsed, QUEUE), "duplicate");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests().length - requestsBeforeDuplicate, 0);
  assert.equal(h.dispatches.length - dispatchesBeforeDuplicate, 0);

  const unmentioned = parseRoomQqMessage(qqEvent(800002, [
    { type: "text", data: { text: "not addressed to a character" } },
  ]), "account-a", h.checkedConfig);
  assert.ok(unmentioned, "an ordinary group text message is parsed for observation");
  assert.deepEqual(unmentioned.mentions, []);
  const requestsBeforeUnmentioned = h.room.store.lifecycleRequests().length;
  const dispatchesBeforeUnmentioned = h.dispatches.length;
  assert.equal(h.room.receiveLifecycle(unmentioned, QUEUE), "observed");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests().length - requestsBeforeUnmentioned, 0);
  assert.equal(h.dispatches.length - dispatchesBeforeUnmentioned, 0);

  const atAll = parseRoomQqMessage(qqEvent(800003, [
    { type: "at", data: { qq: "all" } },
  ]), "account-a", h.checkedConfig);
  assert.equal(atAll, null);
  assert.equal(h.synthesisCalls, 0);
  assert.equal(h.prompts.length, 1);
});

test("Fix-4 B4-01 final lifecycle prompts include only each selected public persona and remain tools-free", async t => {
  const h = await lifecycleHarness(t, {
    model: { generate: async prompt => ({ kind: "reply", segments: [`${prompt.characterId} reply`] }) },
    deps: {
      persona: character => `# ${character.name}\nPUBLIC_PERSONA_${character.id.toUpperCase()}`,
      permitsPrompt: prompt => prompt.tools.length === 0
        && prompt.systemPrompt.includes(`PUBLIC_PERSONA_${prompt.characterId.toUpperCase()}`)
        && !prompt.systemPrompt.includes(prompt.characterId === "character-a"
          ? "PUBLIC_PERSONA_CHARACTER-B" : "PUBLIC_PERSONA_CHARACTER-A"),
    },
  });

  assert.equal(h.receive("805001", "请两位分别回答", ["10002", "10003"]), "scheduled");
  await h.room.whenIdle();

  assert.equal(h.prompts.length, 2);
  for (const characterId of ["character-a", "character-b"]) {
    const prompt = h.prompts.find(item => item.characterId === characterId);
    assert.ok(prompt, `${characterId} must receive a final lifecycle prompt`);
    assert.match(prompt.systemPrompt, new RegExp(`PUBLIC_PERSONA_${characterId.toUpperCase()}`));
    assert.doesNotMatch(prompt.systemPrompt, new RegExp(`PUBLIC_PERSONA_${characterId === "character-a"
      ? "CHARACTER-B" : "CHARACTER-A"}`));
    assert.deepEqual(prompt.tools, []);
  }
});

test("Fix-4 B4-02 trusted cross-account bot quotes continue only through a human parent and cycles fail closed", async t => {
  let receipt = 910000;
  const h = await lifecycleHarness(t, {
    model: { generate: async prompt => ({ kind: "reply", segments: [`${prompt.characterId} continuation`] }) },
    dispatch: async request => {
      const messageId = String(++receipt);
      request.beforeSend();
      await request.observe({ kind: "ack", messageId });
      request.released();
      return messageId;
    },
  });

  assert.equal(h.receive("810001", "先由 B 回答", ["10003"], { senderId: "20001" }), "scheduled");
  await h.room.whenIdle();
  const first = h.room.store.lifecycleRequests()[0]!;
  assert.deepEqual(h.room.store.lifecycleTurns(first.requestId).map(turn => turn.characterId), ["character-b"]);
  assert.equal(first.admissionReason, "explicit_direct");

  const db = new DatabaseSync(join(h.root, "room.sqlite"));
  const bot = db.prepare(`SELECT id,target_id AS targetId FROM room_messages
    WHERE speaker_type='bot' AND platform_id=?`).get("910001") as { id: number; targetId: number };
  db.prepare("UPDATE room_messages SET target_id=? WHERE id=?").run(bot.id, bot.targetId);
  db.close();

  assert.equal(h.receive("810004", "继续教育报名已经结束。", [], {
    senderId: "20001", replyToMessageId: "910001",
  }), "observed");
  assert.equal(h.room.store.lifecycleRequests().length, 1);

  for (const [messageId, text] of [
    ["810005", "继续教育报名指南建议提前准备材料。"],
    ["810006", "我喜欢草莓。"],
    ["810007", "这个邮局上周换了门牌。"],
    ["810008", "如何申请宿舍是迎新手册的第二章。"],
    ["810009", "你说的那家面包店已经搬走了。"],
    ["810010", "剧本选段：备用钥匙放在哪里？"],
    ["810012", "请问标题：备用钥匙放在哪里？"],
    ["810013", "请问对白内容如下：明早几点集合？"],
    ["810014", "麻烦请问他说：备用钥匙放在哪里？"],
    ["810018", "第 12 场：备用钥匙放在哪里？"],
    ["810019", "今天的台词：备用钥匙放在哪里？"],
    ["810020", "请问一下，剧本选段：备用钥匙放在哪里？"],
    ["810021", "今天第 3 场：备用钥匙放在哪里？"],
    ["810022", "下午第 3 场：备用钥匙放在哪里？"],
    ["810023", "甲：备用钥匙放在哪里？"],
    ["810024", "林：明早几点集合？"],
    ["810025", "角色甲：备用钥匙放在哪里？"],
    ["810031", "我有个问题，甲：备用钥匙放在哪里？"],
    ["810032", "我想问个问题，客服 ：备用钥匙放在哪里？"],
    ["810033", "不好意思，他：备用钥匙放在哪里？"],
    ["810034", "打扰一下，林：明早几点集合？"],
    ["810039", "我有个问题。甲：备用钥匙放在哪里？"],
    ["810040", "我想问个问题；客服 ：备用钥匙放在哪里？"],
    ["810041", "不好意思！他：备用钥匙放在哪里？"],
    ["810042", "打扰一下。林：明早几点集合？"],
    ["810043", "麻烦帮我确认一下，甲：备用钥匙放在哪里？"],
    ["810044", "我这边想确认一下，客服 ：备用钥匙放在哪里？"],
    ["810047", "我有个问题：客服；甲：备用钥匙放在哪里？"],
    ["810048", `我有个问题：${"转述内容".repeat(20)}：备用钥匙放在哪里？`],
    ["810049", "我有个问题：客服；甲﹕备用钥匙放在哪里？"],
    ["810050", "我有个问题：客服；甲∶备用钥匙放在哪里？"],
    ["810051", "客服；甲：\n备用钥匙放在哪里？"],
    ["810052", "客服；甲：\u2029备用钥匙放在哪里？"],
    ["810053", "客服；甲﹕\u200B\n备用钥匙放在哪里？"],
    ["810054", "客服；甲：\u2060\n备用钥匙放在哪里？"],
    ["810055", "客服；甲׃\u200B\r\n备用钥匙放在哪里？"],
    ["810058", "客服；甲：\u0085备用钥匙放在哪里？"],
    ["810061", "客服；甲︰备用钥匙放在哪里？"],
  ] as const) {
    assert.equal(h.receive(messageId, text, [], {
      senderId: "20001", replyToMessageId: "910001",
    }), "observed");
    assert.equal(h.room.store.lifecycleRequests().length, 1);
  }

  for (const [messageId, question] of [
    ["810011", "请问志愿者集合点在哪里？"],
    ["810015", "顺便问一下：志愿者集合点在哪里？"],
    ["810016", "请问一下，为什么他说：备用钥匙放在哪里？"],
    ["810017", "麻烦请问下，为什么标题：备用钥匙放在哪里？"],
    ["810026", "请说明：志愿者集合点在哪里？"],
    ["810027", "我只是想知道：志愿者集合点在哪里？"],
    ["810028", "我有个问题：志愿者集合点在哪里？"],
    ["810029", "我想问个问题：志愿者集合点在哪里？"],
    ["810030", "打扰一下：志愿者集合点在哪里？"],
    ["810035", "我还有个问题：志愿者集合点在哪里？"],
    ["810036", "我想再确认一下：当天几点集合？"],
    ["810037", "我这边有个问题：志愿者集合点在哪里？"],
    ["810038", "帮我确认一下：次日上午几点集合？"],
    ["810045", "麻烦你帮我确认一下：明早几点集合？"],
    ["810046", "能不能帮我看看：备用钥匙放在哪里？"],
    ["810056", "  请问志愿者集合点在哪里？"],
    ["810057", "\u00A0请问志愿者集合点在哪里？"],
    ["810059", "客服；甲：\n\u0085请问备用钥匙放在哪里？"],
  ] as const) {
    const priorRequestCount = h.room.store.lifecycleRequests().length;
    assert.equal(h.receive(messageId, [
      "剧本选段：",
      "旁白：展厅已经清场。",
      "甲：备用钥匙放在哪里？",
      "乙：明早谁负责开门？",
      question,
    ].join("\n"), [], {
      senderId: "20001", replyToMessageId: "910001",
    }), "scheduled");
    await h.room.whenIdle();
    assert.equal(h.room.store.lifecycleRequests().length, priorRequestCount + 1);
    const reportContinuation = h.room.store.lifecycleRequests()[priorRequestCount]!;
    assert.equal(reportContinuation.input.replyToMessageId, "910001");
    assert.equal(reportContinuation.admissionReason, "quoted_direct");
    assert.deepEqual(h.room.store.lifecycleTurns(reportContinuation.requestId)
      .map(turn => turn.characterId), ["character-b"]);
  }

  assert.equal(h.receive("810060", "请问备用钥匙放在哪里？\u0085", [], {
    senderId: "20002", replyToMessageId: "910001",
  }), "scheduled");
  await h.room.whenIdle();

  assert.equal(h.receive("810002", "继续", [], {
    senderId: "20001", replyToMessageId: "910001",
  }), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests().length, 21);
  const continuation = h.room.store.lifecycleRequests()[20]!;
  assert.equal(continuation.input.replyToMessageId, "910001");
  assert.equal(continuation.admissionReason, "quoted_direct");
  assert.deepEqual(h.room.store.lifecycleTurns(continuation.requestId).map(turn => turn.characterId),
    ["character-b"]);

  const cycleDb = new DatabaseSync(join(h.root, "room.sqlite"));
  cycleDb.prepare("UPDATE room_messages SET target_id=id WHERE id=?").run(bot.id);
  cycleDb.close();
  assert.equal(h.receive("810003", "那继续详细说说？", [], {
    senderId: "20001", replyToMessageId: "910001",
  }), "observed");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests().length, 21);
});

test("Fix-4 R9 quoted continuation predicate separates commands and questions from declarations", () => {
  const longReportPrefix = "预计会在明天下午全体演员正式到场排演并完成安全检查以后";
  const longScenePostqualifier = "（在正式演出开始之前完成全部布景和道具检查以后）";
  const longLabelPostqualifier = `（${"长".repeat(127)}）`;
  const priorColonPrefix = `${"长".repeat(127)}：`;
  for (const text of [
    "继续",
    "接着说下去",
    "然后呢？",
    "请解释一下。",
    "请解释一下这一步。",
    "可以再解释吗？",
    "钥匙在哪儿？！",
    "为什么海报标题是「谁来值夜班」？",
    "为什么仓库公告的标题引用了这句旧话：「雨天请走侧门」？",
    "你能不能说说：这张旧票现在还能换吗？",
    "我看了群公告，标题：展厅排班变更。\n地图和两张时间表我都收到了，明天早班志愿者的入场卡已经领齐，第一班的名单也刚贴到活动室门口。\n我想问你，明早的志愿者要在哪个门口集合？",
    "剧本选段：\n旁白：展厅已经清场。\n甲：备用钥匙放在哪里？\n乙：明早谁负责开门？\n请问志愿者集合点在哪里？",
    "剧本选段：\n旁白：展厅已经清场。\n顺便问一下：志愿者集合点在哪里？",
    "剧本选段：\n旁白：展厅已经清场。\n请问一下，为什么他说：备用钥匙放在哪里？",
    "剧本选段：\n旁白：展厅已经清场。\n麻烦请问下，为什么标题：备用钥匙放在哪里？",
    "剧本选段：\n旁白：展厅已经清场。\n请说明：志愿者集合点在哪里？",
    "剧本选段：\n旁白：展厅已经清场。\n麻烦告诉我：志愿者集合点在哪里？",
    "剧本选段：\r旁白：展厅已经清场。\r请问志愿者集合点在哪里？",
    "剧本选段：\u2028旁白：展厅已经清场。\u2028请问志愿者集合点在哪里？",
    "剧本选段：\u2029旁白：展厅已经清场。\u2029请问志愿者集合点在哪里？",
    `${longReportPrefix}剧本已经发下来，明天排到几点？`,
    "第三幕排练几点开始？",
    "第 2 景的主要演员是谁？",
    "剧组的台词表我已经整理好了。\n请问明早几点集合？",
    "我只是想知道：备用钥匙放在哪里？",
    "请说一下：备用钥匙放在哪里？",
    "说说看：备用钥匙放在哪里？",
    "能再说说：备用钥匙放在哪里？",
    "详细说下：备用钥匙放在哪里？",
    "有个问题：备用钥匙放在哪里？",
    "问你一下：备用钥匙放在哪里？",
    "我想了解一下：备用钥匙放在哪里？",
    "想请教：备用钥匙放在哪里？",
    "我好奇问一句：备用钥匙放在哪里？",
    "想确认一下：明早几点集合？",
    "麻烦说说：备用钥匙放在哪里？",
    "我有个问题：备用钥匙放在哪里？",
    "我想问个问题：备用钥匙放在哪里？",
    "打扰一下：备用钥匙放在哪里？",
    "我还有个问题：志愿者集合点在哪里？",
    "我想再确认一下：当天几点集合？",
    "我这边有个问题：志愿者集合点在哪里？",
    "帮我确认一下：次日上午几点集合？",
    "麻烦你帮我确认一下：明早几点集合？",
    "能不能帮我看看：备用钥匙放在哪里？",
    "客服；甲：\n  请问备用钥匙放在哪里？",
    "客服；甲：\n\t顺便问一下：备用钥匙放在哪里？",
    "剧本选段：\n旁白：展厅已经清场。\n\u00A0请问志愿者集合点在哪里？",
    "客服；甲：\n\u0085请问备用钥匙放在哪里？",
    "请问备用钥匙放在哪里？\u0085",
    "我有个问题︰备用钥匙放在哪里？",
  ]) {
    assert.equal(isQuotedContinuation(text), true, text);
  }
  for (const text of [
    "继续教育报名已经结束。",
    "继续教育报名指南建议提前准备材料。",
    "我喜欢草莓。",
    "这个邮局上周换了门牌。",
    "如何申请宿舍是迎新手册的第二章。",
    "你说的那家面包店已经搬走了。",
    "继续，报名已经结束了。",
    "然后呢，我去了超市。",
    "请解释一下，这是旧海报。",
    "继续！是海报上印的口号。",
    "请说明！这三个字是旧模板的默认标题。",
    "海报的标题是：钥匙在哪儿？",
    "展板的主标题最终确定为：下周还能借到望远镜吗？",
    "巡场时小顾问了一句：失物招领处几点关门？",
    "值班员在群里问：\n北门今天临时关闭了。\n明天几点重新开放？",
    "领队在收工前问：\n展厅南侧的入口今天临时关闭，原定的导览路线也临时改了，已经预约的两组访客都收到了修改通知。\n明天上午第一场导览应该改在哪里集合？",
    "副导演读剧本：\n我是槐屿，负责保管签到表。\n明晚谁来替我值班？",
    "剧本选段：备用钥匙放在哪里？",
    "对白内容如下：明早几点集合？",
    "请问标题：备用钥匙放在哪里？",
    "请问对白内容如下：明早几点集合？",
    "麻烦请问他说：备用钥匙放在哪里？",
    "第 12 场：备用钥匙放在哪里？",
    "问一下第 12 场：备用钥匙放在哪里？",
    "今天的台词：备用钥匙放在哪里？",
    "本页剧本：备用钥匙放在哪里？",
    "这一段剧本内容如下：备用钥匙放在哪里？",
    "舞台剧第一幕：备用钥匙放在哪里？",
    "请问一下，剧本选段：备用钥匙放在哪里？",
    "今天第 3 场：备用钥匙放在哪里？",
    "下午第 3 场：备用钥匙放在哪里？",
    "甲：备用钥匙放在哪里？",
    "林：明早几点集合？",
    "角色甲：备用钥匙放在哪里？",
    "甲 ：备用钥匙放在哪里？",
    "A ：明早几点集合？",
    "甲　：备用钥匙放在哪里？",
    "第三幕：备用钥匙放在哪里？",
    "第 2 景：备用钥匙放在哪里？",
    "预计会在明天下午全体演员正式到场排演以后第12场：备用钥匙放在哪里？",
    "在正式演出开始之前所有工作人员完成安全检查以后第4幕：备用钥匙放在哪里？",
    "今天下午导演完成最后一次彩排并确认全部布景以后第7景：备用钥匙放在哪里？",
    `第3场${longScenePostqualifier}：备用钥匙放在哪里？`,
    `${longReportPrefix}剧本：备用钥匙放在哪里？`,
    `${longReportPrefix}台词：备用钥匙放在哪里？`,
    `${longReportPrefix}对白：备用钥匙放在哪里？`,
    `${longReportPrefix}独白：备用钥匙放在哪里？`,
    `${longReportPrefix}场记：备用钥匙放在哪里？`,
    `${longReportPrefix}分镜：备用钥匙放在哪里？`,
    `${longReportPrefix}字幕：备用钥匙放在哪里？`,
    `${longReportPrefix}舞台剧：备用钥匙放在哪里？`,
    `${priorColonPrefix}剧本：备用钥匙放在哪里？`,
    `标题${longLabelPostqualifier}：备用钥匙放在哪里？`,
    `他记录了${longLabelPostqualifier}：备用钥匙放在哪里？`,
    "场记：备用钥匙放在哪里？",
    "角色独白：备用钥匙放在哪里？",
    "分镜：备用钥匙放在哪里？",
    "剧本选段：\n旁白：舞台灯全部熄灭。\n甲：备用钥匙放在哪里？\n乙：明早谁负责开门？",
    "对白内容如下：\n林：返场前请确认耳麦。\n周：明早几点集合？\n陈：备用道具谁来收？",
    "他说：备用钥匙放在哪里？",
    "标题：备用钥匙放在哪里？",
    "客服 ：备用钥匙放在哪里？",
    "我只是想知道标题：备用钥匙放在哪里？",
    "我有个问题：标题：备用钥匙放在哪里？",
    "我只是想知道：他说：备用钥匙放在哪里？",
    "我有个问题，甲：备用钥匙放在哪里？",
    "我想问个问题，客服 ：备用钥匙放在哪里？",
    "不好意思，他：备用钥匙放在哪里？",
    "打扰一下，林：明早几点集合？",
    "我有个问题。甲：备用钥匙放在哪里？",
    "我想问个问题；客服 ：备用钥匙放在哪里？",
    "不好意思！他：备用钥匙放在哪里？",
    "打扰一下。林：明早几点集合？",
    "麻烦帮我确认一下，甲：备用钥匙放在哪里？",
    "我这边想确认一下，客服 ：备用钥匙放在哪里？",
    "我有个问题……甲：备用钥匙放在哪里？",
    "我有个问题：客服；甲：备用钥匙放在哪里？",
    `我有个问题：${"转述内容".repeat(20)}：备用钥匙放在哪里？`,
    "我有个问题：客服；甲﹕备用钥匙放在哪里？",
    "我有个问题：客服；甲∶备用钥匙放在哪里？",
    "我有个问题：客服；甲︓备用钥匙放在哪里？",
    "我有个问题：客服；甲꞉备用钥匙放在哪里？",
    "我有个问题：客服；甲׃备用钥匙放在哪里？",
    "我有个问题：客服；甲፡备用钥匙放在哪里？",
    "我有个问题：客服；甲፥备用钥匙放在哪里？",
    "我有个问题：客服；甲ꘌ备用钥匙放在哪里？",
    "我有个问题：客服；甲⁚备用钥匙放在哪里？",
    "我有个问题：客服；甲︰备用钥匙放在哪里？",
    "客服；甲：\n备用钥匙放在哪里？",
    "客服；甲：\r\n备用钥匙放在哪里？",
    "客服；甲：\r备用钥匙放在哪里？",
    "客服；甲：\u2028备用钥匙放在哪里？",
    "客服；甲：\u2029备用钥匙放在哪里？",
    "客服；甲﹕\u200B\n备用钥匙放在哪里？",
    "客服；甲：\u2060\n备用钥匙放在哪里？",
    "客服；甲׃\u200B\r\n备用钥匙放在哪里？",
    "客服；甲：\u0085备用钥匙放在哪里？",
  ]) {
    assert.equal(isQuotedContinuation(text), false, text);
  }
});

test("Fix-4 B4-03 explicit @ wins over a quote and duplicate events do not create a second request", async t => {
  let receipt = 920000;
  const h = await lifecycleHarness(t, {
    model: { generate: async prompt => ({ kind: "reply", segments: [`${prompt.characterId} reply`] }) },
    dispatch: async request => {
      const messageId = String(++receipt);
      request.beforeSend();
      await request.observe({ kind: "ack", messageId });
      request.released();
      return messageId;
    },
  });

  assert.equal(h.receive("820001", "先由 B 回答", ["10003"], { senderId: "20001" }), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.receive("820002", "收到", [], {
    senderId: "20001", replyToMessageId: "920001",
  }), "observed");
  const combined = roomInput("820003", "你刚才为什么这么说？", ["10002"], {
    senderId: "20001", replyToMessageId: "920001",
  });

  assert.equal(h.room.receiveLifecycle(combined, QUEUE), "scheduled");
  await h.room.whenIdle();
  const requests = h.room.store.lifecycleRequests();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.characterIds, ["character-a"]);
  assert.equal(requests[1]!.admissionReason, "explicit_direct");
  assert.deepEqual(h.room.store.lifecycleTurns(requests[1]!.requestId).map(turn => turn.characterId),
    ["character-a"]);

  assert.equal(h.room.receiveLifecycle(combined, QUEUE), "duplicate");
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequests().length, 2);
});

test("Fix-4 B4-08 audit distinguishes direct provenance and ambient no-trigger without bodies or platform identities", async t => {
  const base = Date.parse("2026-11-19T00:30:00Z");
  let now = base;
  let receipt = 925000;
  const notices: Array<Record<string, unknown>> = [];
  const h = await lifecycleHarness(t, {
    deps: {
      now: () => now,
      onAmbientParticipation: notice => { notices.push(notice as unknown as Record<string, unknown>); },
    },
    config: roomConfig({
      limits: { ambientMessages: 3, ambientPeople: 2, ambientQuietMs: 60000 },
    }),
    ambientPlanner: { plan: async () => ({ kind: "skip" }) },
    model: { generate: async prompt => ({ kind: "reply", segments: [`${prompt.characterId} reply`] }) },
    dispatch: async request => {
      const messageId = String(++receipt);
      request.beforeSend();
      await request.observe({ kind: "ack", messageId });
      request.released();
      return messageId;
    },
  });

  assert.equal(h.receive("830001", "先由 B 回答", ["10003"], { senderId: "23001" }), "scheduled");
  await h.room.whenIdle();
  const bot = h.room.store.historyPage(50).filter(row => row.speakerType === "bot").at(-1)!;
  assert.equal(h.receive("830002", "继续", [], {
    senderId: "23001", replyToMessageId: bot.platformId,
  }), "scheduled");
  await h.room.whenIdle();

  const direct = h.room.store.lifecycleRequests();
  assert.equal(direct.length, 2);
  const directAudit = h.room.store.lifecycleAudit();
  assert.equal(direct[0]!.admissionReason, "explicit_direct");
  assert.equal(direct[1]!.admissionReason, "quoted_direct");
  assert.equal(directAudit.find(row => row.requestId === direct[0]!.requestId)!.admissionReason, "explicit_direct");
  assert.equal(directAudit.find(row => row.requestId === direct[1]!.requestId)!.admissionReason, "quoted_direct");
  assert.doesNotMatch(JSON.stringify(directAudit), /830001|830002|23001|先由 B 回答/);

  now = base + 180000;
  assert.equal(h.receive("830003", "/room mode ambient", [], { senderId: "10001" }), "control");
  assert.equal(h.receive("830004", "我先补充一点背景", [], { senderId: "23002" }), "observed");
  assert.equal(h.receive("830005", "这里还有一个相关情况", [], { senderId: "23003" }), "observed");
  assert.equal(h.receive("830006", "小林，你怎么看？", [], { senderId: "23004" }), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now += 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);

  assert.ok(notices.length > 0);
  assert.deepEqual(notices.at(-1), {
    code: "ambient_rule_other-conversation",
    anchorRowId: anchor.id,
  });
  assert.equal(h.room.store.lifecycleRequests().length, 2);
  assert.equal(h.prompts.length, 2);
  assert.equal(h.dispatches.length, 2);
});

test("Fix-4 R3 group-question provenance survives pause and resume with one-segment limits", async t => {
  const base = Date.parse("2026-11-19T00:45:00Z");
  let now = base;
  const first = deferred<RoomLifecycleAnswer>();
  let generation = 0;
  const maxCharsSeen: number[] = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: {
        maxTextChars: 240,
        ambientMessages: 3,
        ambientPeople: 2,
        ambientQuietMs: 60000,
        ambientCooldownMs: 1,
        modelAttemptsPerHour: null,
      },
    }),
    deps: { now: () => now },
    ambientPlanner: {
      plan: async () => ({ kind: "join", characterIds: ["character-b", "character-a"] }),
    },
    model: {
      generate: async (_prompt, _signal, maxChars) => {
        maxCharsSeen.push(maxChars);
        generation++;
        return generation === 1
          ? first.promise
          : { kind: "reply", segments: ["resumed short answer"] };
      },
    },
  });

  try {
    assert.equal(h.receive("840001", "/room mode ambient"), "control");
    assert.equal(h.receive("840002", "先补充一个完整背景", [], { senderId: "24002" }), "observed");
    assert.equal(h.receive("840003", "这里还有一个关键条件", [], { senderId: "24003" }), "observed");
    assert.equal(h.receive("840004", "这个方案接下来到底怎么处理？", [], { senderId: "24004" }), "observed");
    const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
    now += 60000;
    await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
    await waitFor(() => h.prompts.length === 1, "first group-question prompt");
    const request = h.room.store.lifecycleRequests().find(item => item.source === "ambient")!;
    const turn = h.room.store.lifecycleTurns(request.requestId)[0]!;
    assert.equal(request.admissionReason, "ambient_group_question");

    h.room.store.setPaused(true);
    await waitFor(() => h.room.store.lifecycleTurns(request.requestId)[0]!.status === "pending",
      "paused generation returns to pending");
    h.room.store.setPaused(false);
    await waitFor(() => h.prompts.length === 2, "resumed group-question prompt");
    first.resolve({ kind: "reply", segments: ["late answer", "must not expand"] });
    await h.room.whenIdle();

    assert.deepEqual(maxCharsSeen.map(value => value <= 80), [true, true]);
    assert.equal(h.room.store.lifecycleRequestById(request.requestId)!.admissionReason,
      "ambient_group_question");
    assert.equal(h.room.store.lifecycleSegments(turn.turnId).length, 1);
    assert.equal(h.dispatches.length, 1);
    const audit = h.room.store.lifecycleAudit().find(row => row.turnId === turn.turnId)!;
    assert.equal(audit.admissionReason, "ambient_group_question");
  } finally {
    first.resolve({ kind: "reply", segments: ["final cleanup"] });
    await h.room.close();
  }
});

test("Fix-4 R3 admission provenance remains distinct from failure and cancellation reasons", async t => {
  let receipt = 945000;
  let generation = 0;
  const quotedGeneration = deferred<RoomLifecycleAnswer>();
  const h = await lifecycleHarness(t, {
    model: {
      generate: async (_prompt, _signal, _maxChars) => {
        generation++;
        if (generation === 1) return { kind: "reply", segments: ["seed reply"] };
        if (generation === 2) return { kind: "reply", segments: [] };
        if (generation === 3) return { kind: "reply", segments: [] };
        return quotedGeneration.promise;
      },
    },
    dispatch: async request => {
      const messageId = String(++receipt);
      request.beforeSend();
      await request.observe({ kind: "ack", messageId });
      request.released();
      return messageId;
    },
  });

  assert.equal(h.receive("850001", "先请 B 回答", ["10003"], { senderId: "25001" }), "scheduled");
  await h.room.whenIdle();
  const seed = h.room.store.lifecycleRequests()[0]!;
  const bot = h.room.store.historyPage(50).filter(row =>
    row.speakerType === "bot" && row.targetId === seed.messageRowId).at(-1)!;

  assert.equal(h.receive("850002", "显式失败请求", ["10003"], { senderId: "25001" }), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.receive("850003", "继续", [], {
    senderId: "25001", replyToMessageId: bot.platformId,
  }), "scheduled");
  await h.room.whenIdle();

  const requests = h.room.store.lifecycleRequests();
  const explicitFailure = requests.find(request => request.input.messageId === "850002")!;
  const quotedFailure = requests.find(request => request.input.messageId === "850003")!;
  assert.equal(explicitFailure.admissionReason, "explicit_direct");
  assert.equal(quotedFailure.admissionReason, "quoted_direct");
  const audit = h.room.store.lifecycleAudit();
  const explicitAudit = audit.find(row => row.requestId === explicitFailure.requestId)!;
  const quotedAudit = audit.find(row => row.requestId === quotedFailure.requestId)!;
  assert.equal(explicitAudit.turnReason, "lifecycle_answer_invalid");
  assert.equal(quotedAudit.turnReason, "lifecycle_answer_invalid");
  assert.notEqual(explicitAudit.admissionReason, quotedAudit.admissionReason);

  assert.equal(h.receive("850004", "继续", [], {
    senderId: "25001", replyToMessageId: bot.platformId,
  }), "scheduled");
  await waitFor(() => h.prompts.length === 4, "quoted cancellation prompt");
  const quotedCancel = h.room.store.lifecycleRequests().find(request =>
    request.input.messageId === "850004")!;
  assert.equal(h.receive("850005", "/room mode ambient", [], { senderId: "10001" }), "control");
  await waitFor(() => h.room.store.lifecycleRequestById(quotedCancel.requestId)?.status === "cancelled",
    "quoted cancellation");
  quotedGeneration.resolve({ kind: "reply", segments: ["too late"] });
  await h.room.whenIdle();

  const cancelledAudit = h.room.store.lifecycleAudit().find(row => row.requestId === quotedCancel.requestId)!;
  assert.equal(cancelledAudit.admissionReason, "quoted_direct");
  assert.equal(cancelledAudit.turnReason, "mode_changed");
  assert.equal(h.dispatches.filter(item => item.requestId === quotedCancel.requestId).length, 0);
});

test("Fix-4 R3 lifecycle payloads created before admission provenance remain readable", async t => {
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["legacy payload reply"] }) },
  });
  assert.equal(h.receive("860001", "请 B 回答", ["10003"]), "scheduled");
  await h.room.whenIdle();
  const request = h.room.store.lifecycleRequests()[0]!;
  assert.equal(request.admissionReason, "explicit_direct");

  const db = new DatabaseSync(join(h.root, "room.sqlite"));
  db.prepare("UPDATE room_lifecycle_requests SET payload_json=json_remove(payload_json,'$.admissionReason') WHERE request_id=?")
    .run(request.requestId);
  db.close();

  assert.equal(h.room.store.lifecycleRequestById(request.requestId)!.admissionReason, null);
  assert.equal(h.room.store.lifecycleAudit().find(row => row.requestId === request.requestId)!.admissionReason, null);
});

async function ambientCompletionFixture(t: TestContext, options: Parameters<typeof lifecycleHarness>[1]) {
  const base = Date.parse("2026-11-18T00:00:00Z");
  let now = base;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both", limits: { ambientQuietMs: 60000, ambientCooldownMs: 1 } }),
    ambientPlanner: { plan: async () => ({ kind: "join", characterIds: ["character-a"] }) },
    ...options,
    deps: { ...options.deps, now: () => now },
  });
  const admit = async () => {
    assert.equal(h.receive("940001", "/room mode ambient"), "control");
    assert.equal(h.receive("940002", "大家怎么看这个测试？ INPUT_PRIVATE_CANARY"), "observed");
    const anchor = h.room.store.historyPage(50).at(-1)!;
    now += 60000;
    await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
    return h.room.store.lifecycleRequests()[0]!;
  };
  return { ...h, admit, expire: () => { now += QUEUE.ttlMs; } };
}

for (const superseded of [false, true]) {
  test(`Fix-2 Ambient generator skip stays silent ${superseded ? "after a newer human line" : "on the current anchor"}`, async t => {
    const answer = deferred<RoomLifecycleAnswer>();
    const sends: DispatchRecord[] = [];
    let modelCalls = 0;
    const h = await ambientCompletionFixture(t, {
      model: { generate: async () => (++modelCalls === 1 ? answer.promise : { kind: "skip" }) },
      dispatch: async request => {
        request.beforeSend();
        sends.push({ characterId: request.item.character.id, requestId: request.item.request.requestId,
          medium: request.medium, text: request.item.segment.text });
        const messageId = String(949000 + sends.length);
        await request.observe({ kind: "ack", messageId });
        request.physicalSettled?.();
        request.released();
        return messageId;
      },
    });
    const candidate = await h.admit();
    await waitFor(() => modelCalls === 1, "ambient generator called");
    if (superseded) assert.equal(h.receive("940003", "new human line"), "observed");
    answer.resolve({ kind: "skip" });
    await h.room.whenIdle();
    assert.equal(sends.length, 0, "ambient skip never reaches an external send");
    assert.equal(h.synthesisCalls, 0);
    const audit = h.room.store.lifecycleAudit().filter(row => row.requestId === candidate.requestId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.turnStatus, "skipped");
    assert.equal(audit[0]!.turnReason, "ambient_model_skip");
    assert.equal(audit[0]!.attemptId, null);

    assert.equal(h.receive("940004", "I mentioned the bot", ["10002"]), "scheduled");
    await h.room.whenIdle();
    assert.equal(modelCalls, 2);
    assert.deepEqual(sends.map(item => item.medium), ["text", "audio"]);
    assert.ok(sends.every(item => item.text === WORKER_EXPLICIT_NO_ANSWER_FALLBACK.text));
  });
}

test("Fix-2 Ambient generation cancels a reply to a superseded anchor and clears FIFO", async t => {
  const answer = deferred<RoomLifecycleAnswer>();
  let modelCalls = 0;
  const sent: string[] = [];
  const h = await ambientCompletionFixture(t, {
    model: { generate: async () => (++modelCalls === 1 ? answer.promise : { kind: "reply", segments: ["next"] }) },
    dispatch: async request => {
      request.beforeSend();
      sent.push(request.item.request.requestId);
      const messageId = String(949100 + sent.length);
      await request.observe({ kind: "ack", messageId });
      request.physicalSettled?.();
      request.released();
      return messageId;
    },
  });
  const candidate = await h.admit();
  await waitFor(() => modelCalls === 1, "ambient generator called");
  assert.equal(h.receive("941003", "new human line"), "observed");
  answer.resolve({ kind: "reply", segments: ["OUTPUT_PRIVATE_CANARY"] });
  await h.room.whenIdle();
  assert.deepEqual(sent, []);
  assert.equal(h.room.store.lifecycleHeadRequest(), null);
  const outcome = h.room.store.lifecycleRequestById(candidate.requestId)!;
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.outcomeReason, "stale_anchor");
  assert.equal(h.room.store.lifecycleTurns(candidate.requestId)[0]!.segmentCount, 0);
  assert.equal(h.receive("941004", "next FIFO request", ["10002"]), "scheduled");
  await h.room.whenIdle();
  const next = h.room.store.lifecycleRequests().at(-1)!;
  assert.deepEqual(sent, [next.requestId, next.requestId]);
  assert.equal(next.status, "completed");
});

test("Fix-2 Ambient sibling skip remains skipped when another generation is stale", async t => {
  const stale = deferred<RoomLifecycleAnswer>();
  const skip = deferred<RoomLifecycleAnswer>();
  const h = await ambientCompletionFixture(t, {
    ambientPlanner: { plan: async () => ({ kind: "join", characterIds: ["character-a", "character-b"] }) },
    model: { generate: async prompt => prompt.characterId === "character-a" ? stale.promise : skip.promise },
  });
  const candidate = await h.admit();
  await waitFor(() => h.prompts.length === 2, "both ambient generators called");
  assert.equal(h.receive("941005", "new human line"), "observed");
  stale.resolve({ kind: "reply", segments: ["OUTPUT_PRIVATE_CANARY"] });
  await waitFor(() => h.room.store.lifecycleTurns(candidate.requestId)[0]?.status === "cancelled",
    "stale character settles before its sibling").finally(() => skip.resolve({ kind: "skip" }));
  await h.room.whenIdle();
  assert.equal(h.room.store.lifecycleRequestById(candidate.requestId)!.outcomeReason, "stale_anchor");
  assert.deepEqual(h.room.store.lifecycleTurns(candidate.requestId).map(turn => [turn.status, turn.reason]), [
    ["cancelled", "stale_anchor"], ["skipped", "ambient_model_skip"],
  ]);
  assert.equal(h.dispatches.length, 0);
});

for (const reason of ["stale_anchor", "ttl_expired"] as const) {
  test(`Fix-2 Ambient ${reason} at the physical send guard makes no visible send`, async t => {
    const atPreflight = deferred<void>();
    const proceed = deferred<void>();
    const visible: string[] = [];
    const h = await ambientCompletionFixture(t, {
      model: { generate: async () => ({ kind: "reply", segments: ["OUTPUT_PRIVATE_CANARY"] }) },
      dispatch: async request => {
        if (request.item.request.source === "ambient") {
          atPreflight.resolve();
          await proceed.promise;
        }
        request.beforeSend();
        visible.push(request.item.request.requestId);
        const messageId = String(949200 + visible.length);
        await request.observe({ kind: "ack", messageId });
        request.physicalSettled?.();
        request.released();
        return messageId;
      },
    });
    const candidate = await h.admit();
    await atPreflight.promise;
    if (reason === "stale_anchor") assert.equal(h.receive("942003", "new human line"), "observed");
    else h.expire();
    proceed.resolve();
    await h.room.whenIdle();
    assert.deepEqual(visible, []);
    assert.equal(h.room.store.lifecycleHeadRequest(), null);
    const audit = h.room.store.lifecycleAudit().find(row => row.requestId === candidate.requestId)!;
    assert.equal(audit.requestStatus, "cancelled");
    assert.equal(audit.requestReason, reason);
    assert.equal(audit.medium, "text");
    assert.equal(audit.startedAt, null);
    assert.deepEqual(audit.receipts, []);
    assert.equal(h.room.store.counts().send, 0);
    assert.equal(h.receive("942004", "next FIFO request", ["10002"]), "scheduled");
    await h.room.whenIdle();
    const next = h.room.store.lifecycleRequests().at(-1)!;
    assert.deepEqual(visible, [next.requestId, next.requestId]);
    assert.equal(next.status, "completed");
    assert.equal(h.room.workerStatusForTest().phase, "ready");
  });
}

for (const medium of ["text", "audio"] as const) {
  for (const direct of [false, true]) {
    test(`Fix-2 Ambient durable ${medium} ACK survives ${direct ? "direct-request cancellation" : "a newer human line"}`, async t => {
      const visible: { requestId: string; medium: string; messageId: string }[] = [];
      let interrupted = false;
      const h = await ambientCompletionFixture(t, {
        model: { generate: async () => ({ kind: "reply", segments: ["first canary", "unstarted canary"] }) },
        dispatch: async request => {
          request.beforeSend();
          const messageId = String(949300 + visible.length);
          visible.push({ requestId: request.item.request.requestId, medium: request.medium, messageId });
          await request.observe({ kind: "ack", messageId });
          if (!interrupted && request.item.request.source === "ambient" && request.medium === medium) {
            interrupted = true;
            assert.equal(h.receive("943003", "new human line", direct ? ["10002"] : []),
              direct ? "scheduled" : "observed");
          }
          request.physicalSettled?.();
          request.released();
          return messageId;
        },
      });
      const candidate = await h.admit();
      await h.room.whenIdle();
      const oldSends = visible.filter(send => send.requestId === candidate.requestId);
      assert.deepEqual(oldSends.map(send => send.medium), medium === "text" ? ["text"] : ["text", "audio"]);
      const audit = h.room.store.lifecycleAudit().filter(row => row.requestId === candidate.requestId && row.attemptId);
      assert.equal(audit.length, oldSends.length);
      for (const attempt of audit) {
        assert.ok(attempt.startedAt !== null);
        assert.deepEqual(attempt.receipts, ["ack"]);
      }
      const history = h.room.store.history();
      for (const send of oldSends) {
        const confirmed = history.filter(row => row.platformId === send.messageId);
        assert.equal(confirmed.length, 1);
        assert.equal(confirmed[0]!.targetId, candidate.messageRowId);
        assert.equal(confirmed[0]!.medium, send.medium === "text" ? "text" : "voice");
      }
      assert.equal(h.room.workerStatusForTest().phase, "ready");
      if (!direct) {
        assert.equal(h.room.store.lifecycleHeadRequest(), null);
        assert.equal(h.receive("943004", "next FIFO request", ["10002"]), "scheduled");
        await h.room.whenIdle();
      }
      const next = h.room.store.lifecycleRequests().at(-1)!;
      assert.notEqual(next.requestId, candidate.requestId);
      assert.equal(next.status, "completed");
      assert.equal(visible.filter(send => send.requestId === candidate.requestId).length, oldSends.length);
    });
  }
}

test("Fix-2 Ambient observable rule rejection, stale opportunity and planner skip use only internal anchors", async t => {
  let now = Date.parse("2026-11-18T00:00:00Z");
  const notices: unknown[] = [];
  const deps = {
    now: () => now,
    persona: () => "PROMPT_PRIVATE_CANARY MEMORY_PRIVATE_CANARY",
    onAmbientParticipation: (notice: unknown) => notices.push(notice),
  };
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 60000, ambientCooldownMs: 1 } }),
    deps,
    ambientPlanner: { plan: async () => ({ kind: "skip" }) },
    model: { generate: async () => ({ kind: "reply", segments: ["OUTPUT_PRIVATE_CANARY"] }) },
  });
  assert.equal(h.receive("944001", "/room mode ambient"), "control");
  assert.equal(h.receive("944002", "大家怎么看？ INPUT_PRIVATE_CANARY", [], { senderId: "944099" }), "observed");
  const blocked = h.room.store.historyPage(50).at(-1)!;
  now += 60000;
  await h.room.ambientOpportunityForTest(blocked.id, QUEUE, true);
  assert.equal(h.receive("944003", "大家觉得怎么样？ TOKEN_PRIVATE_CANARY", [], { senderId: "944099" }), "observed");
  const skipped = h.room.store.historyPage(50).at(-1)!;
  now += 60000;
  await h.room.ambientOpportunityForTest(skipped.id, QUEUE);
  await h.room.ambientOpportunityForTest(blocked.id, QUEUE);
  assert.deepEqual(notices, [
    { code: "ambient_rule_other-conversation", anchorRowId: blocked.id },
    { code: "ambient_planner_skip", anchorRowId: skipped.id },
    { code: "ambient_stale_anchor", anchorRowId: blocked.id },
  ]);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
});

test("Fix-2 Ambient observable delivery failure retains safe scoped audit metadata", async t => {
  const h = await ambientCompletionFixture(t, {
    deps: { persona: () => "PROMPT_PRIVATE_CANARY MEMORY_PRIVATE_CANARY" },
    model: { generate: async () => ({ kind: "reply", segments: ["OUTPUT_PRIVATE_CANARY"] }) },
    dispatch: async request => {
      request.beforeSend();
      await request.observe({ kind: "rejected" });
      request.released();
      throw new Error("token_private_canary");
    },
  });
  const candidate = await h.admit();
  await h.room.whenIdle();
  const audit = h.room.store.lifecycleAudit().filter(row => row.requestId === candidate.requestId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.requestReason, "delivery_rejected");
  assert.equal(audit[0]!.segmentReason, "delivery_rejected");
  assert.deepEqual(audit[0]!.receipts, ["rejected"]);
  assert.doesNotMatch(JSON.stringify(audit), /private_canary|940002|10001|member-|messageId|senderId/i);
});

test("Fix-2 Ambient audio preparation failure keeps confirmed text and withholds opaque provider codes", async t => {
  const h = await ambientCompletionFixture(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["OUTPUT_PRIVATE_CANARY"] }) },
    synthesize: async () => { throw new Error("token_private_canary"); },
  });
  const candidate = await h.admit();
  await h.room.whenIdle();
  const audit = h.room.store.lifecycleAudit().filter(row => row.requestId === candidate.requestId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.segmentReason, "tts_text_only_voice_preparation_failed");
  assert.equal(audit[0]!.medium, "text");
  assert.deepEqual(audit[0]!.receipts, ["ack"]);
  assert.doesNotMatch(JSON.stringify(audit), /private_canary/i);
});

test("ambient runtime never initiates a new topic and planner input is public and bounded", async t => {
  const base = Date.parse("2026-11-18T00:00:00Z");
  let now = base;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1, modelAttemptsPerHour: null },
    }),
    deps: { now: () => now },
    ambientPlanner: {
      plan: async () => ({ kind: "initiate", characterIds: ["character-a"] }),
    },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });

  for (let index = 0; index < 13; index++) {
    assert.equal(h.receive(String(100 + index), `历史公开消息 ${index}`), "observed");
  }
  assert.equal(h.receive("200", "/room mode ambient"), "control");
  assert.equal(h.receive("201", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;

  now = base + AMBIENT_IDLE_THRESHOLD_MS - 1;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  const before = h.ambientPlannerCalls[0]!;
  assert.equal(before.constraints.allowInitiate, false);
  assert.equal(before.constraints.idleThresholdMs, AMBIENT_IDLE_THRESHOLD_MS);
  assert.equal(before.constraints.maxHistory, 12);
  assert.equal(before.history.length, 12);
  assert.equal(before.anchor.text, "我今天终于跑通了离线测试，大家怎么看？");
  assert.deepEqual(before.characters.map(character => character.id), ["character-a", "character-b"]);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  const publicInput = JSON.stringify(before);
  assert.doesNotMatch(publicInput, /"accountKey"|"groupId"|"platformId"|"selfId"|"speakerId"|"targetId"/);
  assert.doesNotMatch(publicInput, /account-a|10000|synthetic-token|C:\\\\synthetic/);

  now = base + AMBIENT_IDLE_THRESHOLD_MS;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await h.room.whenIdle();
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.ambientPlannerCalls[0]!.constraints.allowInitiate, false);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.room.store.historyMessage(anchor.id)!.text, "我今天终于跑通了离线测试，大家怎么看？");
  assert.equal(h.room.store.history().filter(row => row.speakerType === "user").length, 14);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
});

test("ambient lifecycle ingress schedules the quiet opportunity through the real seam", async t => {
  const base = Date.parse("2026-11-18T00:30:00Z");
  let now = base;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 10, ambientCooldownMs: 1000 } }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => ({ kind: "skip" }) },
    model: { generate: async () => ({ kind: "reply", segments: ["unused"] }) },
  });
  assert.equal(h.receive("250", "/room mode ambient"), "control");
  assert.equal(h.receive("251", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  now = base + 10;
  await waitFor(() => h.ambientPlannerCalls.length === 1, "scheduled ambient quiet opportunity");
  assert.equal(h.room.store.ambientCursor()?.outcome, "skip");
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
});

test("ambient decision validation rejects extra, invented, duplicate and three ids", () => {
  const characters = [
    { id: "character-a", name: "Character A", persona: "public-a" },
    { id: "character-b", name: "Character B", persona: "public-b" },
  ] as const;
  const before = buildAmbientPlannerInput("anchor", [{ speaker: "human", text: "prior" }], characters,
    AMBIENT_IDLE_THRESHOLD_MS - 1);
  const exact = buildAmbientPlannerInput("anchor", [{ speaker: "human", text: "prior" }], characters,
    AMBIENT_IDLE_THRESHOLD_MS);
  assert.equal(ambientInitiationAllowed(AMBIENT_IDLE_THRESHOLD_MS - 1), false);
  assert.equal(ambientInitiationAllowed(AMBIENT_IDLE_THRESHOLD_MS), true);
  assert.equal(checkedAmbientPlannerDecision({ kind: "initiate", characterIds: ["character-a"] }, before), null);
  assert.deepEqual(checkedAmbientPlannerDecision({ kind: "initiate", characterIds: ["character-a"] }, exact),
    { kind: "initiate", characterIds: ["character-a"] });
  assert.deepEqual(checkedAmbientPlannerDecision({ kind: "join", characterIds: ["character-b", "character-a"] }, before),
    { kind: "join", characterIds: ["character-a", "character-b"] });
  assert.equal(checkedAmbientPlannerDecision({ kind: "join", characterIds: [] }, exact), null);
  assert.equal(checkedAmbientPlannerDecision({ kind: "join", characterIds: ["character-a", "character-a"] }, exact), null);
  assert.equal(checkedAmbientPlannerDecision({ kind: "join", characterIds: ["character-a", "character-b", "character-c"] }, exact), null);
  assert.equal(checkedAmbientPlannerDecision({ kind: "join", characterIds: ["invented"] }, exact), null);
  assert.equal(checkedAmbientPlannerDecision({ kind: "join", characterIds: ["character-a"], extra: true }, exact), null);
  assert.equal(checkedAmbientPlannerDecision({ kind: "skip", extra: true }, exact), null);
  assert.deepEqual(checkedAmbientPlannerDecision({ kind: "skip" }, exact), { kind: "skip" });
});

test("ambient planner prompt is valid UTF-8 Chinese without mojibake", () => {
  const characters = [
    { id: "character-a", name: "Character A", persona: "public-a" },
  ] as const;
  const prompt = createAmbientPlannerPrompt(
    buildAmbientPlannerInput("anchor", [], characters, AMBIENT_IDLE_THRESHOLD_MS));
  const text = `${prompt.systemPrompt}\n${prompt.messages[0].content}`;
  const roundTrip = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text));
  assert.equal(roundTrip, text);
  assert.equal(text.includes("\uFFFD"), false);
  assert.doesNotMatch(prompt.systemPrompt, /娴ｇ姵|浣犳槸|鍏紑|锟斤拷/);
  assert.match(prompt.systemPrompt, /你是公开群聊的 Ambient 参与度规划器/);
  assert.match(prompt.systemPrompt, /skip/);
  assert.match(prompt.systemPrompt, /join/);
  assert.match(prompt.systemPrompt, /initiate/);
  assert.match(prompt.systemPrompt, /只返回一个 JSON 对象/);
  assert.match(prompt.systemPrompt, /\{"kind":"skip"\}/);
});

test("ambient planner charges once before call and policy or spend blocks create no row", async t => {
  const base = Date.parse("2026-11-18T01:00:00Z");
  let now = base;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000, modelAttemptsPerHour: 3 },
    }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => ({ kind: "skip" }) },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });
  assert.equal(h.receive("300", "/room mode ambient"), "control");
  assert.equal(h.receive("301", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;

  h.room.store.setPaused(true);
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 0);
  assert.equal(h.room.store.counts().model, 0);
  assert.equal(h.room.store.ambientCursor(), null);
  h.room.store.setPaused(false);

  type Spend = (kind: "model" | "tts" | "send", at: number) => boolean;
  const mutableStore = h.room.store as unknown as { spend: Spend };
  const originalSpend = mutableStore.spend.bind(h.room.store);
  mutableStore.spend = () => false;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 0);
  assert.equal(h.room.store.counts().model, 0);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  mutableStore.spend = originalSpend;

  assert.equal(h.receive("302", "这个公开问题大家怎么处理？"), "observed");
  const retryAnchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 120000;
  await h.room.ambientOpportunityForTest(retryAnchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.room.store.ambientCursor()?.outcome, "skip");
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.synthesisCalls, 0);

  now = base + AMBIENT_IDLE_THRESHOLD_MS;
  await h.room.ambientOpportunityForTest(retryAnchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
});

test("pausing while the ambient planner is in flight admits and generates nothing", async t => {
  const base = Date.parse("2026-11-18T02:00:00Z");
  let now = base;
  const pending = deferred<unknown>();
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000, modelAttemptsPerHour: null },
    }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => pending.promise },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });
  assert.equal(h.receive("400", "/room mode ambient"), "control");
  assert.equal(h.receive("401", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  const work = h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await waitFor(() => h.ambientPlannerCalls.length === 1, "ambient planner in flight");
  h.room.store.setPaused(true);
  pending.resolve({ kind: "join", characterIds: ["character-a"] });
  await work;
  await flush();

  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.synthesisCalls, 0);
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.room.store.state().ambient_at, base + 60000);
  assert.equal(h.room.store.ambientCursor(), null);
  assert.equal(h.room.store.seenEvent(ambientPlannerContextKey(h.ambientPlannerCalls[0]!)), false);
});

test("ambient admission rechecks pause inside its transaction and resume advances pending work", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 60000 } }),
    model: { generate: async () => ({ kind: "reply", segments: ["unused"] }) },
  });
  assert.equal(h.receive("500", "/room mode ambient"), "control");
  assert.equal(h.receive("501", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;

  const admitted = h.room.ambientAdmissionForTest(anchor.id, ["character-a"], QUEUE);
  assert.equal(admitted.kind, "enqueue");
  assert.equal(h.room.store.lifecycleRequests().length, 1);
  const requestId = admitted.request!.requestId;
  const beforePause = h.room.store.lifecycleControlState();
  h.room.store.setPaused(true);
  const paused = h.room.store.lifecycleControlState();
  assert.equal(paused.paused, true);
  assert.equal(paused.executionRevision, beforePause.executionRevision + 1);
  assert.equal(h.room.store.lifecycleTurns(requestId)[0]!.status, "pending");
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);

  h.room.store.setPaused(false);
  await waitFor(() => h.dispatches.length === 1, "resumed lifecycle pump delivery");
  await h.room.whenIdle();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.room.store.lifecycleTurns(requestId)[0]!.status, "completed");
  assert.equal(h.room.store.lifecycleRequests()[0]!.status, "completed");

  h.room.store.setPaused(true);
  assert.equal(h.receive("502", "又一条公开历史消息", []), "observed");
  const second = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  const rejected = h.room.ambientAdmissionForTest(second.id, ["character-b"], QUEUE);
  assert.equal(rejected.kind, "reject");
  assert.equal(rejected.reason, "paused");
  assert.equal(h.room.store.lifecycleRequests().length, 1);
  assert.equal(h.room.store.schemaVersion(), 9);
});

test("pause fences an in-flight lifecycle generation and resume advances it", async t => {
  const base = Date.parse("2026-11-18T02:30:00Z");
  let now = base;
  const generation = deferred<RoomLifecycleAnswer>();
  let calls = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000, modelAttemptsPerHour: null },
    }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => ({ kind: "join", characterIds: ["character-a"] }) },
    model: { generate: async () => {
      calls++;
      return calls === 1 ? generation.promise : { kind: "reply", segments: ["resumed reply"] };
    } },
  });
  assert.equal(h.receive("700", "/room mode ambient"), "control");
  assert.equal(h.receive("701", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await waitFor(() => h.prompts.length === 1, "in-flight lifecycle generation");
  assert.equal(h.prompts[0]!.systemPrompt.includes("你正在公开群聊中扮演"), true);
  assert.equal(h.prompts[0]!.systemPrompt.includes("\uFFFD"), false);

  const requestId = h.room.store.lifecycleRequests()[0]!.requestId;
  h.room.store.setPaused(true);
  assert.equal(h.room.store.lifecycleControlState().paused, true);
  assert.equal(h.room.store.lifecycleTurns(requestId)[0]!.status, "pending");
  generation.resolve({ kind: "reply", segments: ["must not complete"] });
  await h.room.whenIdle();
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.synthesisCalls, 0);
  assert.equal(h.room.store.lifecycleTurns(requestId)[0]!.status, "pending");
  assert.equal(h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(requestId)[0]!.turnId).length, 0);

  h.room.store.setPaused(false);
  await waitFor(() => h.dispatches.length === 1, "resumed generation delivery");
  await h.room.whenIdle();
  assert.equal(calls, 2);
  assert.equal(h.room.store.lifecycleTurns(requestId)[0]!.status, "completed");
  assert.equal(h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(requestId)[0]!.turnId).length, 1);
});

test("ambient admission rejects an anchor superseded while the planner is in flight", async t => {
  const base = Date.parse("2026-11-18T04:00:00Z");
  let now = base;
  const pending = deferred<unknown>();
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000, modelAttemptsPerHour: null },
    }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => pending.promise },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });
  assert.equal(h.receive("800", "/room mode ambient"), "control");
  assert.equal(h.receive("801", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  const work = h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await waitFor(() => h.ambientPlannerCalls.length === 1, "planner in flight");
  assert.equal(h.receive("802", "新的公开消息，大家一起聊聊这个方案怎么样？"), "observed");
  pending.resolve({ kind: "join", characterIds: ["character-a"] });
  await work;
  await flush();
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
});

test("ambient planner failure and timeout record one technical defer with no retry storm", async t => {
  const base = Date.parse("2026-11-18T03:00:00Z");
  let now = base;
  const never = deferred<void>();
  let call = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000, modelAttemptsPerHour: null, requestTimeoutMs: 50 },
    }),
    deps: { now: () => now },
    ambientPlanner: {
      plan: async () => {
        call++;
        if (call === 1) throw new Error("synthetic planner failure");
        return never.promise;
      },
    },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });
  assert.equal(h.receive("600", "/room mode ambient"), "control");
  assert.equal(h.receive("601", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const first = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(first.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  await h.room.ambientOpportunityForTest(first.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);

  assert.equal(h.receive("602", "新的公开消息，大家一起聊聊这个方案怎么样？"), "observed");
  const second = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 120000;
  await h.room.ambientOpportunityForTest(second.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 2);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
});

test("ambient invalid JSON records one technical defer and no generation", async t => {
  const base = Date.parse("2026-11-18T03:30:00Z");
  let now = base;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000, modelAttemptsPerHour: null },
    }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => '{"kind":"skip"}' },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });
  assert.equal(h.receive("650", "/room mode ambient"), "control");
  assert.equal(h.receive("651", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);
});

test("ambient offline and cooldown policy gates never spend or plan", async t => {
  const base = Date.parse("2026-11-18T03:45:00Z");
  let offlineNow = base;
  const offline = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000 } }),
    deps: { now: () => offlineNow },
    ambientPlanner: { plan: async () => ({ kind: "skip" }) },
    model: { generate: async () => ({ kind: "reply", segments: ["unused"] }) },
  });
  assert.equal(offline.receive("660", "/room mode ambient"), "control");
  assert.equal(offline.receive("661", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const offlineAnchor = offline.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  offline.room.setOnline("account-a", false);
  offlineNow = base + 60000;
  await offline.room.ambientOpportunityForTest(offlineAnchor.id, QUEUE);
  assert.equal(offline.ambientPlannerCalls.length, 0);
  assert.equal(offline.room.store.counts().model, 0);
  assert.equal(offline.room.store.ambientCursor(), null);

  let cooldownNow = base;
  const cooldown = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 60000, ambientCooldownMs: 120000 } }),
    deps: { now: () => cooldownNow },
    ambientPlanner: { plan: async () => ({ kind: "skip" }) },
    model: { generate: async () => ({ kind: "reply", segments: ["unused"] }) },
  });
  assert.equal(cooldown.receive("670", "/room mode ambient"), "control");
  assert.equal(cooldown.receive("671", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const cooldownAnchor = cooldown.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  cooldownNow = base + 60000;
  cooldown.room.store.ambientAttempt(cooldownNow);
  await cooldown.room.ambientOpportunityForTest(cooldownAnchor.id, QUEUE);
  assert.equal(cooldown.ambientPlannerCalls.length, 0);
  assert.equal(cooldown.room.store.counts().model, 0);
  assert.equal(cooldown.room.store.ambientCursor(), null);
});

test("ambient cooldown advances after skip and technical defer", async t => {
  const base = Date.parse("2026-11-18T03:50:00Z");
  let now = base;
  let calls = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 200000, modelAttemptsPerHour: null },
    }),
    deps: { now: () => now },
    ambientPlanner: {
      plan: async () => {
        calls++;
        if (calls === 1) return { kind: "skip" };
        if (calls === 2) throw new Error("synthetic technical defer");
        return { kind: "skip" };
      },
    },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });
  assert.equal(h.receive("680", "/room mode ambient"), "control");
  assert.equal(h.receive("681", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const first = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(first.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.ambientCursor()?.outcome, "skip");
  assert.equal(h.room.store.state().ambient_at, now);
  assert.equal(h.room.store.counts().model, 1);

  assert.equal(h.receive("682", "新的公开消息，大家一起聊聊这个方案怎么样？"), "observed");
  const second = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 120000;
  await h.room.ambientOpportunityForTest(second.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);

  now = base + 270000;
  await h.room.ambientOpportunityForTest(second.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 2);
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  assert.equal(h.room.store.state().ambient_at, now);
  assert.equal(h.room.store.counts().model, 2);

  assert.equal(h.receive("683", "还有一个新的公开消息，大家觉得这个方案如何？"), "observed");
  const third = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 330000;
  await h.room.ambientOpportunityForTest(third.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 2);
  assert.equal(h.room.store.counts().model, 2);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
});

test("ambient planner is single-flight and the validated cursor suppresses repeats", async t => {
  const base = Date.parse("2026-11-18T04:00:00Z");
  let now = base;
  const pending = deferred<unknown>();
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 60000 } }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => pending.promise },
    model: { generate: async () => ({ kind: "reply", segments: ["unused"] }) },
  });
  assert.equal(h.receive("700", "/room mode ambient"), "control");
  assert.equal(h.receive("701", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  const first = h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await waitFor(() => h.ambientPlannerCalls.length === 1, "single-flight planner");
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  pending.resolve({ kind: "skip" });
  await first;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
});

test("ambient cursor survives reopen in room_meta and schema remains version 9", async t => {
  const root = mkdtempSync(join(tmpdir(), "pa-ambient-cursor-"));
  const file = join(root, "room.sqlite");
  const config = checkRoomConfig(roomConfig());
  let store = new RoomStore(file, config);
  assert.equal(store.schemaVersion(), 9);
  const contextKey = "a".repeat(64);
  store.recordAmbientCursor(contextKey, "technical_defer", Date.parse("2026-11-18T05:00:00Z"));
  store.close();
  store = new RoomStore(file, config);
  assert.equal(store.schemaVersion(), 9);
  assert.deepEqual(store.ambientCursor(), {
    contextKey,
    outcome: "technical_defer",
    updatedAt: Date.parse("2026-11-18T05:00:00Z"),
  });
  store.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
});

test("an active direct request blocks the ambient planner without spending another model row", async t => {
  const base = Date.parse("2026-11-18T06:00:00Z");
  let now = base;
  const direct = deferred<RoomLifecycleAnswer>();
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 1000, modelAttemptsPerHour: null } }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => ({ kind: "skip" }) },
    model: { generate: async () => direct.promise },
  });
  assert.equal(h.receive("800", "/room mode ambient"), "control");
  assert.equal(h.receive("801", "direct request", ["10002"]), "scheduled");
  await waitFor(() => h.prompts.length === 1, "direct generation");
  assert.equal(h.receive("802", "我今天终于跑通了离线测试，大家怎么看？"), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 2000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 0);
  assert.equal(h.room.store.counts().model, 1);
  direct.resolve({ kind: "reply", segments: ["direct reply"] });
  await h.room.whenIdle();
  assert.equal(h.dispatches.length, 1);
});

test("B4-04/B4-05 ambient group-question uses the real speaker batch, one character and one segment, and stale sends stay closed", async t => {
  const base = Date.parse("2026-11-19T00:00:00Z");
  let now = base;
  const first = deferred<RoomLifecycleAnswer>();
  const second = deferred<RoomLifecycleAnswer>();
  const generations: ReturnType<typeof deferred<RoomLifecycleAnswer>>[] = [first, second];
  let generationCall = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: {
        ambientMessages: 3,
        ambientPeople: 2,
        ambientQuietMs: 60000,
        ambientCooldownMs: 1,
        modelAttemptsPerHour: null,
      },
    }),
    deps: { now: () => now },
    ambientPlanner: {
      plan: async () => ({ kind: "join", characterIds: ["character-b", "character-a"] }),
    },
    model: { generate: async () => {
      const answer = generations[generationCall++];
      if (!answer) throw new Error("unexpected ambient generation");
      return answer.promise;
    } },
  });

  assert.equal(h.receive("900", "/room mode ambient"), "control");
  assert.equal(h.receive("901", "我先补充一个背景", [], { senderId: "20001" }), "observed");
  assert.equal(h.receive("902", "这个方向我觉得可行", [], { senderId: "20002" }), "observed");
  assert.equal(h.receive("903", "大家怎么看？", [], { senderId: "20003" }), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.room.workerStatusForTest().phase, "ready");
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.lifecycleRequests().length, 1);
  const queuedRequest = h.room.store.lifecycleRequests()[0]!;
  assert.ok(["queued", "generating"].includes(queuedRequest.status),
    JSON.stringify({ request: queuedRequest, turns: h.room.store.lifecycleTurns(queuedRequest.requestId) }));
  const requestSettled = () => {
    const request = h.room.store.lifecycleRequestById(queuedRequest.requestId)!;
    return !["queued", "generating", "delivering"].includes(request.status);
  };
  try {
    await waitFor(() => h.prompts.length >= 1 || h.room.workerStatusForTest().phase !== "ready"
      || requestSettled(), "group-question generation, settlement or Worker fault");
  } catch (error) {
    throw new Error(`${String(error)} ${JSON.stringify({ prompts: h.prompts.length,
      worker: h.room.workerStatusForTest(), request: h.room.store.lifecycleRequestById(queuedRequest.requestId),
      turns: h.room.store.lifecycleTurns(queuedRequest.requestId) })}`);
  }
  assert.equal(h.room.workerStatusForTest().phase, "ready", JSON.stringify(h.room.workerStatusForTest()));
  assert.equal(h.prompts.length, 1,
    JSON.stringify({ request: h.room.store.lifecycleRequestById(queuedRequest.requestId),
      turns: h.room.store.lifecycleTurns(queuedRequest.requestId) }));

  assert.equal(h.ambientPlannerCalls[0]!.anchor.text, "大家怎么看？");
  const firstRequest = h.room.store.lifecycleRequests()[0]!;
  const firstTurns = h.room.store.lifecycleTurns(firstRequest.requestId);
  assert.equal(firstTurns.length, 1);
  assert.equal(firstTurns[0]!.characterId, "character-a");
  assert.equal(firstRequest.admissionReason, "ambient_group_question");

  first.resolve({ kind: "reply", segments: ["这是唯一一条短回复", "第二条不能发送"] });
  await h.room.whenIdle();
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.dispatches[0]!.text, "这是唯一一条短回复");
  assert.equal(h.room.store.lifecycleSegments(firstTurns[0]!.turnId).length, 1);
  assert.equal(h.room.store.lifecycleTurns(firstRequest.requestId)[0]!.segmentCount, 1);
  assert.equal(h.room.store.lifecycleAudit().find(row => row.turnId === firstTurns[0]!.turnId)!.admissionReason,
    "ambient_group_question");

  assert.equal(h.receive("910", "又来一个背景消息", [], { senderId: "20001" }), "observed");
  assert.equal(h.receive("911", "这个补充也很重要", [], { senderId: "20002" }), "observed");
  assert.equal(h.receive("912", "大家觉得应该怎么处理？", [], { senderId: "20003" }), "observed");
  const staleAnchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now += 60000;
  await h.room.ambientOpportunityForTest(staleAnchor.id, QUEUE);
  await waitFor(() => h.prompts.length === 2, "stale candidate generation");
  const staleRequest = h.room.store.lifecycleRequests()
    .find(request => request.messageRowId === staleAnchor.id)!;

  assert.equal(h.receive("913", "新的消息已经改变话题", [], { senderId: "20004" }), "observed");
  second.resolve({ kind: "reply", segments: ["迟到回复"] });
  await h.room.whenIdle();
  await flush();
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.room.store.lifecycleRequestById(staleRequest.requestId)!.status, "cancelled");
  assert.equal(h.room.store.lifecycleRequestById(staleRequest.requestId)!.outcomeReason, "stale_anchor");
  assert.equal(h.room.store.lifecycleRequestById(staleRequest.requestId)!.admissionReason, "ambient_group_question");
  assert.equal(h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(staleRequest.requestId)[0]!.turnId).length, 0);
});

test("B4-04 an ambient batch explicitly aimed at another group member is rejected", async t => {
  const base = Date.parse("2026-11-19T01:00:00Z");
  let now = base;
  const notices: Array<Record<string, unknown>> = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientMessages: 3, ambientPeople: 2, ambientQuietMs: 60000 } }),
    deps: {
      now: () => now,
      onAmbientParticipation: notice => { notices.push(notice as unknown as Record<string, unknown>); },
    },
    ambientPlanner: {
      plan: async () => ({ kind: "join", characterIds: ["character-a"] }),
    },
    model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
  });

  assert.equal(h.receive("920", "/room mode ambient"), "control");
  assert.equal(h.receive("921", "我是禾，先确认一下时间。", [], { senderId: "21001" }), "observed");
  assert.equal(h.receive("922", "我们先收集大家的时间。", [], { senderId: "21002" }), "observed");
  assert.equal(h.receive("923", "禾，周六几点能开门？", [], { senderId: "21003" }), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);

  assert.equal(h.ambientPlannerCalls.length, 0);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.deepEqual(notices, [{ code: "ambient_rule_other-conversation", anchorRowId: anchor.id }]);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
});

test("Fix-4 R11 ambient address detects a self-introduced name after an address preamble", async t => {
  const base = Date.parse("2026-11-19T01:15:00Z");
  const cases = [
    { label: "请你", text: "请你问下禾：周六几点能开门？" },
    { label: "麻烦你", text: "麻烦你问下禾：周六几点能开门？" },
    { label: "劳驾你", text: "劳驾你问下禾：周六几点能开门？" },
    { label: "请帮我", text: "请帮我问下禾：周六几点能开门？" },
    { label: "麻烦帮我", text: "麻烦帮我问下禾：周六几点能开门？" },
    { label: "standalone 帮我", text: "帮我问下禾：周六几点能开门？" },
    { label: "麻烦您 and 帮忙", text: "麻烦您帮忙问下禾：周六几点能开门？" },
    { label: "zero-width characters and vertical colon", text: "请\u200B麻烦问下禾\u200B︰周六几点能开门？" },
    {
      label: "stacked connectors with Unicode whitespace and punctuation",
      text: "\u0085请\u200B、你\u00A0；帮我\u2060问下禾\u200B︰周六几点能开门？",
    },
    { label: "name that starts with an ask word", text: "请问问问：周六几点能开门？", member: "问问" },
    { label: "word joiner within the addressed name", text: "请帮我问下小\u2060禾：周六几点能开门？", member: "小禾" },
    { label: "word joiner within the polite request", text: "请帮\u2060我问下小禾：周六几点能开门？", member: "小禾" },
    { label: "word joiner within the introduced name", text: "请帮我问下小禾：周六几点能开门？", member: "小\u2060禾" },
  ];
  for (const { label, text, member = "禾" } of cases) {
    await t.test(label, async subtest => {
      let now = base;
      const notices: Array<Record<string, unknown>> = [];
      const h = await lifecycleHarness(subtest, {
        config: roomConfig({ limits: { ambientMessages: 3, ambientPeople: 2, ambientQuietMs: 60000 } }),
        deps: {
          now: () => now,
          onAmbientParticipation: notice => { notices.push(notice as unknown as Record<string, unknown>); },
        },
        ambientPlanner: { plan: async () => ({ kind: "join", characterIds: ["character-a"] }) },
        model: { generate: async () => ({ kind: "reply", segments: ["must not generate"] }) },
      });

      assert.equal(h.receive("925", "/room mode ambient"), "control");
      assert.equal(h.receive("926", `我叫${member}，今天第一个到场。`, [], { senderId: "21004" }), "observed");
      assert.equal(h.receive("927", "我也在等安排。", [], { senderId: "21005" }), "observed");
      assert.equal(h.receive("928", text, [], { senderId: "21006" }), "observed");
      const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
      now = base + 60000;
      await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
      await h.room.whenIdle();

      assert.equal(h.ambientPlannerCalls.length, 0);
      assert.equal(h.room.store.lifecycleRequests().length, 0);
      assert.deepEqual(notices, [{ code: "ambient_rule_other-conversation", anchorRowId: anchor.id }]);
      assert.equal(h.prompts.length, 0);
      assert.equal(h.dispatches.length, 0);
    });
  }
});

test("Fix-4 R11 ambient time prefix remains an open group question", async t => {
  const base = Date.parse("2026-11-19T01:20:00Z");
  const cases = [
    ["time prefix", "周六，几点能把展板搬进来？"],
    ["polite time question", "请问，周六几点开门？"],
    ["topic after a separated preamble", "麻烦\u0085问下、展板︰怎么摆更合适？"],
  ] as const;
  for (const [label, text] of cases) {
    await t.test(label, async subtest => {
      let now = base;
      const h = await lifecycleHarness(subtest, {
        config: roomConfig({ limits: { ambientMessages: 3, ambientPeople: 2, ambientQuietMs: 60000 } }),
        deps: { now: () => now },
        ambientPlanner: { plan: async () => ({ kind: "join", characterIds: ["character-a"] }) },
        model: { generate: async () => ({ kind: "reply", segments: ["周六上午可以。"] }) },
      });

      assert.equal(h.receive("929", "/room mode ambient"), "control");
      assert.equal(h.receive("930", "我叫禾，先确认一下流程。", [], { senderId: "21007" }), "observed");
      assert.equal(h.receive("931", "我们也在收集信息。", [], { senderId: "21008" }), "observed");
      assert.equal(h.receive("932", text, [], { senderId: "21009" }), "observed");
      const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
      now = base + 60000;
      await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
      await h.room.whenIdle();

      assert.equal(h.ambientPlannerCalls.length, 1);
      const request = h.room.store.lifecycleRequests().find(item => item.messageRowId === anchor.id)!;
      assert.equal(request.admissionReason, "ambient_group_question");
      assert.equal(h.dispatches.length, 1);
    });
  }
});

test("Fix-4 R12 reported script dialogue does not create a member identity", async t => {
  const base = Date.parse("2026-11-19T01:25:00Z");
  let now = base;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientMessages: 3, ambientPeople: 2, ambientQuietMs: 60000 } }),
    deps: { now: () => now },
    ambientPlanner: { plan: async () => ({ kind: "join", characterIds: ["character-a"] }) },
    model: { generate: async () => ({ kind: "reply", segments: ["后面还要补三项。"] }) },
  });

  assert.equal(h.receive("933", "/room mode ambient"), "control");
  assert.equal(h.receive("934", "我叫车石，负责守夜。（第 12 场开场对白）", [],
    { senderId: "21010" }), "observed");
  assert.equal(h.receive("935", "展会的流程表已经确认。", [], { senderId: "21011" }), "observed");
  assert.equal(h.receive("936", "车石，明早第一班车几点出发？", [], { senderId: "21012" }), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await h.room.whenIdle();

  assert.equal(h.ambientPlannerCalls.length, 1);
  const request = h.room.store.lifecycleRequests().find(item => item.messageRowId === anchor.id)!;
  assert.equal(request.admissionReason, "ambient_group_question");
  assert.equal(h.dispatches.length, 1);
});

for (const [timerDelay, label] of [[0, "exact"], [1, "delayed"]] as const) {
  test(`Fix-4 R4 ambient batch keeps earlier in-window speakers at ${label} quiet boundary`, async t => {
    const base = Date.parse("2026-11-19T01:30:00Z");
    let now = base;
    const h = await lifecycleHarness(t, {
      config: roomConfig({
        limits: {
          ambientMessages: 3,
          ambientPeople: 2,
          ambientQuietMs: 60000,
          ambientCooldownMs: 1,
          modelAttemptsPerHour: null,
        },
      }),
      deps: { now: () => now },
      ambientPlanner: {
        plan: async () => ({ kind: "join", characterIds: ["character-a"] }),
      },
      model: { generate: async () => ({ kind: "reply", segments: ["distinct timestamp reply"] }) },
    });

    assert.equal(h.receive(`870${timerDelay}01`, "/room mode ambient"), "control");
    now = base;
    assert.equal(h.receive(`870${timerDelay}02`, "先补充一点背景", [], { senderId: "26001" }), "observed");
    now = base + 1000;
    assert.equal(h.receive(`870${timerDelay}03`, "这里还有一个相关情况", [], { senderId: "26002" }), "observed");
    now = base + 2000;
    assert.equal(h.receive(`870${timerDelay}04`, "这个方案接下来到底怎么处理？", [], { senderId: "26003" }), "observed");
    const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
    now = anchor.createdAt! + 60000 + timerDelay;
    await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
    await h.room.whenIdle();

    assert.equal(h.ambientPlannerCalls.length, 1);
    const request = h.room.store.lifecycleRequests().find(item => item.messageRowId === anchor.id)!;
    assert.equal(request.admissionReason, "ambient_group_question");
    assert.equal(h.room.store.lifecycleTurns(request.requestId).length, 1);
    assert.equal(h.dispatches.length, 1);
  });
}

test("Fix-4 R5 ambient message threshold shares the history page cap", () => {
  assert.doesNotThrow(() => checkRoomConfig(roomConfig({
    limits: { ambientMessages: ROOM_HISTORY_PAGE_LIMIT, ambientPeople: 2 },
  })));
  assert.throws(() => checkRoomConfig(roomConfig({
    limits: { ambientMessages: ROOM_HISTORY_PAGE_LIMIT + 1, ambientPeople: 2 },
  })), /room-limit-invalid/);
});

test("B4-06 member quota counts direct attempts only and preserves duplicate and N-boundary semantics", async t => {
  const base = Date.parse("2026-11-19T02:00:00Z");
  let now = base;
  const policy: RoomQueuePolicy = { capacity: 20, memberLimit: 3, memberWindowMs: 1000, ttlMs: 10000 };
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { ambientQuietMs: 60000, modelAttemptsPerHour: null } }),
    deps: { now: () => now },
    model: { generate: async () => ({ kind: "reply", segments: ["direct reply"] }) },
  });
  const receive = (messageId: string, text: string, mentions: readonly string[] = []) =>
    h.room.receiveLifecycle(roomInput(messageId, text, mentions, { senderId: "22001" }), policy);

  assert.equal(h.receive("930", "/room mode ambient"), "control");
  for (let index = 0; index < 7; index++) {
    assert.equal(receive(String(931 + index), `普通群聊观察 ${index}`), "observed");
  }
  assert.equal(receive("940", "第一次明确请求", ["10002"]), "scheduled");
  assert.equal(receive("941", "第二次明确请求", ["10002"]), "scheduled");
  assert.equal(receive("940", "第一次明确请求", ["10002"]), "duplicate");
  assert.equal(receive("942", "第三次明确请求", ["10002"]), "scheduled");
  assert.equal(receive("944", "第四次明确请求", ["10002"]), "rejected");
  await h.room.whenIdle();

  now = base + 1000;
  assert.equal(receive("945", "窗口边界后的直接请求", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(h.dispatches.length, 4);
});

test("B4-07 ambient evaluation never consumes the final model row reserved for a direct request", async t => {
  const base = Date.parse("2026-11-19T02:30:00Z");
  let now = base;
  const notices: Array<Record<string, unknown>> = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientMessages: 3, ambientPeople: 2, ambientQuietMs: 60000, modelAttemptsPerHour: 1 },
    }),
    deps: {
      now: () => now,
      onAmbientParticipation: notice => { notices.push(notice as unknown as Record<string, unknown>); },
    },
    ambientPlanner: {
      plan: async () => ({ kind: "join", characterIds: ["character-a"] }),
    },
    model: { generate: async () => ({ kind: "reply", segments: ["direct final row"] }) },
  });

  assert.equal(h.receive("946", "/room mode ambient"), "control");
  assert.equal(h.receive("947", "先看一个公开背景", [], { senderId: "24001" }), "observed");
  assert.equal(h.receive("948", "这里还有一个补充", [], { senderId: "24002" }), "observed");
  assert.equal(h.receive("949", "大家怎么看？", [], { senderId: "24003" }), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await h.room.whenIdle();

  assert.equal(h.ambientPlannerCalls.length, 0);
  assert.equal(h.room.store.counts().model, 0);
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.room.workerStatusForTest().phase, "ready");
  assert.ok(notices.some(notice => notice.code === "ambient_rule_budget"));

  assert.equal(h.receive("955", "真实明确请求", ["10002"], { senderId: "24001" }), "scheduled");
  await waitFor(() => h.dispatches.length === 1, "direct request uses the final model row");
  await h.room.whenIdle();
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.dispatches[0]!.text, "direct final row");
  assert.equal(h.room.workerStatusForTest().phase, "ready");
});

test("B4-07 ambient planner and generation reserve the final model row for a direct request", async t => {
  const base = Date.parse("2026-11-19T03:00:00Z");
  let now = base;
  const notices: Array<Record<string, unknown>> = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientMessages: 3, ambientPeople: 2, ambientQuietMs: 60000,
        ambientCooldownMs: 1, modelAttemptsPerHour: 2 },
    }),
    deps: {
      now: () => now,
      onAmbientParticipation: notice => { notices.push(notice as unknown as Record<string, unknown>); },
    },
    ambientPlanner: {
      plan: async () => ({ kind: "join", characterIds: ["character-a"] }),
    },
    model: {
      generate: async prompt => prompt.systemPrompt.includes("主动参与的候选回复")
        ? { kind: "reply", segments: ["ambient must not consume the reserve"] }
        : { kind: "reply", segments: ["direct reply wins the final row"] },
    },
  });

  assert.equal(h.receive("950", "/room mode ambient"), "control");
  assert.equal(h.receive("951", "先看一个公开背景", [], { senderId: "23001" }), "observed");
  assert.equal(h.receive("952", "这里还有一个补充", [], { senderId: "23002" }), "observed");
  assert.equal(h.receive("953", "大家怎么看？", [], { senderId: "23003" }), "observed");
  const anchor = h.room.store.historyPage(50).filter(row => row.speakerType === "user").at(-1)!;
  now = base + 60000;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  await h.room.whenIdle();

  const ambientRequest = h.room.store.lifecycleRequests()[0]!;
  const ambientTurn = h.room.store.lifecycleTurns(ambientRequest.requestId)[0]!;
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
  assert.equal(ambientTurn.status, "skipped");
  assert.equal(ambientTurn.reason, "ambient_model_budget_deferred");
  assert.equal(h.room.store.ambientCursor()?.outcome, "technical_defer");
  assert.equal(h.room.workerStatusForTest().phase, "ready");
  assert.ok(notices.some(notice => notice.code === "ambient_model_budget_deferred"));

  assert.equal(h.receive("954", "真实明确请求", ["10002"], { senderId: "23001" }), "scheduled");
  await waitFor(() => h.dispatches.length === 1, "reserved direct request delivery");
  await h.room.whenIdle();
  assert.equal(h.room.store.counts().model, 2);
  assert.equal(h.dispatches[0]!.text, "direct reply wins the final row");
  assert.equal(h.room.workerStatusForTest().phase, "ready");
});

test("Owner /room pause remains fail-closed for ordinary ingress", async t => {
  const root = mkdtempSync(join(tmpdir(), "pa-owner-pause-"));
  const forbidden = async (): Promise<never> => { throw new Error("synthetic-legacy-forbidden"); };
  const room = new VoiceRoom(join(root, "room.sqlite"), checkRoomConfig(roomConfig()), {
    now: () => Date.parse("2026-11-18T07:00:00Z"),
    persona: character => `# ${character.name}\nSynthetic public persona.`,
    generate: forbidden,
    synthesize: forbidden,
    sendText: forbidden,
    sendAudio: forbidden,
    permitsText: () => true,
  });
  t.after(async () => {
    await room.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const character of room.config.characters) room.setOnline(character.accountKey, true);
  assert.equal(room.receive(roomInput("900", "/room pause")), "control");
  assert.equal(room.store.state().paused, 1);
  assert.equal(room.receive(roomInput("901", "ordinary message", ["10002"])), "paused");
});

function qqWorkerSettings(root: string, config = roomConfig()): RoomQqSettings {
  return {
    room: checkRoomConfig(config),
    dataDir: root,
    port: 0,
    apiTimeoutMs: 1000,
    accounts: [
      { accountKey: "account-a", token: "synthetic-production-token-a", personaFile: "unused-a" },
      { accountKey: "account-b", token: "synthetic-production-token-b", personaFile: "unused-b" },
    ],
    execution: "worker",
    workerQueue: QUEUE,
    closePolicy: { observationCapacity: 32, perAccountCapacity: 16, drainMs: 100, releaseMs: 100, writeWaitMs: 50 },
  };
}

async function qqWorkerFixture(t: TestContext, settings: RoomQqSettings,
  lifecycleModel: RoomLifecycleWorker["model"], voice?: { synthesize: RoomDependencies["synthesize"] }) {
  const notices: RoomQqNotice[] = [];
  const media: string[] = [];
  const sockets: WebSocket[] = [];
  let messageId = 880000;
  let bridge: Awaited<ReturnType<typeof startRoomQq>> | undefined;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await bridge?.close();
    rmSync(settings.dataDir, { recursive: true, force: true });
  });
  const started = bridge = await startRoomQq(settings, {
    persona: character => `# ${character.name}\nSynthetic public persona.`,
    permitsText: () => true,
    permitsPrompt: () => true,
    lifecycleModel,
  }, notice => notices.push(notice), voice);
  const open = async (index: number) => {
    const { accountKey, token } = settings.accounts[index]!;
    const { selfId } = settings.room.characters[index]!;
    const socket = new WebSocket(`${started.url}/room/${accountKey}`, { headers: {
      "x-client-role": "Universal", "x-self-id": selfId, Authorization: `Bearer ${token}`,
    } });
    sockets.push(socket);
    socket.on("message", raw => {
      let value: any;
      try { value = JSON.parse(raw.toString()); } catch { return; }
      if (value && typeof value.echo === "string" && typeof value.action === "string") {
        if (value.action === "send_group_msg") media.push(value.params.message[0].type);
        socket.send(JSON.stringify({ echo: value.echo, status: "ok", retcode: 0,
          data: { message_id: String(++messageId) } }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  };
  const send = (socket: WebSocket, id: string, text: string, mentions: readonly string[] = []) => socket.send(JSON.stringify({
    post_type: "message", message_type: "group", sub_type: "normal",
    self_id: "10002", group_id: "10000", user_id: "10001", message_id: id,
    message: [...mentions.map(qq => ({ type: "at", data: { qq } })), { type: "text", data: { text } }],
  }));
  return { bridge: started, open, send, media, notices };
}

test("production startRoomQq wires the ambient planner into the lifecycle FIFO", async t => {
  const root = mkdtempSync(join(tmpdir(), "pa-production-ambient-"));
  let plannerCalls = 0;
  let lifecycleCalls = 0;
  const settings = qqWorkerSettings(root, roomConfig({ limits: { ambientQuietMs: 100, ambientCooldownMs: 1000 } }));
  const { bridge, open, send } = await qqWorkerFixture(t, settings, {
    generate: async prompt => {
      if (prompt.systemPrompt.includes("Ambient 参与度规划器")) {
        plannerCalls++;
        return { kind: "reply", segments: [JSON.stringify({ kind: "join", characterIds: ["character-a"] })] };
      }
      lifecycleCalls++;
      return { kind: "reply", segments: ["production ambient reply"] };
    },
  });
  const peerA = await open(0);
  await open(1);
  await waitFor(() => bridge.room.ready && bridge.status().online === 2,
    "production lifecycle worker ready", 5000);
  send(peerA, "880001", "/room mode ambient");
  await waitFor(() => bridge.room.store.lifecycleControlState().mode === "ambient", "ambient mode", 5000);
  send(peerA, "880002", "我今天终于跑通了离线测试，大家怎么看？");
  await waitFor(() => plannerCalls === 1 && bridge.room.store.lifecycleRequests().length === 1,
    "production ambient opportunity", 5000);
  await waitFor(() => bridge.room.store.lifecycleRequests()[0]?.status === "completed",
    "production ambient lifecycle completion", 5000);
  assert.equal(lifecycleCalls, 1);
  assert.equal(bridge.room.store.counts().model, 2);
  const request = bridge.room.store.lifecycleRequests()[0]!;
  const turn = bridge.room.store.lifecycleTurns(request.requestId)[0]!;
  assert.equal(bridge.room.store.lifecycleSegments(turn.turnId)[0]!.text, "production ambient reply");
});

const QQ_WORKER_REPLY: RoomLifecycleWorker["model"] = {
  generate: async () => ({ kind: "reply", segments: ["synthetic-worker-reply-canary"] }),
};
const QQ_WORKER_TTS = { synthesize: async () => new Uint8Array([0x49, 0x44, 0x33, 0]) };
const QQ_WORKER_MODE_ERROR = /deliveryMode.*text.*both/;

for (const mode of ["voice", "auto"] as const) {
  test(`B2-04 ${mode} is rejected by settings and the bridge before startup`, async t => {
    const root = mkdtempSync(join(tmpdir(), "pa-unsupported-worker-mode-"));
    const settings = qqWorkerSettings(root, roomConfig({ deliveryMode: mode }));
    const fixture = qqWorkerConfigFixture(t, mode);
    await t.test("server entry", async nested => {
      await assert.rejects(async () => { await qqWorkerFixture(nested, settings, QQ_WORKER_REPLY, QQ_WORKER_TTS); },
        QQ_WORKER_MODE_ERROR);
      assert.equal(existsSync(join(root, "room.sqlite")), false);
    });
    await t.test("settings reader", () => {
      assert.throws(() => readRoomQqSettings(fixture.file, fixture.env), QQ_WORKER_MODE_ERROR);
    });
  });
}

function qqWorkerConfigFixture(t: TestContext, deliveryMode: RoomConfig["deliveryMode"]) {
  const root = mkdtempSync(join(tmpdir(), "pa-worker-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "room.json");
  const env = { ROOM_QQ_A_TOKEN: "synthetic-token-a-canary", ROOM_QQ_B_TOKEN: "synthetic-token-b-canary" };
  const config = roomConfig({ deliveryMode });
  const characters = config.characters.map((character, index) => {
    const personaFile = `public-${index}.md`;
    return { ...character, personaFile, tokenEnv: index === 0 ? "ROOM_QQ_A_TOKEN" : "ROOM_QQ_B_TOKEN" };
  });
  writeFileSync(file, JSON.stringify({ ...config, characters, dataDir: ".", port: 38437,
    execution: "worker", workerQueue: QUEUE }));
  return { file, env };
}

for (const mode of ["text", "both"] as const) {
  for (const tts of [false, true]) {
    test(`B2-04 ${mode} with TTS ${tts} reports effective mode and sends the expected media`, async t => {
      const root = mkdtempSync(join(tmpdir(), "pa-effective-worker-mode-"));
      const settings = qqWorkerSettings(root, roomConfig({ deliveryMode: mode }));
      const { bridge, media, open, send } = await qqWorkerFixture(t, settings, QQ_WORKER_REPLY,
        tts ? QQ_WORKER_TTS : undefined);
      const fixture = qqWorkerConfigFixture(t, mode);
      const expectedMode = mode === "both" && tts ? "both" : "text";
      assert.equal(readRoomQqSettings(fixture.file, fixture.env).room.deliveryMode, mode);
      const peerA = await open(0);
      await open(1);
      await waitFor(() => bridge.room.ready, "worker ready");
      send(peerA, "880005", "synthetic mention", ["10002"]);
      await waitFor(() => bridge.room.store.lifecycleRequests()[0]?.status === "completed", "direct mention completed");
      assert.deepEqual(media, expectedMode === "both" ? ["text", "record"] : ["text"]);
      assert.equal(bridge.status().deliveryMode, expectedMode);
      assert.partialDeepStrictEqual(bridge.status(), { worker: {
        configuredDeliveryMode: mode, effectiveDeliveryMode: expectedMode, audioCapable: expectedMode === "both",
        audioBlockReason: expectedMode === "both" ? null : mode === "text" ? "text_mode" : "tts_unavailable",
      } });
    });
  }
}

for (const storedMode of ["text", "both"] as const) {
  test(`B2-04 omitting deliveryMode preserves stored ${storedMode} with TTS`, async t => {
    const root = mkdtempSync(join(tmpdir(), "pa-stored-worker-mode-"));
    const settings = qqWorkerSettings(root, roomConfig({ deliveryMode: undefined }));
    const store = new RoomStore(join(root, "room.sqlite"), settings.room, { lifecycle: "connection" });
    try { store.setDeliveryMode(storedMode); } finally { store.close(); }
    let synthesisCalls = 0;
    const { bridge, media, open, send } = await qqWorkerFixture(t, settings, QQ_WORKER_REPLY, {
      synthesize: async () => {
        synthesisCalls++;
        return QQ_WORKER_TTS.synthesize();
      },
    });
    const initialMode = bridge.room.store.deliveryMode();
    const peerA = await open(0);
    await open(1);
    await waitFor(() => bridge.room.ready, "worker ready from stored mode");
    send(peerA, "880007", "synthetic mention with stored mode", ["10002"]);
    await waitFor(() => bridge.room.store.lifecycleRequests()[0]?.status === "completed", "stored-mode mention completed");
    assert.deepEqual({ initialMode, media, synthesisCalls }, {
      initialMode: storedMode, media: storedMode === "text" ? ["text"] : ["text", "record"],
      synthesisCalls: storedMode === "text" ? 0 : 1,
    });
    assert.equal(bridge.room.store.deliveryMode(), storedMode);
    assert.partialDeepStrictEqual(bridge.status(), { worker: {
      configuredDeliveryMode: null, effectiveDeliveryMode: storedMode,
      audioBlockReason: storedMode === "text" ? "text_mode" : null,
    } });
  });
}

test("B2-04 omitting deliveryMode rejects an unsupported stored mode with TTS before listening", async t => {
  const root = mkdtempSync(join(tmpdir(), "pa-unsupported-stored-worker-mode-"));
  const settings = qqWorkerSettings(root, roomConfig({ deliveryMode: undefined }));
  const store = new RoomStore(join(root, "room.sqlite"), settings.room, { lifecycle: "connection" });
  try { store.setDeliveryMode("voice"); } finally { store.close(); }
  await assert.rejects(async () => { await qqWorkerFixture(t, settings, QQ_WORKER_REPLY, QQ_WORKER_TTS); },
    QQ_WORKER_MODE_ERROR);
  assert.equal(existsSync(join(root, "room.sqlite.worker.lock")), false);
  const persisted = new RoomStore(join(root, "room.sqlite"), settings.room, { lifecycle: "connection" });
  try { assert.equal(persisted.deliveryMode(), "voice"); } finally { persisted.close(); }
});

test("B2-05 bridge status follows connectivity and pause while an old audio fence leaves text available", async t => {
  const config = roomConfig({ deliveryMode: "both" });
  const h = await lifecycleHarness(t, {
    config, model: QQ_WORKER_REPLY,
    dispatch: async request => {
      request.beforeSend();
      if (request.medium === "audio") return new Promise<string>(() => {});
      await request.observe({ kind: "ack", messageId: "880011" });
      request.released();
      return "880011";
    },
  });
  assert.equal(h.receive("880010", "synthetic-fence-ingress-canary", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleAudioFence() !== null, "audio fence persisted");
  const oldFence = h.room.store.lifecycleAudioFence();
  await h.room.close();
  const root = mkdtempSync(join(tmpdir(), "pa-worker-status-"));
  copyFileSync(join(h.root, "room.sqlite"), join(root, "room.sqlite"));
  const { bridge, media, notices, open, send } = await qqWorkerFixture(t, qqWorkerSettings(root, config),
    QQ_WORKER_REPLY, QQ_WORKER_TTS);
  const initial = bridge.status();
  const peerA = await open(0);
  const oneAccount = bridge.status();
  const peerB = await open(1);
  await waitFor(() => bridge.room.ready, "worker ready");
  const ready = bridge.status();
  assert.equal(bridge.control("pause", roomInput("880012", "/room pause")).kind, "applied");
  const paused = bridge.status();
  assert.equal(bridge.control("resume", roomInput("880013", "/room resume")).kind, "applied");
  send(peerA, "880014", "synthetic-fence-next-ingress-canary", ["10002"]);
  await waitFor(() => bridge.room.store.lifecycleRequests()[1]?.status === "completed", "text through old audio fence");
  assert.deepEqual(media, ["text"]);
  assert.equal(bridge.room.store.lifecycleAudioFence(), oldFence);
  assert.partialDeepStrictEqual(initial, { online: 0, worker: { connectedAccountCount: 0, phase: "starting",
    ingressReady: false, textCanProgress: false, audioBlockReason: "audio_result_unknown" } });
  assert.partialDeepStrictEqual(oneAccount, { online: 1, worker: { connectedAccountCount: 1, phase: "starting",
    ingressReady: false, textCanProgress: false } });
  assert.partialDeepStrictEqual(ready, { online: 2, worker: { connectedAccountCount: 2, phase: "ready",
    paused: false, ingressReady: true, textCanProgress: true, audioBlockReason: "audio_result_unknown" } });
  assert.partialDeepStrictEqual(paused, { worker: { phase: "ready", paused: true, ingressReady: false,
    textCanProgress: false, audioBlockReason: "audio_result_unknown" } });
  await waitFor(() => notices.some(notice => String(notice.type) === "runtime-status"
    && Reflect.get(notice, "status")?.textCanProgress), "owner-facing ready status notice");
  peerB.terminate();
  await waitFor(() => bridge.status().online === 1, "peer disconnected");
  assert.partialDeepStrictEqual(bridge.status(), { worker: { connectedAccountCount: 1, phase: "ready",
    ingressReady: false, textCanProgress: false, audioBlockReason: "audio_result_unknown" } });
  const statusNotices = notices.filter(notice => String(notice.type) === "runtime-status");
  assert.doesNotMatch(JSON.stringify(statusNotices), /canary|account-a|account-b|1000[0-3]/);
  assert.ok(!JSON.stringify(statusNotices).includes(oldFence!));
});

test("B2-05 bridge status distinguishes worker fault from full account connectivity", async t => {
  const root = mkdtempSync(join(tmpdir(), "pa-worker-status-fault-"));
  const { bridge, notices, open } = await qqWorkerFixture(t, qqWorkerSettings(root), QQ_WORKER_REPLY);
  bridge.room.store.recoverLifecycle = () => { throw new Error("synthetic-worker-fault-canary"); };
  await open(0);
  await open(1);
  await waitFor(() => bridge.room.workerStatusForTest().phase === "faulted", "worker startup faulted");
  assert.partialDeepStrictEqual(bridge.status(), { online: 2, worker: { connectedAccountCount: 2,
    phase: "faulted", ingressReady: false, textCanProgress: false, faultReason: "room-lifecycle-startup-failed" } });
  await waitFor(() => notices.some(notice => String(notice.type) === "runtime-status"
    && Reflect.get(notice, "status")?.phase === "faulted"), "owner-facing fault status notice");
  assert.doesNotMatch(JSON.stringify(notices), /synthetic-worker-fault-canary/);
});

test("TTS failure after an acknowledged text segment settles the segment text-only, not failed", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken text"] }) },
    synthesize: async () => { throw new Error("fish-tts-network"); },
  });
  assert.equal(h.receive("90", "speak", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed",
    "text-only fallback completion");
  const request = h.room.store.lifecycleRequests()[0]!;
  const segment = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId)[0]!;
  assert.equal(segment.state, "completed");
  assert.equal(segment.reason, "tts_text_only_fish-tts-network");
  assert.equal(request.outcomeReason, "tts_text_only_fish-tts-network");
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text"]);
});

test("TTS failure without an acknowledged text segment still settles the segment failed", async t => {
  let textAttempts = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken text"] }) },
    synthesize: async () => { throw new Error("fish-tts-network"); },
    dispatch: async (request) => {
      if (request.medium === "text" && ++textAttempts === 1) throw new Error("transport_rejected");
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: "880001" });
      request.released();
      return "880001";
    },
  });
  assert.equal(h.receive("91", "speak", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "failed", "text failure");
  const request = h.room.store.lifecycleRequests()[0]!;
  const segment = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId)[0]!;
  assert.notEqual(segment.state, "completed");
  assert.ok(segment.state === "failed" || segment.state === "unknown");
});

test("a text-only fallback does not block the following segment", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["first", "second"] }) },
    synthesize: async () => { throw new Error("fish-tts-network"); },
  });
  assert.equal(h.receive("92", "speak", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed", "both segments");
  const request = h.room.store.lifecycleRequests()[0]!;
  const segments = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId);
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.equal(segment.state, "completed");
    assert.equal(segment.reason, "tts_text_only_fish-tts-network");
  }
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text", "text"]);
});

test("an overlong TTS failure code degrades to the bare text-only reason", async t => {
  const longCode = "tts_" + "x".repeat(76);
  assert.equal(longCode.length, 80);
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken text"] }) },
    synthesize: async () => { throw new Error(longCode); },
  });
  assert.equal(h.receive("93", "speak", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed", "degraded completion");
  const request = h.room.store.lifecycleRequests()[0]!;
  const segment = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId)[0]!;
  assert.equal(segment.state, "completed");
  assert.equal(segment.reason, "tts_text_only");
  assert.equal(request.outcomeReason, "tts_text_only");
});

test("a text-only fallback keeps the TTS cause visible at request level", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken text"] }) },
    synthesize: async () => { throw new Error("fish-tts-network"); },
  });
  assert.equal(h.receive("94", "speak", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed", "fallback completion");
  const request = h.room.store.lifecycleRequests()[0]!;
  assert.equal(request.outcomeReason, "tts_text_only_fish-tts-network");
});

test("a successful second segment after a text-only fallback still delivers audio", async t => {
  let synthCalls = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["first", "second"] }) },
    synthesize: async () => {
      synthCalls++;
      if (synthCalls === 1) throw new Error("fish-tts-network");
      return new Uint8Array([4, 5, 6]);
    },
  });
  assert.equal(h.receive("95", "speak", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed", "mixed completion");
  const request = h.room.store.lifecycleRequests()[0]!;
  const segments = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]!.state, "completed");
  assert.equal(segments[0]!.reason, "tts_text_only_fish-tts-network");
  assert.equal(segments[1]!.state, "completed");
  assert.equal(segments[1]!.reason, null);
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text", "text", "audio"]);
});

test("pausing while audio synthesis is in flight never settles the segment text-only", async t => {
  let synthesisStarted = false;
  let synthesisCalls = 0;
  let rejectAudio!: (error: Error) => void;
  const audio = new Promise<Uint8Array>((_, reject) => { rejectAudio = reject; });
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken text"] }) },
    synthesize: async () => {
      synthesisCalls++;
      if (synthesisCalls === 1) {
        synthesisStarted = true;
        return audio;
      }
      throw new Error("fish-tts-network");
    },
  });
  assert.equal(h.receive("96", "speak", ["10002"]), "scheduled");
  await waitFor(() => synthesisStarted, "TTS start");

  h.room.store.setPaused(true);
  rejectAudio(new Error("fish-tts-network"));
  await h.room.whenIdle();

  const request = h.room.store.lifecycleRequests()[0]!;
  const segment = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId)[0]!;
  assert.equal(segment.state, "text_sent", JSON.stringify({ status: request.status, outcome: request.outcomeReason,
    state: segment.state, reason: segment.reason, audit: h.room.store.lifecycleAudit() }));
  assert.equal(segment.reason, null);
  assert.notEqual(request.status, "completed");
  assert.notEqual(request.outcomeReason, "tts_text_only_fish-tts-network");
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text"]);

  h.room.store.setPaused(false);
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed", "resumed fallback");
  const resumed = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId)[0]!;
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.reason, "tts_text_only_fish-tts-network");
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text"]);
  assert.equal(synthesisCalls, 2);
});

test("losing the lifecycle owner during audio synthesis never settles the segment text-only", async t => {
  let synthesisStarted = false;
  let rejectAudio!: (error: Error) => void;
  const audio = new Promise<Uint8Array>((_, reject) => { rejectAudio = reject; });
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken text"] }) },
    synthesize: async () => {
      synthesisStarted = true;
      return audio;
    },
  });
  assert.equal(h.receive("97", "speak", ["10002"]), "scheduled");
  await waitFor(() => synthesisStarted, "TTS start");
  assert.equal(h.dispatches.map(item => item.medium).join(","), "text");

  const control = h.room.store.lifecycleControlState();
  h.room.store.initializeLifecycleControl(control.epoch, Date.parse("2026-11-13T00:00:00Z"), "replacement-owner",
    Date.parse("2026-11-13T00:10:00Z"));
  rejectAudio(new Error("fish-tts-network"));
  await h.room.whenIdle();

  const request = h.room.store.lifecycleRequests()[0]!;
  const segment = h.room.store.lifecycleSegments(h.room.store.lifecycleTurns(request.requestId)[0]!.turnId)[0]!;
  assert.notEqual(segment.state, "completed", JSON.stringify({ status: request.status, outcome: request.outcomeReason,
    state: segment.state, reason: segment.reason }));
  assert.equal(segment.reason?.startsWith("tts_text_only") ?? false, false);
  assert.notEqual(request.status, "completed");
  assert.equal(request.outcomeReason?.startsWith("tts_text_only") ?? false, false);
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text"]);
});

test("send budget exhaustion settles only the limited sends and keeps the worker accepting the next request", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  let sent = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both", limits: { turnsPerMinute: 6 } }),
    model: { generate: async () => ({ kind: "reply", segments: ["budget one", "budget two"] }) },
    deps: { now: () => now },
    dispatch: async request => {
      request.beforeSend();
      const id = String(800000 + ++sent);
      await request.observe({ kind: "ack", messageId: id });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      return id;
    },
  });
  assert.equal(h.receive("100", "both", ["10002", "10003"]), "scheduled");
  await h.room.whenIdle();

  const first = h.room.store.lifecycleRequests()[0]!;
  assert.equal(h.room.store.counts().send, 6, "the six-send window is the hard limit");
  assert.equal(sent, 6, "the transport sees exactly the budgeted attempts");
  assert.equal(first.status, "failed");
  assert.equal(h.room.workerStatusForTest().phase, "ready", "a send quota stop is not a worker fault");
  assert.equal(h.room.workerStatusForTest().lastError, null);
  assert.equal(first.outcomeReason, "send_budget_exhausted");

  const limited = h.room.store.lifecycleAudit().filter(row => row.segmentStatus === "blocked");
  assert.ok(limited.length >= 1, "the unstarted remainder stays unsent");
  assert.ok(limited.every(row => row.segmentReason === "send_budget_exhausted"), JSON.stringify(limited));

  now += 61_000;
  sent = 0;
  assert.equal(h.receive("101", "next", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(sent, 4, "two segments of text and audio send after the window");
  assert.equal(h.room.store.lifecycleRequests()[1]!.status, "completed");
});

test("send budget exhaustion on audio keeps an acknowledged text as delivered text-only", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both", limits: { turnsPerMinute: 3 } }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken one", "spoken two"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = String(810000 + (request.medium === "audio" ? 1 : 0));
      await request.observe({ kind: "ack", messageId: id });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      return id;
    },
  });
  assert.equal(h.receive("110", "speak", ["10002"]), "scheduled");
  await h.room.whenIdle();

  const request = h.room.store.lifecycleRequests()[0]!;
  const turn = h.room.store.lifecycleTurns(request.requestId)[0]!;
  const segments = h.room.store.lifecycleSegments(turn.turnId);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]!.state, "completed", "first segment delivered text and audio");
  assert.equal(segments[0]!.reason, null);
  assert.equal(segments[1]!.state, "completed", "second segment keeps its acknowledged text");
  assert.equal(segments[1]!.reason, "tts_text_only_send_budget");
  assert.equal(h.room.store.counts().send, 3, "only the three budgeted sends start");
  assert.equal(h.room.workerStatusForTest().phase, "ready");
  assert.equal(request.outcomeReason, "tts_text_only_send_budget");
});
test("an expiring head request leaves the queue instead of rewriting the same intent", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  const intents: string[] = [];
  let dispatchCount = 0;
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["expires one", "expires two"] }) },
    deps: { now: () => now },
    dispatch: async request => {
      dispatchCount++;
      if (dispatchCount === 1) {
        request.beforeSend();
        await request.observe({ kind: "ack", messageId: "820001" });
        request.released();
        now += QUEUE.ttlMs + 1000;
        return "820001";
      }
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: "820002" });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      return "820002";
    },
  });
  const store = h.room.store as unknown as {
    recordLifecycleIntent(segmentId: string, medium: "text" | "audio", ownerToken: string, now: number): unknown;
  };
  const original = store.recordLifecycleIntent.bind(h.room.store);
  store.recordLifecycleIntent = (segmentId, medium, ownerToken, at) => {
    intents.push(segmentId + ":" + medium);
    return original(segmentId, medium, ownerToken, at);
  };

  assert.equal(h.receive("120", "expire", ["10002"]), "scheduled");
  await h.room.whenIdle();

  const request = h.room.store.lifecycleRequests()[0]!;
  assert.equal(request.outcomeReason, "ttl_expired", JSON.stringify(request));
  assert.equal(request.status, "cancelled", "the existing expiry path settles the remainder as cancelled");
  assert.equal(intents.filter(entry => entry.endsWith(":text")).length, 1,
    "the second segment never records a fresh intent after expiry: " + JSON.stringify(intents));
  const turn = h.room.store.lifecycleTurns(request.requestId)[0]!;
  const segments = h.room.store.lifecycleSegments(turn.turnId);
  assert.equal(segments[0]!.state, "completed", "the acknowledged receipt stays delivered");
  assert.equal(h.room.workerStatusForTest().phase, "ready");
  assert.equal(h.room.store.lifecycleHeadRequest(), null, "the expired head leaves the FIFO");
});

test("a request that expires before its first intent still leaves the queue", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  let dispatchCount = 0;
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["late"] }) },
    deps: { now: () => now },
    dispatch: async request => {
      dispatchCount++;
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: "830001" });
      request.released();
      return "830001";
    },
  });
  assert.equal(h.receive("121", "expire early", ["10002"]), "scheduled");
  now += QUEUE.ttlMs + 1000;
  await h.room.whenIdle();
  assert.equal(dispatchCount, 0, "no send starts after expiry");
  const request = h.room.store.lifecycleRequests()[0]!;
  assert.notEqual(request.status, "delivering", JSON.stringify(request));
  assert.equal(request.outcomeReason, "ttl_expired");
  assert.equal(h.room.store.lifecycleHeadRequest(), null);
});
test("a persistent fence read fault on the audio path faults the worker instead of parking it", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["fence fault"] }) },
  });
  const store = h.room.store as unknown as {
    lifecycleAudioFenceInfo(): unknown;
  };
  // The audio path reads the fence before recording an intent. A read fault
  // that does not clear must surface as a worker fault, never as a silent
  // "no progress" exit that leaves the worker reporting `ready`.
  store.lifecycleAudioFenceInfo = () => { throw new Error("simulated-fence-read-fault"); };

  assert.equal(h.receive("160", "fence fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready", "worker faults on the read error", 4000);

  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a persistent storage read fault must fault the worker: " + JSON.stringify(status));
  assert.ok(typeof status.lastError === "string" && status.lastError.length > 0,
    "the fault is reported: " + JSON.stringify(status));
});

test("a storage fault while settling a send-budget stop faults the worker instead of parking the request", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ limits: { turnsPerMinute: 1 } }),
    model: { generate: async () => ({ kind: "reply", segments: ["first", "second"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = String(880000 + Math.floor(Math.random() * 1000));
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });
  // Fail only the settlement write, leaving the budget rejection itself intact.
  const store = h.room.store as unknown as {
    finishLifecycleSegment(...args: unknown[]): void;
  };
  const original = store.finishLifecycleSegment.bind(h.room.store);
  let injected = false;
  store.finishLifecycleSegment = (...args: unknown[]) => {
    if (!injected) { injected = true; throw new Error("simulated-storage-fault"); }
    return original(...args);
  };

  assert.equal(h.receive("150", "budget fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready"
    || h.room.store.lifecycleHeadRequest() === null, "budget settlement outcome", 4000);

  assert.equal(injected, true, "the settlement write was reached");
  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a real storage fault must not be swallowed as a concurrent cancellation: " + JSON.stringify(status));
  assert.ok(typeof status.lastError === "string" && status.lastError.length > 0,
    "the fault is reported: " + JSON.stringify(status));
});

test("an expiry race between the TTL check and the send intent still leaves the queue", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  let dispatchCount = 0;
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["race"] }) },
    deps: { now: () => now },
    dispatch: async request => {
      dispatchCount++;
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: "890001" });
      request.released();
      return "890001";
    },
  });
  // The delivery loop's expiry check has already passed when the intent
  // transaction rejects. Simulate exactly that: cross the deadline and fail the
  // intent, which is what `recordLifecycleIntent` does when it re-validates TTL.
  const store = h.room.store as unknown as {
    recordLifecycleIntent(...args: unknown[]): unknown;
  };
  const original = store.recordLifecycleIntent.bind(h.room.store);
  let crossed = false;
  store.recordLifecycleIntent = (...args: unknown[]) => {
    if (!crossed) {
      crossed = true;
      now += QUEUE.ttlMs + 1;
      throw new Error("room-lifecycle-attempt-invalid");
    }
    return original(...args);
  };

  assert.equal(h.receive("151", "race", ["10002"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleHeadRequest() === null, "expired head leaves the FIFO", 4000);

  assert.equal(crossed, true, "the intent transaction observed the crossed deadline");
  assert.equal(dispatchCount, 0, "no physical send starts for an expired request");
  const request = h.room.store.lifecycleRequests()[0]!;
  assert.equal(request.outcomeReason, "ttl_expired", JSON.stringify(request));
  assert.equal(h.room.workerStatusForTest().phase, "ready");
});

test("expiry in the moment before a send never starts that attempt", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  let dispatchCount = 0;
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["too late"] }) },
    deps: { now: () => now },
    dispatch: async request => {
      dispatchCount++;
      // The deadline passes between the intent and the physical send check.
      now += QUEUE.ttlMs + 1;
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: "860001" });
      request.released();
      return "860001";
    },
  });
  assert.equal(h.receive("140", "late", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.equal(dispatchCount, 1, "the dispatcher is entered once");
  const request = h.room.store.lifecycleRequests()[0]!;
  assert.notEqual(request.status, "delivering", JSON.stringify(request));
  assert.equal(h.room.store.lifecycleHeadRequest(), null, "the expired request leaves the FIFO");
  assert.equal(h.room.workerStatusForTest().phase, "ready");
});

test("audio preparation that crosses the deadline delivers no audio", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  const media: string[] = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["spoken late"] }) },
    deps: { now: () => now },
    synthesize: async () => {
      // Synthesis itself outlives the request deadline.
      now += QUEUE.ttlMs + 1000;
      return new Uint8Array([9, 9, 9]);
    },
    dispatch: async request => {
      media.push(request.medium);
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: request.medium === "audio" ? "870002" : "870001" });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      return request.medium === "audio" ? "870002" : "870001";
    },
  });
  assert.equal(h.receive("141", "speak late", ["10002"]), "scheduled");
  await h.room.whenIdle();
  assert.deepEqual(media, ["text"], "no audio attempt starts after the deadline");
  const request = h.room.store.lifecycleRequests()[0]!;
  const turn = h.room.store.lifecycleTurns(request.requestId)[0]!;
  const segment = h.room.store.lifecycleSegments(turn.turnId)[0]!;
  assert.equal(segment.state, "failed", JSON.stringify(segment));
  assert.equal(segment.reason, "ttl_expired", "the acknowledged text fact is preserved, the audio part expires");
  assert.equal(request.outcomeReason, "ttl_expired");
  assert.equal(h.room.store.lifecycleHeadRequest(), null);
  assert.equal(h.room.workerStatusForTest().phase, "ready");
});

test("a restart with an unknown audio result still lets new text and both-mode text deliver", async t => {
  const config = roomConfig({ deliveryMode: "both" });
  let stuckAttemptId = "";
  const h = await lifecycleHarness(t, {
    config,
    model: { generate: async () => ({ kind: "reply", segments: ["stuck audio"] }) },
    dispatch: async request => {
      request.beforeSend();
      if (request.medium === "text") {
        await request.observe({ kind: "ack", messageId: "840001" });
        request.released();
        return "840001";
      }
      stuckAttemptId = request.attempt.attemptId;
      // Physical send started, the completion result is never persisted.
      return new Promise<string>(() => {});
    },
  });
  assert.equal(h.receive("130", "stuck", ["10002"]), "scheduled");
  await waitFor(() => stuckAttemptId !== "", "audio attempt start");
  await waitFor(() => h.room.store.lifecycleAudioFence() === stuckAttemptId, "audio fence held");
  await h.room.close();

  const reopened = new VoiceRoom(join(h.root, "room.sqlite"), config, {
    now: () => Date.parse("2026-11-13T00:00:00Z"),
    persona: character => `# ${character.name}\nSynthetic public persona.`,
    generate: async () => { throw new Error("synthetic-legacy-forbidden"); },
    synthesize: async () => new Uint8Array([5, 5, 5]),
    sendText: async () => { throw new Error("synthetic-legacy-forbidden"); },
    sendAudio: async () => { throw new Error("synthetic-legacy-forbidden"); },
    permitsText: () => true,
    permitsPrompt: () => true,
  }, { execution: "lifecycle" });
  try {
    for (const character of config.characters) reopened.setOnline(character.accountKey, true);
    const sent: Array<{ medium: string; text: string; requestId: string }> = [];
    let replyIndex = 0;
    await reopened.startLifecycleProductionWorker({
      // Each request gets its own text so the assertions below cannot be
      // satisfied by an earlier request's dispatch.
      model: { generate: async () => ({ kind: "reply", segments: [`after restart ${++replyIndex}`] }) },
      apiTimeoutMs: 100,
      closePolicy: { observationCapacity: 32, perAccountCapacity: 16, drainMs: 100, releaseMs: 100, writeWaitMs: 50 },
      dispatch: async request => {
        request.beforeSend();
        const id = String(850000 + sent.length);
        sent.push({ medium: request.medium, text: request.item.segment.text, requestId: request.item.request.requestId });
        await request.observe({ kind: "ack", messageId: id });
        if (request.medium === "audio") request.physicalSettled();
        request.released();
        return id;
      },
      beginClose: () => {},
      sealObservations: async () => {},
    });

    assert.equal(reopened.store.lifecycleAudioFence(), stuckAttemptId,
      "the unknown legacy audio keeps its fence and identifier");
    assert.equal(reopened.receiveLifecycle(roomInput("131", "text only", ["10002"]), QUEUE), "scheduled");
    await waitFor(() => sent.length >= 1, "text after restart");
    assert.equal(sent[0]!.medium, "text");
    assert.equal(sent[0]!.text, "after restart 1", "the plain-text request carries its own text");
    const textOnlyRequestId = sent[0]!.requestId;

    reopened.store.setDeliveryMode("both");
    assert.equal(reopened.receiveLifecycle(roomInput("132", "both after restart", ["10002"]), QUEUE), "scheduled");
    await waitFor(() => sent.some(item => item.requestId !== textOnlyRequestId && item.medium === "text"),
      "both-mode text from its own request");
    const bothText = sent.find(item => item.requestId !== textOnlyRequestId && item.medium === "text")!;
    assert.equal(bothText.text, "after restart 2", "the both-mode request delivered its own text");
    assert.equal(sent.filter(item => item.requestId === textOnlyRequestId && item.medium === "text").length, 1,
      "the earlier text-only request is not re-delivered");
    assert.equal(sent.some(item => item.medium === "audio" && item.requestId !== textOnlyRequestId), false,
      "the legacy fence still blocks new audio");
    await reopened.whenIdle();
  } finally {
    await reopened.close();
  }
});

test("a persistent send-intent write fault faults the worker instead of parking two queued requests", async t => {
  let now = Date.parse("2026-11-13T00:00:00Z");
  let intentCalls = 0;
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["first queued", "second queued"] }) },
    deps: { now: () => now },
  });
  // Simulate a durable write failure (SQLITE_IOERR-style) that never clears.
  // This is not one of the three codes the intent transaction raises for a
  // re-validated rejection, so it must reach `faultWorker`.
  const store = h.room.store as unknown as {
    recordLifecycleIntent(...args: unknown[]): unknown;
  };
  store.recordLifecycleIntent = () => {
    intentCalls++;
    throw new Error("simulated-storage-io-fault");
  };

  assert.equal(h.receive("170", "first", ["10002"]), "scheduled");
  assert.equal(h.receive("171", "second", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults on the persistent intent write failure", 4000);

  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a persistent storage fault must not leave the worker reporting ready: " + JSON.stringify(status));
  assert.ok(typeof status.lastError === "string" && status.lastError.length > 0,
    "the fault reason is observable: " + JSON.stringify(status));
  assert.equal(h.dispatches.length, 0, "no physical send starts when the intent cannot be written");
  assert.equal(h.room.store.counts().send, 0, "no send budget is charged for an intent that never started");
  assert.equal(intentCalls, 1, "the pump does not tight-loop the failing write: " + intentCalls);

  const requests = h.room.store.lifecycleRequests();
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.ok(!["queued", "generating", "delivering"].includes(request.status),
      "the fault path settles the request instead of leaving it delivering: " + JSON.stringify(request));
    assert.equal(request.outcomeReason, "lifecycle_fault");
  }
  assert.equal(h.room.store.lifecycleHeadRequest(), null, "the FIFO head leaves the queue");
  assert.equal(h.room.store.lifecycleAudit().some(row => row.startedAt !== null), false,
    "no attempt was recorded as started, so nothing is reported as sent");

  // Crossing the TTL afterwards must not resurrect the requests or the worker.
  now += QUEUE.ttlMs + 1000;
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(h.room.workerStatusForTest().phase, "faulted", "the worker stays faulted");
  assert.equal(h.room.store.lifecycleHeadRequest(), null, "no request returns to the FIFO");
  assert.equal(intentCalls, 1, "the failing write is not retried after the deadline");
});

test("an audio send-intent write fault faults the worker instead of degrading to text-only", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["audio intent fault"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = "890001";
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });
  const store = h.room.store as unknown as {
    recordLifecycleIntent(segmentId: string, medium: "text" | "audio", ownerToken: string, now: number): unknown;
  };
  const original = store.recordLifecycleIntent.bind(h.room.store);
  let audioIntentCalls = 0;
  store.recordLifecycleIntent = (segmentId, medium, ownerToken, at) => {
    if (medium === "audio") {
      audioIntentCalls++;
      throw new Error("simulated-storage-io-fault");
    }
    return original(segmentId, medium, ownerToken, at);
  };

  assert.equal(h.receive("172", "audio fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults on the audio intent write failure", 4000);

  assert.equal(audioIntentCalls, 1, "the audio intent write is attempted exactly once");
  assert.equal(h.dispatches.filter(item => item.medium === "audio").length, 0, "no audio is dispatched");
  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a storage fault must not be recorded as a TTS degradation: " + JSON.stringify(status));
  const turn = h.room.store.lifecycleTurns(h.room.store.lifecycleRequests()[0]!.requestId)[0]!;
  const segments = h.room.store.lifecycleSegments(turn.turnId);
  assert.equal(segments.some(segment => (segment.reason ?? "").startsWith("tts_text_only")), false,
    "the storage fault is not misreported as a TTS fallback: " + JSON.stringify(segments));
});

test("a storage read fault while settling an audio intent rejection faults instead of completing text-only", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["rejected audio intent"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = "895001";
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });
  const store = h.room.store as unknown as {
    recordLifecycleIntent(segmentId: string, medium: "text" | "audio", ownerToken: string, now: number): unknown;
    lifecycleRequestById(requestId: string): unknown;
  };
  const originalIntent = store.recordLifecycleIntent.bind(h.room.store);
  const originalRead = store.lifecycleRequestById.bind(h.room.store);
  let audioIntentCalls = 0;
  let armed = false;
  store.recordLifecycleIntent = (segmentId, medium, ownerToken, at) => {
    if (medium === "audio") {
      audioIntentCalls++;
      // A genuine re-validated rejection: the intent never starts.
      armed = true;
      throw new Error("room-lifecycle-attempt-invalid");
    }
    return originalIntent(segmentId, medium, ownerToken, at);
  };
  store.lifecycleRequestById = (requestId: string) => {
    if (armed) {
      armed = false;
      throw new Error("simulated-read-fault");
    }
    return originalRead(requestId);
  };

  assert.equal(h.receive("173", "rejected audio", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults when the rejection cannot be settled", 4000);

  assert.equal(audioIntentCalls, 1, "the audio intent was reached exactly once");
  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a read fault during rejection settlement must not be absorbed as a TTS fallback: "
      + JSON.stringify(status));
  const turn = h.room.store.lifecycleTurns(h.room.store.lifecycleRequests()[0]!.requestId)[0]!;
  const segments = h.room.store.lifecycleSegments(turn.turnId);
  assert.equal(segments.some(segment => segment.state === "completed"), false,
    "an audio intent that never started is never reported as completed: " + JSON.stringify(segments));
  assert.equal(segments.some(segment => (segment.reason ?? "").startsWith("tts_text_only")), false,
    "the read fault is not misreported as a TTS fallback: " + JSON.stringify(segments));
  assert.equal(h.dispatches.filter(item => item.medium === "audio").length, 0, "no audio was dispatched");
});

test("an unexpired intent rejection that cannot make progress faults instead of parking the head", async t => {
  const h = await lifecycleHarness(t, {
    model: { generate: async () => ({ kind: "reply", segments: ["parked head"] }) },
  });
  const store = h.room.store as unknown as {
    recordLifecycleIntent(...args: unknown[]): unknown;
  };
  // Nothing about the request actually changed: it is not expired, the owner
  // and revision are live, and it is still the FIFO head. A rejection in that
  // state can never be woken into progress, so it must surface as a fault.
  store.recordLifecycleIntent = () => { throw new Error("room-lifecycle-attempt-invalid"); };

  assert.equal(h.receive("174", "unexpired", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults instead of parking an unexpired head", 4000);

  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "an unexpired rejection with no possible progress must not stay ready: " + JSON.stringify(status));
  assert.ok(typeof status.lastError === "string" && status.lastError.length > 0,
    "the fault reason is observable: " + JSON.stringify(status));
  assert.equal(h.dispatches.length, 0, "no physical send starts");
});

test("an owner read fault while judging an audio intent rejection faults instead of completing text-only", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["owner read fault"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = "896001";
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });
  const store = h.room.store as unknown as {
    recordLifecycleIntent(segmentId: string, medium: "text" | "audio", ownerToken: string, now: number): unknown;
    lifecycleOwnerValid(token: string, now: number): boolean;
  };
  const originalIntent = store.recordLifecycleIntent.bind(h.room.store);
  const originalOwner = store.lifecycleOwnerValid.bind(h.room.store);
  let armed = false;
  store.recordLifecycleIntent = (segmentId, medium, ownerToken, at) => {
    if (medium === "audio") {
      armed = true;
      throw new Error("room-lifecycle-attempt-invalid");
    }
    return originalIntent(segmentId, medium, ownerToken, at);
  };
  // The settlement path asks "is the owner still live?" to decide whether some
  // other path will wake this head. A read fault there must not look like
  // "owner changed", which would silently park the request.
  store.lifecycleOwnerValid = (token: string, now: number) => {
    if (armed) {
      armed = false;
      throw new Error("simulated-owner-read-fault");
    }
    return originalOwner(token, now);
  };

  assert.equal(h.receive("175", "owner read fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults on the owner read fault", 4000);

  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "an owner read fault must not be absorbed as a TTS fallback: " + JSON.stringify(status));
  const turn = h.room.store.lifecycleTurns(h.room.store.lifecycleRequests()[0]!.requestId)[0]!;
  const segments = h.room.store.lifecycleSegments(turn.turnId);
  assert.equal(segments.some(segment => segment.state === "completed"), false,
    "a never-started audio intent is never reported as completed: " + JSON.stringify(segments));
  assert.equal(segments.some(segment => (segment.reason ?? "").startsWith("tts_text_only")), false,
    "the owner read fault is not misreported as a TTS fallback: " + JSON.stringify(segments));
});

test("a control read fault while judging an audio intent rejection faults instead of parking the head", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["control read fault"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = "897001";
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });
  const store = h.room.store as unknown as {
    recordLifecycleIntent(segmentId: string, medium: "text" | "audio", ownerToken: string, now: number): unknown;
    lifecycleControlState(): unknown;
  };
  const originalIntent = store.recordLifecycleIntent.bind(h.room.store);
  const originalControl = store.lifecycleControlState.bind(h.room.store);
  let armed = false;
  store.recordLifecycleIntent = (segmentId, medium, ownerToken, at) => {
    if (medium === "audio") {
      armed = true;
      throw new Error("room-lifecycle-attempt-invalid");
    }
    return originalIntent(segmentId, medium, ownerToken, at);
  };
  store.lifecycleControlState = () => {
    if (armed) {
      armed = false;
      throw new Error("simulated-control-read-fault");
    }
    return originalControl();
  };

  assert.equal(h.receive("176", "control read fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults on the control read fault", 4000);

  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a control read fault must not look like a revision change: " + JSON.stringify(status));
  assert.equal(h.dispatches.filter(item => item.medium === "audio").length, 0, "no audio was dispatched");
  assert.equal(h.room.store.lifecycleHeadRequest()?.status === "delivering", false,
    "the head is not silently parked in delivering");
});

test("a storage fault while preparing audio never becomes a text-only degradation", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["prepare fault"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = "898001";
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });
  const store = h.room.store as unknown as {
    prepareLifecycleVoice(...args: unknown[]): void;
  };
  let prepareCalls = 0;
  store.prepareLifecycleVoice = () => {
    prepareCalls++;
    throw new Error("simulated-prepare-write-fault");
  };

  assert.equal(h.receive("177", "prepare fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults on the prepare write fault", 4000);

  assert.equal(prepareCalls, 1, "the prepare write is attempted exactly once");
  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a prepare write fault must not be recorded as a TTS degradation: " + JSON.stringify(status));
  const turn = h.room.store.lifecycleTurns(h.room.store.lifecycleRequests()[0]!.requestId)[0]!;
  const segments = h.room.store.lifecycleSegments(turn.turnId);
  assert.equal(segments.some(segment => (segment.reason ?? "").startsWith("tts_text_only")), false,
    "the prepare fault is not misreported as a TTS fallback: " + JSON.stringify(segments));
});

test("a storage read fault on the refreshed delivery items never becomes a text-only degradation", async t => {
  const textReceiptId = "899001";
  let armed = false;
  let injectedReads = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["items read fault"] }) },
    synthesize: async () => {
      armed = true;
      return new Uint8Array([1, 2, 3]);
    },
    dispatch: async request => {
      request.beforeSend();
      await request.observe({ kind: "ack", messageId: textReceiptId });
      request.released();
      return textReceiptId;
    },
  });
  const store = h.room.store;
  const original = store.lifecycleDeliveryItems.bind(store);
  store.lifecycleDeliveryItems = (requestId: string) => {
    if (armed) {
      armed = false;
      injectedReads++;
      throw new Error("simulated-items-read-fault");
    }
    return original(requestId);
  };

  assert.equal(h.receive("178", "items read fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase === "faulted"
    || store.lifecycleRequests()[0]?.status === "completed", "worker faults or request completes", 4000);

  assert.equal(injectedReads, 1, "one post-synthesis read fault was injected");
  const turn = store.lifecycleTurns(store.lifecycleRequests()[0]!.requestId)[0]!;
  const segments = store.lifecycleSegments(turn.turnId);
  assert.equal(segments.some(segment => (segment.reason ?? "").startsWith("tts_text_only")), false,
    "the read fault is not misreported as a TTS fallback: " + JSON.stringify(segments));
  assert.equal(h.room.workerStatusForTest().phase, "faulted");
  assert.deepEqual(h.dispatches.map(item => item.medium), ["text"]);
  assert.ok(store.historyPage(10).some(row => row.platformId === textReceiptId && row.medium === "text"),
    "the acknowledged text remains committed");
});

test("a classified storage fault survives a failing liveness probe on the audio path", async t => {
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["probe fault"] }) },
    dispatch: async request => {
      request.beforeSend();
      const id = "899501";
      await request.observe({ kind: "ack", messageId: id });
      request.released();
      return id;
    },
  });
  const store = h.room.store as unknown as {
    prepareLifecycleVoice(...args: unknown[]): void;
    lifecycleOwnerValid(token: string, now: number): boolean;
  };
  const originalOwner = store.lifecycleOwnerValid.bind(h.room.store);
  let armed = false;
  let probeFaults = 0;
  store.prepareLifecycleVoice = () => {
    armed = true;
    throw new Error("simulated-prepare-write-fault");
  };
  // The catch must rethrow the classified fault before probing liveness. If it
  // probes first, this read failure turns into `false` and the fault vanishes.
  store.lifecycleOwnerValid = (token: string, now: number) => {
    // One-shot: a single probe failure must be enough to lose the fault. A
    // persistent failure would eventually surface through another call site and
    // mask the ordering bug this test exists to catch.
    if (armed) {
      armed = false;
      probeFaults++;
      throw new Error("simulated-owner-read-fault");
    }
    return originalOwner(token, now);
  };

  assert.equal(h.receive("179", "probe fault", ["10002"]), "scheduled");
  await waitFor(() => h.room.workerStatusForTest().phase !== "ready",
    "worker faults even when the liveness probe also fails", 4000);

  assert.equal(probeFaults, 0,
    "the classified fault is rethrown before any liveness probe reads the store");
  const status = h.room.workerStatusForTest();
  assert.notEqual(status.phase, "ready",
    "a classified storage fault must not be discarded by a failing probe: " + JSON.stringify(status));
  assert.ok(typeof status.lastError === "string" && status.lastError.length > 0,
    "the fault reason survives: " + JSON.stringify(status));
});

for (const fault of ["dispatch request read", "attempt start write", "alternate ACK commit",
  "provider rejection with owner read", "provider rejection with control read"] as const) {
  test(`an audio ${fault} storage fault stops the delivery pump`, async t => {
    const sent: { medium: "text" | "audio"; attemptId: string; messageId: string }[] = [];
    const lateAck = fault === "alternate ACK commit";
    let audioIntentId: string | undefined;
    let requestReadArmed = false;
    let providerReadArmed = false;
    let audioAcked = false;
    let synthesisCalls = 0;
    let injections = 0;
    const checkingAudioFallback = () => providerReadArmed && new Error().stack?.includes("deliverLifecycleAudio");
    const fail = (): never => {
      injections++;
      throw new Error("simulated-audio-storage-fault");
    };
    const h = await lifecycleHarness(t, {
      config: roomConfig({ deliveryMode: "both" }),
      model: { generate: async () => ({ kind: "reply", segments: ["audio storage fault"] }) },
      synthesize: async () => {
        synthesisCalls++;
        if (fault === "provider rejection with owner read" || fault === "provider rejection with control read") {
          providerReadArmed = true;
          throw new Error("synthetic-provider-failure");
        }
        return new Uint8Array([1, 2, 3]);
      },
      dispatch: async request => {
        try {
          request.beforeSend();
        } catch (error) {
          if (request.medium === "audio" && fault === "attempt start write") {
            request.released();
            throw new RoomSendError("rejected");
          }
          throw error;
        }
        const messageId = request.medium === "text" ? "899601" : "899602";
        sent.push({ medium: request.medium, attemptId: request.attempt.attemptId, messageId });
        await request.observe({ kind: "ack", messageId });
        if (request.medium === "audio") request.physicalSettled();
        request.released();
        if (request.medium === "audio" && lateAck) {
          audioAcked = true;
          throw new Error("synthetic-dispatch-rejection-after-ack");
        }
        return messageId;
      },
    });
    const store = h.room.store;
    if (fault === "dispatch request read" || fault === "attempt start write") {
      const intent = store.recordLifecycleIntent.bind(store);
      store.recordLifecycleIntent = (...args) => {
        const attempt = intent(...args);
        if (attempt.medium === "audio") {
          audioIntentId = attempt.attemptId;
          requestReadArmed = true;
        }
        return attempt;
      };
    }
    if (fault === "dispatch request read") {
      const readRequest = store.lifecycleRequestById.bind(store);
      store.lifecycleRequestById = (...args) => {
        if (requestReadArmed) {
          requestReadArmed = false;
          fail();
        }
        return readRequest(...args);
      };
    } else if (fault === "attempt start write") {
      const recordStarted = store.recordLifecycleStarted.bind(store);
      store.recordLifecycleStarted = (...args) => {
        if (args[0] === audioIntentId && injections === 0) fail();
        return recordStarted(...args);
      };
    } else if (lateAck) {
      const commitVoice = store.commitLifecycleVoice.bind(store);
      store.commitLifecycleVoice = (...args) => {
        if (audioAcked && injections === 0) fail();
        return commitVoice(...args);
      };
    } else if (fault === "provider rejection with owner read") {
      const readOwner = store.lifecycleOwnerValid.bind(store);
      store.lifecycleOwnerValid = (...args) => {
        if (checkingAudioFallback()) fail();
        return readOwner(...args);
      };
    } else {
      const readControl = store.lifecycleControlState.bind(store);
      store.lifecycleControlState = (...args) => {
        if (checkingAudioFallback()) fail();
        return readControl(...args);
      };
    }

    assert.equal(h.receive("180", "audio storage fault", ["10002"]), "scheduled");
    try {
      await h.room.whenIdle();
      assert.equal(synthesisCalls, 1);
      if (providerReadArmed) assert.ok(injections > 0, "the sustained read fault was reached");
      else assert.equal(injections, 1, "the one-shot fault was reached");
      assert.equal(h.room.workerStatusForTest().phase, "faulted");
      assert.equal(h.room.workerStatusForTest().lastError, "room-lifecycle-delivery-pump-failed");
      assert.equal(h.receive("181", "new ingress", ["10002"]), "rejected");
    } finally {
      providerReadArmed = false;
    }

    assert.deepEqual(sent.map(({ medium }) => medium), lateAck ? ["text", "audio"] : ["text"]);
    assert.ok(store.historyPage(10).some(row => row.platformId === "899601" && row.medium === "text"));
    if (audioIntentId) assert.equal(store.lifecycleAttempt(audioIntentId)?.startedAt, null);
    for (const { attemptId, messageId } of sent) {
      assert.deepEqual(store.lifecycleReceipts(attemptId).map(receipt => [receipt.kind, receipt.messageId]),
        [["ack", messageId]]);
    }
    const [request] = store.lifecycleRequests();
    const [turn] = store.lifecycleTurns(request!.requestId);
    assert.doesNotMatch(request!.outcomeReason ?? "", /^tts_text_only_/);
    for (const segment of store.lifecycleSegments(turn!.turnId)) {
      assert.doesNotMatch(segment.reason ?? "", /^tts_text_only_/);
    }
  });
}

test("an immutable audio ACK wins when the transport promise later rejects", async t => {
  const sent: string[] = [];
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: { generate: async () => ({ kind: "reply", segments: ["acknowledged before rejection"] }) },
    dispatch: async request => {
      request.beforeSend();
      const messageId = request.medium === "text" ? "899701" : "899702";
      sent.push(request.medium);
      await request.observe({ kind: "ack", messageId });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      if (request.medium === "audio") throw new RoomSendError("uncertain");
      return messageId;
    },
  });

  assert.equal(h.receive("182", "durable audio ack", ["10002"]), "scheduled");
  await h.room.whenIdle();

  assert.deepEqual(sent, ["text", "audio"]);
  assert.deepEqual(h.room.store.historyPage(10).filter(row => row.speakerType === "bot")
    .map(row => [row.medium, row.platformId]), [["text", "899701"], ["voice", "899702"]]);
  assert.equal(h.room.store.lifecycleRequests()[0]?.status, "completed");
  assert.equal(h.room.workerStatusForTest().phase, "ready");
});

test("body retention inventory reports a body-free no-op before the seven-day window", async t => {
  const base = Date.parse("2026-11-20T00:00:00Z");
  const h = await lifecycleHarness(t, {
    deps: { now: () => base },
    model: { generate: async () => ({ kind: "reply", segments: ["retention generated canary"] }) },
    synthesize: async () => new Uint8Array([1, 2, 3]),
    dispatch: async request => {
      request.beforeSend();
      const messageId = request.medium === "text" ? "799001" : "799002";
      await request.observe({ kind: "ack", messageId });
      request.released();
      return messageId;
    },
  });
  assert.equal(h.receive("798", "retention request canary", ["10002"]), "scheduled");
  await h.room.whenIdle();

  const request = h.room.store.lifecycleRequests()[0]!;
  const turn = h.room.store.lifecycleTurns(request.requestId)[0]!;
  const segment = h.room.store.lifecycleSegments(turn.turnId)[0]!;
  const report = h.room.store.cleanupBodyRetention(base);
  assert.equal(report.changed, false);
  assert.deepEqual(report.counts, {
    messageBodiesRedacted: 0,
    deliveryBodiesNulled: 0,
    workPayloadsRedacted: 0,
    lifecycleRequestPayloadsRedacted: 0,
    lifecycleSegmentBodiesRedacted: 0,
  });
  assert.deepEqual(report.reasons, []);
  assert.deepEqual(report.inventory, [
    { table: "room_messages", column: "text", meaning: "message_body" },
    { table: "room_deliveries", column: "semantic_text", meaning: "generated_text" },
    { table: "room_deliveries", column: "voice_text", meaning: "voice_translation" },
    { table: "room_work_items", column: "payload_json", meaning: "request_body_json" },
    { table: "room_lifecycle_requests", column: "payload_json", meaning: "request_body_json" },
    { table: "room_lifecycle_segments", column: "semantic_text", meaning: "generated_text" },
    { table: "room_lifecycle_segments", column: "voice_text", meaning: "voice_translation" },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /retention request canary|retention generated canary|79900/);
  assert.equal(h.room.store.historyMessage(request.messageRowId)?.text, "retention request canary");
  assert.equal(h.room.store.lifecycleRequestById(request.requestId)?.input.text, "retention request canary");
  assert.equal(h.room.store.lifecycleSegments(turn.turnId)[0]?.text, "retention generated canary");
  assert.ok(segment.segmentId);
});

test("body retention is exact at seven days, idempotent, survives reopen and preserves lifecycle facts", async t => {
  const root = mkdtempSync(join(tmpdir(), "pa-retention-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "room.sqlite");
  const config = checkRoomConfig(roomConfig({ deliveryMode: "both" }));
  const base = Date.parse("2026-11-20T00:00:00Z");
  const boundary = base - 7 * 86400000;
  const outside = boundary - 60_000;
  const store = new RoomStore(file, config, { lifecycle: "connection" });
  store.acquireLifecycleOwner("retention-owner", store.state().epoch, base + 60000, base);
  const admittedWork = store.acceptInput(roomInput("798100", "old-work-canary"), {
    now: outside,
    expectedEpoch: store.state().epoch,
    source: "direct",
    mode: "enqueue",
    policy: QUEUE,
  });
  assert.equal(admittedWork.kind, "enqueue");
  const claimedWork = store.claimNext({ expectedEpoch: store.state().epoch, now: outside + 1,
    burstId: "retention-burst" });
  assert.equal(claimedWork?.workItemId, admittedWork.item?.workItemId);
  assert.equal(store.settleWorkItem(admittedWork.item!.workItemId, {
    expectedEpoch: store.state().epoch,
    burstId: "retention-burst",
    now: base + 2,
    status: "cancelled",
    reason: "delivery_cancelled",
  }), true);
  store.close();

  const db = new DatabaseSync(file);
  const insertMessage = db.prepare(`INSERT INTO room_messages
    (speaker_type,speaker_id,account_key,target_id,text,platform_id,created_at,medium) VALUES (?,?,?,?,?,?,?,?)`);
  const oldUser = Number(insertMessage.run("user", "member-1111111111111111", "account-a", null,
    "old-user-canary", "798100", outside, "text").lastInsertRowid);
  const oldBot = Number(insertMessage.run("bot", "character-a", "account-a", oldUser,
    "old-generated-canary", "798101", outside, "text").lastInsertRowid);
  const oldVoice = Number(insertMessage.run("bot", "character-a", "account-a", oldUser,
    "old-voice-canary", "798102", outside, "voice").lastInsertRowid);
  const edgeUser = Number(insertMessage.run("user", "member-1111111111111111", "account-a", null,
    "edge-user-canary", "798103", boundary, "text").lastInsertRowid);
  const activeUser = Number(insertMessage.run("user", "member-1111111111111111", "account-a", null,
    "active-user-canary", "798104", outside, "text").lastInsertRowid);
  const unknownUser = Number(insertMessage.run("user", "member-1111111111111111", "account-a", null,
    "unknown-user-canary", "798105", outside, "text").lastInsertRowid);
  const expiredUser = Number(insertMessage.run("user", "member-1111111111111111", "account-a", null,
    "expired-user-canary", "798106", outside, "text").lastInsertRowid);

  const oldRequest = "11111111-1111-4111-8111-111111111111";
  const oldTurn = "22222222-2222-4222-8222-222222222222";
  const oldSegment = "33333333-3333-4333-8333-333333333333";
  const oldTextAttempt = "44444444-4444-4444-8444-444444444444";
  const activeRequest = "55555555-5555-4555-8555-555555555555";
  const activeTurn = "66666666-6666-4666-8666-666666666666";
  const activeSegment = "77777777-7777-4777-8777-777777777777";
  const unknownRequest = "88888888-8888-4888-8888-888888888888";
  const unknownTurn = "99999999-9999-4999-8999-999999999999";
  const unknownSegment = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const unknownAttempt = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const expiredRequest = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const expiredTurn = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const expiredSegment = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  db.prepare(`INSERT INTO room_lifecycle_requests
    (request_id,event_key,accept_seq,status,outcome_reason,source,execution_epoch,execution_revision,expires_at,
      message_row_id,delivery_mode,payload_json,created_at,updated_at)
    VALUES (?,?,1,'failed','delivery_rejected','direct',0,0,?,?,'both',?,?,?)`).run(oldRequest,
    "a".repeat(64), base, oldUser, JSON.stringify({ input: { text: "old-request-canary" }, characterIds: ["character-a"],
      messageRowId: oldUser, senderKey: "member-1111111111111111" }), outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_turns
    (turn_id,request_id,character_id,mention_index,status,reason,created_at,updated_at)
    VALUES (?,?, 'character-a',0,'failed','delivery_rejected',?,?)`).run(oldTurn, oldRequest, outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_segments
    (segment_id,turn_id,segment_index,semantic_text,voice_text,voice_language,delivery_mode,state,reason,created_at,updated_at)
    VALUES (?,?,0,'old-segment-canary','old-translation-canary','ja','both','failed','delivery_rejected',?,?)`)
    .run(oldSegment, oldTurn, outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_attempts
    (attempt_id,segment_id,request_id,turn_id,account_key,medium,revision,intent_at,started_at,owner_token,committed_row_id)
    VALUES (?,?,?,?, 'account-a','text',0,?,?, 'retention-owner',?)`)
    .run(oldTextAttempt, oldSegment, oldRequest, oldTurn, outside, outside, oldBot);
  db.prepare(`INSERT INTO room_lifecycle_receipts VALUES (?, 'ack', '798101', ?)`).run(oldTextAttempt, outside);

  db.prepare(`INSERT INTO room_lifecycle_requests
    (request_id,event_key,accept_seq,status,outcome_reason,source,execution_epoch,execution_revision,expires_at,
      message_row_id,delivery_mode,payload_json,created_at,updated_at)
    VALUES (?,?,2,'generating',NULL,'direct',0,0,?,?,'text',?,?,?)`).run(activeRequest,
    "b".repeat(64), base + 60000, activeUser,
    JSON.stringify({ input: { text: "active-request-canary" }, characterIds: ["character-a"],
      messageRowId: activeUser, senderKey: "member-1111111111111111" }), outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_turns
    (turn_id,request_id,character_id,mention_index,status,reason,created_at,updated_at)
    VALUES (?,?, 'character-a',0,'generating',NULL,?,?)`).run(activeTurn, activeRequest, outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_segments
    (segment_id,turn_id,segment_index,semantic_text,voice_text,voice_language,delivery_mode,state,reason,created_at,updated_at)
    VALUES (?,?,0,'active-segment-canary',NULL,NULL,'text','pending',NULL,?,?)`)
    .run(activeSegment, activeTurn, outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_requests
    (request_id,event_key,accept_seq,status,outcome_reason,source,execution_epoch,execution_revision,expires_at,
      message_row_id,delivery_mode,payload_json,created_at,updated_at)
    VALUES (?,?,3,'failed','delivery_unknown','direct',0,0,?,?,'both',?,?,?)`).run(unknownRequest,
    "e".repeat(64), base, unknownUser,
    JSON.stringify({ input: { text: "unknown-request-canary" }, characterIds: ["character-a"],
      messageRowId: unknownUser, senderKey: "member-1111111111111111" }), outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_turns
    (turn_id,request_id,character_id,mention_index,status,reason,created_at,updated_at)
    VALUES (?,?, 'character-a',0,'unknown','delivery_unknown',?,?)`).run(unknownTurn, unknownRequest, outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_segments
    (segment_id,turn_id,segment_index,semantic_text,voice_text,voice_language,delivery_mode,state,reason,created_at,updated_at)
    VALUES (?,?,0,'unknown-segment-canary','unknown-translation-canary','ja','both','unknown','delivery_unknown',?,?)`)
    .run(unknownSegment, unknownTurn, outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_attempts
    (attempt_id,segment_id,request_id,turn_id,account_key,medium,revision,intent_at,started_at,owner_token,committed_row_id)
    VALUES (?,?,?,?, 'account-a','audio',0,?,?, 'retention-owner',NULL)`)
    .run(unknownAttempt, unknownSegment, unknownRequest, unknownTurn, outside, outside);
  db.prepare("INSERT INTO room_lifecycle_audio_fence(id,attempt_id,started_at) VALUES (1,?,?)")
    .run(unknownAttempt, outside);
  db.prepare(`INSERT INTO room_lifecycle_requests
    (request_id,event_key,accept_seq,status,outcome_reason,source,execution_epoch,execution_revision,expires_at,
      message_row_id,delivery_mode,payload_json,created_at,updated_at)
    VALUES (?,?,4,'generating',NULL,'direct',0,0,?,?,'text',?,?,?)`).run(expiredRequest,
    "f".repeat(64), outside, expiredUser,
    JSON.stringify({ input: { text: "expired-request-canary" }, characterIds: ["character-a"],
      messageRowId: expiredUser, senderKey: "member-1111111111111111" }), outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_turns
    (turn_id,request_id,character_id,mention_index,status,reason,created_at,updated_at)
    VALUES (?,?, 'character-a',0,'generating',NULL,?,?)`).run(expiredTurn, expiredRequest, outside, outside);
  db.prepare(`INSERT INTO room_lifecycle_segments
    (segment_id,turn_id,segment_index,semantic_text,voice_text,voice_language,delivery_mode,state,reason,created_at,updated_at)
    VALUES (?,?,0,'expired-segment-canary',NULL,NULL,'text','pending',NULL,?,?)`)
    .run(expiredSegment, expiredTurn, outside, outside);
  db.prepare("UPDATE room_work_items SET created_at=?,received_at=?,updated_at=? WHERE work_item_id=?")
    .run(outside, outside, outside, admittedWork.item!.workItemId);
  db.prepare(`INSERT INTO room_deliveries
    (id,burst_id,character_id,account_key,voice_key,state,created_at,semantic_text,voice_text,voice_language,delivery_mode)
    VALUES ('legacy-stale-delivery','legacy-burst','character-a','account-a','voice-a','interrupted',
      ?,'old-delivery-canary','old-delivery-voice-canary','ja','both')`).run(outside);
  db.prepare(`INSERT INTO room_deliveries
    (id,burst_id,character_id,account_key,voice_key,state,created_at,semantic_text,voice_text,voice_language,delivery_mode)
    VALUES ('legacy-terminal-delivery','legacy-terminal-burst','character-a','account-a','voice-a','stopped',
      ?,'old-terminal-canary','old-terminal-voice-canary','ja','both')`).run(outside);
  db.prepare(`INSERT INTO room_bursts(id,epoch,trigger,target_id,state,created_at)
    VALUES ('legacy-burst',0,'direct',?,'interrupted',?)`).run(oldUser, outside);
  db.prepare("UPDATE room_state SET next_accept_seq=4").run();
  db.close();
  const probe = new DatabaseSync(file);
  assert.deepEqual(probe.prepare("SELECT text FROM room_messages WHERE created_at < ? ORDER BY id")
    .all(base - 7 * 86400000).map(row => row.text).sort(), [
      "active-user-canary",
      "expired-user-canary",
      "old-generated-canary",
      "old-user-canary",
      "old-voice-canary",
      "old-work-canary",
      "unknown-user-canary",
    ]);
  assert.equal(Number(probe.prepare("SELECT count(*) AS n FROM room_messages WHERE created_at < ?")
    .get(base - 7 * 86400000)!.n), 7);
  assert.equal(Number(probe.prepare("SELECT count(*) AS n FROM room_work_items WHERE created_at < ?")
    .get(base - 7 * 86400000)!.n), 1);
  const terminalTriggerSql = String(probe.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='room_work_terminal'").get()!.sql);
  probe.close();

  const rollbackDir = join(root, "rollback");
  mkdirSync(rollbackDir);
  const rollbackFile = join(rollbackDir, "room.sqlite");
  copyFileSync(file, rollbackFile);
  const faultDb = new DatabaseSync(rollbackFile);
  faultDb.exec(`CREATE TRIGGER retention_fault BEFORE UPDATE OF semantic_text ON room_lifecycle_segments
    BEGIN SELECT RAISE(ABORT,'forced-retention-fault'); END;`);
  faultDb.close();
  const failing = new RoomStore(rollbackFile, config, { lifecycle: "connection" });
  assert.throws(() => failing.cleanupBodyRetention(base), /forced-retention-fault/);
  failing.close();
  const rolledBack = new DatabaseSync(rollbackFile);
  assert.equal(String(rolledBack.prepare("SELECT text FROM room_messages WHERE id=?").get(oldUser)!.text),
    "old-user-canary");
  assert.match(String(rolledBack.prepare("SELECT payload_json FROM room_work_items WHERE work_item_id=?")
    .get(admittedWork.item!.workItemId)!.payload_json), /old-work-canary/);
  assert.match(String(rolledBack.prepare("SELECT payload_json FROM room_lifecycle_requests WHERE request_id=?")
    .get(oldRequest)!.payload_json), /old-request-canary/);
  assert.match(String(rolledBack.prepare("SELECT payload_json FROM room_lifecycle_requests WHERE request_id=?")
    .get(unknownRequest)!.payload_json), /unknown-request-canary/);
  assert.equal(String(rolledBack.prepare("SELECT semantic_text FROM room_lifecycle_segments WHERE segment_id=?")
    .get(unknownSegment)!.semantic_text), "unknown-segment-canary");
  assert.equal(String(rolledBack.prepare("SELECT semantic_text FROM room_deliveries WHERE id='legacy-terminal-delivery'")
    .get()!.semantic_text), "old-terminal-canary");
  assert.equal(String(rolledBack.prepare("SELECT semantic_text FROM room_deliveries WHERE id='legacy-stale-delivery'")
    .get()!.semantic_text), "old-delivery-canary");
  assert.ok(rolledBack.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='room_work_terminal'").get());
  rolledBack.exec("DROP TRIGGER retention_fault");
  rolledBack.close();

  const reopened = new RoomStore(file, config, { lifecycle: "connection" });
  t.after(() => reopened.close());
  const report = reopened.cleanupBodyRetention(base);
  assert.deepEqual(report.reasons, ["age"]);
  assert.equal(report.changed, true);
  assert.deepEqual(report.counts, {
    messageBodiesRedacted: 6,
    deliveryBodiesNulled: 2,
    workPayloadsRedacted: 1,
    lifecycleRequestPayloadsRedacted: 3,
    lifecycleSegmentBodiesRedacted: 3,
  });
  assert.deepEqual(report.reasons, ["age"]);
  assert.doesNotMatch(JSON.stringify(report), /canary|79810[0-6]|member-|account-a|character-a/);

  for (const id of [oldUser, oldBot, oldVoice, admittedWork.item!.payload!.messageRowId, unknownUser, expiredUser]) {
    const message = reopened.historyMessage(id);
    assert.ok(message, "retention keeps the message identity");
    assert.equal(message.text, "[redacted:retention]");
    assert.equal(message.createdAt, outside);
  }
  assert.equal(reopened.historyMessage(edgeUser)?.text, "edge-user-canary");
  assert.equal(reopened.historyMessage(activeUser)?.text, "active-user-canary");
  const old = reopened.lifecycleRequestById(oldRequest)!;
  assert.equal(old.input.text, "[redacted:retention]");
  assert.equal(old.status, "failed");
  assert.equal(old.outcomeReason, "delivery_rejected");
  assert.equal(old.createdAt, outside);
  assert.equal(old.updatedAt, outside);
  assert.equal(reopened.lifecycleTurns(oldRequest)[0]?.status, "failed");
  assert.equal(reopened.lifecycleSegments(oldTurn)[0]?.text, "[redacted:retention]");
  assert.equal(reopened.lifecycleSegments(oldTurn)[0]?.voiceText, null);
  assert.deepEqual({ ...reopened.lifecycleAttempt(oldTextAttempt) }, {
    attemptId: oldTextAttempt,
    segmentId: oldSegment,
    requestId: oldRequest,
    turnId: oldTurn,
    accountKey: "account-a",
    medium: "text",
    revision: 0,
    intentAt: outside,
    startedAt: outside,
    ownerToken: "retention-owner",
    committedRowId: oldBot,
  });
  assert.deepEqual(reopened.lifecycleReceipts(oldTextAttempt).map(receipt => ({ ...receipt })), [
    { kind: "ack", messageId: "798101", observedAt: outside },
  ]);
  const active = reopened.lifecycleRequestById(activeRequest)!;
  assert.equal(active.input.text, "active-request-canary");
  assert.equal(active.status, "generating");
  assert.equal(reopened.lifecycleSegments(activeTurn)[0]?.text, "active-segment-canary");
  const unknown = reopened.lifecycleRequestById(unknownRequest)!;
  assert.equal(unknown.input.text, "[redacted:retention]");
  assert.equal(unknown.status, "failed");
  assert.equal(reopened.lifecycleSegments(unknownTurn)[0]?.text, "[redacted:retention]");
  assert.equal(reopened.lifecycleSegments(unknownTurn)[0]?.voiceText, null);
  assert.equal(reopened.lifecycleAttempt(unknownAttempt)?.startedAt, outside);
  assert.deepEqual(reopened.lifecycleReceipts(unknownAttempt), []);
  assert.equal(reopened.historyMessage(unknownUser)?.text, "[redacted:retention]");
  assert.equal(reopened.lifecycleAudioFence(), unknownAttempt);
  const expired = reopened.lifecycleRequestById(expiredRequest)!;
  assert.equal(expired.input.text, "[redacted:retention]");
  assert.equal(expired.status, "generating");
  assert.equal(expired.expiresAt, outside);
  assert.equal(reopened.lifecycleSegments(expiredTurn)[0]?.text, "[redacted:retention]");
  assert.equal(reopened.lifecycleSegments(expiredTurn)[0]?.state, "pending");
  const work = reopened.workItem(admittedWork.item!.workItemId)!;
  assert.equal(work.payload?.input.text, "[redacted:retention]");
  assert.equal(work.payload?.input.senderKey, admittedWork.item!.payload!.input.senderKey);
  assert.equal(work.status, "cancelled");
  assert.equal(work.terminalReason, "delivery_cancelled");
  assert.equal(work.createdAt, outside);
  assert.equal(work.receivedAt, outside);
  assert.equal(reopened.schemaVersion(), 9);
  reopened.close();

  const resumed = new RoomStore(file, config, { lifecycle: "connection" });
  t.after(() => resumed.close());
  const repeated = resumed.cleanupBodyRetention(base);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.counts, {
    messageBodiesRedacted: 0,
    deliveryBodiesNulled: 0,
    workPayloadsRedacted: 0,
    lifecycleRequestPayloadsRedacted: 0,
    lifecycleSegmentBodiesRedacted: 0,
  });
  assert.deepEqual(repeated.reasons, []);
  assert.equal(resumed.historyMessage(edgeUser)?.text, "edge-user-canary");
  assert.equal(resumed.lifecycleRequestById(activeRequest)?.input.text, "active-request-canary");
  assert.equal(resumed.lifecycleRequestById(oldRequest)?.input.text, "[redacted:retention]");
  assert.equal(resumed.lifecycleRequestById(unknownRequest)?.input.text, "[redacted:retention]");
  assert.equal(resumed.lifecycleRequestById(expiredRequest)?.input.text, "[redacted:retention]");
  assert.equal(resumed.lifecycleAudioFence(), unknownAttempt);
  assert.equal(resumed.workItem(admittedWork.item!.workItemId)?.payload?.input.senderKey,
    admittedWork.item!.payload!.input.senderKey);
  assert.equal(resumed.lifecycleAttempt(oldTextAttempt)?.committedRowId, oldBot);
  assert.deepEqual(resumed.lifecycleReceipts(oldTextAttempt).map(receipt => receipt.kind), ["ack"]);
  resumed.close();
  const finalDb = new DatabaseSync(file);
  assert.equal(finalDb.prepare("SELECT semantic_text FROM room_deliveries WHERE id='legacy-stale-delivery'")
    .get()!.semantic_text, null);
  assert.equal(finalDb.prepare("SELECT voice_text FROM room_deliveries WHERE id='legacy-stale-delivery'")
    .get()!.voice_text, null);
  assert.equal(finalDb.prepare("SELECT semantic_text FROM room_deliveries WHERE id='legacy-terminal-delivery'")
    .get()!.semantic_text, null);
  assert.equal(finalDb.prepare("SELECT voice_text FROM room_deliveries WHERE id='legacy-terminal-delivery'")
    .get()!.voice_text, null);
  assert.equal(String(finalDb.prepare("SELECT medium FROM room_lifecycle_attempts WHERE attempt_id=?")
    .get(unknownAttempt)!.medium), "audio");
  assert.equal(Number(finalDb.prepare("SELECT count(*) AS n FROM room_lifecycle_receipts WHERE attempt_id=?")
    .get(unknownAttempt)!.n), 0);
  assert.equal(String(finalDb.prepare("SELECT attempt_id FROM room_lifecycle_audio_fence WHERE id=1")
    .get()!.attempt_id), unknownAttempt);
  assert.equal(finalDb.prepare("PRAGMA user_version").get()!.user_version, 9);
  assert.deepEqual(finalDb.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(String(finalDb.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='room_work_terminal'")
    .get()!.sql), terminalTriggerSql);
  finalDb.close();
});

test("default turnsPerMinute allows a dual-mention two-segment both delivery to complete", async t => {
  let sent = 0;
  const h = await lifecycleHarness(t, {
    config: roomConfig({ deliveryMode: "both" }),
    model: {
      generate: async prompt => ({
        kind: "reply",
        segments: [`${prompt.characterId} 第一段`, `${prompt.characterId} 第二段`],
      }),
    },
    dispatch: async request => {
      request.beforeSend();
      const id = String(810000 + ++sent);
      await request.observe({ kind: "ack", messageId: id });
      if (request.medium === "audio") request.physicalSettled();
      request.released();
      return id;
    },
  });
  assert.equal(h.checkedConfig.limits.turnsPerMinute, 12);
  assert.equal(h.receive("7001", "两位都说说", ["10002", "10003"]), "scheduled");
  await waitFor(() => h.room.store.lifecycleRequests()[0]?.status === "completed", "dual-both-default-limit");
  assert.equal(h.dispatches.length, 8);
  assert.equal(h.dispatches.filter(d => d.medium === "text").length, 4);
  assert.equal(h.dispatches.filter(d => d.medium === "audio").length, 4);
  assert.equal(h.room.store.lifecycleRequests()[0]?.outcomeReason, "all_obligations_terminal");
});

test("owner /room stop cancels in-flight lifecycle work without changing mode and ignores duplicates", async t => {
  const first = deferred<RoomLifecycleAnswer>();
  const second = deferred<RoomLifecycleAnswer>();
  const signals: AbortSignal[] = [];
  const h = await lifecycleHarness(t, {
    model: {
      generate: async (_prompt, signal) => {
        signals.push(signal);
        return signals.length === 1 ? first.promise : second.promise;
      },
    },
  });
  assert.equal(h.receive("7100", "/room mode ambient"), "control");
  assert.equal(h.receive("7101", "先问甲", ["10002"]), "scheduled");
  await waitFor(() => signals.length === 1, "first-generation-started");
  assert.equal(h.receive("7102", "/room stop"), "control");
  assert.equal(signals[0]!.aborted, true);
  assert.equal(h.room.store.lifecycleControlState().mode, "ambient");
  assert.equal(h.room.store.lifecycleRequests()[0]?.status, "cancelled");
  assert.equal(h.room.store.lifecycleRequests()[0]?.outcomeReason, "control_stop");
  first.resolve({ kind: "reply", segments: ["晚到结果不应发出"] });
  await flush();
  assert.equal(h.dispatches.length, 0);

  // Replayed /room stop returns duplicate and must not cancel subsequent work.
  assert.equal(h.receive("7103", "再问乙", ["10003"]), "scheduled");
  await waitFor(() => signals.length === 2, "second-generation-started");
  assert.equal(h.receive("7102", "/room stop"), "duplicate");
  assert.equal(signals[1]!.aborted, false);
  second.resolve({ kind: "reply", segments: ["乙正常回复"] });
  await waitFor(() => h.room.store.lifecycleRequests().find(r => r.input.messageId === "7103")?.status === "completed", "second-completed");
  assert.deepEqual(h.dispatches.map(d => d.text), ["乙正常回复"]);
});
