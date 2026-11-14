import { isIP } from "node:net";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
  publishedDate: string | null;
}

/** Complete provider fields, supplied before any result field is bounded. */
export interface TavilySearchFields {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string | null;
}

export interface WebPage {
  url: string;
  title: string | null;
  content: string;
  truncated: boolean;
  totalChars: number;
  nextOffset: number | null;
}

export interface WebSearchOptions {
  maxResults?: number;
  depth?: "basic" | "advanced";
  topic?: "general" | "news";
  /** Provider attempt policy; the shared executor normally passes this explicitly. */
  retry?: boolean;
  timeoutMs?: number;
}

export interface WebFetchOptions {
  query?: string;
  mode?: "full" | "relevant";
  extractDepth?: "basic" | "advanced";
  offset?: number;
  /** Internal per-request display window selected by the shared executor. */
  maxChars?: number;
  /** Provider attempt policy; the shared executor normally passes this explicitly. */
  retry?: boolean;
  timeoutMs?: number;
}

export interface WebProvider {
  search(query: string, options?: WebSearchOptions, signal?: AbortSignal): Promise<WebSearchResult[]>;
  fetchPage(url: string, queryOrOptions?: string | WebFetchOptions, signal?: AbortSignal): Promise<WebPage>;
}
export interface TavilyWebClientOptions {
  /** Main PA keeps its one bounded retry; Voice Room opts out explicitly. */
  retry?: boolean;
  /**
   * Called with the complete parsed provider envelope before any row count,
   * field normalization, content bound or failure classification.
   */
  validateRawResponse?: (value: unknown, kind: "search" | "extract") => boolean;
  /**
   * Called with the complete provider fields before title/content/date bounds
   * are applied. Returning false drops the whole row; throwing also drops it.
   */
  validateSearchResult?: (fields: TavilySearchFields) => boolean;
  /**
   * Called with the complete matched page body before the ordinary 30000-character
   * display bound is applied. Returning false drops the whole page; throwing also
   * drops it.
   */
  validatePageContent?: (url: string, content: string) => boolean;
}

type JsonObject = Record<string, unknown>;

/** A privacy rejection from the provider boundary. It never carries source content. */
export class WebSearchPrivacyRejectedError extends Error {
  constructor() {
    super("搜索结果未通过公开隐私检查。");
    this.name = "WebSearchPrivacyRejectedError";
  }
}

/** A provider envelope or non-empty row batch with no usable result. */
export class WebSearchMalformedResponseError extends Error {
  constructor() {
    super("搜索服务返回了无效结果。");
    this.name = "WebSearchMalformedResponseError";
  }
}

/** A privacy rejection at the page-extraction boundary; it carries no page text. */
export class WebPagePrivacyRejectedError extends Error {
  constructor() {
    super("网页正文未通过公开隐私检查。");
    this.name = "WebPagePrivacyRejectedError";
  }
}

export type WebProviderErrorCode = "cancelled" | "deadline" | "timeout" | "rate_limited"
  | "http_error" | "network" | "invalid_response" | "failed";

/** Sanitized provider failure. Messages never contain provider bodies or credentials. */
export class WebProviderError extends Error {
  constructor(readonly code: WebProviderErrorCode, readonly retryable = false, message = "网页服务请求失败。") {
    super(message);
    this.name = "WebProviderError";
  }
}

const RESPONSE_TOO_LARGE_MESSAGE = "\u641c\u7d22\u670d\u52a1\u54cd\u5e94\u8fc7\u5927\u3002";
const TAVILY_ORIGIN = "https://api.tavily.com";
const TAVILY_REDIRECT_REJECTED_MESSAGE = "网页服务返回了不可接受的重定向响应。";
const TAVILY_UNTRUSTED_ORIGIN_MESSAGE = "网页服务返回了不可信的上游来源。";

type TavilyEndpoint = "search" | "extract";
type FinalUrlIdentity = Pick<URL,
  "protocol" | "username" | "password" | "origin" | "pathname" | "search" | "hash">;

export function isCanonicalTavilyEndpoint(url: FinalUrlIdentity, path: TavilyEndpoint): boolean {
  return url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && url.origin === TAVILY_ORIGIN
    && url.pathname === `/${path}`
    && url.search === ""
    && url.hash === "";
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

const LOCAL_ADDRESS = "不能读取本机或局域网地址。";
const IPV6_LITERAL = "为安全起见不读取 IPv6 字面量地址。";

/**
 * Allowlist for extraction targets. Only public domains and public IPv4 literals pass.
 * Trailing dots are normalized away because `localhost.` and `example.com.` resolve like their dotless forms,
 * and every IPv6 literal is rejected: that conservatively covers `::1`, `::`, `fe80::/10`, `fc00::/7`
 * and IPv4-mapped forms such as `::ffff:127.0.0.1` without relying on string prefixes.
 */
export function publicWebUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("网页地址无效。"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("网页地址只能使用不含凭据的 HTTP(S) URL。");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) throw new Error("网页地址无效。");
  const ip = isIP(host);
  if (ip === 6) throw new Error(IPV6_LITERAL);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error(LOCAL_ADDRESS);
  if (ip === 4) {
    const [a = -1, b = -1, c = -1] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224) throw new Error(LOCAL_ADDRESS);
  }
  url.hash = "";
  return url.toString();
}

/** Minimal Tavily provider. The key is kept in memory and sent only to Tavily's fixed HTTPS origin. */
export class TavilyWebClient implements WebProvider {
  constructor(private readonly apiKey: string, private readonly timeoutMs?: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly options: TavilyWebClientOptions = {}) {
    if (!apiKey.trim()) throw new Error("TAVILY_API_KEY 不能为空。");
  }

  async search(query: string, options: WebSearchOptions = {}, signal?: AbortSignal): Promise<WebSearchResult[]> {
    query = query.trim();
    if (!query || [...query].length > 400) throw new Error("搜索词必须为 1–400 个字符。");
    const maxResults = options.maxResults ?? 5;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new Error("搜索结果数必须在 1–10 之间。");
    const json = await this.post("search", {
      query, search_depth: options.depth ?? "basic", max_results: maxResults,
      topic: options.topic ?? "general", chunks_per_source: 2,
      include_answer: false, include_raw_content: false, include_images: false,
      include_published_date: true, safe_search: true,
    }, signal, options.timeoutMs, options.retry);
    signal?.throwIfAborted();
    const results = Array.isArray(json.results) ? json.results : [];
    const malformedEnvelope = !Array.isArray(json.results);
    const accepted: WebSearchResult[] = [];
    let rejected = false;
    let malformed = malformedEnvelope;
    for (const value of results.slice(0, maxResults)) {
      const row = object(value);
      if (!row) {
        if (this.options.validateSearchResult) malformed = true;
        continue;
      }
      const rawUrl = typeof row.url === "string" ? row.url : "";
      const rawTitle = typeof row.title === "string" ? row.title : null;
      const snippet = typeof row.content === "string" ? row.content : "";
      const publishedDate = typeof row.published_date === "string" ? row.published_date : null;
      if (this.options.validateSearchResult) {
        let valid = false;
        try {
          valid = this.options.validateSearchResult({
            title: rawTitle ?? rawUrl, url: rawUrl, snippet, publishedDate,
          }) === true;
        } catch {
          valid = false;
        }
        if (!valid) {
          rejected = true;
          continue;
        }
        const hasTitle = Object.prototype.hasOwnProperty.call(row, "title");
        const invalidShape = typeof row.url !== "string" || !row.url.trim()
          || typeof row.content !== "string" || !row.content.trim()
          || (hasTitle && (typeof row.title !== "string" || !row.title.trim()));
        if (invalidShape) {
          malformed = true;
          continue;
        }
      }
      if (typeof row.url !== "string") continue;
      let url: string;
      try { url = publicWebUrl(rawUrl); } catch {
        // A caller with a privacy validator treats an unsafe URL as a rejected
        // result; ordinary PA keeps the historical "drop the row" behavior.
        if (this.options.validateSearchResult) rejected = true;
        continue;
      }
      const title = rawTitle ?? url;
      accepted.push({
        title: title.slice(0, 300), url, snippet: snippet.slice(0, 1800),
        score: typeof row.score === "number" ? row.score : null,
        publishedDate: publishedDate?.slice(0, 100) ?? null,
      });
    }
    if (rejected && accepted.length === 0 && this.options.validateSearchResult) {
      throw new WebSearchPrivacyRejectedError();
    }
    if (malformed && accepted.length === 0 && this.options.validateSearchResult) {
      throw new WebSearchMalformedResponseError();
    }
    signal?.throwIfAborted();
    return accepted;
  }

  async fetchPage(rawUrl: string, queryOrOptions?: string | WebFetchOptions, signal?: AbortSignal): Promise<WebPage> {
    const options: WebFetchOptions = typeof queryOrOptions === "string"
      ? { query: queryOrOptions } : queryOrOptions ?? {};
    const url = publicWebUrl(rawUrl);
    const query = options.query;
    if (query !== undefined && query.length > 400) throw new Error("页面筛选词最多 400 个字符。");
    const offset = options.offset ?? 0;
    const maximum = options.maxChars ?? 30000;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("网页正文范围无效。");
    }
    const json = await this.post("extract", {
      urls: url, query: query?.trim() || undefined, chunks_per_source: query?.trim() ? 5 : undefined,
      extract_depth: options.extractDepth ?? "basic", include_images: false, format: "markdown",
      timeout: Math.max(1, Math.ceil(this.effectiveTimeout("extract", options.timeoutMs) / 1000)),
    }, signal, options.timeoutMs, options.retry);
    signal?.throwIfAborted();
    // The content must belong to the URL the caller asked for. A mismatched result is dropped instead of
    // being reported as the requested source, so the model never attributes text to the wrong page.
    const rows = Array.isArray(json.results) ? json.results : [];
    let matched: JsonObject | undefined;
    let hasMismatchedContent = false;
    for (const value of rows) {
      const candidate = object(value);
      if (!candidate || typeof candidate.url !== "string") continue;
      const content = typeof candidate.raw_content === "string" ? candidate.raw_content : "";
      let candidateUrl: string | undefined;
      try { candidateUrl = publicWebUrl(candidate.url); } catch { candidateUrl = undefined; }
      if (candidateUrl === url) {
        matched = candidate;
        if (content.trim()) break;
      } else if (content.trim()) {
        // Non-empty content from another (or unsafe) URL must never be attributed to the requested page.
        hasMismatchedContent = true;
      }
    }
    if (matched && typeof matched.raw_content === "string" && matched.raw_content.trim()) {
      if (this.options.validatePageContent) {
        let valid = false;
        try { valid = this.options.validatePageContent(url, matched.raw_content) === true; }
        catch { valid = false; }
        if (!valid) throw new WebPagePrivacyRejectedError();
      }
      const totalChars = matched.raw_content.length;
      const end = Math.min(totalChars, offset + maximum);
      const content = matched.raw_content.slice(offset, end);
      const truncated = offset > 0 || end < totalChars;
      const title = typeof matched.title === "string" && matched.title.trim()
        ? matched.title.slice(0, 300) : null;
      return { url, title, content, truncated, totalChars, nextOffset: end < totalChars ? end : null };
    }
    if (hasMismatchedContent) throw new WebProviderError("failed", false,
      "网页内容提取结果与请求地址不一致，已丢弃。");
    // A failed_results entry is only used as a boolean signal. Its provider error text is never surfaced.
    if (Array.isArray(json.failed_results) && json.failed_results.length > 0) {
      throw new WebProviderError("failed", false,
        "网页内容提取失败，页面可能无法访问；可换一个公开来源，请勿重复读取同一失败地址。");
    }
    throw new WebProviderError("failed", false, "网页内容提取失败，可能是页面限制访问或没有可读正文。");
  }

  private async post(path: TavilyEndpoint, body: JsonObject, signal?: AbortSignal,
    timeoutOverride?: number, retryOverride?: boolean): Promise<JsonObject> {
    let last: Error | undefined;
    const retry = retryOverride ?? this.options.retry !== false;
    const attempts = retry ? 2 : 1;
    const timeoutMs = this.effectiveTimeout(path, timeoutOverride);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new WebProviderError("deadline", false, "搜索服务请求已超过截止时间。");
    for (let attempt = 0; attempt < attempts; attempt++) {
      // A cancelled turn never starts or repeats a request.
      if (signal?.aborted) throw new WebProviderError("cancelled", false, "搜索服务请求已取消。");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const requestUrl = `${TAVILY_ORIGIN}/${path}`;
        const response = await this.fetcher(requestUrl, {
          method: "POST", signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          redirect: "manual",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if ((response.status >= 300 && response.status < 400)
          || response.type === "opaqueredirect" || response.redirected) {
          throw new WebProviderError("invalid_response", false, TAVILY_REDIRECT_REJECTED_MESSAGE);
        }
        let finalUrl: URL;
        try {
          if (!response.url) throw new Error("missing final URL");
          finalUrl = new URL(response.url);
        } catch {
          throw new WebProviderError("invalid_response", false, TAVILY_UNTRUSTED_ORIGIN_MESSAGE);
        }
        // Response URL is untrusted metadata. Only the exact endpoint this
        // client called may supply provider success or a retryable status.
        if (!isCanonicalTavilyEndpoint(finalUrl, path)) {
          throw new WebProviderError("invalid_response", false, TAVILY_UNTRUSTED_ORIGIN_MESSAGE);
        }
        const text = await boundedText(response, 2 * 1024 * 1024);
        if (!response.ok) {
          // Status is checked before parsing so a non-JSON 429/5xx body still retries once.
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempts > 1 && attempt === 0 && !signal?.aborted) {
            last = new WebProviderError(response.status === 429 ? "rate_limited" : "http_error", true,
              `搜索服务请求失败（HTTP ${response.status}）。`);
            continue;
          }
          throw new WebProviderError(response.status === 429 ? "rate_limited" : "http_error", retryable,
            response.status === 401 ? "Tavily 密钥无效，请检查本地 TAVILY_API_KEY。"
              : `搜索服务请求失败（HTTP ${response.status}）。`);
        }
        // Successful provider text is untrusted and must cross the caller's
        // fail-closed privacy gate before JSON parsing. This makes malformed
        // JSON containing protected text a privacy rejection, not a generic
        // invalid-response result.
        if (this.options.validateRawResponse) {
          let valid = false;
          try { valid = this.options.validateRawResponse(text, path === "search" ? "search" : "extract") === true; }
          catch { valid = false; }
          if (!valid) {
            throw path === "search" ? new WebSearchPrivacyRejectedError() : new WebPagePrivacyRejectedError();
          }
        }
        let value: unknown;
        try { value = JSON.parse(text); } catch {
          throw new WebProviderError("invalid_response", false, "搜索服务返回了无效响应。");
        }
        const json = object(value);
        if (!json) throw new WebProviderError("invalid_response", false, "搜索服务返回了无效响应。");
        signal?.throwIfAborted();
        if (this.options.validateRawResponse) {
          let valid = false;
          try { valid = this.options.validateRawResponse(value, path === "search" ? "search" : "extract") === true; }
          catch { valid = false; }
          if (!valid) {
            throw path === "search" ? new WebSearchPrivacyRejectedError() : new WebPagePrivacyRejectedError();
          }
        }
        return json;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error("搜索服务请求失败。");
        last = normalized;
        if (signal?.aborted) throw new WebProviderError("cancelled", false, "搜索服务请求已取消。");
        if (normalized.message === RESPONSE_TOO_LARGE_MESSAGE) {
          throw new WebProviderError("invalid_response", false, RESPONSE_TOO_LARGE_MESSAGE);
        }
        if (normalized instanceof WebSearchPrivacyRejectedError || normalized instanceof WebPagePrivacyRejectedError) throw normalized;
        if (normalized instanceof WebProviderError) {
          if (normalized.retryable && attempts > 1 && attempt === 0) continue;
          throw normalized;
        }
        if (attempts > 1 && attempt === 0 && normalized instanceof TypeError) {
          last = new WebProviderError("network", true, "fetch failed");
          continue;
        }
        if (normalized.name === "AbortError") throw new WebProviderError("timeout", false, "搜索服务请求超时。");
        if (normalized instanceof TypeError) throw new WebProviderError("network", true, "fetch failed");
        throw new WebProviderError("invalid_response", false, normalized.message === "搜索服务响应过大。"
          ? normalized.message : "搜索服务返回了无效响应。");
      } finally { clearTimeout(timeout); }
    }
    throw last instanceof WebProviderError ? last : new WebProviderError("failed", false, "搜索服务请求失败。");
  }

  private effectiveTimeout(path: "search" | "extract", timeoutOverride?: number): number {
    const operation = timeoutOverride ?? (path === "search" ? 15000 : 20000);
    return this.timeoutMs === undefined ? operation : Math.min(operation, this.timeoutMs);
  }
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return "";
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const trimmed = declared.trim();
    if (!/^\d+$/.test(trimmed)) throw new Error("invalid content-length");
    const bytes = Number(trimmed);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid content-length");
    if (bytes > maximum) throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > maximum) throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch { /* Preserve the classified response failure. */ }
    }
  }
}
