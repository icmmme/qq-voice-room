import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, Message, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { ModelConfig } from "../config.js";
import { estimateTokens } from "../prompting/token-estimate.js";
import type { RoomAnswer, RoomPrompt } from "./types.js";
import { RoomModelDiagnostics, type RoomModelDiagnostic } from "./model-diagnostics.js";
import { dynamicPageTokenBudget, WEB_HARD_CHAR_CEILING, type RoomWebToolkit } from "./web.js";

export const ROOM_MODEL_ROUND_TIMEOUT_MS = 90000;
export const ROOM_LIFECYCLE_MAX_TOKENS = 1024;
export const ROOM_LIFECYCLE_DEEP_MAX_TOKENS = 6144;
export const ROOM_LIFECYCLE_PROTOCOL_RESERVE_TOKENS = 256;
export const ROOM_LIFECYCLE_DEEP_MAX_SEGMENTS = 12;
const ROOM_MAX_TOOL_ROUNDS = 3;
const ROOM_MAX_TOOL_CALLS_PER_ROUND = 3;

export type RoomModelFailure = "incomplete" | "empty" | "invalid-json" | "invalid-schema"
  | "request" | "cancelled" | "deadline" | "budget" | "context-budget";

export class RoomModelError extends Error {
  constructor(readonly code: RoomModelFailure) {
    super(code === "incomplete" || code === "deadline" || code === "budget"
      || code === "context-budget"
      ? "room-model-failed" : "room-model-format");
  }
}

export interface RoomLifecycleGenerateOptions {
  readonly maxSegments?: number;
  readonly deep?: boolean;
  readonly web?: RoomWebToolkit;
  readonly images?: readonly ImageContent[];
}

export function hasVisionModel(config: ModelConfig): boolean {
  return Boolean(config.visionModelId || config.modelSupportsVision);
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

function extractAssistantText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.filter((item): item is { type: "text"; text: string } =>
    item.type === "text" && typeof item.text === "string").map(item => item.text).join("");
}

export function parseRoomAnswer(stopReason: string,
  content: readonly { readonly type: string; readonly text?: string }[]): RoomAnswer {
  if (stopReason !== "stop") throw new RoomModelError("incomplete");
  const text = extractAssistantText(content);
  if (!text.trim()) throw new RoomModelError("empty");
  let answer: unknown;
  try { answer = JSON.parse(stripJsonFence(text)); }
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

/** Strict lifecycle protocol parser. Casual mode allows 1..2 segments; deep mode allows up to `maxSegments`. */
export function parseRoomLifecycleAnswer(stopReason: string,
  content: readonly { readonly type: string; readonly text?: string }[],
  maxSegments = 2): RoomLifecycleAnswer {
  if (stopReason !== "stop") throw new RoomModelError("incomplete");
  const text = extractAssistantText(content);
  if (!text.trim()) throw new RoomModelError("empty");
  let answer: unknown;
  try { answer = JSON.parse(stripJsonFence(text)); }
  catch { throw new RoomModelError("invalid-json"); }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new RoomModelError("invalid-schema");
  const row = answer as Record<string, unknown>;
  if (row.kind === "skip" && Object.keys(row).length === 1) return Object.freeze({ kind: "skip" });
  if (row.kind === "reply" && Object.keys(row).sort().join(",") === "kind,segments"
    && Array.isArray(row.segments) && row.segments.length >= 1 && row.segments.length <= maxSegments
    && row.segments.every(segment => typeof segment === "string" && segment.trim().length > 0
      && !segment.includes("\0"))) {
    return Object.freeze({ kind: "reply", segments: Object.freeze(row.segments.map(segment => segment.trim())) });
  }
  throw new RoomModelError("invalid-schema");
}

function normalizeDeepSegments(rawSegments: readonly string[], maxSegments: number, maxChars: number): readonly string[] | null {
  const expanded: string[] = [];
  for (const raw of rawSegments) {
    const cleaned = raw.replace(/\r\n?/g, "\n").trim();
    if (!cleaned || cleaned.includes("\0")) continue;
    if ([...cleaned].length <= maxChars) {
      expanded.push(cleaned);
      continue;
    }
    // Split overlong paragraphs cleanly at newline or sentence boundaries.
    let rest = cleaned;
    while ([...rest].length > maxChars) {
      const slice = [...rest].slice(0, maxChars).join("");
      const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"), slice.lastIndexOf(". "));
      const cut = breakAt >= Math.floor(slice.length * 0.4) ? breakAt + 1 : slice.length;
      expanded.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) expanded.push(rest);
  }
  if (!expanded.length) return null;
  const merged: string[] = [];
  for (const para of expanded) {
    if (merged.length < maxSegments) {
      merged.push(para);
    } else {
      const combined = `${merged[merged.length - 1]}\n\n${para}`;
      if ([...combined].length <= maxChars) {
        merged[merged.length - 1] = combined;
      } else {
        // Keep last slot within maxChars rather than failing the whole deep answer.
        merged[merged.length - 1] = [...combined].slice(0, maxChars).join("");
      }
    }
  }
  return Object.freeze(merged);
}

/**
 * Tolerant deep-mode parser: handles 1..12+ segments (merging gracefully if needed),
 * `{ kind: "reply", text: "..." }`, extra metadata fields, `{ text }` segment objects,
 * or clean plain-text paragraphs, so high-quality long answers are never discarded.
 */
export function parseDeepLifecycleAnswer(stopReason: string,
  content: readonly { readonly type: string; readonly text?: string }[],
  maxSegments = ROOM_LIFECYCLE_DEEP_MAX_SEGMENTS,
  maxChars = 4000): RoomLifecycleAnswer {
  if (stopReason !== "stop") throw new RoomModelError("incomplete");
  const rawText = extractAssistantText(content);
  if (!rawText.trim()) throw new RoomModelError("empty");
  const stripped = stripJsonFence(rawText);

  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(stripped);
    parsedOk = true;
  } catch {
    // Try extracting the outermost JSON object if the model added prose before/after JSON.
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
        parsedOk = true;
      } catch { /* Fall through to prose fallback. */ }
    }
  }

  if (parsedOk && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const row = parsed as Record<string, unknown>;
    if (row.kind === "skip") return Object.freeze({ kind: "skip" });
    if (Array.isArray(row.segments)) {
      const texts = row.segments.map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
          return String((item as Record<string, unknown>).text);
        }
        return "";
      }).filter(item => item.trim().length > 0);
      const normalized = normalizeDeepSegments(texts, maxSegments, maxChars);
      if (normalized) return Object.freeze({ kind: "reply", segments: normalized });
    }
    if (typeof row.text === "string" && row.text.trim()) {
      const parts = row.text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      const normalized = normalizeDeepSegments(parts, maxSegments, maxChars);
      if (normalized) return Object.freeze({ kind: "reply", segments: normalized });
    }
    if (typeof row.content === "string" && row.content.trim()) {
      const parts = row.content.replace(/\r\n?/g, "\n").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      const normalized = normalizeDeepSegments(parts, maxSegments, maxChars);
      if (normalized) return Object.freeze({ kind: "reply", segments: normalized });
    }
    throw new RoomModelError("invalid-schema");
  }

  // Plain prose / Markdown fallback (e.g. when tools were enabled and response_format wasn't forced)
  const cleaned = rawText.replace(/\r\n?/g, "\n").trim();
  if (!cleaned.startsWith("{")) {
    const parts = cleaned.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const normalized = normalizeDeepSegments(parts, maxSegments, maxChars);
    if (normalized) return Object.freeze({ kind: "reply", segments: normalized });
  }
  throw new RoomModelError("invalid-json");
}

function diagnosticStage(prompt: RoomPrompt): RoomModelDiagnostic["stage"] {
  try {
    return Object.hasOwn(JSON.parse(prompt.messages[0].content), "voiceTranslation")
      ? "voice-translation" : "reply";
  } catch { return "reply"; }
}

function resolveThinkingPayload(config: ModelConfig, deep: boolean, modelId = config.modelId): {
  payload: Record<string, unknown>;
  disableRequested: boolean;
} {
  const isDeepSeekToggle = modelId === "deepseek-flash" || modelId === "deepseek-v4-pro";
  const mode = config.thinkingMode ?? "auto";
  if (mode === "disabled") {
    return {
      payload: isDeepSeekToggle ? { thinking: { type: "disabled" } } : {},
      disableRequested: isDeepSeekToggle,
    };
  }
  if (mode === "enabled") {
    return {
      payload: isDeepSeekToggle ? { thinking: { type: "enabled" } } : {},
      disableRequested: false,
    };
  }
  // auto: keep fast non-thinking for casual/voice, allow native reasoning on deep analysis
  if (!deep && isDeepSeekToggle) {
    return { payload: { thinking: { type: "disabled" } }, disableRequested: true };
  }
  return { payload: {}, disableRequested: false };
}

function createRuntimeAccessor(config: ModelConfig, roomDataDir: string, registeredMaxTokens: number) {
  let runtimePromise: Promise<ModelRuntime> | undefined;
  return (): Promise<ModelRuntime> => {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const runtime = await ModelRuntime.create({
          authPath: join(roomDataDir, "model", "auth.json"), modelsPath: null,
          allowModelNetwork: false, refreshOnCreate: false,
        });
        runtime.registerProvider("room-provider", {
          baseUrl: config.baseUrl, api: "openai-completions", models: [{
            id: config.modelId, name: config.modelId, reasoning: false,
            input: config.modelSupportsVision ? ["text", "image"] : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: config.contextWindow, maxTokens: registeredMaxTokens,
            compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
          }],
        });
        await runtime.setRuntimeApiKey("room-provider", config.apiKey);
        if (config.visionModelId) {
          runtime.registerProvider("room-vision-provider", {
            baseUrl: config.visionBaseUrl ?? config.baseUrl, api: "openai-completions", models: [{
              id: config.visionModelId, name: config.visionModelId, reasoning: false, input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: config.contextWindow, maxTokens: registeredMaxTokens,
              compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
            }],
          });
          await runtime.setRuntimeApiKey("room-vision-provider", config.visionApiKey ?? config.apiKey);
        }
        return runtime;
      })().catch(error => {
        runtimePromise = undefined;
        throw error;
      });
    }
    return runtimePromise;
  };
}

function buildWebTools(web: RoomWebToolkit): Tool[] {
  const tools: Tool[] = [{
    name: "web_fetch",
    description: "Fetch and read a public web page or GitHub repository/issue/PR/file as clean text or Markdown.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The public http/https URL to read." },
      },
      required: ["url"],
      additionalProperties: false,
    } as unknown as Tool["parameters"],
  }];
  if (web.hasSearch) {
    tools.unshift({
      name: "web_search",
      description: "Search the public web for up-to-date facts, articles, documentation, or technical references.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Concise search query." },
        },
        required: ["query"],
        additionalProperties: false,
      } as unknown as Tool["parameters"],
    });
  }
  return tools;
}

function estimateTranscriptTokens(systemPrompt: string, messages: readonly Message[]): number {
  let total = estimateTokens(systemPrompt);
  for (const message of messages) {
    if (typeof message.content === "string") {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text") total += estimateTokens(block.text);
        else if (block.type === "image") total += 1024;
        else if (block.type === "toolCall") total += estimateTokens(block.name + JSON.stringify(block.arguments));
      }
    }
  }
  return total;
}

async function executeWebToolCall(call: ToolCall, web: RoomWebToolkit, remainingTokens: number,
  signal: AbortSignal): Promise<ToolResultMessage> {
  const startedAt = Date.now();
  const makeResult = (payload: unknown, isError = false): ToolResultMessage => ({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError,
    timestamp: Date.now(),
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  try {
    if (call.name === "web_search" && web.hasSearch) {
      const query = typeof call.arguments?.query === "string" ? call.arguments.query : "";
      if (!query.trim()) return makeResult({ error: "empty_query" }, true);
      const hits = await web.search(query, signal);
      return makeResult({ query, results: hits });
    }
    if (call.name === "web_fetch") {
      const url = typeof call.arguments?.url === "string" ? call.arguments.url : "";
      if (!url.trim()) return makeResult({ error: "empty_url" }, true);
      const pageTokens = dynamicPageTokenBudget(Math.max(1000, remainingTokens), 1);
      const item = await web.fetchUrl(url, { maxChars: WEB_HARD_CHAR_CEILING, maxTokens: pageTokens }, signal);
      if (!item) return makeResult({ url, error: "fetch_failed_or_blocked" }, true);
      return makeResult(item);
    }
    return makeResult({ error: "unsupported_tool" }, true);
  } catch {
    return makeResult({ error: "tool_execution_failed" }, true);
  }
}

export function roomWorkerVoiceTranslator(config: ModelConfig, roomDataDir: string,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}) {
  const maxTokens = 2048;
  const thinking = resolveThinkingPayload(config, false);
  const getRuntime = createRuntimeAccessor(config, roomDataDir, maxTokens);
  return async (prompt: RoomPrompt, signal: AbortSignal): Promise<string> => {
    const diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), maxTokens, thinking.disableRequested);
    try {
      signal.throwIfAborted();
      const inputBudget = config.contextWindow - maxTokens - 1024;
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
        result = await runtime.complete(model, { systemPrompt: prompt.systemPrompt, tools: [], messages }, {
          signal, timeoutMs: ROOM_MODEL_ROUND_TIMEOUT_MS, maxTokens, maxRetries: 0,
          onResponse: response => { try { diagnostic.response(response.status, response.headers); } catch { diagnostic.incomplete(); } },
          onProviderStreamEvent: event => { try { diagnostic.event(event); } catch { diagnostic.incomplete(); } },
          onPayload: payload => {
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("room-model-payload");
            return { ...payload, ...thinking.payload, response_format: { type: "json_object" } };
          },
        });
      } catch (error) {
        if (signal.aborted) throw new RoomModelError("cancelled");
        throw error;
      }
      try { diagnostic.result(result); } catch { diagnostic.incomplete(); }
      signal.throwIfAborted();
      if (result.stopReason === "aborted") throw new RoomModelError("cancelled");
      if (diagnostic.snapshot().provider.finishReason === "content_filter") throw new RoomModelError("incomplete");
      if (result.stopReason === "error") throw new RoomModelError("request");
      const parsed = parseRoomAnswer(result.stopReason, result.content);
      if (parsed.kind !== "reply") throw new RoomModelError("invalid-schema");
      return parsed.text;
    } catch (error) {
      const code = signal.aborted ? "cancelled" : error instanceof RoomModelError ? error.code : "request";
      try { onFailure(code, diagnostic.snapshot(signal.aborted)); } catch { /* Observer only. */ }
      if (code === "cancelled") throw new RoomModelError("cancelled");
      throw error;
    }
  };
}

/**
 * Lifecycle reply generator supporting both fast casual replies (tools-free, 1..2 segments)
 * and deep analysis / URL-summary replies (up to 6 structured paragraphs, smart thinking,
 * and optional bounded read-only web_search / web_fetch tool calling).
 */
export function roomLifecycleGenerator(config: ModelConfig, roomDataDir: string,
  onFailure: (code: RoomModelFailure, diagnostic: RoomModelDiagnostic) => void = () => {}):
  (prompt: RoomPrompt, signal: AbortSignal, maxChars: number, options?: RoomLifecycleGenerateOptions) => Promise<RoomLifecycleAnswer> {
  const registeredMaxTokens = Math.max(config.maxTokens, ROOM_LIFECYCLE_DEEP_MAX_TOKENS);
  const getRuntime = createRuntimeAccessor(config, roomDataDir, registeredMaxTokens);

  return async (prompt, signal, maxChars, options = {}) => {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("room-lifecycle-model-request-invalid");
    const deep = Boolean(options.deep);
    const images = options.images ?? [];
    const hasImages = images.length > 0;
    const visionEnabled = hasImages && hasVisionModel(config);
    const useDedicatedVision = visionEnabled && Boolean(config.visionModelId);
    const activeProvider = useDedicatedVision ? "room-vision-provider" : "room-provider";
    const activeModelId = useDedicatedVision ? config.visionModelId! : config.modelId;
    const maxSegments = options.maxSegments ?? (deep ? ROOM_LIFECYCLE_DEEP_MAX_SEGMENTS : 2);
    const targetMaxTokens = deep
      ? Math.max(1, Math.min(Math.max(config.maxTokens, 4096), ROOM_LIFECYCLE_DEEP_MAX_TOKENS))
      : Math.max(1, Math.min(config.maxTokens, ROOM_LIFECYCLE_MAX_TOKENS));
    const maxTokens = Math.max(256, Math.min(targetMaxTokens, Math.max(256, config.contextWindow - 2048)));
    const primaryThinking = resolveThinkingPayload(config, deep, config.modelId);
    let currentThinking = resolveThinkingPayload(config, deep, activeModelId);
    const diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), maxTokens, currentThinking.disableRequested);
    const web = deep ? options.web : undefined;
    const tools: Tool[] = web ? buildWebTools(web) : [];

    const protocolSuffix = deep
      ? `\n\nLifecycle output protocol (overrides every earlier instruction):
- ${tools.length ? "If you need fresher external facts or to read an unfetched link, call web_search or web_fetch first (at most 3 rounds). Otherwise answer directly." : "This request is tools-free. Never emit a tool call."}
- For the final answer, return ONLY one JSON object with no extra prose outside the JSON.
- A skip is encoded as {"kind":"skip"}.
- A reply is encoded as {"kind":"reply","segments":[string,...]} with 1 to ${maxSegments} well-structured, logical paragraphs.
- Each paragraph must be non-empty and at most ${maxChars} Unicode characters.`
      : `\n\nLifecycle output protocol (overrides every earlier instruction):
- This request is tools-free. Never emit a tool call.
- Return exactly one JSON object with no markdown.
- A skip is encoded as {"kind":"skip"}.
- A reply is encoded as {"kind":"reply","segments":[string,...]} with one or two non-empty segments.
- Each segment must be at most ${maxChars} Unicode characters.
- Do not return more than two segments and never pad a one-segment reply.`;

    const systemPrompt = `${prompt.systemPrompt}${protocolSuffix}`;
    const visionUnconfiguredNote = "\n\nNote: the user attached image(s), but vision is not enabled on this model; state honestly that you cannot view images right now and do not guess their content.";
    const visionRuntimeFallbackNote = "\n\nNote: the user attached image(s), and viewing the image failed right now; state honestly that you cannot view the image right now, do not guess its content, and still answer any text question if present.";
    let currentSystemPrompt = hasImages && !hasVisionModel(config)
      ? `${systemPrompt}${visionUnconfiguredNote}`
      : systemPrompt;
    const buildMessages = (withImages: boolean): Message[] => prompt.messages.map((message, index) => ({
      role: "user" as const,
      content: withImages && index === prompt.messages.length - 1
        ? [{ type: "text" as const, text: message.content }, ...images]
        : message.content,
      timestamp: Date.now(),
    }));

    try {
      signal.throwIfAborted();
      const inputBudget = config.contextWindow - maxTokens - 1024;
      let currentMessages = buildMessages(visionEnabled);
      if (inputBudget < 1 || estimateTranscriptTokens(currentSystemPrompt, currentMessages) > inputBudget) {
        throw new RoomModelError("context-budget");
      }
      const runtime = await getRuntime();
      signal.throwIfAborted();
      let currentModel = runtime.getModel(activeProvider, activeModelId)!;
      let visionFallbackAttempted = false;
      const switchToTextFallback = () => {
        visionFallbackAttempted = true;
        currentModel = runtime.getModel("room-provider", config.modelId)!;
        currentThinking = primaryThinking;
        currentSystemPrompt = `${systemPrompt}${visionRuntimeFallbackNote}`;
        currentMessages = buildMessages(false);
      };

      const totalRounds = tools.length > 0 ? ROOM_MAX_TOOL_ROUNDS + 1 : 1;
      for (let round = 0; round < totalRounds; round++) {
        signal.throwIfAborted();
        const allowToolsThisRound = tools.length > 0 && round < ROOM_MAX_TOOL_ROUNDS;

        let result: AssistantMessage;
        for (;;) {
          signal.throwIfAborted();
          const usedTokens = estimateTranscriptTokens(currentSystemPrompt, currentMessages);
          if (usedTokens > inputBudget) throw new RoomModelError("context-budget");
          const canFallback = round === 0 && visionEnabled && !visionFallbackAttempted;
          try {
            result = await runtime.complete(currentModel, {
              systemPrompt: currentSystemPrompt,
              tools: allowToolsThisRound ? tools : [],
              messages: currentMessages,
            }, {
              signal,
              timeoutMs: ROOM_MODEL_ROUND_TIMEOUT_MS,
              maxTokens,
              maxRetries: 0,
              onResponse: response => { try { diagnostic.response(response.status, response.headers); } catch { diagnostic.incomplete(); } },
              onProviderStreamEvent: event => { try { diagnostic.event(event); } catch { diagnostic.incomplete(); } },
              onPayload: payload => {
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("room-model-payload");
                return allowToolsThisRound
                  ? { ...payload, ...currentThinking.payload }
                  : { ...payload, ...currentThinking.payload, response_format: { type: "json_object" } };
              },
            });
          } catch (error) {
            if (signal.aborted) throw new RoomModelError("cancelled");
            if (canFallback) {
              switchToTextFallback();
              continue;
            }
            throw error;
          }
          try { diagnostic.result(result); } catch { diagnostic.incomplete(); }
          signal.throwIfAborted();
          if (result.stopReason === "aborted") throw new RoomModelError("cancelled");
          if (diagnostic.snapshot().provider.finishReason === "content_filter") throw new RoomModelError("incomplete");
          if (result.stopReason === "error") {
            if (canFallback) {
              switchToTextFallback();
              continue;
            }
            throw new RoomModelError("request");
          }
          break;
        }

        const toolCalls = allowToolsThisRound
          ? result.content.filter((item): item is ToolCall => item.type === "toolCall").slice(0, ROOM_MAX_TOOL_CALLS_PER_ROUND)
          : [];

        if (toolCalls.length > 0 && web) {
          currentMessages.push(result);
          const remainingAfterAssistant = Math.max(0, inputBudget - estimateTranscriptTokens(currentSystemPrompt, currentMessages));
          const perCallTokens = Math.max(800, Math.floor(remainingAfterAssistant / Math.max(1, toolCalls.length)));
          const toolResults = await Promise.all(
            toolCalls.map(call => executeWebToolCall(call, web, perCallTokens, signal)),
          );
          currentMessages.push(...toolResults);
          continue;
        }

        if (deep || hasImages) {
          return parseDeepLifecycleAnswer(result.stopReason, result.content, maxSegments, maxChars);
        }
        return parseRoomLifecycleAnswer(result.stopReason, result.content, maxSegments);
      }
      throw new RoomModelError("incomplete");
    } catch (error) {
      const code = signal.aborted ? "cancelled" : error instanceof RoomModelError ? error.code : "request";
      try { onFailure(code, diagnostic.snapshot(signal.aborted)); } catch { /* Metadata observers cannot change delivery. */ }
      if (code === "cancelled") throw new RoomModelError("cancelled");
      throw error;
    }
  };
}
