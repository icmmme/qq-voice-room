import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { ModelConfig } from "../config.js";
import { estimateTokens } from "../prompting/token-estimate.js";
import type { RoomAnswer, RoomPrompt } from "./types.js";
import { RoomModelDiagnostics, type RoomModelDiagnostic } from "./model-diagnostics.js";

export const ROOM_MODEL_ROUND_TIMEOUT_MS = 60000;
export const ROOM_LIFECYCLE_MAX_TOKENS = 1024;
export const ROOM_LIFECYCLE_PROTOCOL_RESERVE_TOKENS = 256;

export type RoomModelFailure = "incomplete" | "empty" | "invalid-json" | "invalid-schema"
  | "request" | "cancelled" | "deadline" | "budget" | "context-budget";

export class RoomModelError extends Error {
  constructor(readonly code: RoomModelFailure) {
    super(code === "incomplete" || code === "deadline" || code === "budget"
      || code === "context-budget"
      ? "room-model-failed" : "room-model-format");
  }
}

export function parseRoomAnswer(stopReason: string,
  content: readonly { readonly type: string; readonly text?: string }[]): RoomAnswer {
  if (stopReason !== "stop") throw new RoomModelError("incomplete");
  const text = content.filter((item): item is { type: "text"; text: string } =>
    item.type === "text" && typeof item.text === "string").map(item => item.text).join("");
  if (!text.trim()) throw new RoomModelError("empty");
  let answer: unknown;
  try { answer = JSON.parse(text); }
  catch { throw new RoomModelError("invalid-json"); }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new RoomModelError("invalid-schema");
  const row = answer as Record<string, unknown>;
  if (row.kind === "skip" && Object.keys(row).length === 1) return { kind: "skip" };
  if (row.kind === "reply" && typeof row.text === "string" && Object.keys(row).sort().join(",") === "kind,text") {
    return { kind: "reply", text: row.text };
  }
  throw new RoomModelError("invalid-schema");
}

export type RoomLifecycleAnswer =
  | { readonly kind: "skip" }
  | { readonly kind: "reply"; readonly segments: readonly string[] };

/** Strict tools-free lifecycle protocol. A target @ may never be swallowed by `skip`. */
export function parseRoomLifecycleAnswer(stopReason: string,
  content: readonly { readonly type: string; readonly text?: string }[]): RoomLifecycleAnswer {
  if (stopReason !== "stop") throw new RoomModelError("incomplete");
  const text = content.filter((item): item is { type: "text"; text: string } =>
    item.type === "text" && typeof item.text === "string").map(item => item.text).join("");
  if (!text.trim()) throw new RoomModelError("empty");
  let answer: unknown;
  try { answer = JSON.parse(text); }
  catch { throw new RoomModelError("invalid-json"); }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new RoomModelError("invalid-schema");
  const row = answer as Record<string, unknown>;
  if (row.kind === "skip" && Object.keys(row).length === 1) return Object.freeze({ kind: "skip" });
  if (row.kind === "reply" && Object.keys(row).sort().join(",") === "kind,segments"
    && Array.isArray(row.segments) && row.segments.length >= 1 && row.segments.length <= 2
    && row.segments.every(segment => typeof segment === "string" && segment.trim().length > 0
      && !segment.includes("\0"))) {
    return Object.freeze({ kind: "reply", segments: Object.freeze(row.segments.map(segment => segment.trim())) });
  }
  throw new RoomModelError("invalid-schema");
}

interface RoomModelRun<T> {
  readonly maxTokens: number;
  readonly parse: (result: AssistantMessage) => T;
}

function diagnosticStage(prompt: RoomPrompt): RoomModelDiagnostic["stage"] {
  try {
    return Object.hasOwn(JSON.parse(prompt.messages[0].content), "voiceTranslation")
      ? "voice-translation" : "reply";
  } catch { return "reply"; }
}

/** Stateless low-level tools-free model invocation; reuses one ModelRuntime per configuration. */
function roomModelRequest<T>(config: ModelConfig, roomDataDir: string,
  run: RoomModelRun<T>,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void) {
  const thinkingDisableRequested = config.modelId === "deepseek-flash" || config.modelId === "deepseek-v4-pro";
  let runtimePromise: Promise<ModelRuntime> | undefined;
  const getRuntime = (): Promise<ModelRuntime> => {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const runtime = await ModelRuntime.create({
          authPath: join(roomDataDir, "model", "auth.json"), modelsPath: null,
          allowModelNetwork: false, refreshOnCreate: false,
        });
        runtime.registerProvider("room-provider", {
          baseUrl: config.baseUrl, api: "openai-completions", models: [{
            id: config.modelId, name: config.modelId, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: config.contextWindow, maxTokens: run.maxTokens,
            compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
          }],
        });
        await runtime.setRuntimeApiKey("room-provider", config.apiKey);
        return runtime;
      })().catch(error => {
        runtimePromise = undefined;
        throw error;
      });
    }
    return runtimePromise;
  };

  const generate = async (prompt: RoomPrompt, signal: AbortSignal,
    diagnostic: RoomModelDiagnostics): Promise<T> => {
    signal.throwIfAborted();
    const inputBudget = config.contextWindow - run.maxTokens - 1024;
    if (inputBudget < 1 || estimateTokens(prompt.systemPrompt
      + prompt.messages.map(message => message.content).join("\n")) > inputBudget) {
      throw new RoomModelError("context-budget");
    }
    const runtime = await getRuntime();
    signal.throwIfAborted();
    const model = runtime.getModel("room-provider", config.modelId)!;
    const messages: Message[] = prompt.messages.map(message => ({
      role: "user" as const, content: message.content, timestamp: Date.now(),
    }));
    let result: AssistantMessage;
    try {
      result = await runtime.complete(model, {
        systemPrompt: prompt.systemPrompt,
        tools: [],
        messages,
      }, {
        signal,
        timeoutMs: ROOM_MODEL_ROUND_TIMEOUT_MS,
        maxTokens: run.maxTokens,
        maxRetries: 0,
        onResponse: response => {
          try { diagnostic.response(response.status, response.headers); }
          catch { diagnostic.incomplete(); }
        },
        onProviderStreamEvent: event => {
          try { diagnostic.event(event); }
          catch { diagnostic.incomplete(); }
        },
        onPayload: payload => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("room-model-payload");
          }
          const thinking = thinkingDisableRequested ? { thinking: { type: "disabled" } } : {};
          return { ...payload, ...thinking, response_format: { type: "json_object" } };
        },
      });
    } catch (error) {
      if (signal.aborted) throw new RoomModelError("cancelled");
      throw error;
    }
    try { diagnostic.result(result); } catch { diagnostic.incomplete(); }
    signal.throwIfAborted();
    if (result.stopReason === "aborted") throw new RoomModelError("cancelled");
    if (diagnostic.snapshot().provider.finishReason === "content_filter") {
      throw new RoomModelError("incomplete");
    }
    if (result.stopReason === "error") throw new RoomModelError("request");
    return run.parse(result);
  };

  return async (prompt: RoomPrompt, signal: AbortSignal): Promise<T> => {
    const diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), run.maxTokens, thinkingDisableRequested);
    try { return await generate(prompt, signal, diagnostic); }
    catch (error) {
      const code = signal.aborted ? "cancelled" : error instanceof RoomModelError ? error.code : "request";
      try { onFailure(code, diagnostic.snapshot(signal.aborted)); }
      catch { /* Metadata observers cannot change delivery. */ }
      if (code === "cancelled") throw new RoomModelError("cancelled");
      throw error;
    }
  };
}

export function roomWorkerVoiceTranslator(config: ModelConfig, roomDataDir: string,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}) {
  const generate = roomModelRequest(config, roomDataDir, {
    maxTokens: 2048,
    parse: result => parseRoomAnswer(result.stopReason, result.content),
  }, onFailure);
  return async (prompt: RoomPrompt, signal: AbortSignal): Promise<string> => {
    const result = await generate(prompt, signal);
    if (result.kind !== "reply") throw new RoomModelError("invalid-schema");
    return result.text;
  };
}

/** Tools-free lifecycle reply generator. */
export function roomLifecycleGenerator(config: ModelConfig, roomDataDir: string,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}):
  (prompt: RoomPrompt, signal: AbortSignal, maxChars: number) => Promise<RoomLifecycleAnswer> {
  const maxTokens = Math.max(1, Math.min(config.maxTokens, ROOM_LIFECYCLE_MAX_TOKENS));
  const request = roomModelRequest(config, roomDataDir, {
    maxTokens,
    parse: result => parseRoomLifecycleAnswer(result.stopReason, result.content),
  }, onFailure);
  return async (prompt, signal, maxChars) => {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("room-lifecycle-model-request-invalid");
    const systemPrompt = `${prompt.systemPrompt}

Lifecycle output protocol (overrides every earlier instruction):
- This request is tools-free. Never emit a tool call.
- Return exactly one JSON object with no markdown.
- A skip is encoded as {"kind":"skip"}.
- A reply is encoded as {"kind":"reply","segments":[string,...]} with one or two non-empty segments.
- Each segment must be at most ${maxChars} Unicode characters.
- Do not return more than two segments and never pad a one-segment reply.`;
    const lifecyclePrompt: RoomPrompt = Object.freeze({
      ...prompt,
      systemPrompt,
      tools: Object.freeze([]) as readonly [],
    });
    return request(lifecyclePrompt, signal);
  };
}
