import {
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  JsonObject,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { ModelConfig } from "../config.js";
import { estimateTokens } from "../prompting/token-estimate.js";
import type {
  RoomAnswer,
  RoomModelToolScope,
  RoomPrompt,
  SyntheticResponsePort,
} from "./types.js";
import { buildWorkerAssistancePrompt } from "./context.js";
import type { CheckedRoomConfig } from "./config.js";
import { RoomModelDiagnostics, type RoomModelDiagnostic } from "./model-diagnostics.js";

export const ROOM_MODEL_ROUND_LIMIT = 8;
export const ROOM_TOOL_ATTEMPT_LIMIT = 12;
export const ROOM_MODEL_ROUND_TIMEOUT_MS = 60000;
export const ROOM_LIFECYCLE_MAX_TOKENS = 1024;
export const ROOM_LIFECYCLE_PROTOCOL_RESERVE_TOKENS = 256;

export type RoomModelFailure = "incomplete" | "empty" | "invalid-json" | "invalid-schema"
  | "request" | "cancelled" | "deadline" | "budget" | "context-budget" | "tool-protocol";

export class RoomModelError extends Error {
  constructor(readonly code: RoomModelFailure) {
    super(code === "incomplete" || code === "deadline" || code === "budget"
      || code === "context-budget" || code === "tool-protocol"
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

type CompletionParser<T> = (result: AssistantMessage) => T;

interface RoomModelRun<T> {
  readonly maxTokens: number;
  readonly parse: CompletionParser<T>;
  readonly exactWorkerBudget?: boolean;
}

const PUBLIC_TOOL_NAMES = Object.freeze(["github_read", "web_fetch", "web_search"]);
const TOOL_RESULT_CHARS = 48 * 1024;
const COMPACT_KEEP_RESULTS = 1;

function publicTools(scope: RoomModelToolScope | undefined): readonly Tool[] {
  if (!scope) return Object.freeze([]);
  const declarations = scope.tools.declarations;
  if (!Array.isArray(declarations) || declarations.length !== PUBLIC_TOOL_NAMES.length
    || declarations.some(tool => !tool || typeof tool.name !== "string")
    || [...declarations].map(tool => tool.name).sort().join(",") !== PUBLIC_TOOL_NAMES.join(",")
    || new Set(declarations.map(tool => tool.name)).size !== PUBLIC_TOOL_NAMES.length) {
    throw new RoomModelError("request");
  }
  return declarations;
}

function messageText(message: Message): string {
  if (message.role === "user" || message.role === "system") {
    return typeof message.content === "string"
      ? message.content : JSON.stringify(message.content);
  }
  if (message.role === "assistant") {
    return JSON.stringify(message.content.map(block => block.type === "text"
      ? { type: "text", text: block.text }
      : block.type === "thinking"
        ? { type: "thinking", thinking: block.thinking }
        : { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments,
          ...(block.argumentsError ? { argumentsError: block.argumentsError } : {}) }));
  }
  return JSON.stringify(message.content);
}

function conversationTokens(systemPrompt: string, messages: readonly Message[]): number {
  return estimateTokens(systemPrompt) + messages.reduce((sum, message) =>
    sum + estimateTokens(messageText(message)), 0);
}

function toolResult(message: Message): message is ToolResultMessage {
  return message.role === "toolResult";
}

function compactedToolResult(message: ToolResultMessage): ToolResultMessage {
  const originalText = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
  const excerpt = originalText.slice(0, 512);
  return {
    ...message,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        kind: "context_compacted",
        status: "compacted",
        contextCompacted: true,
        trust: "external-untrusted",
        note: "An older bounded tool result was omitted to preserve the current task and latest evidence.",
        excerpt,
        excerptChars: excerpt.length,
        originalChars: originalText.length,
      }),
    }],
  };
}

/**
 * Keep the initial task, assistant tool calls, and newest evidence. Under
 * pressure, only older tool-result bodies are replaced with a visible marker.
 */
function compactConversation(systemPrompt: string, messages: Message[], inputBudget: number,
  onCompact: RoomModelToolScope["onContextCompacted"]): Message[] {
  let compacted = [...messages];
  let compactedCount = 0;
  for (let index = 0; index < compacted.length; index++) {
    if (conversationTokens(systemPrompt, compacted) <= inputBudget) break;
    const resultIndexes = compacted.flatMap((message, itemIndex) => toolResult(message) ? [itemIndex] : []);
    const targetIndex = resultIndexes.slice(0, Math.max(0, resultIndexes.length - COMPACT_KEEP_RESULTS))
      .find(itemIndex => {
        const message = compacted[itemIndex];
        return message !== undefined && toolResult(message) && !message.content.some(block =>
          block.type === "text" && block.text.includes('"contextCompacted":true'));
      });
    if (targetIndex === undefined) break;
    const target = compacted[targetIndex];
    if (target === undefined || !toolResult(target)) break;
    compacted[targetIndex] = compactedToolResult(target);
    compactedCount++;
  }
  const usedTokens = conversationTokens(systemPrompt, compacted);
  if (compactedCount > 0) {
    try {
      onCompact?.(Object.freeze({ compactedResults: compactedCount, usedTokens, inputBudget }));
    } catch { /* Diagnostics cannot alter the model request. */ }
  }
  if (usedTokens > inputBudget) throw new RoomModelError("context-budget");
  return compacted;
}

function toolFailure(name: string, code: string, usage?: unknown): {
  readonly value: unknown;
  readonly isError: true;
} {
  return Object.freeze({
    value: Object.freeze({
      kind: "tool_error",
      status: "error",
      errorCode: code,
      trust: "external-untrusted",
      ...(usage === undefined ? {} : { usage }),
    }),
    isError: true,
  });
}

function boundedToolText(value: unknown, isError: boolean): string {
  let text: string;
  try { text = JSON.stringify(value); }
  catch {
    return JSON.stringify({
      kind: "tool_error", status: "error", errorCode: "invalid_response",
      trust: "external-untrusted", isError: true,
    });
  }
  if (typeof text !== "string" || text.length > TOOL_RESULT_CHARS) {
    return JSON.stringify({
      kind: "tool_error", status: "error", errorCode: "result_too_large",
      trust: "external-untrusted", isError: true,
    });
  }
  if (text === undefined) text = JSON.stringify({
    kind: "tool_error", status: "error", errorCode: "invalid_response",
    trust: "external-untrusted", isError: true,
  });
  return text;
}

function toolMessage(call: ToolCall, value: unknown, isError: boolean, now: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text" as const, text: boundedToolText(value, isError) }],
    isError,
    timestamp: now,
  };
}

interface AssistantReplay {
  readonly message: AssistantMessage;
  readonly calls: readonly ToolCall[];
  readonly protectedCalls: readonly boolean[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): value is JsonObject {
  if (!record(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function safeString(value: unknown, containsProtectedText: (value: unknown) => boolean): value is string {
  return typeof value === "string" && !containsProtectedText(value);
}

/**
 * Rebuild only the assistant fields that can be replayed to the model. The
 * complete raw content is scanned first; any protected value taints the
 * message. A tainted message never executes a tool, and unsafe call identity
 * fields are replaced with deterministic protocol-safe values.
 */
function replaySafeAssistant(result: AssistantMessage,
  containsProtectedText: (value: unknown) => boolean): AssistantReplay {
  let messageProtected = false;
  try {
    messageProtected = containsProtectedText(result.content) === true;
  } catch {
    messageProtected = true;
  }

  const content: AssistantMessage["content"] = [];
  const calls: ToolCall[] = [];
  const protectedCalls: boolean[] = [];
  const usedIds = new Set<string>();
  for (const block of result.content as readonly unknown[]) {
    if (!record(block) || typeof block.type !== "string") {
      if (messageProtected) continue;
      throw new RoomModelError("tool-protocol");
    }
    let blockProtected = false;
    try {
      blockProtected = containsProtectedText(block) === true;
    } catch {
      blockProtected = true;
    }
    if (block.type === "text") {
      if (!onlyKeys(block, ["type", "text", "textSignature"])
        || typeof block.text !== "string"
        || (block.textSignature !== undefined && typeof block.textSignature !== "string")) {
        if (messageProtected) continue;
        throw new RoomModelError("tool-protocol");
      }
      if (blockProtected) continue;
      content.push({
        type: "text",
        text: block.text,
        ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
      });
      continue;
    }
    if (block.type === "thinking") {
      if (!onlyKeys(block, ["type", "thinking", "thinkingSignature", "redacted"])
        || typeof block.thinking !== "string"
        || (block.thinkingSignature !== undefined && typeof block.thinkingSignature !== "string")
        || (block.redacted !== undefined && typeof block.redacted !== "boolean")) {
        if (messageProtected) continue;
        throw new RoomModelError("tool-protocol");
      }
      if (blockProtected) continue;
      content.push({
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      });
      continue;
    }
    if (block.type !== "toolCall") {
      if (messageProtected) continue;
      throw new RoomModelError("tool-protocol");
    }
    if (!onlyKeys(block, ["type", "id", "name", "arguments", "thoughtSignature",
      "namespace", "argumentsError"])
      || !jsonObject(block.arguments)
      || (block.thoughtSignature !== undefined && typeof block.thoughtSignature !== "string")
      || (block.namespace !== undefined && typeof block.namespace !== "string")
      || (block.argumentsError !== undefined && typeof block.argumentsError !== "string")) {
      if (messageProtected) continue;
      throw new RoomModelError("tool-protocol");
    }

    const callProtected = messageProtected || blockProtected;
    let safeId = !blockProtected && safeString(block.id, containsProtectedText) && block.id.length > 0
      ? block.id : "";
    if (!safeId || usedIds.has(safeId)) {
      let suffix = calls.length;
      do safeId = `room_call_${suffix++}`;
      while (usedIds.has(safeId));
    }
    usedIds.add(safeId);
    if (typeof block.name !== "string" || block.name.length === 0) {
      if (messageProtected) continue;
      throw new RoomModelError("tool-protocol");
    }
    // A protected name stays on the protected-call path; it is never turned
    // into a different executable public tool.
    const safeName = safeString(block.name, containsProtectedText)
      ? block.name : "web_search";
    const safeArguments: JsonObject = blockProtected ? {} : block.arguments;
    const safeArgumentsError = !blockProtected && safeString(block.argumentsError, containsProtectedText)
      ? block.argumentsError : undefined;
    const safeThoughtSignature = !blockProtected && safeString(block.thoughtSignature, containsProtectedText)
      ? block.thoughtSignature : undefined;
    const safeNamespace = !blockProtected && safeString(block.namespace, containsProtectedText)
      ? block.namespace : undefined;
    const call: ToolCall = {
      type: "toolCall",
      id: safeId,
      name: safeName,
      arguments: safeArguments,
      ...(safeThoughtSignature === undefined ? {} : { thoughtSignature: safeThoughtSignature }),
      ...(safeNamespace === undefined ? {} : { namespace: safeNamespace }),
      ...(safeArgumentsError === undefined ? {} : { argumentsError: safeArgumentsError }),
    };
    content.push(call);
    calls.push(call);
    protectedCalls.push(callProtected);
  }

  const api = safeString(result.api, containsProtectedText) ? result.api : "openai-completions";
  const provider = safeString(result.provider, containsProtectedText) ? result.provider : "room-provider";
  const model = safeString(result.model, containsProtectedText) ? result.model : "room-model";
  const message: AssistantMessage = {
      role: "assistant",
      content,
      api,
      provider,
      model,
      usage: result.usage,
      stopReason: result.stopReason,
      timestamp: result.timestamp,
  };
  return Object.freeze({
    message,
    calls: Object.freeze(calls),
    protectedCalls: Object.freeze(protectedCalls),
  });
}

function diagnosticStage(prompt: RoomPrompt): RoomModelDiagnostic["stage"] {
  try {
    return Object.hasOwn(JSON.parse(prompt.messages[0].content), "voiceTranslation")
      ? "voice-translation" : "reply";
  } catch { return "reply"; }
}

/** Stateless low-level model invocation; it never receives PA sessions, memory, agents or extensions. */
function roomModelRequest<T>(config: ModelConfig, roomDataDir: string,
  run: RoomModelRun<T>,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void) {
  const thinkingDisableRequested = config.modelId === "deepseek-flash" || config.modelId === "deepseek-v4-pro";
  const generate = async (prompt: RoomPrompt, signal: AbortSignal,
    scope: RoomModelToolScope | undefined, diagnostic: RoomModelDiagnostics): Promise<T> => {
    signal.throwIfAborted();
    if (run.exactWorkerBudget && estimateTokens(prompt.systemPrompt
      + prompt.messages.map(message => message.content).join("\n")) + run.maxTokens + 1024 > config.contextWindow) {
      throw new RoomModelError("context-budget");
    }
    const tools = publicTools(scope);
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
    signal.throwIfAborted();
    const model = runtime.getModel("room-provider", config.modelId)!;
    let messages: Message[] = prompt.messages.map(message => ({
      role: "user" as const, content: message.content, timestamp: Date.now(),
    }));

    const completeRound = async (roundTools: readonly Tool[]) => {
      const now = Date.now();
      if (scope) {
        const remaining = Math.floor(scope.turnDeadline.remainingMs());
        if (remaining <= 0) throw new RoomModelError("deadline");
      }
      const remaining = scope ? Math.floor(scope.turnDeadline.remainingMs()) : ROOM_MODEL_ROUND_TIMEOUT_MS;
      if (remaining <= 0) throw new RoomModelError("deadline");
      const timeoutMs = Math.max(1, Math.min(ROOM_MODEL_ROUND_TIMEOUT_MS, remaining));
      const inputBudget = config.contextWindow - run.maxTokens - 1024;
      if (inputBudget < 1) throw new RoomModelError("context-budget");
      messages = compactConversation(prompt.systemPrompt, messages, inputBudget,
        scope?.onContextCompacted);
      let result: AssistantMessage;
      try {
        result = await runtime.complete(model, {
          systemPrompt: prompt.systemPrompt,
          tools: [...roundTools],
          messages,
        }, {
          signal,
          timeoutMs,
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
            const thinking = thinkingDisableRequested
              ? { thinking: { type: "disabled" } } : {};
            const responseFormat = roundTools.length === 0
              ? { response_format: { type: "json_object" } } : {};
            return { ...payload, ...thinking, ...responseFormat };
          },
        });
      } catch (error) {
        if (signal.aborted) throw new RoomModelError("cancelled");
        if (scope && scope.turnDeadline.remainingMs() <= 0) throw new RoomModelError("deadline");
        throw error;
      }
      try { diagnostic.result(result); } catch { diagnostic.incomplete(); }
      signal.throwIfAborted();
      if (result.stopReason === "aborted") throw new RoomModelError("cancelled");
      if (diagnostic.snapshot().provider.finishReason === "content_filter") {
        throw new RoomModelError("incomplete");
      }
      if (result.stopReason === "error") throw new RoomModelError("request");
      return result;
    };

    if (!scope) {
      const result = await completeRound(Object.freeze([]));
      return run.parse(result);
    }

    let toolAttempts = 0;
    let finalNoTools = false;
    for (let round = 0; round < ROOM_MODEL_ROUND_LIMIT; round++) {
      signal.throwIfAborted();
      if (scope.turnDeadline.remainingMs() <= 0) throw new RoomModelError("deadline");
      if (round > 0 && scope.authorizeModelRound && !scope.authorizeModelRound()) {
        throw new RoomModelError("budget");
      }
      const result = await completeRound(finalNoTools ? Object.freeze([]) : tools);
      const replay = replaySafeAssistant(result, value => scope.tools.containsProtectedText(value));
      const calls = replay.calls;
      if (!calls.length) {
        if (result.content.some(block => block.type === "toolCall")) throw new RoomModelError("tool-protocol");
        return run.parse(result);
      }
      if (finalNoTools || result.stopReason !== "toolUse") throw new RoomModelError("tool-protocol");

      signal.throwIfAborted();

      messages.push(replay.message);
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!;
        const protectedCall = replay.protectedCalls[index] === true;
        let value: unknown;
        let isError: boolean;
        if (protectedCall && toolAttempts >= ROOM_TOOL_ATTEMPT_LIMIT) {
          const failure = toolFailure(call.name, "privacy_rejected", scope.tools.usage?.());
          value = failure.value;
          isError = true;
        } else if (toolAttempts >= ROOM_TOOL_ATTEMPT_LIMIT) {
          const failure = toolFailure(call.name, "budget_attempt", scope.tools.usage?.());
          value = failure.value;
          isError = true;
        } else if (protectedCall) {
          toolAttempts++;
          if (signal.aborted) throw new RoomModelError("cancelled");
          if (scope.turnDeadline.remainingMs() <= 0) {
            const failure = toolFailure(call.name, "deadline", scope.tools.usage?.());
            value = failure.value;
            isError = true;
          } else {
            try {
              const rejected = await scope.tools.rejectProtected(call, {
                signal,
                turnDeadline: scope.turnDeadline,
                providerRetry: "none",
              });
              value = rejected.value;
              isError = true;
            } catch {
              if (signal.aborted) throw new RoomModelError("cancelled");
              const failure = toolFailure(call.name, "privacy_rejected", scope.tools.usage?.());
              value = failure.value;
              isError = true;
            }
          }
        } else {
          toolAttempts++;
          if (signal.aborted) throw new RoomModelError("cancelled");
          if (scope.turnDeadline.remainingMs() <= 0) {
            const failure = toolFailure(call.name, "deadline", scope.tools.usage?.());
            value = failure.value;
            isError = true;
          } else {
            try {
              const executed = await scope.tools.execute(call, {
                signal,
                turnDeadline: scope.turnDeadline,
                providerRetry: "none",
              });
              value = executed.value;
              isError = executed.isError;
            } catch {
              if (signal.aborted) throw new RoomModelError("cancelled");
              const failure = toolFailure(call.name, "failed", scope.tools.usage?.());
              value = failure.value;
              isError = true;
            }
          }
        }
        messages.push(toolMessage(call, value, isError, Date.now()));
      }
      if (toolAttempts >= ROOM_TOOL_ATTEMPT_LIMIT) finalNoTools = true;
      if (round === ROOM_MODEL_ROUND_LIMIT - 1) throw new RoomModelError("incomplete");
    }
    throw new RoomModelError("incomplete");
  };

  return async (prompt: RoomPrompt, signal: AbortSignal,
    scope?: RoomModelToolScope): Promise<T> => {
    const diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), run.maxTokens, thinkingDisableRequested);
    try { return await generate(prompt, signal, scope, diagnostic); }
    catch (error) {
      const code = signal.aborted ? "cancelled" : error instanceof RoomModelError ? error.code : "request";
      try { onFailure(code, diagnostic.snapshot(signal.aborted)); }
      catch { /* Metadata observers cannot change delivery. */ }
      if (code === "cancelled") throw new RoomModelError("cancelled");
      throw error;
    }
  };
}

export function roomGenerator(config: ModelConfig, roomDataDir: string,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}) {
  return roomModelRequest(config, roomDataDir, {
    maxTokens: Math.min(config.maxTokens, 256),
    parse: result => parseRoomAnswer(result.stopReason, result.content),
  }, onFailure);
}

/** Worker output budgets are R9's separate approved limits, never Legacy's 256-token cap. */
export function roomWorkerModel(config: ModelConfig, room: CheckedRoomConfig, roomDataDir: string,
  permitsPrompt: (prompt: RoomPrompt) => boolean,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}):
  Pick<SyntheticResponsePort, "plan" | "generate"> {
  const ensure = (prompt: RoomPrompt, tokens: number) => {
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens + 1024 >= config.contextWindow || !permitsPrompt(prompt)) {
      throw new Error("room-worker-model-request-invalid");
    }
  };
  return {
    plan: async (request, signal) => {
      const id = request.context.target.characterIds[request.context.primaryText ? 1 : 0];
      const character = room.characters.find(c => c.id === id);
      if (!character) throw new Error("room-worker-model-request-invalid");
      const prompt = buildWorkerAssistancePrompt(character, request, room.limits);
      ensure(prompt, 512);
      return roomModelRequest(config, roomDataDir, {
        maxTokens: 512,
        exactWorkerBudget: true,
        parse: result => {
          if (result.stopReason !== "stop") throw new RoomModelError("incomplete");
          const text = result.content.filter(block => block.type === "text")
            .map(block => block.type === "text" ? block.text : "").join("");
          try { return JSON.parse(text) as unknown; }
          catch { throw new RoomModelError("invalid-json"); }
        },
      }, onFailure)(prompt, signal);
    },
    generate: async (request, signal, tools) => {
      ensure(request.prompt, request.budget.outputTokens);
      if (request.budget.outputTokens !== request.binding.plan.budget.outputTokens
        || request.budget.maxTextChars !== request.binding.plan.budget.maxTextChars) {
        throw new Error("room-worker-model-request-invalid");
      }
      return roomModelRequest(config, roomDataDir, {
        maxTokens: request.budget.outputTokens,
        exactWorkerBudget: true,
        parse: result => parseRoomAnswer(result.stopReason, result.content),
      }, onFailure)(request.prompt, signal, tools);
    },
  };
}

export function roomWorkerVoiceTranslator(config: ModelConfig, roomDataDir: string,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}) {
  const generate = roomModelRequest(config, roomDataDir, {
    maxTokens: 2048,
    exactWorkerBudget: true,
    parse: result => parseRoomAnswer(result.stopReason, result.content),
  }, onFailure);
  return async (prompt: RoomPrompt, signal: AbortSignal): Promise<string> => {
    const result = await generate(prompt, signal);
    if (result.kind !== "reply") throw new RoomModelError("invalid-schema");
    return result.text;
  };
}

/**
 * Worker-only lifecycle model. It deliberately receives no tool scope and sends an
 * explicit protocol override after the legacy one-reply prompt.
 */
export function roomLifecycleGenerator(config: ModelConfig, roomDataDir: string,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}):
  (prompt: RoomPrompt, signal: AbortSignal, maxChars: number) => Promise<RoomLifecycleAnswer> {
  const maxTokens = Math.max(1, Math.min(config.maxTokens, ROOM_LIFECYCLE_MAX_TOKENS));
  return async (prompt, signal, maxChars) => {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("room-lifecycle-model-request-invalid");
    const systemPrompt = `${prompt.systemPrompt}

Lifecycle output protocol (overrides every earlier tool or single-reply instruction):
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
    return roomModelRequest(config, roomDataDir, {
      maxTokens,
      exactWorkerBudget: true,
      parse: result => parseRoomLifecycleAnswer(result.stopReason, result.content),
    }, onFailure)(lifecyclePrompt, signal);
  };
}

/** Reuses the same generator/endpoint and JSON protocol; no additional agent or hidden retry. */
export function roomVoiceTranslator(generate: ReturnType<typeof roomGenerator>) {
  return async (prompt: RoomPrompt, signal: AbortSignal): Promise<string> => {
    const answer = await generate(prompt, signal);
    if (answer.kind !== "reply") throw new RoomModelError("invalid-schema");
    return answer.text;
  };
}
