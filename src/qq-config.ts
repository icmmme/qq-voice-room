import { channelId } from "./channel-route.js";

export const QQ_PATH = "/onebot";

export interface QqConfig {
  port: number;
  token: string;
  selfId: string;
  ownerId: string;
  groupIds: string[];
  apiTimeoutMs: number;
  replyChars: number;
  maxQueued: number;
  maxConcurrent: number;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} 超出允许的整数范围。`);
  return parsed;
}

export function readQqConfig(env: NodeJS.ProcessEnv = process.env): QqConfig {
  const selfId = channelId(env.QQ_SELF_ID?.trim());
  const ownerId = channelId(env.QQ_OWNER_ID?.trim());
  if (!selfId || !ownerId || selfId === ownerId) throw new Error("请配置不同的 QQ_SELF_ID 与 QQ_OWNER_ID，使用规范的安全正整数。");
  const token = env.QQ_TOKEN ?? "";
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token) || /replace|example/i.test(token)) {
    throw new Error("QQ_TOKEN 必须是在本地生成的 32–256 位无空白随机 Token，不能使用示例占位值。");
  }
  const groupIds = (env.QQ_GROUP_IDS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (groupIds.some(id => channelId(id) === null)) throw new Error("QQ_GROUP_IDS 只能填写逗号分隔的规范群号。");
  return {
    port: integer(env.QQ_WS_PORT, 3001, 1, 65535, "QQ_WS_PORT"), token, selfId, ownerId,
    groupIds: [...new Set(groupIds)],
    apiTimeoutMs: integer(env.QQ_API_TIMEOUT_MS, 10000, 100, 60000, "QQ_API_TIMEOUT_MS"),
    replyChars: integer(env.QQ_REPLY_CHARS, 1000, 32, 2000, "QQ_REPLY_CHARS"),
    maxQueued: integer(env.QQ_MAX_QUEUED, 64, 1, 1000, "QQ_MAX_QUEUED"),
    maxConcurrent: integer(env.QQ_MAX_CONCURRENT, 4, 1, 32, "QQ_MAX_CONCURRENT"),
  };
}
