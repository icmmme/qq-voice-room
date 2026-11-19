import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { QqPeer, type QqAttemptOptions } from "../src/qq-peer.js";
import type { ModelConfig } from "../src/config.js";
import { checkRoomConfig } from "../src/voice-room/config.js";
import { parseRoomQqMessage } from "../src/voice-room/qq-message.js";
import type { RoomQqSettings } from "../src/voice-room/qq-config.js";
import { startRoomQq } from "../src/voice-room/qq-server.js";
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
  assert.equal(h.receive("43", "/room stop"), "rejected");
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

test("ambient initiation boundary is exact and planner input is public and bounded", async t => {
  const base = Date.parse("2026-11-18T00:00:00Z");
  let now = base;
  const h = await lifecycleHarness(t, {
    config: roomConfig({
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1, modelAttemptsPerHour: null },
    }),
    deps: { now: () => now },
    ambientPlanner: {
      plan: async input => input.constraints.allowInitiate
        ? { kind: "initiate", characterIds: ["character-b", "character-a"] }
        : { kind: "initiate", characterIds: ["character-a"] },
    },
    model: { generate: async () => ({ kind: "reply", segments: ["synthetic ambient reply"] }) },
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
  assert.equal(h.ambientPlannerCalls.length, 2);
  assert.equal(h.ambientPlannerCalls[1]!.constraints.allowInitiate, true);
  assert.equal(h.room.store.ambientCursor()?.outcome, "initiate");

  const requests = h.room.store.lifecycleRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.source, "ambient");
  assert.equal(requests[0]!.messageRowId, anchor.id);
  assert.equal(h.room.store.historyMessage(anchor.id)!.text, "我今天终于跑通了离线测试，大家怎么看？");
  assert.deepEqual(h.room.store.lifecycleTurns(requests[0]!.requestId).map(turn => turn.characterId),
    ["character-a", "character-b"]);
  assert.equal(h.room.store.history().filter(row => row.speakerType === "user").length, 14);
  assert.equal(h.dispatches.length, 2);
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
      limits: { ambientQuietMs: 60000, ambientCooldownMs: 1000, modelAttemptsPerHour: 1 },
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
  assert.equal(h.room.store.ambientCursor(), null);
  mutableStore.spend = originalSpend;

  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
  assert.equal(h.ambientPlannerCalls.length, 1);
  assert.equal(h.room.store.counts().model, 1);
  assert.equal(h.room.store.ambientCursor()?.outcome, "skip");
  assert.equal(h.room.store.lifecycleRequests().length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.dispatches.length, 0);
  assert.equal(h.synthesisCalls, 0);

  now = base + AMBIENT_IDLE_THRESHOLD_MS;
  await h.room.ambientOpportunityForTest(anchor.id, QUEUE);
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

test("production startRoomQq wires the ambient planner into the lifecycle FIFO", async t => {
  const root = mkdtempSync(join(tmpdir(), "pa-production-ambient-"));
  let plannerCalls = 0;
  let lifecycleCalls = 0;
  let messageId = 880000;
  const settings: RoomQqSettings = {
    room: checkRoomConfig(roomConfig({ limits: { ambientQuietMs: 100, ambientCooldownMs: 1000 } })),
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
  const lifecycleModel: RoomLifecycleWorker["model"] = {
    generate: async (prompt, _signal, _maxChars) => {
      if (prompt.systemPrompt.includes("Ambient 参与度规划器")) {
        plannerCalls++;
        return { kind: "reply", segments: [JSON.stringify({ kind: "join", characterIds: ["character-a"] })] };
      }
      lifecycleCalls++;
      return { kind: "reply", segments: ["production ambient reply"] };
    },
  };
  const bridge = await startRoomQq(settings, {
    persona: character => `# ${character.name}\nSynthetic public persona.`,
    permitsText: () => true,
    permitsPrompt: () => true,
    lifecycleModel,
  });
  const sockets: WebSocket[] = [];
  const open = async (accountKey: string, selfId: string, token: string) => {
    const socket = new WebSocket(`${bridge.url}/room/${accountKey}`, { headers: {
      "x-client-role": "Universal", "x-self-id": selfId, Authorization: `Bearer ${token}`,
    } });
    sockets.push(socket);
    socket.on("message", raw => {
      let value: any;
      try { value = JSON.parse(raw.toString()); } catch { return; }
      if (value && typeof value.echo === "string" && typeof value.action === "string") {
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
  const send = (socket: WebSocket, id: string, text: string) => socket.send(JSON.stringify({
    post_type: "message", message_type: "group", sub_type: "normal",
    self_id: "10002", group_id: "10000", user_id: "10001", message_id: id,
    message: [{ type: "text", data: { text } }],
  }));
  t.after(async () => {
    for (const socket of sockets) { try { socket.terminate(); } catch { /* already closed */ } }
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  });
  const peerA = await open("account-a", "10002", settings.accounts[0]!.token);
  await open("account-b", "10003", settings.accounts[1]!.token);
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
