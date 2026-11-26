import type { ImageContent } from "@earendil-works/pi-ai";

export const RECENT_IMAGE_MAX_ENTRIES = 8;
export const RECENT_IMAGE_TTL_MS = 10 * 60 * 1000;

export interface RecentImageEntryInput {
  readonly messageRowId?: number;
  readonly platformMessageId: string;
  readonly createdAt: number;
  readonly count?: number;
  readonly images: readonly ImageContent[];
  readonly caption?: string;
}

export interface RecentImageEntry {
  readonly messageRowId?: number;
  readonly platformMessageId: string;
  readonly createdAt: number;
  readonly count: number;
  readonly images: readonly ImageContent[];
  readonly caption?: string;
}

export interface RecentImageCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}

export interface RecentImageFollowUpQuery {
  readonly quotedPlatformMessageId?: string;
  readonly targetText: string;
  readonly now?: number;
}

export type RecentImageRecallReason = "quoted" | "keyword";

export interface RecentImageMatch {
  readonly reason: RecentImageRecallReason;
  readonly entry: RecentImageEntry;
  readonly images: readonly ImageContent[];
}

const IMAGE_FOLLOW_UP_PATTERN = new RegExp(
  [
    "看(?:一下|下|看)?(?:这|那)?(?:张|几张)?图",
    "(?:刚才|刚刚|上面|楼上|前面|之前|上下文)(?:的|那张|这张|那几张|这几张)?(?:图片|截图|照片|图)",
    "(?:刚才|刚刚|上面|楼上|前面)(?:那张|这张|那几张|这几张)",
    "(?:这|那|这几|那几|上一|上)张(?:图片|截图|照片|图)",
    "(?<![地意企试])图[里中上]",
    "图片|截图|原图|画面里",
    "(?:this|that|the|above|previous|recent)\\s+(?:image|pic|picture|screenshot)s?",
    "\\bscreenshots?\\b",
  ].join("|"),
  "iu",
);

/** Formats `[图片]` for 1 image, `[图片×N]` for >1, or `""` for <=0. */
export function formatImagePlaceholder(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  const normalized = Math.floor(count);
  if (normalized <= 0) return "";
  return normalized === 1 ? "[图片]" : `[图片×${normalized}]`;
}

/**
 * Formats message text for Stage 2 history storage/display without mutating
 * `parseRoomQqMessage` raw `text` (`""` on pure-image inbound events).
 */
export function displayTextWithImagePlaceholder(text: string, imageCount: number): string {
  const trimmed = text.trim();
  const placeholder = formatImagePlaceholder(imageCount);
  if (!placeholder) return trimmed;
  if (!trimmed) return placeholder;
  if (trimmed === placeholder || trimmed.startsWith(`${placeholder} `)) return trimmed;
  return `${placeholder} ${trimmed}`;
}

/** Returns true when follow-up text explicitly refers to a recent image. */
export function isImageFollowUpText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return IMAGE_FOLLOW_UP_PATTERN.test(trimmed);
}

/**
 * Memory-only bounded cache for recently seen group images (max 8 messages,
 * 10-minute TTL by default, zero disk/SQLite persistence).
 */
export class RecentImageCache {
  readonly maxEntries: number;
  readonly ttlMs: number;
  private entries: Array<{ readonly entry: RecentImageEntry; readonly seq: number }> = [];
  private nextSeq = 1;

  constructor(options: RecentImageCacheOptions = {}) {
    const rawMax = options.maxEntries ?? RECENT_IMAGE_MAX_ENTRIES;
    this.maxEntries = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : RECENT_IMAGE_MAX_ENTRIES;
    const rawTtl = options.ttlMs ?? RECENT_IMAGE_TTL_MS;
    this.ttlMs = Number.isFinite(rawTtl) ? Math.max(1, Math.floor(rawTtl)) : RECENT_IMAGE_TTL_MS;
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  /** Removes entries whose age at `now` has reached `ttlMs`. */
  prune(now = Date.now()): number {
    if (!Number.isFinite(now)) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter(item => now - item.entry.createdAt < this.ttlMs);
    return before - this.entries.length;
  }

  /** Stores a recent image message in memory, pruning expired and oldest entries. */
  remember(input: RecentImageEntryInput, now = input.createdAt): RecentImageEntry | null {
    const platformMessageId = input.platformMessageId.trim();
    if (!platformMessageId || !Number.isFinite(input.createdAt) || input.images.length === 0) {
      return null;
    }

    const pruneNow = Number.isFinite(now) ? now : input.createdAt;
    this.prune(pruneNow);

    const frozenImages = Object.freeze(input.images.map(image => Object.freeze({ ...image })));
    const count = input.count !== undefined && Number.isFinite(input.count) && input.count > 0
      ? Math.floor(input.count)
      : frozenImages.length;
    const caption = input.caption?.trim();
    const messageRowId = input.messageRowId !== undefined && Number.isSafeInteger(input.messageRowId)
      && input.messageRowId > 0
      ? input.messageRowId
      : undefined;

    const entry: RecentImageEntry = Object.freeze({
      ...(messageRowId === undefined ? {} : { messageRowId }),
      platformMessageId,
      createdAt: input.createdAt,
      count,
      images: frozenImages,
      ...(caption ? { caption } : {}),
    });

    this.entries = this.entries.filter(item => item.entry.platformMessageId !== platformMessageId);
    this.entries.push({ entry, seq: this.nextSeq++ });
    this.entries.sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.seq - b.seq);

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }

    return entry;
  }

  /** Returns a non-expired cached entry for a specific platform message ID. */
  get(platformMessageId: string, now = Date.now()): RecentImageEntry | null {
    const id = platformMessageId.trim();
    if (!id) return null;
    this.prune(now);
    const hit = this.entries.find(item => item.entry.platformMessageId === id);
    return hit ? hit.entry : null;
  }

  /** Returns a snapshot of currently cached non-expired entries, oldest first. */
  list(now = Date.now()): readonly RecentImageEntry[] {
    this.prune(now);
    return Object.freeze(this.entries.map(item => item.entry));
  }

  /**
   * Recalls cached images when either:
   * (a) the message quotes/replies to a cached image message, or
   * (b) the follow-up text explicitly refers to a recent image within TTL.
   */
  resolveForFollowUp(query: RecentImageFollowUpQuery): RecentImageMatch | null {
    const now = query.now !== undefined && Number.isFinite(query.now) ? query.now : Date.now();
    this.prune(now);

    const quotedId = query.quotedPlatformMessageId?.trim();
    if (quotedId) {
      const quotedHit = this.entries.find(item => item.entry.platformMessageId === quotedId);
      if (quotedHit) {
        return Object.freeze({
          reason: "quoted" as const,
          entry: quotedHit.entry,
          images: quotedHit.entry.images,
        });
      }
    }

    if (isImageFollowUpText(query.targetText) && this.entries.length > 0) {
      const latest = this.entries[this.entries.length - 1]!.entry;
      return Object.freeze({
        reason: "keyword" as const,
        entry: latest,
        images: latest.images,
      });
    }

    return null;
  }
}
