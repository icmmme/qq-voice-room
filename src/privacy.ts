const MASK = "[已隐藏]";
const MASK_INTERNAL = "[已隐藏内部信息]";
const MIN_PROTECTED_LENGTH = 4;
const PRIVATE_FRAGMENT_LENGTH = 12;
const SYSTEM_FRAGMENT_LENGTH = 32;

const SEP = "[\\s\\-_.:/|,·\\\\]";
const PHONE = new RegExp(`(?<!\\d)1${SEP}*[3-9](?:${SEP}*\\d){9}(?!\\d)`, "g");
const EMAIL = /[A-Za-z0-9._%+-]+(?:\s*@\s*)[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)*\s*\.\s*[A-Za-z]{2,}/g;
const ID_CARD = new RegExp(`(?<!\\d)\\d(?:${SEP}*\\d){16}${SEP}*[\\dXx](?!\\d)`, "g");
const BANK_CARD = new RegExp(`(?<!\\d)[3-6](?:${SEP}*\\d){15,18}(?!\\d)`, "g");
const STREET_ADDRESS = new RegExp(`[\\u4e00-\\u9fff]{1,12}(?:路|街|道|巷|胡同|里弄|弄|小区|花园|公寓|大厦|大楼)${SEP}*[\\d０-９一二三四五六七八九十百千]{1,6}${SEP}*(?:号|弄|栋|幢|单元|室|楼|层)`, "g");
const PUBLIC_URL_SPAN = /https?:\/\/[^\s<>"'()[\]{}，。！？、；：）》】]+/gi;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function replaceBankCards(text: string): string {
  return text.replace(BANK_CARD, match => {
    const digits = match.replace(/\D/g, "");
    return digits.length >= 16 && digits.length <= 19 && passesLuhn(digits) ? MASK : match;
  });
}

function maskPiiOutsideUrls(text: string): string {
  let out = "";
  let lastIndex = 0;
  PUBLIC_URL_SPAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  const maskPlain = (segment: string) =>
    replaceBankCards(segment.replace(PHONE, MASK).replace(EMAIL, MASK).replace(ID_CARD, MASK))
      .replace(STREET_ADDRESS, MASK);
  while ((match = PUBLIC_URL_SPAN.exec(text)) !== null) {
    if (match.index > lastIndex) out += maskPlain(text.slice(lastIndex, match.index));
    out += match[0];
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) out += maskPlain(text.slice(lastIndex));
  return out;
}

/** A privacy rejection with a fixed message: the triggering value is never included. */
export class PrivacyBlockedError extends Error {
  readonly code = "privacy-block";
  constructor() {
    super("请求包含私人或内部信息，已阻止发送到外部服务。");
    this.name = "PrivacyBlockedError";
  }
}

export interface PrivacyGuardOptions {
  /** Keys/tokens that must never leave the runtime. */
  secrets?: Array<string | null | undefined>;
  /** Local paths, base URLs and other instance-internal values. */
  internalValues?: Array<string | null | undefined>;
  /** Channel/actor numeric IDs for the current scope. */
  identityIds?: Array<string | null | undefined>;
  /** Additional values supplied by an integration for this scope. */
  protectedValues?: Array<string | null | undefined>;
  /** The exact system prompt, used only for in-memory leak detection. */
  systemPrompt?: string;
  /** Private text already visible in the current scope. */
  privateTexts?: Array<string | null | undefined>;
  minProtectedLength?: number;
}

function normalized(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n");
}

function compact(text: string): string {
  return text.replace(/[\s\-_.:/|,·\\]+/g, "");
}

function safeDecode(text: string): string {
  let value = text;
  for (let round = 0; round < 3; round++) {
    if (!/%[0-9A-Fa-f]{2}/.test(value)) break;
    try {
      const next = decodeURIComponent(value.replace(/\+/g, " "));
      if (next === value) break;
      value = next;
    } catch { break; }
  }
  return value;
}

function decodeTokens(text: string): string[] {
  const decoded: string[] = [];
  const base64 = text.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? [];
  for (const token of base64.slice(0, 80)) {
    try {
      const bytes = Buffer.from(token, /[-_]/.test(token) ? "base64url" : "base64");
      const value = bytes.toString("utf8");
      if (value && !value.includes("\uFFFD")) decoded.push(value);
    } catch { /* Not base64. */ }
  }
  const hex = text.match(/[0-9A-Fa-f]{8,}/g) ?? [];
  for (const token of hex.slice(0, 80)) {
    if (token.length % 2 !== 0) continue;
    try {
      const value = Buffer.from(token, "hex").toString("utf8");
      if (value && !value.includes("\uFFFD")) decoded.push(value);
    } catch { /* Not hex. */ }
  }
  return decoded;
}

function encodedVariants(value: string): string[] {
  const variants = new Set<string>([value]);
  const scalar = [
    encodeURIComponent(value),
    encodeURI(value),
    new URLSearchParams([["v", value]]).toString().slice(2),
  ];
  for (const item of scalar) {
    variants.add(item);
    variants.add(item.replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase()));
  }
  const base64 = Buffer.from(value, "utf8").toString("base64");
  for (const item of [base64, base64.replace(/=+$/g, ""), Buffer.from(value, "utf8").toString("base64url")]) {
    variants.add(item);
    variants.add(encodeURIComponent(item));
    variants.add(encodeURIComponent(item).replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase()));
  }
  const hex = Buffer.from(value, "utf8").toString("hex");
  variants.add(hex);
  variants.add(hex.toUpperCase());
  return [...variants].filter(item => item.length >= MIN_PROTECTED_LENGTH);
}

/**
 * In-memory privacy checks. Configured values and private text stay in this object and are never
 * rendered into prompts, errors or audit summaries. Detection is deliberately a finite backstop,
 * not a guarantee against arbitrary semantic transformations.
 */
export class PrivacyGuard {
  private readonly protectedValues = new Set<string>();
  private variants: string[] = [];
  private privateFragments = new Set<string>();
  private privateExactValues = new Set<string>();
  private systemPrompt = "";
  private readonly minProtectedLength: number;

  constructor(options: PrivacyGuardOptions = {}) {
    this.minProtectedLength = Math.max(4, options.minProtectedLength ?? MIN_PROTECTED_LENGTH);
    this.addProtectedValues([
      ...(options.secrets ?? []), ...(options.internalValues ?? []),
      ...(options.identityIds ?? []), ...(options.protectedValues ?? []),
    ]);
    if (options.systemPrompt) this.setSystemPrompt(options.systemPrompt);
    if (options.privateTexts) this.addPrivateTexts(options.privateTexts);
  }

  addProtectedValues(values: Array<string | null | undefined>): void {
    let changed = false;
    for (const value of values) {
      const text = typeof value === "string" ? value.trim() : "";
      if (text.length < this.minProtectedLength) continue;
      if (this.protectedValues.has(text)) continue;
      this.protectedValues.add(text);
      changed = true;
    }
    if (changed) this.variants = [...this.protectedValues].flatMap(encodedVariants);
  }

  addPrivateText(text: string | null | undefined): void {
    if (typeof text !== "string") return;
    const value = normalized(text).trim();
    if (!value) return;
    const pieces = value.split(/\n+|[。！？!?；;]/).map(item => item.trim()).filter(Boolean);
    for (const piece of pieces) this.addPrivateFragment(piece);
    for (const token of value.split(/[\s,，、:：/\\|()[\]{}<>《》"“”'‘’]+/)) {
      if (token.length >= 16 || (token.length >= 8 && /[A-Z0-9_\-]/.test(token))) this.privateFragments.add(token);
    }
    if (value.length >= PRIVATE_FRAGMENT_LENGTH) {
      for (let index = 0; index + PRIVATE_FRAGMENT_LENGTH <= value.length; index++) {
        this.addPrivateFragment(value.slice(index, index + PRIVATE_FRAGMENT_LENGTH));
      }
    }
  }

  addPrivateTexts(values: Array<string | null | undefined>): void {
    for (const value of values) this.addPrivateText(value);
  }

  /** Explicit local note/task fields: short values are matched as whole values, not arbitrary n-grams. */
  addPrivateField(text: string | null | undefined): void {
    if (typeof text !== "string") return;
    const value = normalized(text).trim();
    if (!value) return;
    this.addPrivateText(value);
    if (value.length >= 2 && value.length <= 64) this.privateExactValues.add(value);
  }

  addPrivateMemory(item: { content: string; key?: string }): void {
    this.addPrivateText(item.content);
    if (item.key && item.key.length >= 8 && !/^note:[0-9a-f-]{36}$/i.test(item.key)) this.addPrivateText(item.key);
  }

  setSystemPrompt(text: string): void {
    this.systemPrompt = normalized(text);
  }

  /** True when a web/network argument contains a protected value, private context, system text or obvious PII. */
  assertWebRequest(field: string, value: string): void {
    const text = typeof value === "string" ? value : String(value ?? "");
    if (this.containsProtectedValue(text) || this.containsPrivateFragment(text) ||
        this.containsSystemFragment(text) || this.containsPii(text)) {
      // `field` is accepted for call-site clarity but intentionally not echoed in the error.
      void field;
      throw new PrivacyBlockedError();
    }
  }

  /** Mask known keys, paths and identities without hiding ordinary private memory content. */
  sanitizeKnownValues(text: string): string {
    return this.maskProtectedValues(text);
  }

  /** Mask known values, private fragments, and obvious PII before an auxiliary model request. */
  sanitizeForModel(text: string): string {
    const value = this.maskProtectedValues(text);
    return maskPiiOutsideUrls(value);
  }

  /** Output guard. Known values and a large system-prompt reproduction are always protected. */
  redactOutbound(text: string): string {
    if (this.containsSystemFragment(text)) return MASK_INTERNAL;
    return this.maskProtectedValues(text);
  }

  /**
   * Deterministic refusal for obvious requests to dump this instance's internals from a QQ chat.
   * Ordinary questions such as “如何写 system prompt” or “Node.js 怎么用” are intentionally allowed.
   */
  isInstanceProbe(text: string): boolean {
    const value = normalized(text).toLowerCase().replace(/\s+/g, " ").trim();
    if (!value) return false;

    const dumpVerb = "(?:原样|逐字|完整)?(?:输出|打印|显示|展示|复述|泄露|贴出|列出|发给我|给我看|dump|print|show|reveal|expose|cat)";
    const dumpVerbBody = "(?:原样|逐字|完整)?(?:输出|打印|显示|展示|复述|泄露|贴出|列出|发给我|给我看|dump|print|show|reveal|expose|cat)";
    const promptTerm = "(?:system\\s*prompt|系统提示词|系统提示|内部提示词|内部指令|提示词原文)";
    const promptTermBody = "system\\s*prompt|系统提示词|系统提示|内部提示词|内部指令|提示词原文";
    const possessive = "(?:你的|你们的|你自己的|本实例|当前实例|这个实例|当前系统|你们的系统|your|this instance|current instance)";
    const howTo = /(?:如何|怎么|怎样|什么是|是什么|写法|教程|示例|怎么用|如何使用|how to|what is)/i.test(value);
    const possessiveValue = new RegExp(possessive, "i").test(value);

    if (new RegExp(`${possessive}.{0,24}${promptTerm}`, "i").test(value)) return true;
    if (new RegExp(`${possessive}.{0,24}(?:内部配置|配置(?:文件|信息)?|环境变量|\\.env|部署路径|部署目录|服务器路径|安装路径|数据目录|数据库路径|技术栈|源代码|底层实现|api[ _-]?key|密钥|令牌|token|secret)`, "i").test(value)) return true;
    if (!howTo || possessiveValue) {
      if (new RegExp(`${dumpVerb}.{0,30}(?:\\.env(?:\\b|文件)?|env\\s*文件)`, "i").test(value)) return true;
      if (new RegExp(`(?:\\.env).{0,30}${dumpVerb}`, "i").test(value)) return true;
    }
    if (new RegExp(`${dumpVerb}.{0,30}${promptTerm}`, "i").test(value) && !howTo) return true;
    if (new RegExp(`(?:忽略|无视|ignore|forget).{0,24}(?:之前|以上|前面|previous|above|prior).{0,24}(?:指令|规则|instructions?).{0,30}(?:${promptTermBody}|内部配置|密钥|secret)`, "i").test(value)) return true;
    if (new RegExp(`(?:我是|作为|以).{0,8}(?:管理员|开发者|系统管理员|owner|admin).{0,36}${dumpVerbBody}.{0,36}(?:系统|提示词|配置|密钥|记忆|数据|权限|memory|config|secret)`, "i").test(value)) return true;
    if (new RegExp(`(?:我是|作为|以).{0,8}(?:管理员|开发者|系统管理员|owner|admin).{0,36}(?:系统|提示词|配置|密钥|记忆|数据|权限|memory|config|secret).{0,36}${dumpVerbBody}`, "i").test(value)) return true;
    if (/(?:管理员|开发者|admin|developer|owner).{0,24}(?:权限|permission|特权)/i.test(value) &&
        /(?:读取|访问|输出|给我|列出|read|access|show|list)/i.test(value) &&
        /(?:其他|全部|所有|other|all)/i.test(value)) return true;
    return false;
  }

  private addPrivateFragment(fragment: string): void {
    const value = normalized(fragment).trim();
    if (value.length >= PRIVATE_FRAGMENT_LENGTH) this.privateFragments.add(value);
  }

  private containsProtectedValue(text: string): boolean {
    if (!this.protectedValues.size) return false;
    const plain = normalized(text);
    const decoded = safeDecode(plain);
    const candidates = [plain, decoded, compact(plain), compact(decoded), ...decodeTokens(plain), ...decodeTokens(decoded)];
    for (const value of this.protectedValues) {
      const valueCompact = compact(value);
      for (const candidate of candidates) {
        if (this.isIdentity(value)) {
          const pattern = new RegExp(`(?<!\\d)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`);
          if (pattern.test(candidate)) return true;
          const compactValue = compact(value);
          if (compactValue && new RegExp(`(?<!\\d)${compactValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(compact(candidate))) return true;
        } else if (candidate.includes(value) || (valueCompact && compact(candidate).includes(valueCompact))) {
          return true;
        }
      }
    }
    for (const variant of this.variants) {
      if (/^[1-9]\d{3,15}$/.test(variant)) {
        const pattern = new RegExp(`(?<!\\d)${variant}(?!\\d)`);
        if (pattern.test(plain) || pattern.test(decoded) || pattern.test(compact(plain)) || pattern.test(compact(decoded))) return true;
        continue;
      }
      if (plain.includes(variant) || decoded.includes(variant) || compact(plain).includes(compact(variant))) return true;
      for (const token of decodeTokens(plain)) if (token.includes(variant)) return true;
      for (const token of decodeTokens(decoded)) if (token.includes(variant)) return true;
    }
    return false;
  }

  private isIdentity(value: string): boolean {
    return /^[1-9]\d{3,15}$/.test(value);
  }

  private containsPrivateFragment(text: string): boolean {
    if (!this.privateFragments.size && !this.privateExactValues.size) return false;
    const views = this.canonicalViews(text);
    for (const fragment of this.privateFragments) {
      const fragmentCompact = compact(fragment);
      for (const view of views) {
        if (view.includes(fragment)) return true;
        if (fragmentCompact && compact(view).includes(fragmentCompact)) return true;
      }
    }
    for (const value of this.privateExactValues) {
      const valueCompact = compact(value);
      for (const view of views) {
        const compactView = compact(view);
        if (view.includes(value) && (value.length >= 3 || shortValueDelimited(view, value))) return true;
        if (valueCompact && compactView.includes(valueCompact) &&
            (value.length >= 3 || shortValueDelimited(compactView, valueCompact))) return true;
      }
    }
    return false;
  }

  private containsSystemFragment(text: string): boolean {
    if (!this.systemPrompt) return false;
    const promptCompact = compact(this.systemPrompt);
    for (const view of this.canonicalViews(text)) {
      for (let index = 0; index + SYSTEM_FRAGMENT_LENGTH <= view.length; index++) {
        if (this.systemPrompt.includes(view.slice(index, index + SYSTEM_FRAGMENT_LENGTH))) return true;
      }
      const compactView = compact(view);
      for (let index = 0; index + SYSTEM_FRAGMENT_LENGTH <= compactView.length; index++) {
        if (promptCompact.includes(compactView.slice(index, index + SYSTEM_FRAGMENT_LENGTH))) return true;
      }
    }
    return false;
  }

  private containsPii(text: string): boolean {
    for (const view of this.canonicalViews(text)) {
      if (maskPiiOutsideUrls(view) !== view) return true;
    }
    return false;
  }

  private canonicalViews(text: string): string[] {
    const plain = normalized(text);
    const decoded = safeDecode(plain);
    const views = new Set<string>([plain, decoded, compact(plain), compact(decoded)]);
    for (const value of [plain, decoded]) {
      // Keep the semantic dot/@ of an email while removing surrounding separators.
      views.add(value.replace(/[\s\-_:|,·/\\]+/g, ""));
    }
    for (const token of [...decodeTokens(plain), ...decodeTokens(decoded)]) {
      views.add(token);
      views.add(compact(token));
    }
    return [...views];
  }

  private maskProtectedValues(text: string): string {
    let value = text;
    const variants = [...this.variants].sort((a, b) => b.length - a.length);
    for (const variant of variants) {
      if (variant.length < this.minProtectedLength) continue;
      if (/^[1-9]\d{3,15}$/.test(variant)) {
        // Numeric identities must not eat a substring of a longer ordinary number.
        value = value.replace(new RegExp(`(?<!\\d)${escapeRegExp(variant)}(?!\\d)`, "g"), MASK);
      } else {
        value = value.split(variant).join(MASK);
      }
    }
    // Whitespace/hyphen/dot separated spellings of known values are still the same value.
    for (const protectedValue of [...this.protectedValues].sort((a, b) => b.length - a.length)) {
      if (protectedValue.length < this.minProtectedLength || protectedValue.length > 128) continue;
      const body = [...protectedValue].map(escapeRegExp).join("[\\s\\-_.:/|,·\\\\]*");
      const identity = this.isIdentity(protectedValue);
      const pattern = new RegExp(`${identity ? "(?<!\\d)" : ""}${body}${identity ? "(?!\\d)" : ""}`, "gu");
      value = value.replace(pattern, MASK);
    }
    const decoded = safeDecode(value);
    if (decoded !== value) {
      let masked = decoded;
      for (const variant of variants) {
        if (/^[1-9]\d{3,15}$/.test(variant)) {
          masked = masked.replace(new RegExp(`(?<!\\d)${escapeRegExp(variant)}(?!\\d)`, "g"), MASK);
        } else {
          masked = masked.split(variant).join(MASK);
        }
      }
      if (masked !== decoded) value = masked;
    }
    return value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortValueDelimited(text: string, value: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(value, from);
    if (index < 0) return false;
    const before = index === 0 ? undefined : text[index - 1];
    const after = index + value.length >= text.length ? undefined : text[index + value.length];
    const boundary = (character: string | undefined) =>
      character === undefined || !/[\p{L}\p{N}]/u.test(character);
    if (boundary(before) && boundary(after)) return true;
    from = index + 1;
  }
}

function uuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^note:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Sanitize model-visible tool output while preserving IDs needed for later tool calls. */
export function sanitizeModelValue(value: unknown, guard: PrivacyGuard, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "id" || uuidLike(value)) return value;
    return guard.sanitizeKnownValues(value);
  }
  if (Array.isArray(value)) return value.map(item => sanitizeModelValue(item, guard));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) =>
      [name, sanitizeModelValue(item, guard, name)]));
  }
  return value;
}
