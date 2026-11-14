/** Provider hooks expose objects in memory; this collector retains only counts and finite enums. */
const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const chars = (v: unknown): number => typeof v === "string" ? v.length : 0;
const FINISH = ["stop", "length", "tool_calls", "function_call", "content_filter", "network_error"] as const;
const STOP = ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] as const;

export type RoomModelHint = "cancelled" | "output-limit" | "content-filter" | "adapter-text-mismatch"
  | "message-instead-of-delta" | "provider-refusal" | "reasoning-only" | "blank-text" | "text-present"
  | "no-observed-response" | "no-provider-events" | "no-text-fields";
export interface RoomModelDiagnostic {
  version: 1;
  stage: "reply" | "voice-translation";
  maxTokens: number;
  thinkingDisableRequested: boolean;
  httpStatus: number | null;
  responseFormat: "sse" | "json" | "other" | "unknown";
  observationIncomplete: boolean;
  provider: { events: number; deltaTextChars: number; messageTextChars: number; reasoningChars: number;
    refusalChars: number; nonStringContent: boolean; finishReason: typeof FINISH[number] | "other" | null;
    outputTokens: number | null; reasoningTokens: number | null };
  normalized: { stopReason: typeof STOP[number] | "unknown" | null; textChars: number; visibleTextChars: number;
    thinkingChars: number; toolCalls: number; outputTokens: number | null; errorPresent: boolean };
  outputAtLimit: boolean;
  hint: RoomModelHint;
}

export class RoomModelDiagnostics {
  private httpStatus: number | null = null;
  private responseFormat: RoomModelDiagnostic["responseFormat"] = "unknown";
  private observationIncomplete = false;
  private provider: RoomModelDiagnostic["provider"] = { events: 0, deltaTextChars: 0, messageTextChars: 0,
    reasoningChars: 0, refusalChars: 0, nonStringContent: false, finishReason: null, outputTokens: null, reasoningTokens: null };
  private normalized: RoomModelDiagnostic["normalized"] = { stopReason: null, textChars: 0, visibleTextChars: 0,
    thinkingChars: 0, toolCalls: 0, outputTokens: null, errorPresent: false };
  constructor(private readonly stage: RoomModelDiagnostic["stage"], private readonly maxTokens: number,
    private readonly thinkingDisableRequested: boolean) {}
  incomplete(): void { this.observationIncomplete = true; }

  response(status: number, headers: Readonly<Record<string, string>>): void {
    this.httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const type = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    this.responseFormat = type === "text/event-stream" ? "sse" : type === "application/json" ? "json" : "other";
  }
  event(input: unknown): void {
    this.provider.events++;
    const chunk = record(input);
    if (!chunk) return;
    // Pi normalizes the first choice. Counting text from another choice would give a false mismatch.
    const choice = Array.isArray(chunk.choices) ? record(chunk.choices[0]) : undefined;
    const delta = record(choice?.delta), message = record(choice?.message);
    this.provider.deltaTextChars += chars(delta?.content);
    this.provider.messageTextChars += chars(message?.content);
    for (const value of [delta, message]) {
      if (!value) continue;
      if (value.content !== undefined && value.content !== null && typeof value.content !== "string") this.provider.nonStringContent = true;
      const reasoning = [value.reasoning_content, value.reasoning, value.reasoning_text].find(v => typeof v === "string" && v.length);
      this.provider.reasoningChars += chars(reasoning);
      this.provider.refusalChars += chars(value.refusal);
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      this.provider.finishReason = FINISH.includes(choice.finish_reason as typeof FINISH[number])
        ? choice.finish_reason as typeof FINISH[number] : "other";
    }
    const usage = record(chunk.usage) ?? record(choice?.usage);
    if (usage) {
      this.provider.outputTokens = count(usage.completion_tokens) ?? this.provider.outputTokens;
      this.provider.reasoningTokens = count(record(usage.completion_tokens_details)?.reasoning_tokens) ?? this.provider.reasoningTokens;
    }
  }
  result(input: unknown): void {
    const result = record(input);
    if (!result) return;
    const n = this.normalized;
    n.stopReason = STOP.includes(result.stopReason as typeof STOP[number]) ? result.stopReason as typeof STOP[number] : "unknown";
    n.outputTokens = count(record(result.usage)?.output);
    n.errorPresent = typeof result.errorMessage === "string" && result.errorMessage.length > 0;
    for (const block of Array.isArray(result.content) ? result.content : []) {
      const row = record(block);
      if (row?.type === "text") {
        n.textChars += chars(row.text);
        if (typeof row.text === "string") n.visibleTextChars += row.text.replace(/\s/gu, "").length;
      } else if (row?.type === "thinking") n.thinkingChars += chars(row.thinking);
      else if (row?.type === "toolCall") n.toolCalls++;
    }
  }
  snapshot(cancelled = false): RoomModelDiagnostic {
    const p = this.provider, n = this.normalized;
    const hint: RoomModelHint = cancelled ? "cancelled"
      : p.finishReason === "content_filter" ? "content-filter"
      : p.finishReason === "length" || n.stopReason === "length" ? "output-limit"
      : p.deltaTextChars > 0 && n.textChars === 0 ? "adapter-text-mismatch"
      : p.messageTextChars > 0 && n.textChars === 0 ? "message-instead-of-delta"
      : p.refusalChars > 0 && n.visibleTextChars === 0 ? "provider-refusal"
      : (p.reasoningChars > 0 || n.thinkingChars > 0) && n.visibleTextChars === 0 ? "reasoning-only"
      : n.textChars > 0 && n.visibleTextChars === 0 ? "blank-text"
      : n.visibleTextChars > 0 ? "text-present"
      : this.httpStatus === null ? "no-observed-response"
      : p.events === 0 ? "no-provider-events" : "no-text-fields";
    return Object.freeze({ version: 1, stage: this.stage, maxTokens: this.maxTokens,
      thinkingDisableRequested: this.thinkingDisableRequested, httpStatus: this.httpStatus, responseFormat: this.responseFormat,
      observationIncomplete: this.observationIncomplete,
      provider: Object.freeze({ ...p }), normalized: Object.freeze({ ...n }),
      outputAtLimit: (p.outputTokens ?? n.outputTokens ?? -1) >= this.maxTokens, hint });
  }
}
