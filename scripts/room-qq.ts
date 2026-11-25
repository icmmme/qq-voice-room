import { resolve } from "node:path";
import { checkRoomConfig } from "../src/voice-room/config.js";
import { checkPublicPersonas, readRoomModelConfig, readRoomQqSettings, RoomWorkerDeliveryError,
  workerDeliveryModes } from "../src/voice-room/qq-config.js";
import { hasVisionModel, roomLifecycleGenerator, roomWorkerVoiceTranslator,
  ROOM_LIFECYCLE_DEEP_MAX_TOKENS, ROOM_MODEL_ROUND_TIMEOUT_MS } from "../src/voice-room/model.js";
import { createRoomWebToolkit } from "../src/voice-room/web.js";
import { createRoomImageFetcher } from "../src/voice-room/image.js";
import { startRoomQq } from "../src/voice-room/qq-server.js";
import { roomPublicPolicy } from "../src/voice-room/public-policy.js";
import { readFishConfig, fishSynthesizer, FishTtsError } from "../src/voice-room/fish.js";
import { activateRoomProxy, discoverRoomProxy, RoomProxyError } from "../src/voice-room/proxy.js";
import { calculateContextBudget, selectRoomContextWindow } from "../src/prompting/context-budget.js";

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!["check", "run"].includes(action ?? "") || (args.length !== 0 && (args.length !== 2 || args[0] !== "--config"))) {
    throw new Error("usage");
  }
  const file = args[1] ?? process.env.ROOM_CONFIG;
  if (!file) throw new Error("missing-config");
  const settings = readRoomQqSettings(resolve(file));
  checkPublicPersonas(settings);
  const model = readRoomModelConfig();
  const fish = readFishConfig(process.env, settings.room);
  const deliveryModes = workerDeliveryModes(settings.room.deliveryMode, fish !== null);
  const policy = roomPublicPolicy(settings, model, resolve(file), fish
    ? [fish.apiKey, fish.baseUrl, ...fish.voices.map(v => v.referenceId)] : []);
  for (const c of settings.room.characters) policy.persona(c);
  const contextWindow = selectRoomContextWindow({
    roomCap: settings.room.limits.contextTokens,
    roomCapSource: settings.room.contextWindowSource,
    configuredModelWindow: model.contextWindow,
    modelWindowSource: model.contextWindowSource ?? "default",
    modelWindowVerified: model.contextWindowVerified === true,
  });
  const web = createRoomWebToolkit({
    tavilyApiKey: model.tavilyApiKey,
    bochaApiKey: model.bochaApiKey,
    exaApiKey: model.exaApiKey,
    jinaApiKey: model.jinaApiKey,
    githubToken: model.githubToken,
    timeoutMs: model.webTimeoutMs,
    sanitizeText: policy.sanitizeWebText,
  });
  const room = checkRoomConfig({ ...settings.room, limits: { ...settings.room.limits,
    contextTokens: contextWindow.effectiveWindow,
    outputTokens: Math.min(model.maxTokens, ROOM_LIFECYCLE_DEEP_MAX_TOKENS),
    requestTimeoutMs: Math.min(settings.room.limits.requestTimeoutMs, model.requestTimeoutMs),
  } });
  const budget = calculateContextBudget(room.limits.contextTokens, room.limits.outputTokens);
  const contextDiagnostic = {
    type: "room-context-budget",
    ...deliveryModes,
    ...(deliveryModes.effectiveDeliveryMode === null ? { effectiveDeliveryModeSource: "stored" } : {}),
    contextWindowSource: room.contextWindowSource,
    modelWindowSource: contextWindow.modelWindowSource,
    modelWindowVerified: contextWindow.modelWindowVerified,
    configuredModelWindow: contextWindow.configuredModelWindow,
    effectiveContextWindow: budget.effectiveWindow,
    outputReserve: budget.outputReserve,
    safetyMargin: budget.safetyMargin,
    inputBudget: budget.inputBudget,
    thinkingMode: model.thinkingMode ?? "auto",
    replyDeadlineSource: settings.replyDeadlineSource ?? "default",
    replyDeadlineMs: room.limits.replyDeadlineMs,
    nonReplyTimeoutMs: room.limits.requestTimeoutMs,
    nonReplyTimeoutSource: "default",
    modelRoundTimeoutMs: ROOM_MODEL_ROUND_TIMEOUT_MS,
    modelRoundTimeoutSource: "default",
    tools: web.hasSearch ? "web_search,web_fetch" : "web_fetch",
    visionMode: model.visionModelId ? "dedicated" : model.modelSupportsVision !== false ? "primary" : "disabled",
    providerRetry: "none",
  };
  const proxy = discoverRoomProxy();
  const bypassWarning = proxy.summary.ignoredBypassRuleCount
    ? " 未支持的绕过规则未生效，请核对内网域名/IP。" : "";
  if (action === "check") {
    console.log(`房间配置有效：两账号、两份公开人设、模型格式有效；${fish ? "Fish 配置格式有效（未验证连通性/音色）" : "仅文字"}；lifecycle Worker 两账号就绪后进入 mention_only。`);
    if (deliveryModes.effectiveDeliveryMode === null) console.log("未配置 deliveryMode，启动时沿用存储的投递模式。");
    console.log(JSON.stringify(contextDiagnostic));
    console.log(`代理诊断：来源=${proxy.summary.source}，启用=${proxy.summary.enabled ? "是" : "否"}，绕过规则=${proxy.summary.bypassRuleCount} 条，忽略=${proxy.summary.ignoredBypassRuleCount} 条。${bypassWarning}`);
    console.log("本检查未创建数据库、未连接 QQ、未调用模型或 TTS，也未启用代理。不要与旧 bridge 同时消费测试群。");
    return;
  }
  const restoreProxy = activateRoomProxy(proxy);
  console.log(JSON.stringify(contextDiagnostic));
  console.log(proxy.summary.enabled
    ? `代理已启用：来源=${proxy.summary.source}，绕过规则=${proxy.summary.bypassRuleCount} 条，忽略=${proxy.summary.ignoredBypassRuleCount} 条。${bypassWarning}`
    : "代理未启用：直连。");
  let bridge: Awaited<ReturnType<typeof startRoomQq>>;
  try {
    bridge = await startRoomQq({ ...settings, room }, {
      ...policy,
      web,
      imageFetcher: createRoomImageFetcher({ timeoutMs: model.webTimeoutMs }),
      lifecycleModel: {
        visionCapable: hasVisionModel(model),
        generate: roomLifecycleGenerator({ ...model, contextWindow: room.limits.contextTokens },
          settings.dataDir, (code, diagnostic) => console.log(JSON.stringify({ type: "model-error", code, diagnostic }))),
      },
      translateVoice: roomWorkerVoiceTranslator(model, settings.dataDir),
      onContextCompacted: notice => console.log(JSON.stringify({ type: "room-context-compacted", ...notice })),
    }, notice => console.log(JSON.stringify(notice)), fish ? {
      synthesize: fishSynthesizer(fish, policy.permitsText, fetch, code => console.log(JSON.stringify({ type: "tts-error", code }))),
    } : undefined);
  } catch (error) {
    restoreProxy();
    throw error;
  }
  const entryMode = deliveryModes.effectiveDeliveryMode === "both" ? "文字＋语音"
    : deliveryModes.effectiveDeliveryMode === "text" ? "文字" : "";
  console.log(`房间${entryMode}入口已启动，端口 ${settings.port}；等待两个 NapCat Universal 反向连接。`);
  console.log(`lifecycle Worker 两账号就绪后进入 mention_only；仅支持 text/both，仅配置 ownerId 可切换模式；联网工具：${web.hasSearch ? "web_search+web_fetch" : "web_fetch"}。Ctrl+C 关闭并归账。`);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void bridge.close().then(() => { restoreProxy(); console.log("房间服务已停止。"); },
      () => { restoreProxy(); console.error("房间关闭失败，请核查进程及独立房间锁。"); process.exitCode = 1; });
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
main().catch(error => {
  console.error(error instanceof RoomWorkerDeliveryError ? error.message
    : error instanceof FishTtsError ? "Fish 配置无效：检查密钥、两音色 ID、官方基址、受支持模型和 MP3 设置；原始值已隐藏。"
    : error instanceof RoomProxyError ? `代理配置无效（${error.code}）：未自动回退直连。检查进程代理变量或 Windows 系统代理；PAC、SOCKS 和不支持配置需先显式处理。`
    : "房间启动/检查失败：检查 ROOM_CONFIG、公开人设、模型配置及 ROOM_QQ_*_TOKEN；原始错误已隐藏。");
  process.exitCode = 1;
});
