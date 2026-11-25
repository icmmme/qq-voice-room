import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, Message, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { ModelConfig } from "../config.js";
import { estimateTokens } from "../prompting/token-estimate.js";
import type { RoomAnswer, RoomPrompt } from "./types.js";
import { RoomModelDiagnostics, type RoomModelDiagnostic } from "./model-diagnostics.js";
import {
  dynamicPageTokenBudget,
  parsePublicUrl,
  truncateByBudget,
  WEB_HARD_CHAR_CEILING,
  type RoomWebToolkit,
} from "./web.js";

export const ROOM_MODEL_ROUND_TIMEOUT_MS = 90000;
export const ROOM_LIFECYCLE_MAX_TOKENS = 1024;
export const ROOM_LIFECYCLE_DEEP_MAX_TOKENS = 6144;
export const ROOM_LIFECYCLE_PROTOCOL_RESERVE_TOKENS = 256;
export const ROOM_LIFECYCLE_DEEP_MAX_SEGMENTS = 12;
const ROOM_MAX_TOOL_ROUNDS = 3;
const ROOM_MAX_TOOL_CALLS_PER_ROUND = 3;
const TOOL_ROUND_SAFETY_RESERVE = 512;

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
  return Boolean(config.visionModelId) || config.modelSupportsVision !== false;
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

function repairJsonControlCharsAndTrailingCommas(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        const next = raw[i + 1];
        const validSimple = next !== undefined && "\"\\/bfnrt".includes(next);
        const validUnicode = next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6));
        if (validSimple || validUnicode) {
          out += ch;
          escaped = true;
        } else {
          out += "\\\\";
        }
        continue;
      }
      if (ch === "\"") {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      if (ch.charCodeAt(0) < 0x20) { out += " "; continue; }
      out += ch;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === "}" || raw[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function repairJsonUnescapedQuotes(raw: string): string {
  const base = repairJsonControlCharsAndTrailingCommas(raw);
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < base.length; i++) {
    const ch = base[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        let j = i + 1;
        while (j < base.length && /\s/.test(base[j]!)) j++;
        const next = base[j];
        let isClosing = next === undefined || next === "}" || next === "]" || next === ":";
        if (next === ",") {
          let k = j + 1;
          while (k < base.length && /\s/.test(base[k]!)) k++;
          const afterComma = base[k];
          isClosing = afterComma !== undefined && /["0-9\-{[tfn]/.test(afterComma);
        }
        if (isClosing) {
          out += ch;
          inString = false;
        } else {
          out += "\\\"";
        }
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "\"") inString = true;
    out += ch;
  }
  return out;
}

function tryParseJsonTolerant(raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const candidates = [raw];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1);
    if (slice !== raw) candidates.push(slice);
  }
  for (const candidate of candidates) {
    for (const attempt of [
      () => JSON.parse(candidate),
      () => JSON.parse(repairJsonControlCharsAndTrailingCommas(candidate)),
      () => JSON.parse(repairJsonUnescapedQuotes(candidate)),
    ]) {
      try {
        return { ok: true, value: attempt() };
      } catch { /* Try next repair strategy. */ }
    }
  }
  return { ok: false };
}

/**
 * Tolerant deep-mode parser: handles 1..12+ segments (merging gracefully if needed),
 * `{ kind: "reply", text: "..." }`, extra metadata fields, `{ text }` segment objects,
 * slightly malformed JSON (raw newlines, trailing commas, unescaped quotes),
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

  const attempt = tryParseJsonTolerant(stripped);
  const parsed = attempt.ok ? attempt.value : undefined;
  const parsedOk = attempt.ok;

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
  const cleaned = stripped.replace(/\r\n?/g, "\n").trim();
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
            input: config.modelSupportsVision !== false ? ["text", "image"] : ["text"],
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
      description: "Search the public web ONLY when you need up-to-date facts, recent events/news, external projects/docs you are unsure of, or when the user asks to look something up. Do NOT call for greetings, casual banter, or questions answerable from conversation context.",
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

function estimateMessageTokens(message: Message): number {
  let total = 0;
  if (typeof message.content === "string") {
    total += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "text") total += estimateTokens(block.text);
      else if (block.type === "image") total += 1024;
      else if (block.type === "toolCall") total += estimateTokens(block.name + JSON.stringify(block.arguments));
    }
  }
  return total;
}

function estimateTranscriptTokens(systemPrompt: string, messages: readonly Message[]): number {
  let total = estimateTokens(systemPrompt);
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

function compactToolResultText(rawText: string, targetTokens: number, aggressive: boolean): string {
  const safeTokens = Math.max(48, targetTokens);
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.content === "string") {
        if (aggressive) {
          return JSON.stringify({
            ...(typeof obj.url === "string" ? { url: obj.url } : {}),
            ...(typeof obj.title === "string" ? { title: obj.title } : {}),
            content: obj.content.slice(0, 120),
            truncated: true,
            compacted: true,
          });
        }
        const targetChars = Math.max(200, Math.min(obj.content.length, safeTokens * 3));
        const shrunk = truncateByBudget(obj.content, targetChars, Math.max(60, safeTokens - 32));
        return JSON.stringify({ ...obj, content: shrunk.text, truncated: true, compacted: true });
      }
      if (Array.isArray(obj.results)) {
        const hits = (obj.results as Array<Record<string, unknown>>).slice(0, aggressive ? 2 : 3).map(hit => ({
          ...(typeof hit.title === "string" ? { title: hit.title.slice(0, 80) } : {}),
          ...(typeof hit.url === "string" ? { url: hit.url } : {}),
          ...(typeof hit.snippet === "string" && !aggressive ? { snippet: hit.snippet.slice(0, 140) } : {}),
        }));
        return JSON.stringify({
          ...(typeof obj.query === "string" ? { query: obj.query } : {}),
          ...(typeof obj.status === "string" ? { status: obj.status } : {}),
          results: hits,
          compacted: true,
        });
      }
    }
  } catch { /* Fall through to plain excerpt. */ }
  const keepChars = aggressive ? 80 : Math.max(100, safeTokens * 2);
  return JSON.stringify({ compacted: true, excerpt: rawText.slice(0, keepChars) });
}

/**
 * Compact older toolResult messages in place when multi-round web tool outputs
 * push the transcript past `inputBudget`, so synthesis succeeds without crashing.
 */
function compactToolResultsToBudget(systemPrompt: string, messages: Message[], inputBudget: number): void {
  let currentTotal = estimateTranscriptTokens(systemPrompt, messages);
  if (currentTotal <= inputBudget) return;

  for (const aggressive of [false, true]) {
    for (let i = 0; i < messages.length; i++) {
      if (currentTotal <= inputBudget) return;
      const msg = messages[i];
      if (!msg || msg.role !== "toolResult") continue;
      const msgTokens = estimateMessageTokens(msg);
      const excess = currentTotal - inputBudget;
      const targetMsgTokens = Math.max(48, msgTokens - excess - 32);
      if (!aggressive && targetMsgTokens >= msgTokens) continue;
      const rawText = msg.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
        .map(block => block.text)
        .join("\n");
      const compactedText = compactToolResultText(rawText, targetMsgTokens, aggressive);
      if (compactedText.length >= rawText.length && !aggressive) continue;
      messages[i] = { ...msg, content: [{ type: "text", text: compactedText }] };
      currentTotal = estimateTranscriptTokens(systemPrompt, messages);
    }
  }
}

function searchStatusNote(status: string): string | undefined {
  if (status === "empty") return "No relevant search results were found; do not fabricate sources or dates.";
  if (status === "blocked") return "Query was blocked by privacy policy; rephrase without sensitive details or answer directly.";
  if (status === "provider_error") return "Search providers failed temporarily; answer honestly without fabricating sources or dates.";
  if (status === "unavailable") return "Search provider is unavailable; answer honestly without fabricating sources or dates.";
  return undefined;
}

async function executeWebToolCall(
  call: ToolCall,
  web: RoomWebToolkit,
  remainingAfterAssistant: number,
  perCallTokens: number,
  seenCalls: Set<string>,
  signal: AbortSignal,
): Promise<ToolResultMessage> {
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

  if (call.argumentsError) {
    return makeResult({ error: "invalid_arguments" }, true);
  }

  try {
    if (call.name === "web_search" && web.hasSearch) {
      const query = typeof call.arguments?.query === "string" ? call.arguments.query : "";
      const trimmed = query.trim();
      if (!trimmed) return makeResult({ error: "empty_query" }, true);
      const callKey = `web_search:${trimmed.replace(/\s+/g, " ").toLowerCase()}`;
      if (seenCalls.has(callKey)) {
        return makeResult({
          duplicate: true,
          note: "Already queried earlier in this turn; synthesize your answer from existing evidence.",
        }, false);
      }
      if (remainingAfterAssistant < TOOL_ROUND_SAFETY_RESERVE) {
        return makeResult({
          error: "context_budget_tight",
          note: "Context budget is tight; answer directly using evidence already gathered.",
        }, true);
      }
      seenCalls.add(callKey);
      if (web.searchDetailed) {
        const outcome = await web.searchDetailed(trimmed, signal);
        const note = searchStatusNote(outcome.status);
        return makeResult({
          query: trimmed,
          status: outcome.status,
          ...(outcome.provider ? { provider: outcome.provider } : {}),
          results: outcome.hits,
          ...(note ? { note } : {}),
        }, outcome.status === "provider_error" || outcome.status === "blocked" || outcome.status === "unavailable");
      }
      const hits = await web.search(trimmed, signal);
      return makeResult({
        query: trimmed,
        status: hits.length > 0 ? "ok" : "empty",
        results: hits,
        ...(hits.length === 0 ? { note: searchStatusNote("empty") } : {}),
      });
    }

    if (call.name === "web_fetch") {
      const url = typeof call.arguments?.url === "string" ? call.arguments.url : "";
      const trimmed = url.trim();
      if (!trimmed) return makeResult({ error: "empty_url" }, true);
      const canonical = parsePublicUrl(trimmed)?.toString() ?? trimmed;
      const callKey = `web_fetch:${canonical}`;
      if (seenCalls.has(callKey)) {
        return makeResult({
          duplicate: true,
          note: "Already queried earlier in this turn; synthesize your answer from existing evidence.",
        }, false);
      }
      if (remainingAfterAssistant < TOOL_ROUND_SAFETY_RESERVE || perCallTokens < 128) {
        return makeResult({
          error: "context_budget_tight",
          note: "Context budget is tight; answer directly using evidence already gathered.",
        }, true);
      }
      seenCalls.add(callKey);
      const pageTokens = Math.min(perCallTokens, dynamicPageTokenBudget(perCallTokens, 1));
      const item = await web.fetchUrl(trimmed, { maxChars: WEB_HARD_CHAR_CEILING, maxTokens: pageTokens }, signal);
      if (!item) return makeResult({ url: trimmed, error: "fetch_failed_or_blocked" }, true);
      return makeResult(item);
    }

    return makeResult({ error: "unsupported_tool" }, true);
  } catch (error) {
    if (signal.aborted) throw error;
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
    const web = options.web;
    const tools: Tool[] = web ? buildWebTools(web) : [];
    const allowStructuredSearchReserve = !deep && Boolean(web?.hasSearch);
    const targetMaxTokens = deep
      ? Math.max(1, Math.min(Math.max(config.maxTokens, 4096), ROOM_LIFECYCLE_DEEP_MAX_TOKENS))
      : allowStructuredSearchReserve
        ? Math.max(1, Math.min(config.maxTokens, 4096))
        : Math.max(1, Math.min(config.maxTokens, ROOM_LIFECYCLE_MAX_TOKENS));
    const maxTokens = Math.max(256, Math.min(targetMaxTokens, Math.max(256, config.contextWindow - 2048)));
    const primaryThinking = resolveThinkingPayload(config, deep, config.modelId);
    let currentThinking = resolveThinkingPayload(config, deep, activeModelId);
    let diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), maxTokens, currentThinking.disableRequested);

    const toolGuidance = web?.hasSearch
      ? "For fresh, time-sensitive, or verifiable external facts, call web_search first, and use web_fetch to read authoritative URLs when search snippets are not enough (at most 3 rounds total). Do NOT call search tools for greetings or casual chat. If search returns empty or provider_error/blocked/unavailable, answer honestly without fabricating sources or dates."
      : web
        ? "Only web_fetch is available to read explicit public URLs (there is no live web search engine); never claim to have searched the web."
        : "This request is tools-free. Never emit a tool call.";

    const protocolSuffix = deep
      ? `\n\nLifecycle output protocol (overrides every earlier instruction):
- ${toolGuidance}
- For the final answer, return ONLY one JSON object with no extra prose outside the JSON.
- A skip is encoded as {"kind":"skip"}.
- A reply is encoded as {"kind":"reply","segments":[string,...]} with 1 to ${maxSegments} well-structured, logical paragraphs.
- Each paragraph must be non-empty and at most ${maxChars} Unicode characters.`
      : web?.hasSearch
        ? `\n\nLifecycle output protocol (overrides every earlier instruction):
- ${toolGuidance}
- Return ONLY one JSON object with no markdown.
- A skip is encoded as {"kind":"skip"}.
- A reply is encoded as {"kind":"reply","segments":[string,...]} (1–2 short casual lines when no search was needed, or up to ${maxSegments} structured paragraphs if presenting searched facts).
- Each segment must be non-empty and at most ${maxChars} Unicode characters.`
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

      const seenCalls = new Set<string>();
      const totalRounds = tools.length > 0 ? ROOM_MAX_TOOL_ROUNDS + 1 : 1;
      let disableToolsFallback = false;
      let usedWebTools = false;
      for (let round = 0; round < totalRounds; round++) {
        signal.throwIfAborted();
        if (round > 0) {
          compactToolResultsToBudget(currentSystemPrompt, currentMessages, inputBudget);
        }

        let allowToolsThisRound = !disableToolsFallback && tools.length > 0 && round < ROOM_MAX_TOOL_ROUNDS;
        let result: AssistantMessage;
        for (;;) {
          signal.throwIfAborted();
          const usedTokens = estimateTranscriptTokens(currentSystemPrompt, currentMessages);
          if (usedTokens > inputBudget) throw new RoomModelError("context-budget");
          const canVisionFallback = round === 0 && visionEnabled && !visionFallbackAttempted;
          const canToolsFallback = round === 0 && allowToolsThisRound && !disableToolsFallback;
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
            if (canVisionFallback) {
              switchToTextFallback();
              diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), maxTokens, currentThinking.disableRequested);
              continue;
            }
            if (canToolsFallback) {
              disableToolsFallback = true;
              allowToolsThisRound = false;
              diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), maxTokens, currentThinking.disableRequested);
              continue;
            }
            throw error;
          }
          try { diagnostic.result(result); } catch { diagnostic.incomplete(); }
          signal.throwIfAborted();
          if (result.stopReason === "aborted") throw new RoomModelError("cancelled");
          if (diagnostic.snapshot().provider.finishReason === "content_filter") throw new RoomModelError("incomplete");
          if (result.stopReason === "error") {
            if (canVisionFallback) {
              switchToTextFallback();
              diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), maxTokens, currentThinking.disableRequested);
              continue;
            }
            if (canToolsFallback) {
              disableToolsFallback = true;
              allowToolsThisRound = false;
              diagnostic = new RoomModelDiagnostics(diagnosticStage(prompt), maxTokens, currentThinking.disableRequested);
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
          usedWebTools = true;
          currentMessages.push(result);
          const remainingAfterAssistant = Math.max(0, inputBudget - estimateTranscriptTokens(currentSystemPrompt, currentMessages));
          const usableTokens = Math.max(0, remainingAfterAssistant - TOOL_ROUND_SAFETY_RESERVE);
          const perCallTokens = Math.floor(usableTokens / Math.max(1, toolCalls.length));
          const toolResults = await Promise.all(
            toolCalls.map(call => executeWebToolCall(call, web, remainingAfterAssistant, perCallTokens, seenCalls, signal)),
          );
          currentMessages.push(...toolResults);
          continue;
        }

        try {
          if (deep || hasImages || usedWebTools || allowToolsThisRound) {
            return parseDeepLifecycleAnswer(result.stopReason, result.content, maxSegments, maxChars);
          }
          return parseRoomLifecycleAnswer(result.stopReason, result.content, maxSegments);
        } catch (error) {
          if (allowToolsThisRound && error instanceof RoomModelError && error.code === "invalid-json"
            && round + 1 < totalRounds) {
            // Re-run once without tools so response_format: json_object is enforced on output.
            disableToolsFallback = true;
            continue;
          }
          throw error;
        }
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
