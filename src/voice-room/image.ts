import type { ImageContent } from "@earendil-works/pi-ai";
import { parsePublicUrl } from "./web.js";

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_HARD_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 4;
export const IMAGE_DEFAULT_TIMEOUT_MS = 10_000;
export const IMAGE_MAX_REDIRECTS = 3;

export type RoomImageFormat = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type RoomImageFetchErrorReason =
  | "blocked_url"
  | "http_error"
  | "too_large"
  | "unsupported_format"
  | "timeout"
  | "network_error";

export interface RoomImageFetchConfig {
  readonly maxBytes?: number;
  readonly maxImages?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export type RoomImageFetchResult =
  | { readonly ok: true; readonly image: ImageContent; readonly bytes: number }
  | { readonly ok: false; readonly reason: RoomImageFetchErrorReason };

export interface RoomImageFetchBatch {
  readonly images: readonly ImageContent[];
  readonly attempted: number;
  readonly failed: number;
  readonly reasons: readonly RoomImageFetchErrorReason[];
}

export type RoomImageFetcher = (urls: readonly string[], signal?: AbortSignal) => Promise<RoomImageFetchBatch>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/octet-stream",
]);

function isAllowedContentType(header: string | null): boolean {
  if (!header) return true;
  const mime = header.split(";")[0]!.trim().toLowerCase();
  if (!mime) return true;
  return ALLOWED_CONTENT_TYPES.has(mime);
}

/** Strict magic-byte image format detection; never trusts HTTP headers alone. */
export function detectImageMime(bytes: Uint8Array): RoomImageFormat | null {
  if (bytes.byteLength >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.byteLength >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.byteLength >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }
  if (bytes.byteLength >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        exceeded = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (exceeded) {
      try { await reader.cancel(); } catch { /* Ignore cancel errors. */ }
    } else {
      try { reader.releaseLock(); } catch { /* Ignore lock release errors. */ }
    }
  }
  if (exceeded) return null;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function createFetchSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let isTimeout = false;
  const timer = setTimeout(() => {
    isTimeout = true;
    controller.abort(new Error("image-fetch-timeout"));
  }, Math.max(10, Math.floor(timeoutMs)));
  const onAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => isTimeout,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Fetch a single public HTTP(S) image strictly into memory with SSRF redirect checks,
 * byte-ceiling enforcement, magic-byte validation, and zero disk writes.
 */
export async function fetchPublicImage(
  rawUrl: string,
  options: RoomImageFetchConfig = {},
  parentSignal?: AbortSignal,
): Promise<RoomImageFetchResult> {
  const initialUrl = parsePublicUrl(rawUrl);
  if (!initialUrl) return Object.freeze({ ok: false, reason: "blocked_url" });

  const rawMaxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  const maxBytes = Number.isFinite(rawMaxBytes)
    ? Math.min(IMAGE_HARD_MAX_BYTES, Math.max(1, Math.floor(rawMaxBytes)))
    : IMAGE_MAX_BYTES;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(10, Math.floor(options.timeoutMs!))
    : IMAGE_DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  const { signal, timedOut, cleanup } = createFetchSignal(parentSignal, timeoutMs);
  let currentUrl = initialUrl;
  try {
    for (let redirects = 0; redirects <= IMAGE_MAX_REDIRECTS; redirects++) {
      const response = await fetchFn(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "qq-voice-room" },
        signal,
      });

      if (response.url && !parsePublicUrl(response.url)) {
        try { await response.body?.cancel(); } catch { /* Ignore cancel errors. */ }
        return Object.freeze({ ok: false, reason: "blocked_url" });
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        try { await response.body?.cancel(); } catch { /* Ignore cancel errors. */ }
        if (redirects >= IMAGE_MAX_REDIRECTS) {
          return Object.freeze({ ok: false, reason: "http_error" });
        }
        const location = response.headers.get("location");
        if (!location) return Object.freeze({ ok: false, reason: "http_error" });
        let nextUrl: URL | null = null;
        try {
          nextUrl = parsePublicUrl(new URL(location, currentUrl).toString());
        } catch {
          nextUrl = null;
        }
        if (!nextUrl) return Object.freeze({ ok: false, reason: "blocked_url" });
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Ignore cancel errors. */ }
        return Object.freeze({ ok: false, reason: "http_error" });
      }

      const contentLength = response.headers.get("content-length")?.trim();
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
        try { await response.body?.cancel(); } catch { /* Ignore cancel errors. */ }
        return Object.freeze({ ok: false, reason: "too_large" });
      }

      if (!isAllowedContentType(response.headers.get("content-type"))) {
        try { await response.body?.cancel(); } catch { /* Ignore cancel errors. */ }
        return Object.freeze({ ok: false, reason: "unsupported_format" });
      }

      const bytes = await readBoundedBytes(response, maxBytes);
      if (bytes === null) {
        return Object.freeze({ ok: false, reason: "too_large" });
      }

      const mimeType = detectImageMime(bytes);
      if (!mimeType) {
        return Object.freeze({ ok: false, reason: "unsupported_format" });
      }

      const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
      return Object.freeze({
        ok: true,
        image: Object.freeze({ type: "image", mimeType, data }),
        bytes: bytes.byteLength,
      });
    }
    return Object.freeze({ ok: false, reason: "http_error" });
  } catch (error) {
    if (timedOut() || (error instanceof Error && (error.name === "TimeoutError" || error.message === "image-fetch-timeout"))) {
      return Object.freeze({ ok: false, reason: "timeout" });
    }
    return Object.freeze({ ok: false, reason: "network_error" });
  } finally {
    cleanup();
  }
}

/** Fetch up to `maxImages` public images concurrently into memory. */
export async function fetchRoomImages(
  urls: readonly string[],
  options: RoomImageFetchConfig = {},
  parentSignal?: AbortSignal,
): Promise<RoomImageFetchBatch> {
  const rawMax = options.maxImages ?? IMAGE_MAX_COUNT;
  const maxImages = Number.isFinite(rawMax)
    ? Math.max(0, Math.min(IMAGE_MAX_COUNT, Math.floor(rawMax)))
    : IMAGE_MAX_COUNT;
  const targets = urls.slice(0, maxImages);
  const results = await Promise.all(targets.map(url => fetchPublicImage(url, options, parentSignal)));
  const images: ImageContent[] = [];
  const reasons: RoomImageFetchErrorReason[] = [];
  for (const result of results) {
    if (result.ok) images.push(result.image);
    else reasons.push(result.reason);
  }
  return Object.freeze({
    images: Object.freeze(images),
    attempted: targets.length,
    failed: reasons.length,
    reasons: Object.freeze(reasons),
  });
}

export function createRoomImageFetcher(config: RoomImageFetchConfig = {}): RoomImageFetcher {
  return (urls, signal) => fetchRoomImages(urls, config, signal);
}
