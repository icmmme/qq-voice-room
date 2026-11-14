import { roomUrlLikeTokens } from "./url-tokens.js";

export const ROOM_GITHUB_TARGET_LIMIT = 2;
export const ROOM_GITHUB_EVIDENCE_CHARS = 6000;
export const ROOM_GITHUB_TITLE_CHARS = 300;
export const ROOM_GITHUB_TREE_ENTRIES = 100;
export const ROOM_GITHUB_COMMIT_ENTRIES = 10;
export const ROOM_GITHUB_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type RoomGitHubKind = "repository" | "blob" | "tree" | "issue" | "pull"
  | "commit" | "commits" | "unsupported";
export type RoomGitHubStatus = "ok" | "partial" | "not_found" | "forbidden"
  | "rate_limited" | "timeout" | "unsupported" | "invalid_response"
  | "http_error" | "privacy_rejected" | "cancelled" | "failed";

export interface RoomGitHubTarget {
  readonly inputUrl: string;
  readonly htmlUrl: string;
  readonly owner: string;
  readonly repo: string;
  readonly kind: RoomGitHubKind;
  readonly ref?: string;
  readonly path?: string;
  readonly number?: number;
}

export interface RoomGitHubEvidence {
  readonly url: string;
  readonly kind: Exclude<RoomGitHubKind, "unsupported">;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly trust: "external-untrusted";
}

export interface RoomGitHubResult {
  readonly url: string;
  readonly status: RoomGitHubStatus;
}

export interface RoomGitHubContext {
  readonly status: RoomGitHubStatus;
  readonly evidence: readonly RoomGitHubEvidence[];
  readonly results: readonly RoomGitHubResult[];
}

/** Raw provider response. Fields are intentionally not bounded here. */
export interface RoomGitHubReadPayload {
  readonly data: unknown;
  /** Optional second structured request for a repository's default-branch HEAD. */
  readonly head?: unknown;
  readonly htmlUrl?: unknown;
  readonly hasNext?: boolean;
  readonly partial?: boolean;
}

export type RoomGitHubReadProvider = (
  target: RoomGitHubTarget,
  signal: AbortSignal,
) => Promise<RoomGitHubReadPayload>;

export class RoomGitHubReadError extends Error {
  constructor(readonly status: RoomGitHubStatus) {
    super(status);
    this.name = "RoomGitHubReadError";
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
/**
 * Public github.com routes that occupy the first URL segment but are not
 * repository owners. This is one explicit fail-closed policy rather than
 * scattered parser exceptions. GitHub may add routes later; unknown names
 * still follow the standard `<owner>/<repo>` grammar.
 */
const NON_REPOSITORY_TOP_LEVEL_ROUTES = new Set([
  "about", "account", "apps", "codespaces", "collections", "contact",
  "copilot", "customer-stories", "dashboard", "education", "enterprise",
  "events", "explore", "features", "home", "issues", "join", "login",
  "logout", "marketplace", "mobile", "new", "nonprofit", "notifications",
  "organizations", "orgs", "pricing", "pulls", "readme", "resources",
  "search", "security", "settings", "signup", "site", "solutions",
  "sponsors", "stars", "team", "topics", "trending", "users", "watching",
]);

/** All GitHub-owned HTML hosts must stay off the generic page-reader path. */
export function isRoomGitHubHostname(value: string): boolean {
  const hostname = value.toLocaleLowerCase("en-US").replace(/\.+$/, "");
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

function target(inputUrl: string, htmlUrl: string, owner: string, repo: string,
  kind: RoomGitHubKind, fields: { ref?: string; path?: string; number?: number } = {}): RoomGitHubTarget {
  return Object.freeze({ inputUrl, htmlUrl, owner, repo, kind, ...fields });
}

function targetKey(value: RoomGitHubTarget): string {
  return [
    value.owner.toLocaleLowerCase("en-US"), value.repo.toLocaleLowerCase("en-US"),
    value.kind, value.number ?? "", value.ref ?? "", value.path ?? "",
  ].join("\u0000");
}

function safeDecode(value: string): string | undefined {
  try {
    if (/%2f|%5c/i.test(value)) return undefined;
    return decodeURIComponent(value);
  } catch { return undefined; }
}

function unsafeSegment(value: string): boolean {
  return value === "." || value === ".." || /[\u0000-\u001f\u007f]/.test(value)
    || /[?#]/.test(value);
}

/**
 * Parse only standard public github.com HTML URLs. A URL that is clearly a
 * GitHub URL but has an unsupported or ambiguous route is retained as an
 * explicit unsupported target; it is never handed to a generic fetcher.
 */
export function parseRoomGitHubTarget(raw: string): RoomGitHubTarget | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:" || !isRoomGitHubHostname(url.hostname)
    || url.username || url.password) return undefined;
  const normalized = new URL(url.toString());
  normalized.hash = "";
  const query = normalized.search;
  normalized.search = "";
  normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
  const rawSegments = normalized.pathname.split("/").slice(1);
  if (rawSegments.at(-1) === "") rawSegments.pop();
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const canonicalHost = hostname === "github.com";
  const nonDefaultPort = Boolean(url.port);
  if (!canonicalHost || nonDefaultPort) {
    return target(raw, normalized.toString(), rawSegments[0] ?? "", rawSegments[1] ?? "", "unsupported");
  }
  if (rawSegments.some(value => value === "")) {
    return target(raw, normalized.toString(), rawSegments[0] ?? "", rawSegments[1] ?? "", "unsupported");
  }
  const segments = rawSegments.map(safeDecode);
  if (segments.some(value => value === undefined) || query) {
    return target(raw, normalized.toString(), segments[0] ?? "", segments[1] ?? "", "unsupported");
  }
  const owner = segments[0], repo = segments[1];
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === "."
    || repo === ".." || /\.git$/i.test(repo)) {
    return target(raw, normalized.toString(), owner ?? "", repo ?? "", "unsupported");
  }
  if (NON_REPOSITORY_TOP_LEVEL_ROUTES.has(owner.toLowerCase())) {
    return target(raw, normalized.toString(), owner, repo, "unsupported");
  }
  const rest = segments.slice(2).filter((value): value is string => value !== undefined);
  if (rest.some(unsafeSegment)) {
    return target(raw, normalized.toString(), owner, repo, "unsupported");
  }
  if (!rest.length) return target(raw, normalized.toString(), owner, repo, "repository");
  const route = rest[0]!;
  const suffix = rest.slice(1);
  if (route === "issues" || route === "pull") {
    if (suffix.length !== 1 || !/^[1-9]\d{0,15}$/.test(suffix[0]!)
      || !Number.isSafeInteger(Number(suffix[0]))) {
      return target(raw, normalized.toString(), owner, repo, "unsupported");
    }
    return target(raw, normalized.toString(), owner, repo, route === "issues" ? "issue" : "pull",
      { number: Number(suffix[0]) });
  }
  if (route === "commit") {
    if (suffix.length !== 1 || !SHA.test(suffix[0]!)) {
      return target(raw, normalized.toString(), owner, repo, "unsupported");
    }
    return target(raw, normalized.toString(), owner, repo, "commit", { ref: suffix[0]! });
  }
  if (route === "commits") {
    if (suffix.length > 1) return target(raw, normalized.toString(), owner, repo, "unsupported");
    return target(raw, normalized.toString(), owner, repo, "commits",
      suffix[0] ? { ref: suffix[0] } : {});
  }
  if (route === "blob" || route === "tree") {
    if (!suffix[0]) return target(raw, normalized.toString(), owner, repo, "unsupported");
    const ref = suffix[0];
    const path = suffix.slice(1).join("/");
    if (route === "blob" && !path) return target(raw, normalized.toString(), owner, repo, "unsupported");
    // The public HTML route has no delimiter between a slash-containing ref
    // and the path. The accepted grammar is therefore one ref segment followed
    // by an optional path. Encoded slashes are rejected above, so a
    // slash-containing ref is never silently guessed; callers that need one
    // must use the API rather than this bounded HTML URL reader.
    return target(raw, normalized.toString(), owner, repo, route === "blob" ? "blob" : "tree",
      { ref, ...(path ? { path } : {}) });
  }
  return target(raw, normalized.toString(), owner, repo, "unsupported");
}

/** Extract standard public GitHub URLs from one explicit message. */
export function githubTargetsFromText(text: string): readonly RoomGitHubTarget[] {
  if (typeof text !== "string") return Object.freeze([]);
  const found: RoomGitHubTarget[] = [];
  for (const token of roomUrlLikeTokens(text)) {
    const raw = token.kind === "github" ? `https://${token.raw}` : token.raw;
    const parsed = parseRoomGitHubTarget(raw);
    if (parsed) found.push(parsed);
  }
  return uniqueGitHubTargets(found);
}

/** Only the already bounded, privacy-checked search results can add targets. */
export function githubTargetsFromSearch(search: {
  readonly results: readonly { readonly url: string }[];
} | undefined): readonly RoomGitHubTarget[] {
  if (!search) return Object.freeze([]);
  const found: RoomGitHubTarget[] = [];
  for (const result of search.results.slice(0, 3)) {
    const parsed = parseRoomGitHubTarget(result.url);
    if (parsed) found.push(parsed);
  }
  return uniqueGitHubTargets(found);
}

export function uniqueGitHubTargets(...groups: readonly (readonly RoomGitHubTarget[])[]): readonly RoomGitHubTarget[] {
  const seen = new Set<string>();
  const result: RoomGitHubTarget[] = [];
  for (const group of groups) {
    for (const target of group) {
      const key = targetKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(target);
      if (result.length === ROOM_GITHUB_TARGET_LIMIT) return Object.freeze(result);
    }
  }
  return Object.freeze(result);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safe(permitsText: (text: string) => boolean, value: string): boolean {
  try { return permitsText(value) === true; } catch { return false; }
}

function scanStrings(value: unknown, permitsText: (text: string) => boolean): boolean {
  if (typeof value === "string") return safe(permitsText, value);
  if (Array.isArray(value)) return value.every(item => scanStrings(item, permitsText));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(item => scanStrings(item, permitsText));
  }
  return true;
}

function projectFields(value: unknown, fields: readonly string[]): unknown {
  const source = object(value);
  if (!source) return value;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) projected[field] = source[field];
  }
  return projected;
}

function projectList(value: unknown, fields: readonly string[]): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => projectFields(item, fields));
}

function projectRepository(data: unknown): unknown {
  return projectFields(data, [
    "full_name", "name", "description", "default_branch", "language",
    "stargazers_count", "forks_count", "updated_at",
  ]);
}

function projectBlob(data: unknown): unknown {
  return projectFields(data, ["path", "sha", "encoding", "content", "truncated"]);
}

function projectTree(data: unknown): unknown {
  const projected = projectFields(data, ["sha", "tree", "truncated"]);
  const source = object(data);
  const target = object(projected);
  if (source && target && Object.prototype.hasOwnProperty.call(source, "tree")) {
    target.tree = projectList(source.tree, ["type", "name", "path", "size"]);
  }
  return projected;
}

function projectUser(value: unknown): unknown {
  return projectFields(value, ["login"]);
}

function projectLabels(value: unknown): unknown {
  return projectList(value, ["name"]);
}

function projectIssue(data: unknown, pull: boolean): unknown {
  const projected = projectFields(data, pull
    ? ["title", "body", "state", "user", "labels", "created_at", "updated_at",
      "comments", "merged", "base", "head"]
    : ["title", "body", "state", "user", "labels", "created_at", "updated_at", "comments"]);
  const source = object(data);
  const target = object(projected);
  if (!source || !target) return projected;
  if (Object.prototype.hasOwnProperty.call(source, "user")) target.user = projectUser(source.user);
  if (Object.prototype.hasOwnProperty.call(source, "labels")) target.labels = projectLabels(source.labels);
  if (pull) {
    if (Object.prototype.hasOwnProperty.call(source, "base")) target.base = projectFields(source.base, ["ref"]);
    if (Object.prototype.hasOwnProperty.call(source, "head")) target.head = projectFields(source.head, ["ref"]);
  }
  return projected;
}

function projectCommit(data: unknown): unknown {
  const projected = projectFields(data, ["sha", "commit", "author", "stats", "files"]);
  const source = object(data);
  const target = object(projected);
  if (!source || !target) return projected;
  if (Object.prototype.hasOwnProperty.call(source, "commit")) {
    const commit = projectFields(source.commit, ["message", "author"]);
    const commitSource = object(source.commit);
    const commitTarget = object(commit);
    if (commitSource && commitTarget && Object.prototype.hasOwnProperty.call(commitSource, "author")) {
      commitTarget.author = projectFields(commitSource.author, ["name", "date"]);
    }
    target.commit = commit;
  }
  if (Object.prototype.hasOwnProperty.call(source, "author")) {
    target.author = projectFields(source.author, ["name", "login", "date"]);
  }
  if (Object.prototype.hasOwnProperty.call(source, "stats")) {
    target.stats = projectFields(source.stats, ["total"]);
  }
  if (Object.prototype.hasOwnProperty.call(source, "files")) {
    target.files = projectList(source.files, ["filename", "status", "changes"]);
  }
  return projected;
}

function projectCommits(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map(item => {
    const projected = projectFields(item, ["sha", "commit"]);
    const source = object(item);
    const target = object(projected);
    if (source && target && Object.prototype.hasOwnProperty.call(source, "commit")) {
      target.commit = projectFields(source.commit, ["message"]);
    }
    return projected;
  });
}

function projectGitHubData(kind: RoomGitHubKind, data: unknown): unknown {
  if (kind === "repository") return projectRepository(data);
  if (kind === "blob") return projectBlob(data);
  if (kind === "tree") return projectTree(data);
  if (kind === "issue") return projectIssue(data, false);
  if (kind === "pull") return projectIssue(data, true);
  if (kind === "commit") return projectCommit(data);
  if (kind === "commits") return projectCommits(data);
  return data;
}

function projectHead(data: unknown): unknown {
  return projectFields(data, ["sha"]);
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const value = declared.trim();
    if (!/^\d+$/.test(value)) throw new RoomGitHubReadError("invalid_response");
    const length = Number(value);
    if (!Number.isSafeInteger(length) || length > ROOM_GITHUB_MAX_RESPONSE_BYTES) {
      throw new RoomGitHubReadError("invalid_response");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > ROOM_GITHUB_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RoomGitHubReadError("invalid_response");
      }
      chunks.push(next.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* stream already closed or cancelled */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RoomGitHubReadError("invalid_response");
  }
}

function bounded(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function line(label: string, value: unknown): string {
  return `${label}: ${typeof value === "string" ? value.trim() : String(value)}`;
}

function repositoryText(data: Record<string, unknown>): string {
  return [
    line("仓库", data.full_name ?? data.name),
    line("描述", data.description ?? ""),
    line("默认分支", data.default_branch ?? ""),
    line("默认分支 HEAD", textField(data.headSha) ?? "未知"),
    line("语言", data.language ?? ""),
    line("Stars", numberField(data.stargazers_count) ?? 0),
    line("Forks", numberField(data.forks_count) ?? 0),
    line("更新时间", data.updated_at ?? ""),
  ].join("\n");
}

type BlobTextResult =
  | { readonly status: "ok"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "invalid"; readonly text?: never; readonly truncated?: never }
  | { readonly status: "privacy_rejected"; readonly text?: never; readonly truncated?: never };

function decodeGitHubBase64(encoded: string): Uint8Array | undefined {
  // The GitHub contents API may wrap base64 with ASCII line breaks. Accept
  // only those transport whitespace characters, then require canonical,
  // padded RFC 4648 base64 before asking Node to decode it.
  const compact = encoded.replace(/[ \t\r\n\f]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    return undefined;
  }
  const bytes = Buffer.from(compact, "base64");
  return bytes.toString("base64") === compact ? bytes : undefined;
}

function blobText(data: Record<string, unknown>, ref: string,
  permitsText: (text: string) => boolean): BlobTextResult {
  const encoded = textField(data.content);
  const encoding = textField(data.encoding);
  let content = "";
  if (encoded !== undefined && encoding === "base64") {
    const bytes = decodeGitHubBase64(encoded);
    if (!bytes) return { status: "invalid" };
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { return { status: "invalid" }; }
  } else if (encoded !== undefined && encoding === "utf-8") {
    content = encoded;
  } else if (encoded !== undefined && !encoding) {
    content = encoded;
  } else {
    return { status: "invalid" };
  }
  if (!safe(permitsText, content)) return { status: "privacy_rejected" };
  const header = [
    line("路径", data.path ?? ""),
    line("ref", ref),
    line("SHA", data.sha ?? ""),
    line("是否截断", Boolean(data.truncated)),
    "",
  ].join("\n");
  const full = `${header}${content}`;
  const text = bounded(full, ROOM_GITHUB_EVIDENCE_CHARS);
  return { status: "ok", text, truncated: text.length < full.length || Boolean(data.truncated) };
}

function treeText(data: Record<string, unknown>, ref: string): { text: string; truncated: boolean } {
  const tree = Array.isArray(data.tree) ? data.tree : [];
  const entries = tree.slice(0, ROOM_GITHUB_TREE_ENTRIES).map(item => {
    const entry = object(item) ?? {};
    return `${String(entry.type ?? "?")}\t${String(entry.name ?? entry.path ?? "?")}`
      + (numberField(entry.size) === undefined ? "" : `\t${numberField(entry.size)}B`);
  });
  const header = [
    line("ref", ref),
    line("SHA", data.sha ?? ""),
    line("目录项", tree.length),
    line("是否截断", Boolean(data.truncated)),
    "",
  ].join("\n");
  const full = `${header}${entries.length ? entries.join("\n") : "目录为空。"}`;
  const text = bounded(full, ROOM_GITHUB_EVIDENCE_CHARS);
  return { text, truncated: Boolean(data.truncated) || tree.length > ROOM_GITHUB_TREE_ENTRIES
    || text.length < full.length };
}

function issueText(data: Record<string, unknown>, pull: boolean): string {
  const user = object(data.user) ?? {};
  const labels = Array.isArray(data.labels)
    ? data.labels.map(label => textField(object(label)?.name) ?? textField(label) ?? "").filter(Boolean)
    : [];
  const lines = [
    line("标题", data.title ?? ""),
    line("状态", data.state ?? ""),
    line("作者", user.login ?? ""),
    line("创建时间", data.created_at ?? ""),
    line("更新时间", data.updated_at ?? ""),
    line("评论数", data.comments ?? 0),
    line("标签", labels.join(", ")),
  ];
  if (pull) {
    const base = object(data.base) ?? {}, head = object(data.head) ?? {};
    lines.push(line("merged", Boolean(data.merged)), line("base", base.ref ?? ""), line("head", head.ref ?? ""));
  }
  lines.push("", textField(data.body) ?? "");
  return lines.join("\n");
}

function commitText(data: Record<string, unknown>): { text: string; truncated: boolean } {
  const commit = object(data.commit) ?? {};
  const author = object(commit.author) ?? object(data.author) ?? {};
  const files = Array.isArray(data.files) ? data.files.map(file => {
    const value = object(file) ?? {};
    return `${String(value.status ?? "?")}\t${String(value.filename ?? "?")}`
      + (numberField(value.changes) === undefined ? "" : `\t${numberField(value.changes)} changes`);
  }) : [];
  const text = [
    line("SHA", data.sha ?? ""),
    line("作者", author.name ?? author.login ?? ""),
    line("时间", author.date ?? ""),
    line("消息", textField(commit.message) ?? ""),
    line("文件数", numberField(data.stats && object(data.stats)?.total) ?? files.length),
    line("文件", files.slice(0, 100).join("; ")),
  ].join("\n");
  return { text, truncated: files.length > 100 };
}

function commitsText(data: readonly unknown[], hasNext: boolean): { text: string; truncated: boolean } {
  const entries = data.slice(0, ROOM_GITHUB_COMMIT_ENTRIES).map(item => {
    const value = object(item) ?? {};
    const commit = object(value.commit) ?? {};
    return `${String(value.sha ?? "?")}\t${String(commit.message ?? "").split("\n")[0] ?? ""}`;
  });
  const full = entries.length ? entries.join("\n") : "没有提交。";
  const text = bounded(full, ROOM_GITHUB_EVIDENCE_CHARS);
  return { text, truncated: hasNext || data.length > ROOM_GITHUB_COMMIT_ENTRIES || text.length < full.length };
}

function normalize(targetValue: RoomGitHubTarget, payload: RoomGitHubReadPayload,
  permitsText: (text: string) => boolean): { evidence?: RoomGitHubEvidence; status: RoomGitHubStatus } {
  if (!scanStrings(payload.data, permitsText)) return { status: "privacy_rejected" };
  if (!scanStrings(payload.head, permitsText)) return { status: "privacy_rejected" };
  if (!scanStrings(payload.htmlUrl, permitsText)) return { status: "privacy_rejected" };
  if (payload.htmlUrl !== undefined && typeof payload.htmlUrl !== "string") {
    return { status: "invalid_response" };
  }
  const data = payload.data;
  let title = "";
  let text = "";
  let truncated = false;
  if (targetValue.kind === "repository") {
    const value = object(data);
    if (!value) return { status: "invalid_response" };
    if (payload.head !== undefined && !textField(object(payload.head)?.sha)) {
      return { status: "invalid_response" };
    }
    title = textField(value.full_name) ?? textField(value.name) ?? "";
    const headSha = textField(object(payload.head)?.sha);
    text = repositoryText({ ...value, ...(headSha ? { headSha } : {}) });
  } else if (targetValue.kind === "blob") {
    const value = object(data);
    if (!value) return { status: "invalid_response" };
    const result = blobText(value, targetValue.ref!, permitsText);
    if (result.status === "privacy_rejected") return { status: "privacy_rejected" };
    if (result.status === "invalid") return { status: "invalid_response" };
    title = textField(value.path) ?? "";
    text = result.text; truncated = result.truncated;
  } else if (targetValue.kind === "tree") {
    const value = object(data);
    if (!value || typeof value.sha !== "string" || !Array.isArray(value.tree)
      || typeof value.truncated !== "boolean") return { status: "invalid_response" };
    title = targetValue.path || `${targetValue.owner}/${targetValue.repo} tree`;
    const result = treeText(value, targetValue.ref!);
    text = result.text; truncated = result.truncated;
  } else if (targetValue.kind === "issue" || targetValue.kind === "pull") {
    const value = object(data);
    if (!value) return { status: "invalid_response" };
    title = textField(value.title) ?? "";
    text = issueText(value, targetValue.kind === "pull");
  } else if (targetValue.kind === "commit") {
    const value = object(data);
    if (!value) return { status: "invalid_response" };
    const commit = object(value.commit) ?? {};
    title = textField(commit.message) ?? textField(value.sha) ?? "";
    const result = commitText(value);
    text = result.text; truncated = result.truncated;
  } else if (targetValue.kind === "commits") {
    if (!Array.isArray(data)) return { status: "invalid_response" };
    const result = commitsText(data, payload.hasNext === true);
    title = "提交列表"; text = result.text; truncated = result.truncated;
  } else {
    return { status: "unsupported" };
  }
  if (!title.trim()) return { status: "invalid_response" };
  if (!safe(permitsText, title) || !safe(permitsText, text)) return { status: "privacy_rejected" };
  const boundedText = bounded(text, ROOM_GITHUB_EVIDENCE_CHARS);
  truncated ||= boundedText.length < text.length;
  const htmlUrl = targetValue.htmlUrl;
  if (payload.htmlUrl !== undefined) {
    if (typeof payload.htmlUrl !== "string") return { status: "invalid_response" };
    const returned = parseRoomGitHubTarget(payload.htmlUrl);
    if (!returned || !sameTargetIdentity(returned, targetValue)) {
      return { status: "invalid_response" };
    }
  }
  return {
    status: payload.partial ? "partial" : "ok",
    evidence: Object.freeze({ url: htmlUrl, kind: targetValue.kind as Exclude<RoomGitHubKind, "unsupported">,
      title: bounded(title, ROOM_GITHUB_TITLE_CHARS), text: boundedText, truncated,
      trust: "external-untrusted" as const }),
  };
}

function sameTargetIdentity(returned: RoomGitHubTarget, expected: RoomGitHubTarget): boolean {
  if (returned.owner !== expected.owner || returned.repo !== expected.repo
    || returned.kind !== expected.kind) return false;
  if (expected.kind === "issue" || expected.kind === "pull") {
    return returned.number === expected.number;
  }
  if (expected.kind === "blob" || expected.kind === "tree") {
    return returned.ref === expected.ref && returned.path === expected.path;
  }
  if (expected.kind === "commits") return returned.ref === expected.ref;
  if (expected.kind === "commit") {
    return returned.ref !== undefined && expected.ref !== undefined
      && returned.ref.toLowerCase().startsWith(expected.ref.toLowerCase());
  }
  return true;
}

function failureContext(status: RoomGitHubStatus, targets: readonly RoomGitHubTarget[]): RoomGitHubContext {
  return Object.freeze({ status, evidence: Object.freeze([]),
    results: Object.freeze(targets.map(value => Object.freeze({ url: value.htmlUrl, status }))) });
}

/**
 * Read at most two already parsed targets. Unsupported routes are rejected
 * locally and never delegated to Tavily, Fetch or a model.
 */
export async function readRoomGitHub(targets: readonly RoomGitHubTarget[],
  provider: RoomGitHubReadProvider | undefined,
  permitsText: (text: string) => boolean,
  signal: AbortSignal): Promise<RoomGitHubContext> {
  const selected = uniqueGitHubTargets(targets);
  if (!selected.length) return Object.freeze({ status: "ok", evidence: Object.freeze([]), results: Object.freeze([]) });
  if (signal.aborted) return failureContext("cancelled", selected);
  if (selected.some(value => !safe(permitsText, value.htmlUrl) || !safe(permitsText, value.inputUrl))) {
    return failureContext("privacy_rejected", selected);
  }
  if (selected.every(value => value.kind === "unsupported")) {
    return failureContext("unsupported", selected);
  }
  if (!provider) return failureContext("invalid_response", selected);
  const outcomes = await Promise.all(selected.map(async targetValue => {
    if (targetValue.kind === "unsupported") return { status: "unsupported" as const };
    if (signal.aborted) return { status: "cancelled" as const };
    if (!safe(permitsText, targetValue.htmlUrl) || !safe(permitsText, targetValue.inputUrl)) {
      return { status: "privacy_rejected" as const };
    }
    try {
      const payload = await provider(targetValue, signal);
      if (signal.aborted) return { status: "cancelled" as const };
      if (!payload || typeof payload !== "object") return { status: "invalid_response" as const };
      return normalize(targetValue, payload, permitsText);
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" as const };
      if (error instanceof RoomGitHubReadError) return { status: error.status };
      return { status: "invalid_response" as const };
    }
  }));
  if (signal.aborted) return failureContext("cancelled", selected);
  const evidence = outcomes.flatMap(outcome => outcome.evidence ? [outcome.evidence] : []);
  const results = selected.map((targetValue, index) =>
    Object.freeze({ url: targetValue.htmlUrl, status: outcomes[index]!.status }));
  const statuses = outcomes.map(outcome => outcome.status);
  const status: RoomGitHubStatus = evidence.length === selected.length
    ? (statuses.every(value => value === "ok") ? "ok" : "partial")
    : evidence.length ? "partial"
      : statuses.every(value => value === statuses[0]) ? statuses[0]! : "failed";
  return Object.freeze({ status, evidence: Object.freeze(evidence), results: Object.freeze(results) });
}

function apiUrl(targetValue: RoomGitHubTarget): URL {
  const base = new URL("https://api.github.com");
  const root = `/repos/${encodeURIComponent(targetValue.owner)}/${encodeURIComponent(targetValue.repo)}`;
  if (targetValue.kind === "repository") base.pathname = root;
  else if (targetValue.kind === "issue") base.pathname = `${root}/issues/${targetValue.number}`;
  else if (targetValue.kind === "pull") base.pathname = `${root}/pulls/${targetValue.number}`;
  else if (targetValue.kind === "commit") base.pathname = `${root}/commits/${encodeURIComponent(targetValue.ref!)}`;
  else if (targetValue.kind === "commits") {
    base.pathname = `${root}/commits`;
    base.searchParams.set("per_page", String(ROOM_GITHUB_COMMIT_ENTRIES));
    if (targetValue.ref) base.searchParams.set("sha", targetValue.ref);
  } else if (targetValue.kind === "blob") {
    base.pathname = `${root}/contents${targetValue.path ? `/${targetValue.path.split("/").map(encodeURIComponent).join("/")}` : ""}`;
    if (targetValue.ref) base.searchParams.set("ref", targetValue.ref);
  } else if (targetValue.kind === "tree") {
    const treeRef = targetValue.path ? `${targetValue.ref}:${targetValue.path}` : targetValue.ref!;
    base.pathname = `${root}/git/trees/${encodeURIComponent(treeRef)}`;
  } else throw new RoomGitHubReadError("unsupported");
  return base;
}

function responseStatus(response: Response): RoomGitHubStatus | undefined {
  if (response.ok) return undefined;
  if (response.status === 404) return "not_found";
  if (response.status === 429) return "rate_limited";
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") return "rate_limited";
  if (response.status === 403) return "forbidden";
  if (response.status === 408 || response.status === 504) return "timeout";
  if (response.status >= 300 && response.status < 400) return "invalid_response";
  return "http_error";
}

/**
 * Fixed-origin, anonymous, non-retrying GitHub API client. The optional raw
 * validator runs on the complete response text before JSON parsing and again
 * on the complete parsed value before projection or truncation.
 */
export function createRoomGitHubReadProvider(fetcher: typeof fetch = fetch, timeoutMs = 10000,
  permitsRawText?: (text: string) => boolean): RoomGitHubReadProvider {
  async function request(url: URL, signal: AbortSignal): Promise<{ data: unknown; hasNext: boolean }> {
    if (signal.aborted) throw new RoomGitHubReadError("cancelled");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { method: "GET", redirect: "manual",
        headers: { Accept: "application/vnd.github+json", "User-Agent": "pa-starter-voice-room" },
        signal: AbortSignal.any([signal, timeout.signal]) });
      if (signal.aborted) throw new RoomGitHubReadError("cancelled");
      const status = responseStatus(response);
      if (status) throw new RoomGitHubReadError(status);
      if (response.url) {
        let origin: string;
        try { origin = new URL(response.url).origin; } catch { throw new RoomGitHubReadError("invalid_response"); }
        if (origin !== "https://api.github.com") throw new RoomGitHubReadError("invalid_response");
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType && !contentType.includes("application/json")
        && !contentType.includes("application/vnd.github+json")) {
        throw new RoomGitHubReadError("invalid_response");
      }
      const raw = await boundedResponseText(response);
      if (!raw.trim()) throw new RoomGitHubReadError("invalid_response");
      if (permitsRawText) {
        let valid = false;
        try { valid = permitsRawText(raw) === true; }
        catch { valid = false; }
        if (!valid) throw new RoomGitHubReadError("privacy_rejected");
      }
      let data: unknown;
      try { data = JSON.parse(raw); } catch { throw new RoomGitHubReadError("invalid_response"); }
      if (permitsRawText) {
        let valid = false;
        try { valid = scanStrings(data, permitsRawText); }
        catch { valid = false; }
        if (!valid) throw new RoomGitHubReadError("privacy_rejected");
      }
      return { data, hasNext: /<[^>]+>;\s*rel="next"/i.test(response.headers.get("link") ?? "") };
    } catch (error) {
      if (error instanceof RoomGitHubReadError) throw error;
      if (signal.aborted) throw new RoomGitHubReadError("cancelled");
      if (timeout.signal.aborted) throw new RoomGitHubReadError("timeout");
      throw new RoomGitHubReadError("http_error");
    } finally { clearTimeout(timer); }
  }

  return async (targetValue, signal) => {
    if (targetValue.kind === "unsupported") throw new RoomGitHubReadError("unsupported");
    const first = await request(apiUrl(targetValue), signal);
    const rawData = first.data;
    const objectData = object(rawData);
    const data = projectGitHubData(targetValue.kind, rawData);
    const hasHtmlUrl = objectData !== undefined
      && Object.prototype.hasOwnProperty.call(objectData, "html_url");
    const htmlUrl = hasHtmlUrl ? objectData.html_url : targetValue.htmlUrl;
    if (targetValue.kind === "repository") {
      const repo = objectData;
      const branch = textField(repo?.default_branch);
      let head: unknown;
      if (branch) {
        try {
          head = projectHead((await request(new URL(`/repos/${encodeURIComponent(targetValue.owner)}/${encodeURIComponent(targetValue.repo)}/commits/${encodeURIComponent(branch)}`, "https://api.github.com"), signal)).data);
        } catch (error) {
          if (error instanceof RoomGitHubReadError && error.status === "cancelled") throw error;
          return { data, ...(hasHtmlUrl || htmlUrl ? { htmlUrl } : {}), partial: true };
        }
      }
      return { data, ...(hasHtmlUrl || htmlUrl ? { htmlUrl } : {}), ...(head ? { head } : {}) };
    }
    return { data, ...(hasHtmlUrl || htmlUrl ? { htmlUrl } : {}), hasNext: first.hasNext };
  };
}
