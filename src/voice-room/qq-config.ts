import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { checkRoomConfig, checkClosePolicy, type RoomClosePolicy, type CheckedRoomConfig } from "./config.js";
import type { RoomQueuePolicy } from "./store.js";
import { readFilePersona } from "../file-persona.js";
import { readModelConfig, type ModelConfig } from "../config.js";

export interface RoomQqAccount { accountKey: string; token: string; personaFile: string }
export interface RoomQqSettings {
  room: CheckedRoomConfig;
  dataDir: string;
  port: number;
  apiTimeoutMs: number;
  accounts: readonly RoomQqAccount[];
  execution?: "legacy" | "worker";
  workerQueue?: Readonly<RoomQueuePolicy>;
  closePolicy?: Readonly<RoomClosePolicy>;
  replyDeadlineSource?: "env" | "default";
}

export class RoomWorkerDeliveryError extends Error {
  constructor(source: "configured" | "stored" = "configured") {
    super(source === "stored"
      ? "lifecycle Worker 的历史 deliveryMode 无法沿用，请在房间配置中明确设为 text 或 both 后重试。"
      : "lifecycle Worker 的 deliveryMode 仅支持 text 或 both，请修改房间配置后重试。");
  }
}

export function workerDeliveryModes(value: unknown, voiceAvailable: boolean) {
  if (value !== undefined && value !== "text" && value !== "both") throw new RoomWorkerDeliveryError();
  const configuredDeliveryMode = value ?? null;
  const effectiveDeliveryMode = voiceAvailable ? configuredDeliveryMode : "text";
  return { configuredDeliveryMode, effectiveDeliveryMode } as const;
}

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
export function checkedWorkerQueue(value: unknown): Readonly<RoomQueuePolicy> {
  const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (!object(value) || Object.keys(value).sort().join() !== "capacity,memberLimit,memberWindowMs,ttlMs"
    || ![value.capacity, value.memberWindowMs, value.ttlMs].every(positive)
    || !(value.memberLimit === null || positive(value.memberLimit))
    || !Number.isSafeInteger(Date.now() + Number(value.ttlMs))) throw new Error("room-queue-policy-invalid");
  return Object.freeze({ ...value }) as unknown as Readonly<RoomQueuePolicy>;
}

/** Dedicated config, never reads the ordinary PA persona/data/channel settings. No writes or sockets. */
export function readRoomQqSettings(file: string, env: NodeJS.ProcessEnv = process.env): RoomQqSettings {
  try {
    if (statSync(file).size > 64 * 1024) throw new Error();
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)));
    if (!object(input) || !Array.isArray(input.characters) || typeof input.dataDir !== "string" || !input.dataDir.trim()) throw new Error();
    const base = dirname(resolve(file));
    const characters = input.characters.map(c => {
      if (!object(c)) throw new Error();
      return { id: c.id, accountKey: c.accountKey, selfId: c.selfId, name: c.name, voiceKey: c.voiceKey };
    });
    const replyDeadlineInput = env.ROOM_REPLY_DEADLINE_MS?.trim();
    const replyDeadlineMs = replyDeadlineInput === undefined || replyDeadlineInput === ""
      ? undefined : Number(replyDeadlineInput);
    if (replyDeadlineMs !== undefined && (!Number.isSafeInteger(replyDeadlineMs)
      || replyDeadlineMs < 1000 || replyDeadlineMs > 600000)) throw new Error();
    const inputLimits = object(input.limits) ? { ...input.limits } : {};
    if (replyDeadlineMs !== undefined) inputLimits.replyDeadlineMs = replyDeadlineMs;
    const execution = input.execution;
    if (execution !== "worker") throw new Error();
    workerDeliveryModes(input.deliveryMode, false);
    const room = checkRoomConfig({ roomId: input.roomId, groupId: input.groupId, ownerId: input.ownerId,
      ingressAccountKey: input.ingressAccountKey, characters, limits: inputLimits,
      participation: input.participation, characterLanguages: input.characterLanguages,
      deliveryMode: input.deliveryMode, workerResponseBudgets: input.workerResponseBudgets } as Parameters<typeof checkRoomConfig>[0]);
    const workerQueue = checkedWorkerQueue(input.workerQueue);
    const closePolicy = checkClosePolicy(input.closePolicy as Partial<RoomClosePolicy> | undefined);
    const port = input.port ?? 3011, apiTimeoutMs = input.apiTimeoutMs ?? 10000;
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535
      || !Number.isInteger(apiTimeoutMs) || Number(apiTimeoutMs) < 100 || Number(apiTimeoutMs) > 60000) throw new Error();
    const accounts = input.characters.map((c: unknown) => {
      if (!object(c) || typeof c.personaFile !== "string" || !c.personaFile.trim()
        || typeof c.tokenEnv !== "string" || !/^ROOM_QQ_[A-Z0-9_]+_TOKEN$/.test(c.tokenEnv)) throw new Error();
      const token = env[c.tokenEnv];
      if (!token || !/^[\x21-\x7e]{16,256}$/.test(token)) throw new Error();
      return Object.freeze({ accountKey: String(c.accountKey), token, personaFile: resolve(base, c.personaFile) });
    });
    if (new Set(accounts.map(a => a.token)).size !== accounts.length) throw new Error();
    const dataDir = resolve(base, input.dataDir);
    if (!isAbsolute(dataDir) || accounts.some(a => a.personaFile === dataDir)) throw new Error();
    return Object.freeze({ room, dataDir, port: Number(port), apiTimeoutMs: Number(apiTimeoutMs), accounts: Object.freeze(accounts),
      execution, workerQueue, closePolicy,
      replyDeadlineSource: replyDeadlineMs === undefined ? "default" : "env" });
  } catch (error) {
    if (error instanceof RoomWorkerDeliveryError) throw error;
    throw new Error("房间配置无效：检查 JSON、两账号映射、独立数据目录及 ROOM_QQ_*_TOKEN 环境变量。");
  }
}

export function readRoomModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  // Deliberately allowlist model fields and the Voice Room-only public search setting.
  return readModelConfig(Object.fromEntries(["PA_BASE_URL", "PA_MODEL", "PA_API_KEY", "PA_CONTEXT_WINDOW", "PA_MAX_TOKENS",
    "PA_CONTEXT_WINDOW_VERIFIED", "PA_REQUEST_TIMEOUT_MS", "TAVILY_API_KEY", "PA_WEB_TIMEOUT_MS"]
    .map(key => [key, env[key]])));
}

export function checkPublicPersonas(settings: RoomQqSettings): void {
  for (const c of settings.room.characters) {
    const account = settings.accounts.find(a => a.accountKey === c.accountKey)!;
    const snapshot = readFilePersona(account.personaFile, c.id);
    if (snapshot.content.includes("\0")) throw new Error("房间公开人设包含无效字符。");
  }
}
