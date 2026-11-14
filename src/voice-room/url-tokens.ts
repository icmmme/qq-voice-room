export type RoomUrlLikeTokenKind = "scheme" | "github";

export interface RoomUrlLikeToken {
  readonly raw: string;
  readonly kind: RoomUrlLikeTokenKind;
  readonly start: number;
  readonly end: number;
}

const SCHEME_PREFIX = /^https?:\/{1,2}/iu;
const GITHUB_HOST = /^(?:[A-Za-z0-9-]+\.)*github\.com/iu;
const GITHUB_LEFT_CONTEXT = /[\p{L}\p{N}_.@:/?#-]/u;
const HOST_RIGHT_CONTEXT = /[\p{L}\p{N}_@:-]/u;
const URL_PATH_START = /[/?#]/u;

function trimTokenEnd(text: string, start: number, end: number): number {
  const raw = text.slice(start, end).replace(/[.,;:!?]+$/u, "");
  return start + raw.length;
}

function isUrlTailTerminator(value: string): boolean {
  const point = value.codePointAt(0);
  if (point === undefined || point < 0x20 || point === 0x7f) return true;
  // Keep the grammar intentionally ASCII; raw Unicode prose is a boundary.
  if (point > 0x7e) return true;
  return /\s/u.test(value) || "<>\"'`\\|^,;!{}".includes(value);
}

function schemePrefixAt(text: string, index: number): number {
  return SCHEME_PREFIX.exec(text.slice(index))?.[0].length ?? 0;
}

function continuesHostname(text: string, index: number): boolean {
  const next = text[index];
  if (!next) return false;
  if (next === ".") return /[\p{L}\p{N}_-]/u.test(text[index + 1] ?? "");
  return HOST_RIGHT_CONTEXT.test(next);
}

function consumeUrlTail(text: string, index: number): number {
  let round = 0, square = 0, cursor = index;
  while (cursor < text.length) {
    if (schemePrefixAt(text, cursor)) break;
    const point = text.codePointAt(cursor);
    if (point === undefined) break;
    const value = String.fromCodePoint(point);
    if (value === "(") round++;
    else if (value === ")") {
      if (round === 0) break;
      round--;
    } else if (value === "[") square++;
    else if (value === "]") {
      if (square === 0) break;
      square--;
    } else if (isUrlTailTerminator(value)) break;
    cursor += value.length;
  }
  return cursor;
}

function githubTokenAt(text: string, start: number): RoomUrlLikeToken | undefined {
  if (start > 0) {
    const previous = String.fromCodePoint(text.codePointAt(start - 1)!);
    if (GITHUB_LEFT_CONTEXT.test(previous)) return undefined;
  }
  const host = GITHUB_HOST.exec(text.slice(start));
  if (!host) return undefined;
  let cursor = start + host[0].length;
  const next = text[cursor];
  if (next === ":") {
    const port = /^:\d{1,5}/u.exec(text.slice(cursor));
    if (!port) return undefined;
    cursor += port[0].length;
    if (continuesHostname(text, cursor)) return undefined;
  } else if (continuesHostname(text, cursor)) {
    return undefined;
  }
  const tail = text[cursor];
  if (tail && URL_PATH_START.test(tail)) cursor = consumeUrlTail(text, cursor);
  const end = trimTokenEnd(text, start, cursor);
  return Object.freeze({ raw: text.slice(start, end), kind: "github" as const, start, end });
}

/**
 * Shared, bounded scanner for explicit URL-like tokens. It recognizes HTTP(S)
 * scheme tokens and bare GitHub hosts, while stopping at common prose
 * separators, unmatched closers, raw non-ASCII prose and nested schemes.
 */
export function roomUrlLikeTokens(text: string): readonly RoomUrlLikeToken[] {
  if (typeof text !== "string" || !text) return Object.freeze([]);
  const tokens: RoomUrlLikeToken[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const prefixLength = schemePrefixAt(text, cursor);
    if (prefixLength) {
      const consumed = consumeUrlTail(text, cursor + prefixLength);
      const end = trimTokenEnd(text, cursor, consumed);
      tokens.push(Object.freeze({
        raw: text.slice(cursor, end), kind: "scheme" as const, start: cursor, end,
      }));
      cursor = Math.max(end, cursor + prefixLength);
      continue;
    }
    const github = githubTokenAt(text, cursor);
    if (github) {
      tokens.push(github);
      cursor = Math.max(github.end, cursor + 1);
      continue;
    }
    cursor += String.fromCodePoint(text.codePointAt(cursor)!).length;
  }
  return Object.freeze(tokens);
}
