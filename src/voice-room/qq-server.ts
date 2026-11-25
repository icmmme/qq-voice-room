import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { QqPeer, QqApiError } from "../qq-peer.js";
import { checkRoomConfig, checkClosePolicy } from "./config.js";
import { parseRoomQqMessage } from "./qq-message.js";
import type { RoomQqSettings } from "./qq-config.js";
import { checkedWorkerQueue, RoomWorkerDeliveryError, workerDeliveryModes } from "./qq-config.js";
import { VoiceRoom, type RoomLifecycleModelPort } from "./runtime.js";
import type { RoomAmbientPlanner } from "./participation-planner.js";
import type { RoomWebToolkit } from "./web.js";
import { RoomSendError, type RoomControlAction, type RoomDependencies, type RoomInput,
  type RoomParticipationMode, type RoomPrompt } from "./types.js";
import { roomRecord } from "./fish.js";

const AMBIENT_PLANNER_TRANSPORT_MAX_CHARS = 1000;

type RoomQqWorkerStatus = Omit<ReturnType<VoiceRoom["lifecycleStatus"]>, "audioFenceReason">
  & Pick<ReturnType<typeof workerDeliveryModes>, "configuredDeliveryMode"> & {
    effectiveDeliveryMode: "text" | "both";
    connectedAccountCount: number;
    audioCapable: boolean;
    audioBlockReason: ReturnType<VoiceRoom["lifecycleStatus"]>["audioFenceReason"]
      | "text_mode" | "tts_unavailable" | "worker_not_ready";
  };

export interface RoomQqNotice {
  type: "connected" | "disconnected" | "rejected" | "received" | "error" | "participation" | "voice-preparation" | "runtime-status";
  code: string;
  elapsedMs?: number;
  anchorRowId?: number;
  status?: RoomQqWorkerStatus;
}
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Local reverse Universal WS. One path/token/self-id per account; never starts ordinary QQ bridge. */
export async function startRoomQq(settings: RoomQqSettings,
  deps: Pick<RoomDependencies, "persona" | "permitsText" | "permitsPrompt" | "now" | "onContextCompacted">
    & Partial<Pick<RoomDependencies, "generate" | "translateVoice">>
    & { lifecycleModel?: RoomLifecycleModelPort; web?: RoomWebToolkit },
  onNotice: (notice: RoomQqNotice) => void = () => {},
  voice?: { synthesize: RoomDependencies["synthesize"] }) {
  const workerSelected = settings.execution === "worker";
  const workerTts = typeof voice?.synthesize === "function";
  const startupModes = workerSelected ? workerDeliveryModes(settings.room.deliveryMode, workerTts) : undefined;
  const config = checkRoomConfig(startupModes
    ? { ...settings.room, deliveryMode: startupModes.effectiveDeliveryMode ?? undefined } : settings.room);
  const closePolicy = checkClosePolicy(settings.closePolicy);
  if ((settings.execution !== undefined && settings.execution !== "legacy" && !workerSelected)
    || (workerSelected && (!settings.workerQueue || typeof deps.lifecycleModel?.generate !== "function"))) {
    throw new Error("room-worker-config-invalid");
  }
  const workerQueue = workerSelected ? checkedWorkerQueue(settings.workerQueue) : undefined;
  // Reuse the lifecycle model endpoint through its existing JSON envelope. This
  // keeps production on the same model/config as lifecycle generation and adds
  // no second provider, dependency, config field or test-only entry point.
  const ambientPlanner: RoomAmbientPlanner | undefined = workerSelected && deps.lifecycleModel
    ? {
        plan: async (_input, prompt, signal) => {
          const character = config.characters[0]!;
          const maxChars = AMBIENT_PLANNER_TRANSPORT_MAX_CHARS;
          const roomPrompt: RoomPrompt = Object.freeze({
            systemPrompt: prompt.systemPrompt,
            messages: Object.freeze([{ role: "user" as const,
              content: `${prompt.messages[0].content}\n\nAmbient planner transport protocol: `
                + `return exactly {"kind":"reply","segments":["<planner decision JSON>"]}. `
                + `The single segment must be the planner decision JSON object, for example `
                + `{"kind":"skip"} or {"kind":"join","characterIds":["configured-id"]}. `
                + `Do not return a lifecycle skip for this request.` }]) as RoomPrompt["messages"],
            tools: Object.freeze([]) as readonly [],
            personaHash: createHash("sha256").update(prompt.systemPrompt).digest("hex"),
            characterId: character.id,
            accountKey: character.accountKey,
            voiceKey: character.voiceKey,
            targetId: 0,
          });
          const answer = await deps.lifecycleModel!.generate(roomPrompt, signal, maxChars);
          if (answer.kind === "skip") return Object.freeze({ kind: "skip" as const });
          if (answer.segments.length !== 1) throw new Error("room-ambient-planner-envelope-invalid");
          let decision: unknown;
          try { decision = JSON.parse(answer.segments[0]!); }
          catch { throw new Error("room-ambient-planner-decision-invalid"); }
          return decision;
        },
      }
    : undefined;
  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535
    || !Number.isInteger(settings.apiTimeoutMs) || settings.apiTimeoutMs < 100 || settings.apiTimeoutMs > 60000
    || settings.accounts.length !== config.characters.length
    || new Set(settings.accounts.map(a => a.accountKey)).size !== settings.accounts.length
    || new Set(settings.accounts.map(a => a.token)).size !== settings.accounts.length
    || settings.accounts.some(a => !config.characters.some(c => c.accountKey === a.accountKey) || !/^[\x21-\x7e]{16,256}$/.test(a.token))) {
    throw new Error("room-transport-config-invalid");
  }
  const notice = (type: RoomQqNotice["type"], code: string, elapsedMs?: number) => {
    try { onNotice({ type, code, ...(elapsedMs === undefined ? {} : { elapsedMs }) }); } catch { /* Observer only. */ }
  };
  const peers = new Map<string, QqPeer>();
  const ackAt = new Map<string, number>();
  let closing = false, closePromise: Promise<void> | undefined;
  let workerStarted = false;
  const room = new VoiceRoom(join(settings.dataDir, "room.sqlite"), config, {
    persona: deps.persona, ...(deps.translateVoice ? { translateVoice: deps.translateVoice } : {}),
    permitsText: deps.permitsText, ...(deps.permitsPrompt ? { permitsPrompt: deps.permitsPrompt } : {}),
    ...(deps.now ? { now: deps.now } : {}), ...(deps.onContextCompacted ? { onContextCompacted: deps.onContextCompacted } : {}),
    voiceAvailable: Boolean(voice), onParticipation: decision => notice("participation", decision.reason),
    onVoicePreparation: decision => notice("voice-preparation", decision.code, decision.elapsedMs),
    onAmbientParticipation: ({ code, anchorRowId }) => onNotice({ type: "participation", code, anchorRowId }),
    synthesize: voice?.synthesize ?? (async () => { throw new Error("room-voice-unavailable"); }),
  }, { execution: "lifecycle" });
  let workerModes: Pick<RoomQqWorkerStatus, "configuredDeliveryMode" | "effectiveDeliveryMode"> | undefined;
  if (startupModes) {
    try {
      const effectiveDeliveryMode = startupModes.effectiveDeliveryMode ?? room.store.deliveryMode();
      if (effectiveDeliveryMode !== "text" && effectiveDeliveryMode !== "both") throw new RoomWorkerDeliveryError("stored");
      workerModes = { configuredDeliveryMode: startupModes.configuredDeliveryMode, effectiveDeliveryMode };
    } catch (error) { await room.close(); throw error; }
  }
  function workerStatus(): RoomQqWorkerStatus | undefined {
    if (!workerModes) return;
    const { audioFenceReason, ...runtime } = room.lifecycleStatus();
    const audioCapable = workerModes.effectiveDeliveryMode === "both";
    const audioBlockReason = audioFenceReason ?? (!audioCapable
      ? workerTts || workerModes.configuredDeliveryMode === "text" ? "text_mode" : "tts_unavailable"
      : !runtime.ingressReady ? "worker_not_ready" : null);
    return { ...runtime, ...workerModes, connectedAccountCount: peers.size, audioCapable, audioBlockReason };
  }
  let lastWorkerStatus: string | undefined;
  function publishWorkerStatus() {
    const status = workerStatus();
    if (!status) return;
    const snapshot = JSON.stringify(status);
    if (snapshot === lastWorkerStatus) return;
    lastWorkerStatus = snapshot;
    try { onNotice({ type: "runtime-status", code: "room-worker-status", status }); } catch { /* Observer only. */ }
  }
  const server = createServer({ maxHeaderSize: 8192 }, (_req, res) => { res.writeHead(404, { Connection: "close" }); res.end(); });
  server.headersTimeout = 5000; server.requestTimeout = 5000;
  const connections = new Set<Socket>();
  server.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  async function acknowledge(accountKey: string, text: string) {
    // Independent best-effort control ACK; never blocks stop and cannot accumulate a control queue.
    const now = Date.now();
    if (now - (ackAt.get(accountKey) ?? -Infinity) < 1000) return;
    ackAt.set(accountKey, now);
    try { await peers.get(accountKey)?.request("send_group_msg", { group_id: Number(config.groupId),
      message: [{ type: "text", data: { text } }], auto_escape: true }); }
    catch { notice("error", "control-ack-failed"); }
  }
  server.on("upgrade", (req, socket, head) => {
    const deny = (status: number) => { notice("rejected", `upgrade-${status}`); socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (closing) { deny(503); return; }
    if (req.headers.origin || req.headers["x-client-role"] !== "Universal") { deny(403); return; }
    const account = settings.accounts.find(a => req.url === `/room/${a.accountKey}`);
    if (!account) { deny(404); return; }
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !equal(auth, `Bearer ${account.token}`)) { deny(401); return; }
    const character = config.characters.find(c => c.accountKey === account.accountKey)!;
    if (req.headers["x-self-id"] !== character.selfId) { deny(403); return; }
    if (peers.has(account.accountKey)) { deny(409); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      const peer = new QqPeer(ws, settings.apiTimeoutMs, value => {
        if (closing || peers.get(account.accountKey) !== peer) return;
        const input = parseRoomQqMessage(value, account.accountKey, config);
        if (!input) return;
        if (!room.ready) { notice("rejected", "room-not-ready"); return; }
        try {
          const receipt = room.receiveLifecycle(input, workerQueue!);
          notice("received", receipt);
          if (receipt === "control") {
            const trimmed = input.text.trim();
            const lifecycle = room.store.lifecycleControlState();
            let text: string;
            if (/^\/room\s+status$/.test(trimmed)) {
              const st = workerStatus();
              text = st
                ? `房间状态：模式 ${lifecycle.mode}｜投递 ${st.effectiveDeliveryMode}｜在线 ${st.connectedAccountCount}/${config.characters.length}｜${st.textCanProgress ? "文字正常" : "文字未就绪"}｜${st.audioBlockReason ? `语音受阻(${st.audioBlockReason})` : "语音正常"}${st.faultReason ? `｜故障(${st.faultReason})` : ""}`
                : `房间模式：${lifecycle.mode}`;
            } else if (/^\/room\s+stop$/.test(trimmed)) {
              text = "已停止当前回复队列。";
            } else if (/^\/room\s+mode$/.test(trimmed)) {
              text = `房间模式：${lifecycle.mode === "ambient" ? "ambient" : "mention_only"}`;
            } else {
              text = `房间模式已切换为 ${lifecycle.mode === "ambient" ? "ambient" : "mention_only"}。`;
            }
            void acknowledge(account.accountKey, text);
          }
        } catch {
          try {
            room.store.cancelLifecycleAll("ingress_failed", Date.now());
          } catch { /* Do not continue on unavailable storage. */ }
          notice("error", "room-input-failed");
        }
      });
      peers.set(account.accountKey, peer);
      room.setOnline(account.accountKey, true);
      if (workerSelected && !workerStarted && peers.size === config.characters.length) {
        workerStarted = true;
        void room.startLifecycleProductionWorker({ model: deps.lifecycleModel!, ambientPlanner,
          ...(deps.web ? { web: deps.web } : {}),
          apiTimeoutMs: settings.apiTimeoutMs,
          closePolicy, dispatch: async request => {
            if (closing || request.signal.aborted) throw new RoomSendError("rejected");
            const peer = peers.get(request.attempt.accountKey);
            if (!peer?.open) throw new RoomSendError("rejected");
            if (request.medium === "audio" && !request.bytes) throw new RoomSendError("rejected");
            const attemptOptions = {
              attemptId: request.attempt.attemptId, beforeSend: request.beforeSend, observe: request.observe,
              released: request.released, physicalSettled: request.physicalSettled, notSent: request.notSent,
              capacity: closePolicy.perAccountCapacity,
            };
            const forwardNodes = request.medium === "text"
              ? (request.forwardNodes?.length
                ? request.forwardNodes
                : request.item.segment.deliveryMode === "text" && [...request.item.segment.text].length > 200
                  ? request.item.segment.text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
                  : undefined)
              : undefined;
            if (forwardNodes && forwardNodes.length > 0) {
              const messages = forwardNodes.map(nodeText => ({
                type: "node",
                data: {
                  uin: request.item.character.selfId,
                  name: request.item.character.name,
                  content: [{ type: "text", data: { text: nodeText } }],
                },
              }));
              try {
                return await peer.requestAttempt("send_group_forward_msg",
                  { group_id: Number(config.groupId), messages }, attemptOptions);
              } catch (error) {
                throw new RoomSendError(error instanceof QqApiError && error.code === "api-rejected" ? "rejected" : "uncertain");
              }
            }
            const message = request.medium === "audio" ? [roomRecord(request.bytes!)]
              : [{ type: "text", data: { text: request.item.segment.text } }];
            try { return await peer.requestAttempt("send_group_msg", { group_id: Number(config.groupId), message, auto_escape: true },
              attemptOptions); }
            catch (error) { throw new RoomSendError(error instanceof QqApiError && error.code === "api-rejected" ? "rejected" : "uncertain"); }
          }, beginClose: until => { for (const p of peers.values()) p.beginObservationClose(until); },
          sealObservations: () => Promise.all([...peers.values()].map(p => p.sealObservations())).then(() => {}),
        }).catch(() => notice("error", "room-worker-startup-failed"));
      }
      notice("connected", "account-online");
      publishWorkerStatus();
      ws.once("close", () => {
        if (peers.get(account.accountKey) !== peer) return;
        peers.delete(account.accountKey);
        if (!closing) {
          try { room.setOnline(account.accountKey, false); } catch { notice("error", "disconnect-state-failed"); }
          notice("disconnected", "account-offline");
          publishWorkerStatus();
        }
      });
    });
  });
  sockets.on("error", () => notice("error", "websocket-server-failed"));
  server.on("error", () => notice("error", "http-server-failed"));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject);
      server.listen(settings.port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  } catch (error) { sockets.close(); await room.close(); throw error; }
  publishWorkerStatus();
  const poll = setInterval(() => {
    publishWorkerStatus();
  }, 500);
  const heartbeat = setInterval(() => {
    for (const peer of peers.values()) { if (!peer.alive) peer.close(); else { peer.alive = false; try { peer.socket.ping(); } catch { peer.close(); } } }
  }, 15000);
  poll.unref(); heartbeat.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    room, url: `ws://127.0.0.1:${port}`,
    status: () => ({ online: peers.size, ...room.status(), ...(workerModes ? { worker: workerStatus() } : {}) }),
    /** Local deterministic control seam; production Legacy receive() still owns command parsing. */
    control: (action: RoomControlAction, input: RoomInput, mode?: RoomParticipationMode) => room.handleControl(action, input, mode),
    close(): Promise<void> {
      return closePromise ??= (async () => {
        closing = true; clearInterval(poll); clearInterval(heartbeat);
        try {
          if (!workerSelected) { for (const peer of peers.values()) peer.close(); peers.clear(); }
          await room.close();
        } finally {
          for (const peer of peers.values()) peer.close(); peers.clear(); sockets.close();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { for (const socket of connections) socket.destroy(); reject(new Error("room-release-timeout")); }, closePolicy.releaseMs);
            server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
            for (const socket of connections) socket.destroy();
          });
        }
      })();
    },
  };
}
