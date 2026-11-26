import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { estimateTokens } from "../prompting/token-estimate.js";

export const ROOM_MEMORY_FILE = "room-memory.json";
export const ROOM_MEMORY_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_MEMORY_ENTRIES = 80;
export const DEFAULT_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_MEMORY_CONTENT_CHARS = 300;
export const DEFAULT_SELECT_MAX_ITEMS = 6;
export const DEFAULT_SELECT_MAX_TOKENS = 400;

export type RoomMemoryScope = "room" | "member";

export interface RoomMemoryEntry {
  readonly id: string;
  readonly scope: RoomMemoryScope;
  readonly senderKey?: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
}

export interface RoomMemoryStoreOptions {
  readonly maxEntries?: number;
  readonly defaultTtlMs?: number | null;
  readonly maxContentChars?: number;
  readonly now?: () => number;
  readonly permitsText?: (text: string) => boolean;
}

export interface RememberMemoryInput {
  readonly scope: RoomMemoryScope;
  readonly senderKey?: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  readonly ttlMs?: number | null;
  readonly now?: number;
}

export type RememberMemoryResult =
  | { readonly ok: true; readonly action: "created" | "updated"; readonly entry: RoomMemoryEntry }
  | { readonly ok: false; readonly reason: "privacy-rejected" | "invalid-input" | "invalid-sender-key" };

export interface ListMemoryOptions {
  readonly scope?: RoomMemoryScope;
  readonly senderKey?: string;
  readonly includeExpired?: boolean;
  readonly now?: number;
}

export interface ForgetMemoryOptions {
  readonly scope?: RoomMemoryScope;
  readonly senderKey?: string;
  readonly now?: number;
}

export interface ForgetMemoryResult {
  readonly removed: readonly RoomMemoryEntry[];
  readonly remaining: number;
}

export interface SelectRelevantMemoriesOptions {
  readonly entries: readonly RoomMemoryEntry[];
  readonly queryText: string;
  readonly senderKey?: string;
  readonly maxItems?: number;
  readonly maxTokens?: number;
  readonly now?: number;
  readonly permitsText?: (text: string) => boolean;
}

export interface FormatMemoryBlockOptions {
  readonly permitsText?: (text: string) => boolean;
}

export type MemoryCommand =
  | { readonly kind: "remember"; readonly scope: "room"; readonly fact: string }
  | { readonly kind: "forget"; readonly query: string }
  | { readonly kind: "list" }
  | { readonly kind: "invalid"; readonly action: "remember" | "forget" | "list"; readonly reason: string }
  | { readonly kind: "rejected"; readonly action: "remember"; readonly reason: "privacy-rejected" };

export interface ParseMemoryCommandOptions {
  readonly permitsText?: (text: string) => boolean;
}

interface PersistedMemoryFile {
  readonly version: number;
  readonly entries: readonly RoomMemoryEntry[];
}

const SENDER_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/;
const RAW_QQ_ID_PATTERN = /^(?:qq[-_]?)?\d{4,16}$/i;
const MEMORY_ID_PATTERN = /^mem-[0-9a-f]{8}$/;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i,
  /-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[:=]\s*\S{4,}/i,
];

const PRIVATE_PATH_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:\\[^\s"'`]+/,
  /[A-Za-z]:\/(?:Users|demo|proj|Windows|Program\s+Files|AppData|etc|home|root)\b/i,
  /(?:^|[\s"'`(])(?:\/Users\/|\/home\/|\/root\/|\/etc\/|\/var\/|\/tmp\/)[^\s"'`)]*/i,
  /(?:^|[\s"'`\/\\])\.env(?:\.[A-Za-z0-9_-]+)?(?=$|[\s"'`])/i,
];

const PII_PATTERNS: readonly RegExp[] = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /(?<!\d)1[3-9][-\s]\d{4}[-\s]\d{4}(?!\d)/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/,
];

function baselinePermitsText(text: string): boolean {
  if (typeof text !== "string" || text.includes("\0")) return false;
  const normalized = text.normalize("NFKC").trim();
  if (!normalized) return false;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(normalized)) return false;
  }
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    if (pattern.test(normalized)) return false;
  }
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(normalized)) return false;
  }
  return true;
}

function checkPermitsText(text: string, customPermits?: (text: string) => boolean): boolean {
  if (!baselinePermitsText(text)) return false;
  if (!customPermits) return true;
  try {
    return customPermits(text) === true;
  } catch {
    return false;
  }
}

export function isValidSenderKey(senderKey: unknown): senderKey is string {
  return (
    typeof senderKey === "string"
    && SENDER_KEY_PATTERN.test(senderKey)
    && !RAW_QQ_ID_PATTERN.test(senderKey)
  );
}

function normalizeContent(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function canonicalContentKey(text: string): string {
  return normalizeContent(text).toLowerCase();
}

function normalizeTags(tags: readonly string[] | undefined): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = normalizeContent(raw);
    if (!tag || tag.length > 40) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result.length > 0 ? result : undefined;
}

function freezeEntry(entry: RoomMemoryEntry): RoomMemoryEntry {
  return Object.freeze({
    id: entry.id,
    scope: entry.scope,
    ...(entry.senderKey !== undefined ? { senderKey: entry.senderKey } : {}),
    content: entry.content,
    ...(entry.tags && entry.tags.length > 0 ? { tags: Object.freeze([...entry.tags]) } : {}),
    pinned: entry.pinned,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
  });
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePersistedEntry(raw: unknown, maxContentChars: number): RoomMemoryEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id.trim() || obj.id.length > 64) return null;
  if (obj.scope !== "room" && obj.scope !== "member") return null;
  if (obj.scope === "member" && !isValidSenderKey(obj.senderKey)) return null;
  if (obj.scope === "room" && obj.senderKey !== undefined) return null;
  if (typeof obj.content !== "string") return null;
  const content = normalizeContent(obj.content);
  if (!content || content.includes("\0") || content.length > maxContentChars) return null;
  if (typeof obj.pinned !== "boolean") return null;
  if (!isSafeNonNegativeInt(obj.createdAt) || !isSafeNonNegativeInt(obj.updatedAt)) return null;
  if (obj.expiresAt !== null && !isSafeNonNegativeInt(obj.expiresAt)) return null;

  let tags: string[] | undefined;
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || !obj.tags.every(item => typeof item === "string")) return null;
    tags = normalizeTags(obj.tags);
  }

  return freezeEntry({
    id: obj.id,
    scope: obj.scope,
    ...(obj.scope === "member" ? { senderKey: obj.senderKey as string } : {}),
    content,
    ...(tags ? { tags } : {}),
    pinned: obj.pinned,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    expiresAt: obj.expiresAt,
  });
}

function isExpired(entry: RoomMemoryEntry, now: number): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= now;
}

function entryPermits(entry: RoomMemoryEntry, customPermits?: (text: string) => boolean): boolean {
  if (!checkPermitsText(entry.content, customPermits)) return false;
  if (entry.senderKey !== undefined && !isValidSenderKey(entry.senderKey)) return false;
  if (entry.tags) {
    for (const tag of entry.tags) {
      if (!checkPermitsText(tag, customPermits)) return false;
    }
  }
  return true;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const serialized = JSON.stringify(data, null, 2) + "\n";
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Best-effort close. */ }
    }
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch { /* Best-effort cleanup. */ }
    }
  }
}

/** Extracts normalized alphanumeric terms and CJK character bigrams for zero-dependency matching. */
function extractQueryTerms(text: string): string[] {
  const normalized = normalizeContent(text).toLowerCase();
  if (!normalized) return [];
  const terms = new Set<string>();

  const asciiTokens = normalized.match(/[a-z0-9_+-]{2,}/g) ?? [];
  for (const token of asciiTokens) {
    terms.add(token);
  }

  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    if (run.length <= 6) {
      terms.add(run);
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      terms.add(run.slice(i, i + 2));
    }
  }

  return [...terms];
}

function keywordOverlapScore(queryText: string, queryTerms: readonly string[], entry: RoomMemoryEntry): number {
  if (queryTerms.length === 0) return 0;
  const haystack = normalizeContent(
    [entry.content, ...(entry.tags ?? [])].join(" "),
  ).toLowerCase();

  let matched = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) {
      matched += 1;
    }
  }

  let tagBonus = 0;
  if (entry.tags && entry.tags.length > 0) {
    const normalizedQuery = normalizeContent(queryText).toLowerCase();
    for (const tag of entry.tags) {
      if (normalizedQuery.includes(tag.toLowerCase())) {
        tagBonus += 0.25;
      }
    }
  }

  return matched / queryTerms.length + Math.min(0.5, tagBonus);
}

/**
 * Ranks and selects scoped memories matching the query within item and token budgets.
 * Fail-closed: expired entries and entries failing privacy checks are never returned.
 */
export function selectRelevantMemories(options: SelectRelevantMemoriesOptions): readonly RoomMemoryEntry[] {
  const maxItems = options.maxItems ?? DEFAULT_SELECT_MAX_ITEMS;
  const maxTokens = options.maxTokens ?? DEFAULT_SELECT_MAX_TOKENS;
  if (!Number.isFinite(maxItems) || maxItems <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return [];
  }

  const now = options.now ?? Date.now();
  const senderKey = options.senderKey !== undefined && isValidSenderKey(options.senderKey)
    ? options.senderKey
    : undefined;
  const queryTerms = extractQueryTerms(options.queryText);
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  const eligible: Array<{ entry: RoomMemoryEntry; score: number }> = [];
  for (const entry of options.entries) {
    if (entry.scope === "member" && (!senderKey || entry.senderKey !== senderKey)) continue;
    if (isExpired(entry, now)) continue;
    if (!entryPermits(entry, options.permitsText)) continue;

    const keywordScore = keywordOverlapScore(options.queryText, queryTerms, entry);
    const ageMs = Math.max(0, now - entry.updatedAt);
    const recencyScore = 1 / (1 + ageMs / weekMs);
    const pinnedBonus = entry.pinned ? 0.2 : 0;
    const scopeBonus = entry.scope === "member" ? 0.1 : 0;
    const score = queryTerms.length > 0
      ? keywordScore * 3.0 + recencyScore * 0.8 + pinnedBonus + scopeBonus
      : recencyScore + pinnedBonus + scopeBonus;

    eligible.push({ entry, score });
  }

  eligible.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.entry.updatedAt !== left.entry.updatedAt) return right.entry.updatedAt - left.entry.updatedAt;
    return left.entry.id.localeCompare(right.entry.id);
  });

  const selected: RoomMemoryEntry[] = [];
  for (const candidate of eligible) {
    if (selected.length >= maxItems) break;
    const next = [...selected, candidate.entry];
    const block = formatMemoryBlock(next, { permitsText: options.permitsText });
    if (block && estimateTokens(block) <= maxTokens) {
      selected.push(candidate.entry);
    }
  }

  return Object.freeze(selected);
}

/**
 * Formats selected memories into a compact Chinese prompt block.
 * Fail-closed: entries failing privacy checks are omitted.
 */
export function formatMemoryBlock(
  entries: readonly RoomMemoryEntry[],
  options: FormatMemoryBlockOptions = {},
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entryPermits(entry, options.permitsText)) continue;
    const prefix = entry.scope === "room" ? "[群]" : "[成员]";
    lines.push(`- ${prefix} ${entry.content}`);
  }
  if (lines.length === 0) return "";
  return `【长期记忆（背景参考）】\n${lines.join("\n")}`;
}

/** Formats a compact Chinese summary of stored memories for owner `/room memory` output. */
export function formatMemorySummary(
  entries: readonly RoomMemoryEntry[],
  options: { readonly maxItems?: number; readonly permitsText?: (text: string) => boolean } = {},
): string {
  const maxItems = options.maxItems ?? 15;
  const visible = entries.filter(entry => entryPermits(entry, options.permitsText));
  if (visible.length === 0) return "当前暂无长期记忆。";
  const shown = visible.slice(0, Math.max(1, maxItems));
  const lines = shown.map(entry => {
    const scopeLabel = entry.scope === "room" ? "群" : `成员:${entry.senderKey}`;
    const pinLabel = entry.pinned ? "·置顶" : "";
    return `- [${entry.id}] (${scopeLabel}${pinLabel}) ${entry.content}`;
  });
  const suffix = visible.length > shown.length ? `\n…其余 ${visible.length - shown.length} 条未展开` : "";
  return `长期记忆共 ${visible.length} 条：\n${lines.join("\n")}${suffix}`;
}

/**
 * Parses owner memory commands:
 * - `/room remember <fact>`
 * - `/room forget <id-or-keyword>`
 * - `/room memory`
 * Returns `null` for non-memory messages or other `/room` commands.
 */
export function parseMemoryCommand(
  text: string,
  options: ParseMemoryCommandOptions = {},
): MemoryCommand | null {
  if (typeof text !== "string" || text.includes("\0")) return null;
  const trimmed = text.trim();
  if (!/^\/room(?:\s|$)/i.test(trimmed)) return null;

  const rememberMatch = /^\/room\s+remember(?:\s+(.*))?$/is.exec(trimmed);
  if (rememberMatch) {
    const rawFact = (rememberMatch[1] ?? "").trim();
    const fact = normalizeContent(rawFact);
    if (!fact) {
      return Object.freeze({ kind: "invalid", action: "remember", reason: "missing-fact" });
    }
    if (!checkPermitsText(fact, options.permitsText)) {
      return Object.freeze({ kind: "rejected", action: "remember", reason: "privacy-rejected" });
    }
    return Object.freeze({ kind: "remember", scope: "room", fact });
  }

  const forgetMatch = /^\/room\s+forget(?:\s+(.*))?$/is.exec(trimmed);
  if (forgetMatch) {
    const query = normalizeContent(forgetMatch[1] ?? "");
    if (!query) {
      return Object.freeze({ kind: "invalid", action: "forget", reason: "missing-query" });
    }
    return Object.freeze({ kind: "forget", query });
  }

  const listMatch = /^\/room\s+memory(?:\s+(.*))?$/is.exec(trimmed);
  if (listMatch) {
    const extra = (listMatch[1] ?? "").trim();
    if (extra) {
      return Object.freeze({ kind: "invalid", action: "list", reason: "unexpected-args" });
    }
    return Object.freeze({ kind: "list" });
  }

  return null;
}

/**
 * Standalone JSON-sidecar backed long-term memory store (`<dataDir>/room-memory.json`).
 * Keeps SQLite schema v9 untouched while guaranteeing atomic persistence and fail-closed privacy gating.
 */
export class RoomMemoryStore {
  readonly filePath: string;
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | null;
  private readonly maxContentChars: number;
  private readonly now: () => number;
  private readonly customPermitsText?: (text: string) => boolean;
  private entries: RoomMemoryEntry[] = [];

  constructor(dataDir: string, options: RoomMemoryStoreOptions = {}) {
    if (typeof dataDir !== "string" || !dataDir.trim()) {
      throw new Error("room-memory-datadir-invalid");
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_MEMORY_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) {
      throw new Error("room-memory-max-entries-invalid");
    }
    const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_MEMORY_CONTENT_CHARS;
    if (!Number.isSafeInteger(maxContentChars) || maxContentChars < 20 || maxContentChars > 2000) {
      throw new Error("room-memory-max-content-invalid");
    }
    const defaultTtlMs = options.defaultTtlMs === undefined ? DEFAULT_MEMORY_TTL_MS : options.defaultTtlMs;
    if (defaultTtlMs !== null && (!Number.isSafeInteger(defaultTtlMs) || defaultTtlMs <= 0)) {
      throw new Error("room-memory-ttl-invalid");
    }

    this.filePath = join(resolve(dataDir), ROOM_MEMORY_FILE);
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.maxContentChars = maxContentChars;
    this.now = options.now ?? Date.now;
    this.customPermitsText = options.permitsText;
    this.reload();
  }

  /** Reloads entries from the JSON sidecar file and discards expired or invalid records. */
  reload(): void {
    if (!existsSync(this.filePath)) {
      this.entries = [];
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("room-memory-corrupt");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("room-memory-corrupt");
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== ROOM_MEMORY_SCHEMA_VERSION || !Array.isArray(record.entries)) {
      throw new Error("room-memory-corrupt");
    }
    const now = this.now();
    const loaded: RoomMemoryEntry[] = [];
    const seenIds = new Set<string>();
    for (const raw of record.entries) {
      const entry = parsePersistedEntry(raw, this.maxContentChars);
      if (!entry || seenIds.has(entry.id) || isExpired(entry, now)) continue;
      seenIds.add(entry.id);
      loaded.push(entry);
    }
    this.entries = loaded;
  }

  private persist(): void {
    const payload: PersistedMemoryFile = {
      version: ROOM_MEMORY_SCHEMA_VERSION,
      entries: this.entries,
    };
    atomicWriteJson(this.filePath, payload);
  }

  private nextId(): string {
    while (true) {
      const candidate = `mem-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      if (!this.entries.some(entry => entry.id === candidate)) return candidate;
    }
  }

  private dropExpired(now: number): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => !isExpired(entry, now));
    return this.entries.length !== before;
  }

  private evictToCap(): void {
    while (this.entries.length > this.maxEntries) {
      let victimIndex = -1;
      for (let i = 0; i < this.entries.length; i += 1) {
        const candidate = this.entries[i]!;
        if (candidate.pinned) continue;
        if (victimIndex === -1) {
          victimIndex = i;
          continue;
        }
        const currentVictim = this.entries[victimIndex]!;
        if (
          candidate.updatedAt < currentVictim.updatedAt
          || (candidate.updatedAt === currentVictim.updatedAt && candidate.createdAt < currentVictim.createdAt)
        ) {
          victimIndex = i;
        }
      }
      if (victimIndex === -1) {
        // All entries are pinned; evict the oldest updated entry to enforce hard cap.
        for (let i = 0; i < this.entries.length; i += 1) {
          const candidate = this.entries[i]!;
          if (victimIndex === -1) {
            victimIndex = i;
            continue;
          }
          const currentVictim = this.entries[victimIndex]!;
          if (
            candidate.updatedAt < currentVictim.updatedAt
            || (candidate.updatedAt === currentVictim.updatedAt && candidate.createdAt < currentVictim.createdAt)
          ) {
            victimIndex = i;
          }
        }
      }
      if (victimIndex >= 0) {
        this.entries.splice(victimIndex, 1);
      } else {
        break;
      }
    }
  }

  /** Saves or deduplicates/upserts a scoped memory entry with fail-closed privacy gating. */
  remember(input: RememberMemoryInput): RememberMemoryResult {
    if (input.scope !== "room" && input.scope !== "member") {
      return Object.freeze({ ok: false, reason: "invalid-input" });
    }
    if (input.scope === "member") {
      if (!isValidSenderKey(input.senderKey)) {
        return Object.freeze({ ok: false, reason: "invalid-sender-key" });
      }
    } else if (input.senderKey !== undefined) {
      return Object.freeze({ ok: false, reason: "invalid-input" });
    }

    if (typeof input.content !== "string" || input.content.includes("\0")) {
      return Object.freeze({ ok: false, reason: "invalid-input" });
    }
    const content = normalizeContent(input.content);
    if (!content || content.length > this.maxContentChars) {
      return Object.freeze({ ok: false, reason: "invalid-input" });
    }
    if (!checkPermitsText(content, this.customPermitsText)) {
      return Object.freeze({ ok: false, reason: "privacy-rejected" });
    }

    const tags = normalizeTags(input.tags);
    if (tags) {
      for (const tag of tags) {
        if (!checkPermitsText(tag, this.customPermitsText)) {
          return Object.freeze({ ok: false, reason: "privacy-rejected" });
        }
      }
    }

    if (input.ttlMs !== undefined && input.ttlMs !== null && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      return Object.freeze({ ok: false, reason: "invalid-input" });
    }

    const now = input.now ?? this.now();
    this.dropExpired(now);

    const canonical = canonicalContentKey(content);
    const existingIndex = this.entries.findIndex(entry =>
      entry.scope === input.scope
      && entry.senderKey === input.senderKey
      && canonicalContentKey(entry.content) === canonical);

    const resolveExpiry = (pinned: boolean): number | null => {
      if (input.ttlMs === null) return null;
      if (typeof input.ttlMs === "number") return Math.floor(now + input.ttlMs);
      if (pinned) return null;
      return this.defaultTtlMs !== null ? now + this.defaultTtlMs : null;
    };

    if (existingIndex >= 0) {
      const existing = this.entries[existingIndex]!;
      const pinned = input.pinned ?? existing.pinned;
      const mergedTags = tags ?? existing.tags;
      const updated = freezeEntry({
        id: existing.id,
        scope: existing.scope,
        ...(existing.senderKey !== undefined ? { senderKey: existing.senderKey } : {}),
        content,
        ...(mergedTags ? { tags: mergedTags } : {}),
        pinned,
        createdAt: existing.createdAt,
        updatedAt: now,
        expiresAt: resolveExpiry(pinned),
      });
      this.entries[existingIndex] = updated;
      this.persist();
      return Object.freeze({ ok: true, action: "updated", entry: updated });
    }

    const pinned = input.pinned === true;
    const created = freezeEntry({
      id: this.nextId(),
      scope: input.scope,
      ...(input.scope === "member" ? { senderKey: input.senderKey } : {}),
      content,
      ...(tags ? { tags } : {}),
      pinned,
      createdAt: now,
      updatedAt: now,
      expiresAt: resolveExpiry(pinned),
    });

    this.entries.push(created);
    this.evictToCap();
    this.persist();
    return Object.freeze({ ok: true, action: "created", entry: created });
  }

  get(id: string, now = this.now()): RoomMemoryEntry | undefined {
    if (this.dropExpired(now)) this.persist();
    return this.entries.find(entry => entry.id === id);
  }

  list(options: ListMemoryOptions = {}): readonly RoomMemoryEntry[] {
    const now = options.now ?? this.now();
    if (!options.includeExpired && this.dropExpired(now)) {
      this.persist();
    }
    const filtered = this.entries.filter(entry => {
      if (!options.includeExpired && isExpired(entry, now)) return false;
      if (options.scope !== undefined && entry.scope !== options.scope) return false;
      if (options.senderKey !== undefined && entry.senderKey !== options.senderKey) return false;
      return true;
    });
    filtered.sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
      return left.id.localeCompare(right.id);
    });
    return Object.freeze(filtered);
  }

  pin(id: string, pinned = true, now = this.now()): RoomMemoryEntry | null {
    const expiredRemoved = this.dropExpired(now);
    const index = this.entries.findIndex(entry => entry.id === id);
    if (index < 0) {
      if (expiredRemoved) this.persist();
      return null;
    }
    const existing = this.entries[index]!;
    const updated = freezeEntry({
      ...existing,
      pinned,
      updatedAt: now,
      expiresAt: pinned ? null : (this.defaultTtlMs !== null ? now + this.defaultTtlMs : null),
    });
    this.entries[index] = updated;
    this.persist();
    return updated;
  }

  forget(idOrKeyword: string, options: ForgetMemoryOptions = {}): ForgetMemoryResult {
    const now = options.now ?? this.now();
    const expiredRemoved = this.dropExpired(now);
    const query = normalizeContent(idOrKeyword);
    if (!query) {
      if (expiredRemoved) this.persist();
      return Object.freeze({ removed: Object.freeze([]), remaining: this.entries.length });
    }

    const byId = MEMORY_ID_PATTERN.test(query);
    const lower = query.toLowerCase();
    const removed: RoomMemoryEntry[] = [];
    const kept: RoomMemoryEntry[] = [];

    for (const entry of this.entries) {
      const scopeMatches = options.scope === undefined || entry.scope === options.scope;
      const senderMatches = options.senderKey === undefined || entry.senderKey === options.senderKey;
      const queryMatches = byId
        ? entry.id === query
        : (entry.content.toLowerCase().includes(lower)
          || (entry.tags?.some(tag => tag.toLowerCase().includes(lower)) ?? false));

      if (scopeMatches && senderMatches && queryMatches) {
        removed.push(entry);
      } else {
        kept.push(entry);
      }
    }

    if (removed.length > 0 || expiredRemoved) {
      this.entries = kept;
      this.persist();
    }

    return Object.freeze({
      removed: Object.freeze(removed),
      remaining: this.entries.length,
    });
  }

  pruneExpired(now = this.now()): number {
    const before = this.entries.length;
    if (this.dropExpired(now)) {
      this.persist();
    }
    return before - this.entries.length;
  }

  selectRelevantMemories(
    options: Omit<SelectRelevantMemoriesOptions, "entries">,
  ): readonly RoomMemoryEntry[] {
    return selectRelevantMemories({
      ...options,
      entries: this.entries,
      now: options.now ?? this.now(),
      permitsText: options.permitsText ?? this.customPermitsText,
    });
  }

  formatMemoryBlock(entries: readonly RoomMemoryEntry[]): string {
    return formatMemoryBlock(entries, { permitsText: this.customPermitsText });
  }

  summarize(options: ListMemoryOptions & { readonly maxItems?: number } = {}): string {
    return formatMemorySummary(this.list(options), {
      maxItems: options.maxItems,
      permitsText: this.customPermitsText,
    });
  }
}
