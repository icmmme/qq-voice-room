import { calculateContextBudget, HIGH_CONTEXT_WINDOW_THRESHOLD,
  type PaContextWindowSource } from "./prompting/context-budget.js";

export type ModelThinkingMode = "auto" | "enabled" | "disabled";

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
  thinkingMode?: ModelThinkingMode;
  visionModelId?: string;
  visionBaseUrl?: string;
  visionApiKey?: string;
  modelSupportsVision?: boolean;
  tavilyApiKey?: string;
  bochaApiKey?: string;
  exaApiKey?: string;
  jinaApiKey?: string;
  githubToken?: string;
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

function validateApiBaseUrl(rawUrl: string, name: string, keyName: string): string {
  const url = new URL(rawUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error(`${name} 请使用 HTTPS 地址；本机调试可用 HTTP。凭据请放在 ${keyName} 中。`);
  }
  if (/\/(chat\/completions|responses)\/?$/.test(url.pathname)) {
    throw new Error(`${name} 应填写 API 基址（例如 /v1），不要带 /chat/completions 或 /responses。`);
  }
  return rawUrl.replace(/\/$/, "");
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const baseUrl = env.PA_BASE_URL?.trim();
  const modelId = env.PA_MODEL?.trim();
  const apiKey = env.PA_API_KEY?.trim();
  if (!baseUrl || !modelId || !apiKey || baseUrl.includes("example.com") ||
      modelId === "your-model-id" || apiKey === "replace-with-your-api-key") {
    throw new Error("请先复制 .env.example 为 .env，填写 PA_BASE_URL、PA_MODEL 和 PA_API_KEY。密钥只填在本地文件中。");
  }
  const normalizedBaseUrl = validateApiBaseUrl(baseUrl, "PA_BASE_URL", "PA_API_KEY");
  const contextWindowInput = env.PA_CONTEXT_WINDOW?.trim();
  const contextWindow = positiveInteger(contextWindowInput, 32768, "PA_CONTEXT_WINDOW");
  const contextWindowSource: PaContextWindowSource = contextWindowInput ? "env" : "default";
  const contextWindowVerified = booleanSetting(env.PA_CONTEXT_WINDOW_VERIFIED, false, "PA_CONTEXT_WINDOW_VERIFIED");
  if (contextWindow > HIGH_CONTEXT_WINDOW_THRESHOLD && !contextWindowVerified) {
    throw new Error(`PA_CONTEXT_WINDOW 超过 ${HIGH_CONTEXT_WINDOW_THRESHOLD} 时必须显式设置 PA_CONTEXT_WINDOW_VERIFIED=true。`);
  }
  const maxTokens = positiveInteger(env.PA_MAX_TOKENS, 4096, "PA_MAX_TOKENS");
  if (contextWindow < 4096 || calculateContextBudget(contextWindow, maxTokens).inputBudget < 1024) {
    throw new Error("上下文窗口至少设置为 4096，扣除 PA_MAX_TOKENS 和 1024 tokens 安全余量后至少留出 1024 tokens 作为输入预算。");
  }
  const optionalSecret = (value: string | undefined, name: string): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (/replace|your-|example/i.test(trimmed)) {
      throw new Error(`${name} 仍是示例占位值；暂不使用时请留空。`);
    }
    return trimmed;
  };
  const thinkingRaw = env.PA_THINKING?.trim().toLowerCase();
  let thinkingMode: ModelThinkingMode = "auto";
  if (thinkingRaw) {
    if (thinkingRaw === "auto" || thinkingRaw === "enabled" || thinkingRaw === "disabled") {
      thinkingMode = thinkingRaw;
    } else {
      throw new Error("PA_THINKING 仅支持 auto、enabled 或 disabled。");
    }
  }
  const visionModelId = env.PA_VISION_MODEL?.trim() || undefined;
  const visionBaseUrlRaw = env.PA_VISION_BASE_URL?.trim();
  if (visionBaseUrlRaw && visionBaseUrlRaw.includes("example.com")) {
    throw new Error("PA_VISION_BASE_URL 仍是示例占位值；暂不使用时请留空。");
  }
  const visionBaseUrl = visionBaseUrlRaw
    ? validateApiBaseUrl(visionBaseUrlRaw, "PA_VISION_BASE_URL", "PA_VISION_API_KEY")
    : undefined;
  const visionApiKey = optionalSecret(env.PA_VISION_API_KEY, "PA_VISION_API_KEY");
  const modelSupportsVision = booleanSetting(env.PA_MODEL_SUPPORTS_VISION, true, "PA_MODEL_SUPPORTS_VISION");
  const tavilyApiKey = optionalSecret(env.TAVILY_API_KEY, "TAVILY_API_KEY");
  const bochaApiKey = optionalSecret(env.BOCHA_API_KEY, "BOCHA_API_KEY");
  const exaApiKey = optionalSecret(env.EXA_API_KEY, "EXA_API_KEY");
  const jinaApiKey = optionalSecret(env.JINA_API_KEY, "JINA_API_KEY");
  const githubToken = optionalSecret(env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const webTimeoutInput = env.PA_WEB_TIMEOUT_MS?.trim();
  const requestTimeoutInput = env.PA_REQUEST_TIMEOUT_MS?.trim();
  return {
    baseUrl: normalizedBaseUrl, modelId, apiKey,
    contextWindow, contextWindowSource, contextWindowVerified, maxTokens,
    requestTimeoutMs: positiveInteger(requestTimeoutInput, 60000, "PA_REQUEST_TIMEOUT_MS"),
    requestTimeoutSource: requestTimeoutInput ? "env" : "default",
    thinkingMode,
    ...(visionModelId ? { visionModelId } : {}),
    ...(visionBaseUrl ? { visionBaseUrl } : {}),
    ...(visionApiKey ? { visionApiKey } : {}),
    modelSupportsVision,
    tavilyApiKey,
    bochaApiKey,
    exaApiKey,
    jinaApiKey,
    githubToken,
    ...(webTimeoutInput ? { webTimeoutMs: positiveInteger(webTimeoutInput, 15000, "PA_WEB_TIMEOUT_MS") } : {}),
    webTimeoutSource: webTimeoutInput ? "env" : "default",
  };
}
