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
import { roomPublicPolicy } from "../src/voice-room/public-policy.js";
import {
  VoiceRoom,
  WORKER_EXPLICIT_NO_ANSWER_FALLBACK,
  type RoomLifecycleDispatch,
  type RoomLifecycleWorker,
} from "../src/voice-room/runtime.js";
import type { RoomQueuePolicy } from "../src/voice-room/store.js";
import { RoomSendError, type RoomConfig, type RoomDependencies, type RoomInput } from "../src/voice-room/types.js";
import type { RoomLifecycleAnswer } from "../src/voice-room/model.js";
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
  deps?: Partial<RoomDependencies>;
}): Promise<LifecycleHarness> {
  const root = mkdtempSync(join(tmpdir(), "pa-lifecycle-test-"));
  const checkedConfig = checkRoomConfig(options.config ?? roomConfig());
  let sent = 0;
  let synthesisCalls = 0;
  const prompts: LifecycleHarness["prompts"] = [];
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
  assert.equal(turn.status, "failed");
  assert.equal(translated.room.store.lifecycleSegments(turn.turnId)[0]!.reason, "voice_translation_unavailable");
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
