import type { CharacterLanguage, RoomConfig, RoomLimits, ResponseBudgets } from "./types.js";
import { defaultCharacterLanguage } from "./language.js";
import type { RoomContextWindowSource } from "../prompting/context-budget.js";

export const ROOM_LIMITS: Readonly<RoomLimits> = Object.freeze({
  maxTextChars: 100, maxHistory: 80, historyPageRows: 200, contextTokens: 8192, outputTokens: 256,
  turnsPerMinute: 12, modelAttemptsPerHour: 20, ttsAttemptsPerHour: 20,
  requestTimeoutMs: 30000, replyDeadlineMs: 120000, ambientMessages: 3, ambientPeople: 2,
  ambientQuietMs: 2000, ambientCooldownMs: 30000,
});
export const ROOM_HISTORY_PAGE_LIMIT = 500;
export const WORKER_RESPONSE_BUDGETS: ResponseBudgets = Object.freeze({
  daily: Object.freeze({ maxTextChars: 100, outputTokens: 512 }),
  formal: Object.freeze({ maxTextChars: 800, outputTokens: 2048 }),
  detailed: Object.freeze({ maxTextChars: 2000, outputTokens: 4096 }),
});
export interface RoomClosePolicy { observationCapacity: number; perAccountCapacity: number; drainMs: number; releaseMs: number; writeWaitMs: number }
export const ROOM_CLOSE_POLICY: Readonly<RoomClosePolicy> = Object.freeze({ observationCapacity: 32, perAccountCapacity: 16,
  drainMs: 8000, releaseMs: 2000, writeWaitMs: 250 });
export function checkClosePolicy(value: Partial<RoomClosePolicy> = {}): Readonly<RoomClosePolicy> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(k => !Object.hasOwn(ROOM_CLOSE_POLICY, k))) throw new Error("room-close-policy-invalid");
  const policy = { ...ROOM_CLOSE_POLICY, ...value };
  if (Object.values(policy).some(v => !Number.isSafeInteger(v) || v <= 0 || v > 65536)
    || policy.perAccountCapacity > policy.observationCapacity || policy.writeWaitMs > policy.drainMs || policy.writeWaitMs > 250)
    throw new Error("room-close-policy-invalid");
  return Object.freeze(policy);
}
export type CheckedRoomConfig = Omit<RoomConfig, "limits" | "participation" | "characterLanguages"> & {
  limits: Readonly<RoomLimits>;
  contextWindowSource: RoomContextWindowSource;
  workerResponseBudgets: ResponseBudgets;
  characterLanguages: Readonly<Record<string, Readonly<CharacterLanguage>>>;
  participation: Readonly<{ enabled: boolean; aliases: Readonly<Record<string, readonly string[]>> }>;
};
const key = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const numericId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,15}$/.test(v)
  && Number.isSafeInteger(Number(v));

export function checkRoomConfig(config: RoomConfig): CheckedRoomConfig {
  if (!key(config.roomId) || !numericId(config.groupId) || !numericId(config.ownerId)
    || !Array.isArray(config.characters) || config.characters.length !== 2) throw new Error("room-config-invalid");
  const inputLimits = config.limits ?? {};
  const contextWindowSource: RoomContextWindowSource = config.contextWindowSource
    ?? (Object.hasOwn(inputLimits, "contextTokens") ? "explicit-room" : "default-safe");
  const historyPageRows = inputLimits.historyPageRows
    ?? (Object.hasOwn(inputLimits, "maxHistory") ? inputLimits.maxHistory : ROOM_LIMITS.historyPageRows)
    ?? ROOM_LIMITS.historyPageRows;
  const limits = { ...ROOM_LIMITS, ...inputLimits, historyPageRows };
  const profiles = config.workerResponseBudgets ?? {};
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)
    || Object.keys(profiles).some(k => !["daily", "formal", "detailed"].includes(k))) throw new Error("room-response-budget-invalid");
  const workerResponseBudgets = Object.fromEntries(Object.entries(WORKER_RESPONSE_BUDGETS).map(([tier, defaults]) => {
    const value = profiles[tier as keyof ResponseBudgets] ?? defaults;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "maxTextChars,outputTokens"
      || [value.maxTextChars, value.outputTokens].some(n => !Number.isSafeInteger(n) || n <= 0 || n > 1_000_000)) {
      throw new Error("room-response-budget-invalid");
    }
    return [tier, Object.freeze({ ...value })];
  })) as unknown as ResponseBudgets;
  for (const [name, value] of Object.entries(limits)) {
    if (value === null && ["turnsPerMinute", "modelAttemptsPerHour", "ttsAttemptsPerHour"].includes(name)) continue;
    if (!(name in ROOM_LIMITS) || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
      throw new Error("room-limit-invalid");
    }
  }
  if (limits.contextTokens < limits.outputTokens + 1024 || limits.ambientPeople > limits.ambientMessages
    || limits.ambientMessages > ROOM_HISTORY_PAGE_LIMIT || limits.maxHistory > ROOM_HISTORY_PAGE_LIMIT
    || !Number.isSafeInteger(limits.historyPageRows) || limits.historyPageRows <= 0
    || limits.historyPageRows > ROOM_HISTORY_PAGE_LIMIT
    || limits.maxTextChars > 1000) {
    throw new Error("room-limit-invalid");
  }
  for (const c of config.characters) {
    if (!key(c.id) || !key(c.accountKey) || !numericId(c.selfId) || !key(c.voiceKey)
      || typeof c.name !== "string" || !c.name.trim() || [...c.name].length > 80
      || c.selfId === config.ownerId) throw new Error("room-character-invalid");
  }
  for (const field of ["id", "accountKey", "selfId"] as const) {
    if (new Set(config.characters.map(c => c[field])).size !== config.characters.length) {
      throw new Error("room-character-duplicate");
    }
  }
  if (!config.characters.some(c => c.accountKey === config.ingressAccountKey)) throw new Error("room-ingress-invalid");
  if (config.deliveryMode !== undefined && !["text", "both", "voice", "auto"].includes(config.deliveryMode)) throw new Error("room-delivery-invalid");
  const languages = config.characterLanguages === undefined ? {} : config.characterLanguages;
  if (!languages || typeof languages !== "object" || Array.isArray(languages)
    || Object.entries(languages).some(([id, value]) => !config.characters.some(c => c.id === id)
      || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "textLanguage,translateForVoice,voiceLanguage"
      || value.textLanguage !== "zh" || !["zh", "ja"].includes(value.voiceLanguage)
      || value.translateForVoice !== (value.voiceLanguage === "ja"))) throw new Error("room-language-invalid");
  const participation = config.participation;
  if (participation !== undefined && (!participation || typeof participation !== "object" || Array.isArray(participation)
    || Object.keys(participation).some(k => !["enabled", "aliases"].includes(k))
    || (participation.enabled !== undefined && typeof participation.enabled !== "boolean"))) throw new Error("room-participation-invalid");
  const aliases = participation?.aliases === undefined ? {} : participation.aliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)
    || Object.entries(aliases).some(([id, values]) => !config.characters.some(c => c.id === id) || !Array.isArray(values)
      || values.length > 8 || values.some(v => typeof v !== "string" || !v.trim() || v !== v.trim()
        || [...v].length > 40 || /[\x00-\x1f\x7f]/.test(v)))) throw new Error("room-participation-invalid");
  return Object.freeze({ ...config, contextWindowSource, limits: Object.freeze(limits), workerResponseBudgets: Object.freeze(workerResponseBudgets),
    characterLanguages: Object.freeze(Object.fromEntries(config.characters.map(c => [c.id,
      Object.freeze({ ...(Object.hasOwn(languages, c.id) ? languages[c.id]! : defaultCharacterLanguage(c)) })]))),
    participation: Object.freeze({ enabled: participation?.enabled ?? true,
      aliases: Object.freeze(Object.fromEntries(Object.entries(aliases).map(([id, values]) => [id, Object.freeze([...values])]))), }),
    characters: Object.freeze(config.characters.map(c => Object.freeze({ ...c }))) });
}

export function roomInputId(value: unknown): value is string {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d{0,9})$/.test(value)) return false;
  const number = Number(value);
  return number >= -2147483648 && number <= 2147483647 && String(number) === value;
}
