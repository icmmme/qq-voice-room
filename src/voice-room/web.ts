import { estimateTokens } from "../prompting/token-estimate.js";
import type { WebEvidenceItem } from "./context.js";

export const WEB_DEFAULT_TIMEOUT_MS = 15_000;
export const WEB_MAX_URLS_PER_MESSAGE = 3;
export const WEB_MAX_RESPONSE_BYTES = 512 * 1024;
export const WEB_HARD_CHAR_CEILING = 40_000;

export interface RoomWebConfig {
  readonly tavilyApiKey?: string;
  readonly bochaApiKey?: string;
  readonly exaApiKey?: string;
  readonly jinaApiKey?: string;
  readonly githubToken?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sanitizeText?: (text: string) => string | null;
}

export interface RoomWebFetchOptions extends RoomWebConfig {
  readonly maxChars?: number;
  readonly maxTokens?: number;
}

export type WebSearchProvider = "bocha" | "exa" | "tavily";

export type WebSearchStatus = "ok" | "empty" | "blocked" | "provider_error" | "unavailable";

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: string;
}

export interface WebSearchOutcome {
  readonly status: WebSearchStatus;
  readonly provider?: WebSearchProvider;
  readonly hits: readonly WebSearchHit[];
}

export interface RoomWebToolkit {
  readonly hasSearch: boolean;
  readonly search: (query: string, signal?: AbortSignal) => Promise<readonly WebSearchHit[]>;
  readonly searchDetailed?: (query: string, signal?: AbortSignal) => Promise<WebSearchOutcome>;
  readonly fetchUrl: (url: string, options: { maxChars?: number; maxTokens?: number }, signal?: AbortSignal) => Promise<WebEvidenceItem | null>;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'()[\]{}，。！？、；：）》】]+/gi;
const TRAILING_PUNCTUATION = /[.,;!?)\]}'"`，。！？、；：》】]+$/;

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return false;
  const nums = parts.map(Number);
  if (nums.some(num => num < 0 || num > 255)) return true;
  const [a, b] = nums as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".home.arpa") || host.endsWith(".lan")) {
    return true;
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1).toLowerCase();
    if (inner === "::1" || inner === "::" || inner === "0:0:0:0:0:0:0:1"
      || inner.startsWith("fc") || inner.startsWith("fd")
      || inner.startsWith("fe80") || inner.startsWith("fec0")
      || inner.includes("::ffff:")) {
      return true;
    }
    return false;
  }
  if (host.includes(":")) return true;
  // Block single-label hosts and integer/octal/hex IPv4 obfuscations.
  if (!host.includes(".")) return true;
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
  return false;
}

/** Validate that a URL is a clean public HTTP(S) URL with no credentials or private host. */
export function parsePublicUrl(raw: string): URL | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isBlockedHost(url.hostname)) return null;
  return url;
}

/** Extract up to `maxUrls` unique public HTTP(S) URLs from a message. */
export function extractPublicUrls(text: string, maxUrls = WEB_MAX_URLS_PER_MESSAGE): readonly string[] {
  if (typeof text !== "string" || !text.includes("://")) return Object.freeze([]);
  const found: string[] = [];
  const seen = new Set<string>();
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const cleaned = match[0].replace(TRAILING_PUNCTUATION, "");
    const parsed = parsePublicUrl(cleaned);
    if (!parsed) continue;
    const canonical = parsed.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    found.push(canonical);
    if (found.length >= maxUrls) break;
  }
  return Object.freeze(found);
}

/**
 * Determine whether a direct user request calls for a structured deep reply
 * (more output budget, multi-paragraph logic, web search/fetch, thinking enabled)
 * versus a quick conversational chat bubble + TTS voice.
 */
export function isDeepRequest(text: string, hasUrls: boolean): boolean {
  if (hasUrls) return true;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const chars = [...trimmed].length;
  if (chars >= 60) return true;
  if (/(查一下|查查|查一查|搜一下|搜搜|搜一搜|联网|上网查|帮我查|帮我搜|最近的|近况|热搜|吃瓜|什么瓜|的瓜|什么事|出了什么|发生了什么|search|look up|check online)/i.test(trimmed)) {
    return true;
  }
  if (/(总结|概括|解读|分析|评测|对比|比较|区别|原理|机制|架构|设计|详细|深入|展开|科普|优缺点|利弊|源码|论文|报告|攻略|教程|怎么评价|怎么看待|介绍一下|讲讲|聊聊这个|explain|analyze|compare|summarize|summary|architecture|benchmark|tradeoff|verification|deep dive)/i.test(trimmed)) {
    return true;
  }
  if (chars >= 8 && /(最新发布|最新版本|最新进展|最新消息|最新动态|更新日志|发布说明|官方文档|官网地址|价格对比|收费标准|什么时候发布|出了什么新|什么版本|什么是|怎么实现|怎么配置|怎么部署|怎么解决|报错|排查|踩坑|选型|推荐个|推荐几个|release notes|changelog|pricing|benchmarks?|what is|how to|why does|how does)/i.test(trimmed)) {
    return true;
  }
  if (chars >= 12 && /(为什么|为何|如何|怎样|怎么回事|发生了什么|有什么|推荐一下|怎么选|值得吗|靠谱吗|how does|why does|what is)/i.test(trimmed)) {
    return true;
  }
  return false;
}

/** Compute per-page token budget dynamically from remaining input tokens (shares up to 70%). */
export function dynamicPageTokenBudget(remainingInputTokens: number, urlCount: number): number {
  const safeRemaining = Math.max(0, remainingInputTokens);
  const totalWebTokens = Math.floor(safeRemaining * 0.70);
  return Math.max(800, Math.floor(totalWebTokens / Math.max(1, urlCount)));
}

/**
 * Truncate long web content while keeping 75% head + 25% tail so both
 * opening thesis and closing conclusions remain intact within char and token caps.
 */
export function truncateByBudget(text: string, maxChars: number, maxTokens?: number): { text: string; truncated: boolean } {
  const safeChars = Math.max(200, Math.min(WEB_HARD_CHAR_CEILING, maxChars));
  const fits = (candidate: string) =>
    candidate.length <= safeChars && (maxTokens === undefined || estimateTokens(candidate) <= maxTokens);
  if (fits(text)) return { text, truncated: false };

  let low = 120;
  let high = Math.min(text.length, safeChars);
  let best = text.slice(0, low);
  const build = (budgetChars: number): string => {
    const headLen = Math.max(80, Math.floor(budgetChars * 0.75));
    const tailLen = Math.max(40, budgetChars - headLen);
    const omitted = Math.max(0, text.length - headLen - tailLen);
    const marker = `\n\n[... 中间省略约 ${omitted} 字以适配上下文预算 ...]\n\n`;
    return `${text.slice(0, headLen).trimEnd()}${marker}${text.slice(text.length - tailLen).trimStart()}`;
  };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(mid);
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { text: best, truncated: true };
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("web-timeout")), Math.max(500, timeoutMs));
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBoundedText(response: Response, maxBytes = WEB_MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch { /* Ignore cancel errors. */ }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => {
      const num = Number(code);
      return Number.isSafeInteger(num) && num >= 32 && num <= 0x10ffff ? String.fromCodePoint(num) : "";
    });
}

function htmlToReadableText(html: string): { title?: string; content: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]!.replace(/\s+/g, " ").trim()) : undefined;
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|header|footer|h[1-6]|li|tr|blockquote|pre|br|hr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeHtmlEntities(cleaned)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { ...(title ? { title } : {}), content: text };
}

function parseJinaMarkdown(raw: string): { title?: string; content: string } {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  const titleMatch = /^Title:\s*(.+)$/m.exec(normalized);
  const title = titleMatch?.[1]?.trim();
  const markerIndex = normalized.indexOf("Markdown Content:");
  const body = markerIndex >= 0 ? normalized.slice(markerIndex + "Markdown Content:".length).trim() : normalized;
  return { ...(title ? { title } : {}), content: body.replace(/\n{3,}/g, "\n\n").trim() };
}

interface ParsedGithubTarget {
  readonly kind: "repo" | "issue" | "pull" | "commit" | "blob";
  readonly owner: string;
  readonly repo: string;
  readonly number?: string;
  readonly ref?: string;
  readonly path?: string;
}

function parseGithubUrl(url: URL): ParsedGithubTarget | null {
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, section, fourth, ...rest] = parts as [string, string, string?, string?, ...string[]];
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(owner) || !/^[a-zA-Z0-9._-]{1,100}$/.test(repo)) return null;
  const cleanRepo = repo.replace(/\.git$/i, "");
  if (!section) return { kind: "repo", owner, repo: cleanRepo };
  if (section === "issues" && fourth && /^\d+$/.test(fourth)) {
    return { kind: "issue", owner, repo: cleanRepo, number: fourth };
  }
  if (section === "pull" && fourth && /^\d+$/.test(fourth)) {
    return { kind: "pull", owner, repo: cleanRepo, number: fourth };
  }
  if (section === "commit" && fourth && /^[0-9a-f]{6,40}$/i.test(fourth)) {
    return { kind: "commit", owner, repo: cleanRepo, ref: fourth };
  }
  if (section === "blob" && fourth && rest.length > 0) {
    return { kind: "blob", owner, repo: cleanRepo, ref: fourth, path: rest.join("/") };
  }
  return null;
}

async function fetchGithubTarget(target: ParsedGithubTarget, options: RoomWebConfig,
  signal: AbortSignal): Promise<{ title: string; content: string } | null> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "qq-voice-room",
    ...(options.githubToken ? { Authorization: `Bearer ${options.githubToken}` } : {}),
  };
  const getJson = async (endpoint: string): Promise<Record<string, unknown> | null> => {
    const res = await fetchFn(`https://api.github.com${endpoint}`, { headers, signal });
    if (!res.ok) return null;
    const text = await readBoundedText(res, WEB_MAX_RESPONSE_BYTES);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  };

  if (target.kind === "repo") {
    const repo = await getJson(`/repos/${target.owner}/${target.repo}`);
    if (!repo) return null;
    const readme = await getJson(`/repos/${target.owner}/${target.repo}/readme`);
    const readmeText = typeof readme?.content === "string" && readme.encoding === "base64"
      ? Buffer.from(readme.content.replace(/\s+/g, ""), "base64").toString("utf8") : "";
    const lines = [
      `# ${String(repo.full_name ?? `${target.owner}/${target.repo}`)}`,
      repo.description ? `简介：${String(repo.description)}` : "",
      `语言：${String(repo.language ?? "未知")}｜Stars：${String(repo.stargazers_count ?? 0)}｜Forks：${String(repo.forks_count ?? 0)}`,
      readmeText ? `\n## README\n${readmeText}` : "",
    ].filter(Boolean);
    return { title: String(repo.full_name ?? `${target.owner}/${target.repo}`), content: lines.join("\n") };
  }
  if (target.kind === "issue" || target.kind === "pull") {
    const path = target.kind === "issue"
      ? `/repos/${target.owner}/${target.repo}/issues/${target.number}`
      : `/repos/${target.owner}/${target.repo}/pulls/${target.number}`;
    const item = await getJson(path);
    if (!item) return null;
    const title = `${target.owner}/${target.repo}#${target.number}: ${String(item.title ?? "")}`;
    const lines = [
      `# ${title}`,
      `状态：${String(item.state ?? "")}｜作者：${String((item.user as Record<string, unknown> | undefined)?.login ?? "")}`,
      typeof item.body === "string" && item.body.trim() ? `\n${item.body.trim()}` : "",
    ].filter(Boolean);
    return { title, content: lines.join("\n") };
  }
  if (target.kind === "commit") {
    const item = await getJson(`/repos/${target.owner}/${target.repo}/commits/${target.ref}`);
    if (!item) return null;
    const commit = item.commit as Record<string, unknown> | undefined;
    const files = Array.isArray(item.files) ? item.files as Array<Record<string, unknown>> : [];
    const fileSummary = files.slice(0, 15).map(f => `- ${String(f.filename ?? "")} (+${String(f.additions ?? 0)}/-${String(f.deletions ?? 0)})`).join("\n");
    return {
      title: `${target.owner}/${target.repo}@${target.ref?.slice(0, 8)}`,
      content: `# Commit ${target.ref}\n${String(commit?.message ?? "")}\n\n${fileSummary}`.trim(),
    };
  }
  if (target.kind === "blob" && target.path && target.ref) {
    const item = await getJson(`/repos/${target.owner}/${target.repo}/contents/${target.path}?ref=${encodeURIComponent(target.ref)}`);
    if (!item || typeof item.content !== "string") return null;
    const decoded = item.encoding === "base64"
      ? Buffer.from(item.content.replace(/\s+/g, ""), "base64").toString("utf8") : item.content;
    return {
      title: `${target.owner}/${target.repo}/${target.path}`,
      content: decoded,
    };
  }
  return null;
}

interface ParsedXTarget {
  readonly user: string;
  readonly id: string;
}

const X_HOSTS = new Set([
  "x.com", "www.x.com", "mobile.x.com",
  "twitter.com", "www.twitter.com", "mobile.twitter.com",
  "fxtwitter.com", "www.fxtwitter.com",
  "vxtwitter.com", "www.vxtwitter.com",
  "fixupx.com", "www.fixupx.com",
]);

function parseXUrl(url: URL): ParsedXTarget | null {
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  // Supports /<user>/status/<id> and /i/status/<id> and /<user>/article/<id>
  if (parts.length >= 3 && (parts[1] === "status" || parts[1] === "statuses" || parts[1] === "article")
    && /^[A-Za-z0-9_]{1,50}$/.test(parts[0]!) && /^\d{6,25}$/.test(parts[2]!)) {
    return { user: parts[0]!, id: parts[2]! };
  }
  return null;
}

async function fetchXTarget(target: ParsedXTarget, options: RoomWebConfig,
  signal: AbortSignal): Promise<{ title: string; content: string } | null> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const res = await fetchFn(`https://api.fxtwitter.com/${target.user}/status/${target.id}`, {
    headers: { Accept: "application/json", "User-Agent": "qq-voice-room/1.0" },
    signal,
  });
  if (!res.ok) return null;
  const parsed: unknown = JSON.parse(await readBoundedText(res, WEB_MAX_RESPONSE_BYTES));
  if (!parsed || typeof parsed !== "object") return null;
  const tweet = (parsed as { tweet?: Record<string, unknown> }).tweet;
  if (!tweet || typeof tweet !== "object") return null;
  const author = (tweet.author ?? {}) as Record<string, unknown>;
  const authorName = String(author.name ?? target.user);
  const handle = String(author.screen_name ?? target.user);
  const createdAt = typeof tweet.created_at === "string" ? tweet.created_at : "";
  const body = typeof tweet.text === "string" ? tweet.text.trim() : "";

  const lines: string[] = [
    `# X 帖子：${authorName} (@${handle})`,
    [
      createdAt ? `发布时间：${createdAt}` : "",
      typeof tweet.likes === "number" ? `点赞：${tweet.likes}` : "",
      typeof tweet.retweets === "number" ? `转发：${tweet.retweets}` : "",
      typeof tweet.replies === "number" ? `回复：${tweet.replies}` : "",
      typeof tweet.views === "number" ? `浏览：${tweet.views}` : "",
    ].filter(Boolean).join("｜"),
  ].filter(Boolean);

  if (body) lines.push("", body);

  // X long-form Article support
  const article = tweet.article as Record<string, unknown> | undefined;
  if (article && typeof article === "object") {
    const articleTitle = typeof article.title === "string" ? article.title.trim() : "";
    if (articleTitle) lines.push("", `## X 长文：${articleTitle}`);
    const blocks = (article.content as { blocks?: Array<Record<string, unknown>> } | undefined)?.blocks;
    if (Array.isArray(blocks) && blocks.length > 0) {
      const articleBody = blocks.map(b => typeof b?.text === "string" ? b.text.trim() : "").filter(Boolean).join("\n\n");
      if (articleBody) lines.push("", articleBody);
    } else if (typeof article.preview_text === "string" && article.preview_text.trim()) {
      lines.push("", article.preview_text.trim());
    }
  }

  // Quoted tweet support
  const quote = tweet.quote as Record<string, unknown> | undefined;
  if (quote && typeof quote === "object" && typeof quote.text === "string" && quote.text.trim()) {
    const qAuthor = (quote.author ?? {}) as Record<string, unknown>;
    const qName = String(qAuthor.name ?? "");
    const qHandle = String(qAuthor.screen_name ?? "");
    lines.push("", `## 引用推文（${qName}${qHandle ? ` @${qHandle}` : ""}）`, quote.text.trim());
  }

  // Media alt texts if any
  const mediaAll = (tweet.media as { all?: Array<Record<string, unknown>> } | undefined)?.all;
  if (Array.isArray(mediaAll)) {
    const alts = mediaAll.map(m => typeof m?.altText === "string" ? m.altText.trim() : "").filter(Boolean);
    if (alts.length) lines.push("", "配图说明：" + alts.join(" / "));
  }

  const content = lines.join("\n").trim();
  if (!content) return null;
  const title = article && typeof article.title === "string" && article.title.trim()
    ? `${authorName} (@${handle}) - ${article.title.trim()}`
    : `${authorName} (@${handle}) on X`;
  return { title, content };
}

/**
 * Fetch a single public URL with smart routing:
 * 1. GitHub URLs -> GitHub REST API (fallback to Jina Reader if rate-limited)
 * 2. X / Twitter URLs -> FxTwitter public JSON API (tweets, quotes, X Articles)
 * 3. General / JS-rendered pages -> Jina Reader Markdown
 * 4. Fallback -> Direct HTTP fetch + HTML-to-text cleaner (SSRF-checked after redirect)
 */
export async function fetchPublicUrl(rawUrl: string, options: RoomWebFetchOptions = {},
  parentSignal?: AbortSignal): Promise<WebEvidenceItem | null> {
  const url = parsePublicUrl(rawUrl);
  if (!url) return null;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? WEB_DEFAULT_TIMEOUT_MS;
  const { signal, cleanup } = combineSignal(parentSignal, timeoutMs);
  try {
    let kind: WebEvidenceItem["kind"] = "page";
    let title: string | undefined;
    let rawContent = "";

    // Route 1: GitHub API
    const gh = parseGithubUrl(url);
    if (gh) {
      try {
        const result = await fetchGithubTarget(gh, options, signal);
        if (result && result.content.trim()) {
          kind = "github";
          title = result.title;
          rawContent = result.content;
        }
      } catch { /* Fall through to Jina Reader. */ }
    }

    // Route 1.5: X / Twitter via FxTwitter API (works on tweets, quotes, and X Articles without login)
    const xTarget = !rawContent ? parseXUrl(url) : null;
    if (xTarget) {
      try {
        const result = await fetchXTarget(xTarget, options, signal);
        if (result && result.content.trim()) {
          kind = "page";
          title = result.title;
          rawContent = result.content;
        }
      } catch { /* Fall through to Jina Reader. */ }
    }

    // Route 2: Jina Reader (clean Markdown, works great for JS/SPA blogs like claude.dev)
    if (!rawContent) {
      try {
        const jinaHeaders: Record<string, string> = {
          Accept: "text/markdown",
          "X-Return-Format": "markdown",
          ...(options.jinaApiKey ? { Authorization: `Bearer ${options.jinaApiKey}` } : {}),
        };
        const res = await fetchFn(`https://r.jina.ai/${url.toString()}`, { headers: jinaHeaders, signal });
        if (res.ok) {
          const text = await readBoundedText(res, WEB_MAX_RESPONSE_BYTES);
          const parsed = parseJinaMarkdown(text);
          if (parsed.content.length >= 40) {
            title = parsed.title ?? title;
            rawContent = parsed.content;
          }
        }
      } catch { /* Fall through to direct fetch. */ }
    }

    // Route 3: Direct HTTP fetch + HTML cleaner fallback
    if (!rawContent) {
      try {
        const res = await fetchFn(url.toString(), {
          redirect: "follow",
          headers: {
            Accept: "text/markdown, text/html, text/plain;q=0.9, */*;q=0.1",
            "User-Agent": "Mozilla/5.0 (compatible; qq-voice-room/1.0)",
          },
          signal,
        });
        if (res.ok) {
          // Verify final redirected URL is still public (prevents SSRF via 302).
          if (res.url && !parsePublicUrl(res.url)) return null;
          const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
          if (contentType.includes("text/") || contentType.includes("json") || contentType.includes("xml") || !contentType) {
            const text = await readBoundedText(res, WEB_MAX_RESPONSE_BYTES);
            if (contentType.includes("html") || /<html[\s>]|<body[\s>]|<!doctype/i.test(text.slice(0, 512))) {
              const parsed = htmlToReadableText(text);
              title = parsed.title ?? title;
              rawContent = parsed.content;
            } else {
              rawContent = text.trim();
            }
          }
        }
      } catch { /* Unable to fetch URL. */ }
    }

    if (!rawContent.trim()) return null;

    const sanitize = options.sanitizeText;
    const safeUrl = sanitize ? sanitize(url.toString()) : url.toString();
    const safeTitle = title === undefined ? undefined : (sanitize ? sanitize(title) : title);
    const safeContent = sanitize ? sanitize(rawContent) : rawContent;
    if (!safeUrl || !safeContent || (title !== undefined && safeTitle === null)) return null;

    const maxChars = Math.min(WEB_HARD_CHAR_CEILING, Math.max(400, options.maxChars ?? WEB_HARD_CHAR_CEILING));
    const truncated = truncateByBudget(safeContent.trim(), maxChars, options.maxTokens);
    return Object.freeze({
      kind,
      url: safeUrl,
      ...(safeTitle ? { title: safeTitle } : {}),
      content: truncated.text,
      truncated: truncated.truncated,
    });
  } finally {
    cleanup();
  }
}

export function hasWebSearchProvider(config: RoomWebConfig): boolean {
  return Boolean(config.bochaApiKey || config.exaApiKey || config.tavilyApiKey);
}

interface RawSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: string;
}

interface SearchProviderSpec {
  readonly name: WebSearchProvider;
  readonly apiKey: string | undefined;
  readonly buildRequest: (query: string, apiKey: string) => { url: string; init: RequestInit };
  readonly parseHits: (body: unknown) => readonly RawSearchHit[];
}

function normalizeSearchHits(
  rawHits: readonly RawSearchHit[],
  sanitize?: (text: string) => string | null,
): readonly WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const seenUrls = new Set<string>();
  for (const hit of rawHits) {
    const parsed = parsePublicUrl(hit.url);
    if (!parsed) continue;
    const canonicalUrl = parsed.toString();
    if (seenUrls.has(canonicalUrl)) continue;
    const normalizedTitle = hit.title.replace(/\s+/g, " ").trim();
    if (!normalizedTitle) continue;
    const safeTitle = sanitize ? sanitize(normalizedTitle) : normalizedTitle;
    const safeUrl = sanitize ? sanitize(canonicalUrl) : canonicalUrl;
    if (!safeTitle || !safeUrl) continue;

    const normalizedSnippet = hit.snippet.replace(/\s+/g, " ").trim().slice(0, 1200);
    let safeSnippet: string | null;
    if (normalizedSnippet) {
      safeSnippet = sanitize ? sanitize(normalizedSnippet) : normalizedSnippet;
      if (!safeSnippet) continue;
    } else {
      safeSnippet = safeTitle;
    }

    let safePublishedDate: string | undefined;
    if (typeof hit.publishedDate === "string") {
      const normalizedDate = hit.publishedDate.replace(/\s+/g, " ").trim().slice(0, 64);
      if (normalizedDate) {
        const sanitizedDate = sanitize ? sanitize(normalizedDate) : normalizedDate;
        if (sanitizedDate) safePublishedDate = sanitizedDate.slice(0, 64);
      }
    }

    seenUrls.add(canonicalUrl);
    hits.push(Object.freeze({
      title: safeTitle,
      url: safeUrl,
      snippet: safeSnippet,
      ...(safePublishedDate ? { publishedDate: safePublishedDate } : {}),
    }));
    if (hits.length >= 5) break;
  }
  return Object.freeze(hits);
}

function buildSearchProviders(config: RoomWebConfig): readonly SearchProviderSpec[] {
  return [
    {
      name: "bocha",
      apiKey: config.bochaApiKey,
      buildRequest: (query, apiKey) => ({
        url: "https://api.bochaai.com/v1/web-search",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ query, summary: true, count: 5 }),
        },
      }),
      parseHits: body => {
        const items = (body as { data?: { webPages?: { value?: Array<Record<string, unknown>> } } } | null)
          ?.data?.webPages?.value ?? [];
        return items.map(item => ({
          title: String(item.name ?? ""),
          url: String(item.url ?? ""),
          snippet: String(item.summary ?? item.snippet ?? ""),
          ...(typeof item.datePublished === "string" ? { publishedDate: item.datePublished } : {}),
        }));
      },
    },
    {
      name: "exa",
      apiKey: config.exaApiKey,
      buildRequest: (query, apiKey) => ({
        url: "https://api.exa.ai/search",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({ query, numResults: 5, contents: { text: { maxCharacters: 1200 } } }),
        },
      }),
      parseHits: body => {
        const items = (body as { results?: Array<Record<string, unknown>> } | null)?.results ?? [];
        return items.map(item => ({
          title: String(item.title ?? ""),
          url: String(item.url ?? ""),
          snippet: String(item.text ?? item.summary ?? ""),
          ...(typeof item.publishedDate === "string" ? { publishedDate: item.publishedDate } : {}),
        }));
      },
    },
    {
      name: "tavily",
      apiKey: config.tavilyApiKey,
      buildRequest: (query, apiKey) => ({
        url: "https://api.tavily.com/search",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: 5,
            search_depth: "basic",
            include_answer: false,
          }),
        },
      }),
      parseHits: body => {
        const items = (body as { results?: Array<Record<string, unknown>> } | null)?.results ?? [];
        return items.map(item => ({
          title: String(item.title ?? ""),
          url: String(item.url ?? ""),
          snippet: String(item.content ?? ""),
          ...(typeof item.published_date === "string" ? { publishedDate: item.published_date } : {}),
        }));
      },
    },
  ];
}

/**
 * Search public web across configured providers in Bocha -> Exa -> Tavily priority order
 * with per-provider automatic failover and structured outcome reporting.
 */
export async function searchPublicWebDetailed(query: string, config: RoomWebConfig,
  parentSignal?: AbortSignal): Promise<WebSearchOutcome> {
  if (parentSignal?.aborted) {
    throw parentSignal.reason instanceof Error ? parentSignal.reason : new Error("web-search-aborted");
  }
  if (!hasWebSearchProvider(config)) {
    return Object.freeze({ status: "unavailable", hits: Object.freeze([]) });
  }
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed || trimmed.length > 400) {
    return Object.freeze({ status: "empty", hits: Object.freeze([]) });
  }
  const sanitize = config.sanitizeText;
  const safeQuery = sanitize ? sanitize(trimmed) : trimmed;
  if (!safeQuery || safeQuery !== trimmed) {
    return Object.freeze({ status: "blocked", hits: Object.freeze([]) });
  }

  const fetchFn = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? WEB_DEFAULT_TIMEOUT_MS;
  const providers = buildSearchProviders(config).filter(spec => Boolean(spec.apiKey));
  let anyOkResponse = false;

  for (const spec of providers) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason instanceof Error ? parentSignal.reason : new Error("web-search-aborted");
    }
    const { signal, cleanup } = combineSignal(parentSignal, timeoutMs);
    try {
      const req = spec.buildRequest(safeQuery, spec.apiKey!);
      const res = await fetchFn(req.url, { ...req.init, signal });
      if (!res.ok) continue;
      const body: unknown = JSON.parse(await readBoundedText(res));
      anyOkResponse = true;
      const hits = normalizeSearchHits(spec.parseHits(body), sanitize);
      if (hits.length > 0) {
        return Object.freeze({ status: "ok", provider: spec.name, hits });
      }
    } catch (error) {
      if (parentSignal?.aborted) throw error;
    } finally {
      cleanup();
    }
  }

  return Object.freeze({
    status: anyOkResponse ? "empty" : "provider_error",
    hits: Object.freeze([]),
  });
}

/** Search public web using Bocha -> Exa -> Tavily priority order. */
export async function searchPublicWeb(query: string, config: RoomWebConfig,
  parentSignal?: AbortSignal): Promise<readonly WebSearchHit[]> {
  return searchPublicWebDetailed(query, config, parentSignal).then(result => result.hits);
}

export function createRoomWebToolkit(config: RoomWebConfig): RoomWebToolkit {
  return Object.freeze({
    hasSearch: hasWebSearchProvider(config),
    search: (query: string, signal?: AbortSignal) => searchPublicWeb(query, config, signal),
    searchDetailed: (query: string, signal?: AbortSignal) => searchPublicWebDetailed(query, config, signal),
    fetchUrl: (url: string, options: { maxChars?: number; maxTokens?: number }, signal?: AbortSignal) =>
      fetchPublicUrl(url, { ...config, ...options }, signal),
  });
}
