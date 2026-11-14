import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";

/** Replacement text shared by every outbound QQ path. */
export const QQ_REDACTED = "[已隐藏]";

/** Process-local fallback so compatibility callers never use a publicly recomputable empty HMAC key. */
const FALLBACK_ALIAS_KEY = randomBytes(32);

const SEPARATOR_CHARS = "\\s\\-_.:/|,·";
const NON_SPACE_SEPARATORS = "\\-_.:/,·";
const SEPARATOR_ANY = `[${SEPARATOR_CHARS}]*`;

export interface QqPrivacyConfig {
  apiKey?: string;
  tavilyApiKey?: string;
  token?: string;
  dataDir?: string;
  personaFile?: string;
}

export interface QqPrivacyIdentity {
  selfId?: string;
  ownerId?: string;
  groupId?: string | null;
  senderId?: string;
}

/** Raw and automatically derived forms of known configuration values and IDs. */
export interface QqRedactionRules {
  secrets: string[];
  identifiers: string[];
  /** Original known values used for separator-aware matching; optional for older callers. */
  separated?: string[];
}

export interface QqMemoryView {
  id: string;
  kind: string;
  content: string;
  status: string;
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function percentLower(value: string): string {
  return value.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase());
}

/** Percent-encode every UTF-8 byte, including otherwise unreserved characters. */
function fullPercent(value: string, upper = true): string {
  const bytes = Buffer.from(value, "utf8").toString("hex").match(/../g) ?? [];
  return bytes.map(byte => `%${upper ? byte.toUpperCase() : byte.toLowerCase()}`).join("");
}

function encodedForms(value: string): string[] {
  const forms = new Set<string>([value]);
  const add = (candidate: string) => { if (candidate) forms.add(candidate); };
  try { add(encodeURIComponent(value)); } catch { /* Invalid lone surrogate; keep the raw value. */ }
  try { add(encodeURI(value)); } catch { /* Invalid lone surrogate; keep the raw value. */ }
  try {
    const once = encodeURIComponent(value);
    const twice = encodeURIComponent(once);
    add(percentLower(once));
    add(twice);
    add(percentLower(twice));
    add(encodeURIComponent(fullPercent(value)));
    add(encodeURIComponent(fullPercent(value, false)));
  } catch { /* Invalid lone surrogate; keep the raw value. */ }
  add(fullPercent(value));
  add(fullPercent(value, false));
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const base64url = bytes.toString("base64url");
  add(base64);
  add(base64.replace(/=+$/, ""));
  add(base64url);
  add(base64url.replace(/=+$/, ""));
  add(bytes.toString("hex"));
  add(bytes.toString("hex").toUpperCase());
  return [...forms];
}

function pathForms(value: string): string[] {
  const forms = new Set<string>([value]);
  try { forms.add(resolve(value)); } catch { /* Keep the configured spelling. */ }
  forms.add(value.replace(/\\/g, "/"));
  return [...forms];
}

export function qqRedactionRules(config: QqPrivacyConfig, identity: QqPrivacyIdentity): QqRedactionRules {
  const rawSecrets = unique([
    config.apiKey, config.tavilyApiKey, config.token,
    ...(config.dataDir ? pathForms(config.dataDir) : []),
    ...(config.personaFile ? pathForms(config.personaFile) : []),
  ]);
  const rawIdentifiers = unique([identity.selfId, identity.ownerId, identity.groupId, identity.senderId]);
  return {
    secrets: unique(rawSecrets.flatMap(value => [value, ...encodedForms(value)])),
    identifiers: unique(rawIdentifiers.flatMap(value => [value, ...encodedForms(value)])),
    separated: unique([...rawSecrets, ...rawIdentifiers]),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Static replacement only; no text is logged. Configured values are matched in raw,
 * full percent-encoded, Base64/Base64URL and hex form. Known values also match common
 * separator spellings; numeric account IDs require complete numeric boundaries.
 */
export function redactQqText(text: string, rules: QqRedactionRules): string {
  let result = text;
  const numeric = /^\d+$/;
  const literals = unique([
    ...rules.secrets,
    ...rules.identifiers.filter(value => !numeric.test(value)),
  ]).sort((a, b) => b.length - a.length);
  for (const literal of literals) result = result.split(literal).join(QQ_REDACTED);

  const ids = unique(rules.identifiers).filter(value => numeric.test(value)).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const pattern = new RegExp(`(?<!\\d)${escapeRegExp(id)}(?!\\d)`, "g");
    result = result.replace(pattern, QQ_REDACTED);
  }

  const separated = unique(rules.separated ?? [...rules.secrets, ...rules.identifiers])
    .sort((a, b) => b.length - a.length);
  for (const value of separated) {
    const chars = Array.from(value);
    if (chars.length < 2) continue;
    if (numeric.test(value)) {
      // Raw digits were handled above with ordinary digit boundaries. Separated IDs
      // require actual separators and must not match inside a larger number where the
      // adjacent extent is connected by a non-space separator such as 9-1-0-0-0-1-7.
      const body = chars.map(escapeRegExp).join(`[${SEPARATOR_CHARS}]+`);
      const connectedBefore = `(?<!\\d)(?<!\\d(?:[\\s]*[${NON_SPACE_SEPARATORS}][\\s]*)+)`;
      const connectedAfter = `(?!\\d)(?![\\s]*(?:[${NON_SPACE_SEPARATORS}][\\s]*)+\\d)`;
      const pattern = new RegExp(`${connectedBefore}${body}${connectedAfter}`, "g");
      result = result.replace(pattern, QQ_REDACTED);
      continue;
    }
    const first = chars[0]!;
    const last = chars[chars.length - 1]!;
    const prefix = /[A-Za-z0-9]/.test(first) ? "(?<![A-Za-z0-9])" : "";
    const suffix = /[A-Za-z0-9]/.test(last) ? "(?![A-Za-z0-9])" : "";
    const body = chars.map(escapeRegExp).join(SEPARATOR_ANY);
    result = result.replace(new RegExp(`${prefix}${body}${suffix}`, "g"), QQ_REDACTED);
  }
  return result;
}

/** Stable per group and sender, keyed by QQ_TOKEN, and never a bare low-entropy hash. */
export function qqActorAlias(options: {
  aliasKey?: string;
  kind: "private" | "group";
  conversationId: string;
  senderId: string;
  ownerId?: string;
}): string {
  if (options.ownerId && options.senderId === options.ownerId) return "owner";
  const digest = createHmac("sha256", options.aliasKey ? options.aliasKey : FALLBACK_ALIAS_KEY)
    .update(`qq\u0000${options.kind}\u0000${options.conversationId}\u0000${options.senderId}`)
    .digest("base64url")
    .slice(0, 22);
  return `member_${digest}`;
}

/** Only the four fields allowed in owner-facing memory command replies. */
export function qqMemoryView(memory: QqMemoryView): QqMemoryView {
  return { id: memory.id, kind: memory.kind, content: memory.content, status: memory.status };
}
