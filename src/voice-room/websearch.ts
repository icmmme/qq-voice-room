import {
  publicWebUrl, TavilyWebClient, WebSearchMalformedResponseError,
  WebPagePrivacyRejectedError, WebSearchPrivacyRejectedError,
  type TavilySearchFields, type WebSearchResult,
} from "../web.js";
import { isRoomGitHubHostname, parseRoomGitHubTarget, type RoomGitHubTarget } from "./github.js";
import { roomUrlLikeTokens } from "./url-tokens.js";

export const ROOM_SEARCH_INTENTS = Object.freeze([
  "最新", "今天", "当前", "现在", "新闻", "搜索", "检索", "查一下", "查找",
  "资料", "官网", "发布", "版本", "价格", "日程", "天气",
  "latest", "current", "news", "search", "look up",
] as const);
export const ROOM_SEARCH_MAX_RESULTS = 5;
export const ROOM_SEARCH_PROMPT_RESULTS = 3;
export const ROOM_SEARCH_SNIPPET_CHARS = 600;
export const ROOM_SEARCH_QUERY_CHARS = 400;
export const ROOM_PAGE_READ_LIMIT = 2;
export const ROOM_PAGE_BODY_CHARS = 1200;
export const ROOM_DIRECT_URL_LIMIT = 1;

export type RoomSearchStatus = "ok" | "empty" | "unavailable" | "failed" | "timeout"
  | "privacy_rejected" | "cancelled";
export interface RoomSearchEvidence {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: string;
  readonly trust: "external-untrusted";
}
export interface RoomSearchContext {
  readonly status: RoomSearchStatus;
  readonly query: string | null;
  readonly results: readonly RoomSearchEvidence[];
  readonly pages?: RoomPageReadContext;
}

export type RoomPageStatus = "not_attempted" | "ok" | "partial" | "failed" | "timeout"
  | "privacy_rejected" | "cancelled";
export interface RoomPageEvidence {
  readonly url: string;
  readonly body: string;
  readonly trust: "external-untrusted";
}
export interface RoomPageResult {
  readonly url: string;
  readonly status: Exclude<RoomPageStatus, "not_attempted" | "partial">;
}
export interface RoomPageReadContext {
  readonly status: RoomPageStatus;
  readonly pages: readonly RoomPageEvidence[];
  readonly results: readonly RoomPageResult[];
}
/** A narrow injected port: Voice Room never receives the ordinary PA WebProvider. */
export type RoomSearchProvider = (
  query: string,
  options: { maxResults: number },
  signal: AbortSignal,
) => Promise<readonly WebSearchResult[]>;
/** A narrow page-read port; it cannot search, follow links, or reach the ordinary PA tools. */
export type RoomPageReadProvider = (
  url: string,
  signal: AbortSignal,
) => Promise<{ readonly url: string; readonly content: string }>;

/** The exact contract list; English terms are case-insensitive. */
export function shouldSearchRoomText(text: string): boolean {
  if (typeof text !== "string") return false;
  const folded = text.toLocaleLowerCase("en-US");
  return ROOM_SEARCH_INTENTS.some(term => folded.includes(term.toLocaleLowerCase("en-US")));
}

export function roomSearchQuery(text: string): string {
  return [...text.trim()].slice(0, ROOM_SEARCH_QUERY_CHARS).join("");
}

export type RoomExplicitTargetKind = "ordinary" | "github" | "invalid";
export interface RoomExplicitTarget {
  readonly raw: string;
  readonly key: string;
  readonly kind: RoomExplicitTargetKind;
  readonly url?: string;
  readonly github?: RoomGitHubTarget;
}
export interface RoomExplicitTargetPlan {
  readonly rawCandidates: readonly string[];
  readonly targets: readonly RoomExplicitTarget[];
  readonly hasTargets: boolean;
  readonly failClosed: boolean;
}

function rawExplicitUrlCandidates(text: string): readonly string[] {
  if (typeof text !== "string") return [];
  const found: string[] = [], seen = new Set<string>();
  for (const token of roomUrlLikeTokens(text)) {
    if (seen.has(token.raw)) continue;
    seen.add(token.raw);
    found.push(token.raw);
  }
  return Object.freeze(found);
}

function classifyExplicitTarget(raw: string): RoomExplicitTarget {
  if (/^https?:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return Object.freeze({ raw, key: `invalid:${raw}`, kind: "invalid" as const });
  }
  const input = /^https?:\/{1,2}/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(input); } catch {
    return Object.freeze({ raw, key: `invalid:${raw}`, kind: "invalid" as const });
  }
  if (isRoomGitHubHostname(parsed.hostname)) {
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return Object.freeze({ raw, key: `invalid:${raw}`, kind: "invalid" as const });
    }
    const github = parseRoomGitHubTarget(input);
    if (!github) {
      return Object.freeze({ raw, key: `invalid:${raw}`, kind: "invalid" as const });
    }
    return Object.freeze({ raw, key: github.htmlUrl, kind: "github" as const, url: github.htmlUrl, github });
  }
  let url: string;
  try { url = publicWebUrl(input); } catch {
    return Object.freeze({ raw, key: `invalid:${raw}`, kind: "invalid" as const });
  }
  if (!url.startsWith("https://")) {
    return Object.freeze({ raw, key: `invalid:${raw}`, kind: "invalid" as const });
  }
  return Object.freeze({ raw, key: url, kind: "ordinary" as const, url });
}

/**
 * One fail-closed plan for every explicit URL-like target in one message. The
 * same plan drives Legacy and Worker, so ordinary pages and GitHub can never
 * independently spend the single-target allowance.
 */
export function explicitTargetPlan(text: string): RoomExplicitTargetPlan {
  const rawCandidates = rawExplicitUrlCandidates(text);
  const targets: RoomExplicitTarget[] = [], seen = new Set<string>();
  for (const raw of rawCandidates) {
    const candidate = classifyExplicitTarget(raw);
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    targets.push(candidate);
  }
  const frozenTargets = Object.freeze(targets);
  return Object.freeze({
    rawCandidates,
    targets: frozenTargets,
    hasTargets: rawCandidates.length > 0,
    failClosed: frozenTargets.some(candidate => candidate.kind === "invalid")
      || frozenTargets.length > ROOM_DIRECT_URL_LIMIT,
  });
}

/** All unique explicit HTTPS URLs, including GitHub and locally unsupported routes. */
export function roomExplicitHttpsUrls(text: string): readonly string[] {
  return Object.freeze(explicitTargetPlan(text).targets
    .flatMap(candidate => candidate.url ? [candidate.url] : []));
}

export function hasRoomExplicitHttpsUrl(text: string): boolean {
  return explicitTargetPlan(text).hasTargets;
}

/**
 * Non-GitHub explicit URLs are candidates for the ordinary page reader. GitHub
 * URLs stay on their structured API path and are never downgraded here.
 */
export function roomExplicitPageCandidates(text: string): readonly string[] {
  return Object.freeze(explicitTargetPlan(text).targets
    .flatMap(candidate => candidate.kind === "ordinary" && candidate.url ? [candidate.url] : []));
}

function bounded(value: string, maximum: number): string {
  return [...value.trim()].slice(0, maximum).join("");
}

function context(status: RoomSearchStatus, query: string | null,
  results: readonly RoomSearchEvidence[] = [], pages?: RoomPageReadContext): RoomSearchContext {
  return Object.freeze({ status, query, results: Object.freeze([...results]),
    ...(pages ? { pages: Object.freeze({ ...pages, pages: Object.freeze([...pages.pages]),
      results: Object.freeze([...pages.results]) }) } : {}) });
}

function timeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /timeout|超时|abort|room-operation-cancelled|room-worker-plan-timeout/i.test(message);
}

/**
 * Normalize only fields that can safely enter a public prompt. A result is dropped
 * as a whole when any returned field contains protected material or an unsafe URL.
 */
function normalize(raw: readonly WebSearchResult[], permitsText: (text: string) => boolean): {
  results: RoomSearchEvidence[];
  privacyRejected: boolean;
  malformed: boolean;
} {
  const results: RoomSearchEvidence[] = [];
  let privacyRejected = false;
  let malformed = false;
  for (const value of Array.isArray(raw) ? raw.slice(0, ROOM_SEARCH_MAX_RESULTS) : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      malformed = true;
      continue;
    }
    const safe = (text: string): boolean => {
      try { return permitsText(text) === true; } catch { return false; }
    };
    const stringFields = [value.title, value.url, value.snippet, value.publishedDate];
    if (stringFields.some(field => typeof field === "string" && !safe(field))) {
      privacyRejected = true;
      continue;
    }
    if (typeof value.title !== "string" || !value.title.trim()
      || typeof value.url !== "string" || !value.url.trim()
      || typeof value.snippet !== "string" || !value.snippet.trim()
      || (value.publishedDate !== null && typeof value.publishedDate !== "string")) {
      malformed = true;
      continue;
    }
    let url: string;
    try { url = publicWebUrl(value.url); } catch { privacyRejected = true; continue; }
    if (!safe(url) || !safe(value.title) || !safe(value.snippet)
      || (value.publishedDate !== null && !safe(value.publishedDate))) {
      privacyRejected = true;
      continue;
    }
    const title = bounded(value.title, 300);
    const snippet = bounded(value.snippet, ROOM_SEARCH_SNIPPET_CHARS);
    const publishedDate = value.publishedDate === null
      ? undefined : bounded(value.publishedDate, 100);
    if (!title || !snippet) { malformed = true; continue; }
    results.push(Object.freeze({
      title, url, snippet, ...(publishedDate ? { publishedDate } : {}),
      trust: "external-untrusted" as const,
    }));
  }
  return {
    results: results.slice(0, ROOM_SEARCH_PROMPT_RESULTS),
    privacyRejected,
    malformed,
  };
}

/**
 * Performs at most one application-level search. Missing configuration, privacy
 * rejection, empty results, provider errors and cancellation are explicit states,
 * never a synthetic successful result or an automatic retry.
 */
export async function searchRoomText(text: string, provider: RoomSearchProvider | undefined,
  permitsText: (text: string) => boolean, signal: AbortSignal): Promise<RoomSearchContext> {
  let safeText = false;
  try { safeText = permitsText(text) === true; } catch { safeText = false; }
  if (!safeText) return context("privacy_rejected", null);
  const query = roomSearchQuery(text);
  if (!query) return context("empty", null);
  let safeQuery = false;
  try { safeQuery = permitsText(query) === true; } catch { safeQuery = false; }
  if (!safeQuery) return context("privacy_rejected", null);
  if (signal.aborted) return context("cancelled", query);
  if (!provider) return context("unavailable", query);
  try {
    const raw = await provider(query, { maxResults: ROOM_SEARCH_MAX_RESULTS }, signal);
    if (signal.aborted) return context("cancelled", query);
    if (!Array.isArray(raw)) return context("failed", query);
    const normalized = normalize(raw, permitsText);
    if (normalized.results.length) return context("ok", query, normalized.results);
    if (normalized.privacyRejected) return context("privacy_rejected", query);
    return context(normalized.malformed ? "failed" : "empty", query);
  } catch (error) {
    if (signal.aborted) return context("cancelled", query);
    if (error instanceof WebSearchPrivacyRejectedError) return context("privacy_rejected", query);
    if (error instanceof WebSearchMalformedResponseError) return context("failed", query);
    return context(timeout(error) ? "timeout" : "failed", query);
  }
}

function pageTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /timeout|超时|abort/i.test(message);
}

function pageContext(status: RoomPageStatus, pages: readonly RoomPageEvidence[] = [],
  results: readonly RoomPageResult[] = []): RoomPageReadContext {
  return Object.freeze({ status, pages: Object.freeze([...pages]),
    results: Object.freeze([...results]) });
}

/**
 * Reads at most one public HTTPS URL explicitly supplied in the message. All
 * complete URL and body values are privacy-checked before normalization or
 * display truncation. Multiple distinct URLs fail closed without a provider
 * call, and GitHub URLs are left to the structured GitHub path.
 */
export async function readRoomDirectPage(text: string,
  provider: RoomPageReadProvider | undefined,
  permitsText: (text: string) => boolean, signal: AbortSignal): Promise<RoomPageReadContext> {
  const safe = (value: string): boolean => {
    try { return permitsText(value) === true; } catch { return false; }
  };
  if (!safe(text)) return pageContext("privacy_rejected");

  const plan = explicitTargetPlan(text);
  if (!plan.hasTargets) return pageContext("not_attempted");
  if (plan.rawCandidates.some(candidate => !safe(candidate))) {
    return pageContext("privacy_rejected");
  }
  if (plan.failClosed) return pageContext("failed");
  const candidate = plan.targets[0];
  if (plan.targets.length !== 1 || !candidate || candidate.kind === "invalid") {
    return pageContext("failed");
  }
  if (candidate.kind === "github") return pageContext("not_attempted");
  if (!candidate.url) return pageContext("failed");
  if (!safe(candidate.url)) return pageContext("privacy_rejected");
  if (!provider) {
    return pageContext("failed", [], [{ url: candidate.url, status: "failed" }]);
  }
  if (signal.aborted) {
    return pageContext("cancelled", [], [{ url: candidate.url, status: "cancelled" }]);
  }
  try {
    const raw = await provider(candidate.url, signal);
    if (signal.aborted) {
      return pageContext("cancelled", [], [{ url: candidate.url, status: "cancelled" }]);
    }
    if (!raw || typeof raw !== "object" || typeof raw.url !== "string"
      || typeof raw.content !== "string") {
      return pageContext("failed", [], [{ url: candidate.url, status: "failed" }]);
    }
    if (!safe(raw.url)) return pageContext("privacy_rejected");
    let returned: string;
    try { returned = publicWebUrl(raw.url); } catch {
      return pageContext("failed", [], [{ url: candidate.url, status: "failed" }]);
    }
    if (returned !== candidate.url || !returned.startsWith("https://")) {
      return pageContext("failed", [], [{ url: candidate.url, status: "failed" }]);
    }
    if (!raw.content.trim()) {
      return pageContext("failed", [], [{ url: candidate.url, status: "failed" }]);
    }
    if (!safe(raw.content)) return pageContext("privacy_rejected");
    const body = [...raw.content.trim()].slice(0, ROOM_PAGE_BODY_CHARS).join("");
    return pageContext("ok", [Object.freeze({ url: candidate.url, body,
      trust: "external-untrusted" as const })],
    [{ url: candidate.url, status: "ok" }]);
  } catch (error) {
    if (signal.aborted) {
      return pageContext("cancelled", [], [{ url: candidate.url, status: "cancelled" }]);
    }
    if (error instanceof WebPagePrivacyRejectedError) return pageContext("privacy_rejected");
    return pageContext(pageTimeout(error) ? "timeout" : "failed", [],
      [{ url: candidate.url, status: pageTimeout(error) ? "timeout" : "failed" }]);
  }
}

/**
 * Reads at most two unique HTTPS pages from already validated search evidence. The
 * page provider is called only for eligible URLs and cancellation is checked before
 * and after each call; no failure is retried or replaced by another source.
 */
export async function readRoomPages(search: RoomSearchContext,
  provider: RoomPageReadProvider | undefined,
  permitsText: (text: string) => boolean, signal: AbortSignal): Promise<RoomSearchContext> {
  if (search.status !== "ok" || !search.results.length) {
    return context(search.status, search.query, search.results, pageContext("not_attempted"));
  }
  const candidates = roomPageCandidates(search);
  if (!candidates.length) {
    return context(search.status, search.query, search.results, pageContext("not_attempted"));
  }
  if (!provider) {
    return context(search.status, search.query, search.results, pageContext("failed",
      [], candidates.map(url => Object.freeze({ url, status: "failed" as const }))));
  }
  if (signal.aborted) {
    return context(search.status, search.query, search.results, pageContext("cancelled",
      [], candidates.map(url => Object.freeze({ url, status: "cancelled" as const }))));
  }
  const outcomes = await Promise.all(candidates.map(async (url): Promise<{
    evidence?: RoomPageEvidence; result: RoomPageResult;
  }> => {
    if (signal.aborted) return { result: Object.freeze({ url, status: "cancelled" as const }) };
    try {
      const raw = await provider(url, signal);
      if (signal.aborted) return { result: Object.freeze({ url, status: "cancelled" as const }) };
      if (!raw || typeof raw.url !== "string" || typeof raw.content !== "string") {
        return { result: Object.freeze({ url, status: "failed" as const }) };
      }
      let returned: string;
      try { returned = publicWebUrl(raw.url); } catch {
        return { result: Object.freeze({ url, status: "failed" as const }) };
      }
      if (returned !== url || !returned.startsWith("https://")) {
        return { result: Object.freeze({ url, status: "failed" as const }) };
      }
      if (!raw.content.trim()) return { result: Object.freeze({ url, status: "failed" as const }) };
      let safe = false;
      try { safe = permitsText(raw.content) === true; } catch { safe = false; }
      if (!safe) return { result: Object.freeze({ url, status: "privacy_rejected" as const }) };
      const body = [...raw.content.trim()].slice(0, ROOM_PAGE_BODY_CHARS).join("");
      return { evidence: Object.freeze({ url, body, trust: "external-untrusted" as const }),
        result: Object.freeze({ url, status: "ok" as const }) };
    } catch (error) {
      if (signal.aborted) return { result: Object.freeze({ url, status: "cancelled" as const }) };
      if (error instanceof WebPagePrivacyRejectedError) {
        return { result: Object.freeze({ url, status: "privacy_rejected" as const }) };
      }
      return { result: Object.freeze({ url, status: pageTimeout(error) ? "timeout" as const : "failed" as const }) };
    }
  }));
  if (signal.aborted) {
    return context(search.status, search.query, search.results, pageContext("cancelled",
      [], outcomes.map(value => Object.freeze({ url: value.result.url, status: "cancelled" as const }))));
  }
  const pages = outcomes.flatMap(value => value.evidence ? [value.evidence] : []);
  const results = outcomes.map(value => value.result);
  const status: RoomPageStatus = pages.length === candidates.length ? "ok"
    : pages.length ? "partial"
    : results.every(value => value.status === "privacy_rejected") ? "privacy_rejected"
    : results.every(value => value.status === "timeout") ? "timeout"
    : "failed";
  return context(search.status, search.query, search.results, pageContext(status, pages, results));
}

/** The exact bounded HTTPS candidates selected from the current search evidence. */
export function roomPageCandidates(search: RoomSearchContext): readonly string[] {
  const candidates: string[] = [];
  for (const result of search.results.slice(0, ROOM_SEARCH_PROMPT_RESULTS)) {
    // GitHub targets have their own structured API path and must never fall
    // through to Tavily Extract or an ordinary page fetch.
    if (parseRoomGitHubTarget(result.url)) continue;
    let url: string;
    try { url = publicWebUrl(result.url); } catch { continue; }
    if (!url.startsWith("https://") || candidates.includes(url)) continue;
    candidates.push(url);
    if (candidates.length === ROOM_PAGE_READ_LIMIT) break;
  }
  return Object.freeze(candidates);
}

export function tavilyRoomSearch(client: {
  search(query: string, options: { maxResults: number }, signal?: AbortSignal): Promise<readonly WebSearchResult[]>;
}): RoomSearchProvider {
  return (query, options, signal) => client.search(query, options, signal);
}

/**
 * Construct the Voice Room's narrowly scoped Tavily client. The validator runs
 * on complete provider fields inside the client before result bounds are applied.
 */
export function createRoomTavilySearch(apiKey: string, timeoutMs: number | undefined,
  permitsText: (text: string) => boolean, fetcher: typeof fetch = fetch): TavilyWebClient {
  const safe = (text: string): boolean => {
    try { return permitsText(text) === true; } catch { return false; }
  };
  const scanRaw = (value: unknown): boolean => {
    if (typeof value === "string") return safe(value);
    if (Array.isArray(value)) return value.every(scanRaw);
    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).every(scanRaw);
    }
    return true;
  };
  const completeRaw = (value: unknown): boolean => {
    if (typeof value !== "string") return scanRaw(value);
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch { return safe(value); }
    return scanRaw(parsed);
  };
  return new TavilyWebClient(apiKey, timeoutMs, fetcher, {
    retry: false,
    validateRawResponse: completeRaw,
    validateSearchResult: (fields: TavilySearchFields) =>
      safe(fields.url) && safe(fields.title) && safe(fields.snippet)
      && (fields.publishedDate === null || safe(fields.publishedDate)),
    validatePageContent: (url, content) => safe(url) && safe(content),
  });
}

export function tavilyRoomPageRead(client: {
  fetchPage(url: string, query?: string, signal?: AbortSignal): Promise<{ url: string; content: string }>;
}): RoomPageReadProvider {
  return (url, signal) => client.fetchPage(url, undefined, signal);
}
