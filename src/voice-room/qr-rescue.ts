import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_DOCKER_QR_PATH = "/app/napcat/cache/qrcode.png";
export const MAX_QR_PNG_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ACCOUNT_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DOCKER_CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export type QrRescueSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "docker"; readonly container: string; readonly path: string };

export type QrRescueReason = "offline" | "zombie" | "manual";

/**
 * Parse comma-separated `ROOM_QR_RESCUE_SOURCES` specs:
 * `account-a=docker:napcat-bot-a,account-b=docker:napcat-bot-b`
 * or `account-a=file:/opt/napcat/bot-a/qrcode.png`.
 */
export function parseQrRescueSources(raw?: string): ReadonlyMap<string, QrRescueSource> {
  const map = new Map<string, QrRescueSource>();
  if (typeof raw !== "string" || !raw.trim()) return map;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const accountKey = trimmed.slice(0, eq).trim();
    const spec = trimmed.slice(eq + 1).trim();
    if (!ACCOUNT_KEY_RE.test(accountKey) || !spec) continue;
    if (spec.startsWith("docker:")) {
      const rest = spec.slice("docker:".length).trim();
      const colon = rest.indexOf(":");
      const container = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
      const path = (colon >= 0 ? rest.slice(colon + 1) : DEFAULT_DOCKER_QR_PATH).trim() || DEFAULT_DOCKER_QR_PATH;
      if (!DOCKER_CONTAINER_RE.test(container) || !path.startsWith("/") || path.includes("\0")) continue;
      map.set(accountKey, Object.freeze({ kind: "docker", container, path }));
    } else if (spec.startsWith("file:")) {
      const path = spec.slice("file:".length).trim();
      if (!path || path.includes("\0")) continue;
      map.set(accountKey, Object.freeze({ kind: "file", path }));
    }
  }
  return map;
}

export function isValidPngBuffer(buf: Buffer): boolean {
  return Buffer.isBuffer(buf)
    && buf.byteLength > PNG_MAGIC.byteLength
    && buf.byteLength <= MAX_QR_PNG_BYTES
    && buf.subarray(0, PNG_MAGIC.byteLength).equals(PNG_MAGIC);
}

export async function readQrCodePng(source: QrRescueSource): Promise<Buffer | null> {
  try {
    let raw: Buffer;
    if (source.kind === "file") {
      raw = await readFile(source.path);
    } else {
      const result = await execFileAsync("docker", ["exec", source.container, "cat", source.path], {
        encoding: "buffer",
        timeout: 5000,
        maxBuffer: MAX_QR_PNG_BYTES + 1024,
      });
      raw = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
    }
    return isValidPngBuffer(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function buildPrivateQrRescueMessage(
  characterName: string,
  png: Buffer,
  reason: QrRescueReason,
): readonly Record<string, unknown>[] {
  const headline = reason === "zombie"
    ? `【掉线互救】${characterName} 登录态已失效（假在线），请长按识别下方二维码重新登录：`
    : reason === "offline"
      ? `【掉线互救】${characterName} 已离线，请长按识别下方二维码重新登录：`
      : `【扫码重登】${characterName} 最新登录二维码如下，请长按识别确认：`;
  return Object.freeze([
    { type: "text", data: { text: `${headline}\n若二维码已过期，在群里发 /room qr 可重新获取。` } },
    { type: "image", data: { file: `base64://${png.toString("base64")}` } },
  ]);
}
