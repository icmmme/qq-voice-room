import { calculateContextBudget, HIGH_CONTEXT_WINDOW_THRESHOLD,
  type PaContextWindowSource } from "./prompting/context-budget.js";

export interface ModelConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  contextWindow: number;
  contextWindowSource?: PaContextWindowSource;
  contextWindowVerified?: boolean;
  maxTokens: number;
  requestTimeoutMs: number;
  requestTimeoutSource?: "env" | "default";
  tavilyApiKey?: string;
  webTimeoutMs?: number;
  webTimeoutSource?: "env" | "default";
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} 必须是正整数。`);
  return number;
}

function booleanSetting(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} 只能填写 true 或 false。`);
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const baseUrl = env.PA_BASE_URL?.trim();
  const modelId = env.PA_MODEL?.trim();
  const apiKey = env.PA_API_KEY?.trim();
  if (!baseUrl || !modelId || !apiKey || baseUrl.includes("example.com") ||
      modelId === "your-model-id" || apiKey === "replace-with-your-api-key") {
    throw new Error("请先复制 .env.example 为 .env，填写 PA_BASE_URL、PA_MODEL 和 PA_API_KEY。密钥只填在本地文件中。");
  }
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("PA_BASE_URL 请使用 HTTPS 地址；本机调试可用 HTTP。凭据请放在 PA_API_KEY 中。");
  }
  if (/\/(chat\/completions|responses)\/?$/.test(url.pathname)) {
    throw new Error("PA_BASE_URL 应填写 API 基址（例如 /v1），不要带 /chat/completions 或 /responses。");
  }
  const contextWindowInput = env.PA_CONTEXT_WINDOW?.trim();
  const contextWindow = positiveInteger(contextWindowInput, 32768, "PA_CONTEXT_WINDOW");
  const contextWindowSource: PaContextWindowSource = contextWindowInput ? "env" : "default";
  const contextWindowVerified = booleanSetting(env.PA_CONTEXT_WINDOW_VERIFIED, false, "PA_CONTEXT_WINDOW_VERIFIED");
  if (contextWindow > HIGH_CONTEXT_WINDOW_THRESHOLD && !contextWindowVerified) {
    throw new Error("PA_CONTEXT_WINDOW 超过 65536 时必须显式设置 PA_CONTEXT_WINDOW_VERIFIED=true。");
  }
  const maxTokens = positiveInteger(env.PA_MAX_TOKENS, 2048, "PA_MAX_TOKENS");
  if (contextWindow < 4096 || calculateContextBudget(contextWindow, maxTokens).inputBudget < 1024) {
    throw new Error("上下文窗口至少设置为 4096，扣除 PA_MAX_TOKENS 和 1024 tokens 安全余量后至少留出 1024 tokens 作为输入预算。");
  }
  const tavilyApiKey = env.TAVILY_API_KEY?.trim();
  if (tavilyApiKey && /replace|your-|example/i.test(tavilyApiKey)) {
    throw new Error("TAVILY_API_KEY 仍是示例占位值；暂不使用联网搜索时请留空。");
  }
  const webTimeoutInput = env.PA_WEB_TIMEOUT_MS?.trim();
  const requestTimeoutInput = env.PA_REQUEST_TIMEOUT_MS?.trim();
  return {
    baseUrl: baseUrl.replace(/\/$/, ""), modelId, apiKey,
    contextWindow, contextWindowSource, contextWindowVerified, maxTokens,
    requestTimeoutMs: positiveInteger(requestTimeoutInput, 60000, "PA_REQUEST_TIMEOUT_MS"),
    requestTimeoutSource: requestTimeoutInput ? "env" : "default",
    tavilyApiKey: tavilyApiKey || undefined,
    ...(webTimeoutInput ? { webTimeoutMs: positiveInteger(webTimeoutInput, 10000, "PA_WEB_TIMEOUT_MS") } : {}),
    webTimeoutSource: webTimeoutInput ? "env" : "default",
  };
}
