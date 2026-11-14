import {
  publicWebUrl,
  WebPagePrivacyRejectedError,
  WebProviderError,
  WebSearchMalformedResponseError,
  WebSearchPrivacyRejectedError,
  type WebFetchOptions,
  type WebPage,
  type WebProvider,
  type WebSearchResult,
  type WebSearchOptions,
} from "./web.js";

export interface WebTaskLimits {
  maxToolCalls: number;
  maxSearches: number;
  maxExtractUrls: number;
  webTaskTimeoutMs: number;
  searchTimeoutMs: number;
  extractTimeoutMs: number;
}

export const WEB_TASK_LIMITS: Readonly<WebTaskLimits> = Object.freeze({
  maxToolCalls: 10,
  maxSearches: 5,
  maxExtractUrls: 10,
  webTaskTimeoutMs: 90000,
  searchTimeoutMs: 15000,
  extractTimeoutMs: 20000,
});

/** Counts-only startup facts for the effective upper bounds in one turn. */
export function webStartupLimits(turnDeadlineMs: number, transportCeilingMs?: number) {
  if (!Number.isSafeInteger(turnDeadlineMs) || turnDeadlineMs <= 0) throw new Error("web-turn-deadline-invalid");
  if (transportCeilingMs !== undefined
    && (!Number.isSafeInteger(transportCeilingMs) || transportCeilingMs <= 0)) {
    throw new Error("web-transport-timeout-invalid");
  }
  const webTaskTimeoutMs = Math.min(WEB_TASK_LIMITS.webTaskTimeoutMs, turnDeadlineMs);
  const ceiling = transportCeilingMs ?? Number.MAX_SAFE_INTEGER;
  const source = (defaultMs: number, effectiveMs: number): "default" | "web-task-parent" | "env" => {
    if (webTaskTimeoutMs < defaultMs && effectiveMs === webTaskTimeoutMs) return "web-task-parent";
    if (transportCeilingMs !== undefined && effectiveMs === transportCeilingMs) return "env";
    return "default";
  };
  return Object.freeze({
    webTaskTimeoutMs,
    webTaskTimeoutSource: turnDeadlineMs < WEB_TASK_LIMITS.webTaskTimeoutMs ? "turn-parent" : "default",
    searchTimeoutMs: Math.min(WEB_TASK_LIMITS.searchTimeoutMs, webTaskTimeoutMs, ceiling),
    extractTimeoutMs: Math.min(WEB_TASK_LIMITS.extractTimeoutMs, webTaskTimeoutMs, ceiling),
    searchTimeoutSource: source(WEB_TASK_LIMITS.searchTimeoutMs,
      Math.min(WEB_TASK_LIMITS.searchTimeoutMs, webTaskTimeoutMs, ceiling)),
    extractTimeoutSource: source(WEB_TASK_LIMITS.extractTimeoutMs,
      Math.min(WEB_TASK_LIMITS.extractTimeoutMs, webTaskTimeoutMs, ceiling)),
  });
}

export type MonotonicClock = () => number;

export class MonotonicDeadline {
  constructor(readonly expiresAtMs: number,
    private readonly clock: MonotonicClock = () => performance.now()) {
    if (!Number.isFinite(expiresAtMs)) throw new Error("web-deadline-invalid");
  }

  static after(durationMs: number, clock: MonotonicClock = () => performance.now()): MonotonicDeadline {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("web-deadline-invalid");
    const now = clock();
    return new MonotonicDeadline(now + durationMs, clock);
  }

  remainingMs(clock: MonotonicClock = this.clock): number {
    return Math.max(0, this.expiresAtMs - clock());
  }
}

export interface WebTaskUsage {
  readonly toolCalls: number;
  readonly searches: number;
  readonly extractUrls: number;
  readonly remainingMs: number;
}

export interface WebTaskCallScope {
  readonly signal: AbortSignal;
  readonly turnDeadline: MonotonicDeadline;
  readonly providerRetry: "once" | "none";
  /** Room supplies a fail-closed validator for every complete raw value it can observe. */
  readonly permitsRawText?: (text: string) => boolean;
}

export interface SearchInput extends WebSearchOptions {
  readonly query: string;
}

export interface FetchInput extends WebFetchOptions {
  readonly url: string;
  readonly maxChars?: number;
}

export interface WebResultUsage {
  readonly toolCalls: number;
  readonly searches: number;
  readonly extractUrls: number;
  readonly remainingMs: number;
}

export type WebEvidenceErrorCode = "cancelled" | "deadline" | "timeout" | "rate_limited"
  | "http_error" | "network" | "invalid_response" | "privacy_rejected"
  | "budget_tool" | "budget_search" | "budget_extract" | "invalid_input" | "failed";

export interface WebSearchEvidence {
  readonly kind: "web_search";
  readonly status: "ok" | "empty" | "error";
  readonly query: string;
  readonly results: readonly {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
    readonly publishedDate: string | null;
    readonly score: number | null;
  }[];
  readonly provider: "tavily";
  readonly retrievedAt: string | null;
  readonly trust: "external-untrusted";
  readonly errorCode: WebEvidenceErrorCode | null;
  readonly usage: WebResultUsage;
}

export interface WebPageEvidence {
  readonly kind: "web_fetch";
  readonly status: "ok" | "partial" | "error";
  readonly sourceUrl: string | null;
  readonly title: string | null;
  readonly content: string;
  readonly retrievedAt: string | null;
  readonly provider: "tavily";
  readonly trust: "external-untrusted";
  readonly mode: "full" | "relevant";
  readonly extractDepth: "basic" | "advanced";
  readonly truncated: boolean;
  readonly totalChars: number | null;
  readonly nextOffset: number | null;
  readonly errorCode: WebEvidenceErrorCode | null;
  readonly usage: WebResultUsage;
}

export type WebToolEvidence = WebSearchEvidence | WebPageEvidence;

export class WebTaskError extends Error {
  constructor(readonly code: WebEvidenceErrorCode, message = "网页工具调用失败。") {
    super(message);
    this.name = "WebTaskError";
  }
}

interface WebTaskExecutorOptions {
  readonly clock?: MonotonicClock;
  readonly wallClock?: () => Date;
  readonly limits?: Partial<WebTaskLimits>;
  readonly defaultPageChars?: number;
}

function operationTimeout(operationMs: number, webDeadline: MonotonicDeadline,
  turnDeadline: MonotonicDeadline, clock: MonotonicClock): number {
  const now = clock();
  const webRemaining = Math.max(0, webDeadline.expiresAtMs - now);
  const turnRemaining = turnDeadline.remainingMs(clock);
  return Math.floor(Math.min(operationMs, webRemaining, turnRemaining));
}

export function effectiveWebTimeout(operationMs: number, webDeadline: MonotonicDeadline,
  turnDeadline: MonotonicDeadline, clock: MonotonicClock = () => performance.now()): number {
  return operationTimeout(operationMs, webDeadline, turnDeadline, clock);
}

function searchKey(input: SearchInput): string {
  return JSON.stringify([
    input.query.trim(),
    input.depth ?? "basic",
    input.topic ?? "general",
    input.maxResults ?? 5,
  ]);
}

function fetchKey(input: FetchInput, normalizedUrl: string): string {
  return JSON.stringify([
    normalizedUrl,
    input.query === undefined ? ["omitted"] : ["present", input.query.trim()],
    input.mode ?? "full",
    input.extractDepth ?? "basic",
    input.offset ?? 0,
  ]);
}

function validSearchRows(value: unknown): value is WebSearchResult[] {
  if (!Array.isArray(value)) return false;
  return value.every(row => {
    if (row === null || typeof row !== "object") return false;
    if (typeof row.title !== "string" || typeof row.url !== "string"
      || typeof row.snippet !== "string"
      || (row.publishedDate !== null && typeof row.publishedDate !== "string")
      || (row.score !== null && typeof row.score !== "number")) return false;
    try {
      return publicWebUrl(row.url) === row.url;
    } catch {
      return false;
    }
  });
}

function validPage(value: unknown, requestedUrl: string, offset: number): value is WebPage {
  if (value === null || typeof value !== "object") return false;
  const page = value as Partial<WebPage>;
  return typeof page.url === "string" && (page.title === null || typeof page.title === "string")
    && typeof page.content === "string" && typeof page.truncated === "boolean"
    && typeof page.totalChars === "number" && Number.isSafeInteger(page.totalChars) && page.totalChars >= 0
    && (page.nextOffset === null || typeof page.nextOffset === "number"
      && Number.isSafeInteger(page.nextOffset) && page.nextOffset >= 0
      && page.nextOffset <= page.totalChars)
    && page.url === requestedUrl
    && page.content.trim().length > 0
    && offset <= page.totalChars
    && page.content.length <= page.totalChars - offset
    && (page.truncated || page.nextOffset === null)
    && (page.nextOffset === null || page.nextOffset >= offset + page.content.length);
}

function evidenceCode(error: unknown, signal: AbortSignal): WebEvidenceErrorCode {
  if (signal.aborted || error instanceof WebProviderError && error.code === "cancelled") return "cancelled";
  if (error instanceof WebSearchPrivacyRejectedError || error instanceof WebPagePrivacyRejectedError) return "privacy_rejected";
  if (error instanceof WebSearchMalformedResponseError) return "invalid_response";
  if (error instanceof WebTaskError) return error.code;
  if (error instanceof WebProviderError) return error.code;
  return "failed";
}

function retryable(error: unknown): boolean {
  return error instanceof WebProviderError && error.retryable
    && ["network", "rate_limited", "http_error"].includes(error.code);
}

/**
 * One task-local executor over the existing Tavily provider. It owns only
 * public Web accounting and never sees Room prompts, personas or PA memory.
 */
export class WebTaskExecutor {
  private readonly clock: MonotonicClock;
  private readonly wallClock: () => Date;
  private readonly limits: WebTaskLimits;
  private readonly defaultPageChars: number;
  private webDeadline: MonotonicDeadline | undefined;
  private toolCalls = 0;
  private searches = 0;
  private readonly extractUrlKeys = new Set<string>();
  private readonly searchCache = new Map<string, WebSearchEvidence>();
  private readonly fetchCache = new Map<string, WebPageEvidence>();

  constructor(private readonly provider: WebProvider | undefined,
    options: WebTaskExecutorOptions = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => new Date());
    this.limits = Object.freeze({ ...WEB_TASK_LIMITS, ...options.limits });
    this.defaultPageChars = options.defaultPageChars ?? 12000;
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`web-task-limit-invalid:${name}`);
    }
  }

  usage(): WebTaskUsage {
    return Object.freeze({
      toolCalls: this.toolCalls,
      searches: this.searches,
      extractUrls: this.extractUrlKeys.size,
      remainingMs: this.webDeadline ? Math.max(0, this.webDeadline.expiresAtMs - this.clock()) : 0,
    });
  }

  reserveExternalToolCall(scope: WebTaskCallScope): WebTaskUsage {
    this.assertCallable(scope.signal);
    this.start(scope.turnDeadline);
    this.reserveToolCall();
    return this.usage();
  }

  async search(input: SearchInput, scope: WebTaskCallScope): Promise<WebSearchEvidence> {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const normalized: SearchInput = Object.freeze({
      query,
      maxResults: input.maxResults ?? 5,
      depth: input.depth ?? "basic",
      topic: input.topic ?? "general",
    });
    try {
      this.assertCallable(scope.signal);
      this.start(scope.turnDeadline);
      this.reserveToolCall();
      if (this.searches >= this.limits.maxSearches) throw new WebTaskError("budget_search");
      this.searches++;
      if (!query || [...query].length > 400 || !Number.isInteger(normalized.maxResults)
        || normalized.maxResults! < 1 || normalized.maxResults! > 10
        || !["basic", "advanced"].includes(normalized.depth!)
        || !["general", "news"].includes(normalized.topic!)) {
        throw new WebTaskError("invalid_input");
      }
      if (!this.permits(scope, query)) throw new WebTaskError("privacy_rejected");
      const key = searchKey(normalized);
      const cached = this.searchCache.get(key);
      if (cached) return Object.freeze({ ...cached, usage: this.resultUsage() });
      if (!this.provider) throw new WebTaskError("failed", "未配置网页搜索服务。");
      const result = await this.callWithRetry(
        timeout => this.provider!.search(query, {
          maxResults: normalized.maxResults,
          depth: normalized.depth,
          topic: normalized.topic,
          retry: false,
          timeoutMs: timeout,
        }, scope.signal),
        scope,
        this.limits.searchTimeoutMs,
      );
      scope.signal.throwIfAborted();
      if (!this.permits(scope, result)) throw new WebTaskError("privacy_rejected");
      if (!validSearchRows(result)) throw new WebTaskError("invalid_response");
      const evidence: WebSearchEvidence = Object.freeze({
        kind: "web_search",
        status: result.length ? "ok" : "empty",
        query,
        results: Object.freeze(result.map(row => Object.freeze({ ...row }))),
        provider: "tavily",
        retrievedAt: result.length ? this.wallClock().toISOString() : null,
        trust: "external-untrusted",
        errorCode: null,
        usage: this.resultUsage(),
      });
      this.searchCache.set(key, evidence);
      return evidence;
    } catch (error) {
      const code = evidenceCode(error, scope.signal);
      return this.searchError(code === "privacy_rejected" ? { ...normalized, query: "" } : normalized, code);
    }
  }

  async fetch(input: FetchInput, scope: WebTaskCallScope): Promise<WebPageEvidence> {
    let normalizedUrl: string | null = null;
    const offset = input.offset ?? 0;
    const mode = input.mode ?? "full";
    const extractDepth = input.extractDepth ?? "basic";
    const maxChars = input.maxChars ?? this.defaultPageChars;
    try {
      this.assertCallable(scope.signal);
      this.start(scope.turnDeadline);
      this.reserveToolCall();
      if (typeof input.url !== "string") throw new WebTaskError("invalid_input");
      try { normalizedUrl = publicWebUrl(input.url); }
      catch { throw new WebTaskError("invalid_input"); }
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1
        || !["full", "relevant"].includes(mode) || !["basic", "advanced"].includes(extractDepth)
        || input.query !== undefined && (typeof input.query !== "string"
          || [...input.query].length > 400 || input.query.includes("\0"))) {
        throw new WebTaskError("invalid_input");
      }
      const query = typeof input.query === "string" ? input.query.trim() : undefined;
      if (!this.extractUrlKeys.has(normalizedUrl)) {
        if (this.extractUrlKeys.size >= this.limits.maxExtractUrls) throw new WebTaskError("budget_extract");
        this.extractUrlKeys.add(normalizedUrl);
      }
      if (!this.permits(scope, normalizedUrl)
        || query !== undefined && !this.permits(scope, query)) {
        throw new WebTaskError("privacy_rejected");
      }
      const normalized: FetchInput = Object.freeze({
        url: normalizedUrl,
        ...(query === undefined ? {} : { query }),
        offset,
        mode,
        extractDepth,
        maxChars,
      });
      const key = fetchKey(normalized, normalizedUrl);
      const cached = this.fetchCache.get(key);
      if (cached) return Object.freeze({ ...cached, usage: this.resultUsage() });
      if (!this.provider) throw new WebTaskError("failed", "未配置网页读取服务。");
      const fetchUrl = normalizedUrl;
      const page = await this.callWithRetry(
        timeout => this.provider!.fetchPage(fetchUrl, {
          query,
          mode,
          extractDepth,
          offset,
          maxChars,
          retry: false,
          timeoutMs: timeout,
        }, scope.signal),
        scope,
        this.limits.extractTimeoutMs,
      );
      scope.signal.throwIfAborted();
      if (!this.permits(scope, page)) throw new WebTaskError("privacy_rejected");
      if (!validPage(page, normalizedUrl, offset)) throw new WebTaskError("invalid_response");
      const evidence: WebPageEvidence = Object.freeze({
        kind: "web_fetch",
        status: page.truncated ? "partial" : "ok",
        sourceUrl: page.url,
        title: page.title,
        content: page.content,
        retrievedAt: this.wallClock().toISOString(),
        provider: "tavily",
        trust: "external-untrusted",
        mode,
        extractDepth,
        truncated: page.truncated,
        totalChars: page.totalChars,
        nextOffset: page.nextOffset,
        errorCode: null,
        usage: this.resultUsage(),
      });
      this.fetchCache.set(key, evidence);
      return evidence;
    } catch (error) {
      const code = evidenceCode(error, scope.signal);
      return this.fetchError(code === "privacy_rejected" ? null : normalizedUrl,
        { ...input, url: normalizedUrl ?? input.url, offset, mode, extractDepth, maxChars }, code);
    }
  }

  private start(turnDeadline: MonotonicDeadline): void {
    if (this.webDeadline) return;
    const webExpiry = this.clock() + this.limits.webTaskTimeoutMs;
    this.webDeadline = new MonotonicDeadline(Math.min(webExpiry, turnDeadline.expiresAtMs));
  }

  private assertCallable(signal: AbortSignal): void {
    if (signal.aborted) throw new WebTaskError("cancelled");
  }

  private permits(scope: WebTaskCallScope, value: unknown): boolean {
    if (!scope.permitsRawText) return true;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    try { return scope.permitsRawText(text) === true; }
    catch { return false; }
  }

  private reserveToolCall(): void {
    if (this.toolCalls >= this.limits.maxToolCalls) throw new WebTaskError("budget_tool");
    this.toolCalls++;
  }

  private resultUsage(): WebResultUsage {
    return Object.freeze({ toolCalls: this.toolCalls, searches: this.searches,
      extractUrls: this.extractUrlKeys.size,
      remainingMs: this.webDeadline ? Math.max(0, this.webDeadline.expiresAtMs - this.clock()) : 0 });
  }

  private async callWithRetry<T>(call: (timeoutMs: number) => Promise<T>,
    scope: WebTaskCallScope, operationMs: number): Promise<T> {
    const deadline = this.webDeadline!;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertCallable(scope.signal);
      const timeout = operationTimeout(operationMs, deadline, scope.turnDeadline, this.clock);
      if (timeout <= 0) throw new WebTaskError("deadline");
      try {
        return await call(timeout);
      } catch (error) {
        if (scope.signal.aborted) throw new WebTaskError("cancelled");
        if (scope.providerRetry !== "once" || attempt > 0 || !retryable(error)) throw error;
        if (operationTimeout(operationMs, deadline, scope.turnDeadline, this.clock) <= 0) {
          throw new WebTaskError("deadline");
        }
      }
    }
    throw new WebTaskError("failed");
  }

  private searchError(input: SearchInput, code: WebEvidenceErrorCode): WebSearchEvidence {
    return Object.freeze({
      kind: "web_search",
      status: "error",
      query: input.query,
      results: Object.freeze([]),
      provider: "tavily",
      retrievedAt: null,
      trust: "external-untrusted",
      errorCode: code,
      usage: this.resultUsage(),
    });
  }

  private fetchError(sourceUrl: string | null, input: FetchInput, code: WebEvidenceErrorCode): WebPageEvidence {
    return Object.freeze({
      kind: "web_fetch",
      status: "error",
      sourceUrl: code === "privacy_rejected" ? null : sourceUrl,
      title: null,
      content: "",
      retrievedAt: null,
      provider: "tavily",
      trust: "external-untrusted",
      mode: input.mode ?? "full",
      extractDepth: input.extractDepth ?? "basic",
      truncated: false,
      totalChars: null,
      nextOffset: null,
      errorCode: code,
      usage: this.resultUsage(),
    });
  }
}
