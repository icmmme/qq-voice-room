import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { QqPeer, QqApiError } from "../qq-peer.js";
import { checkRoomConfig, checkClosePolicy } from "./config.js";
import { parseRoomQqMessage } from "./qq-message.js";
import type { RoomQqSettings } from "./qq-config.js";
import { checkedWorkerQueue } from "./qq-config.js";
import { VoiceRoom, type RoomLifecycleModelPort } from "./runtime.js";
import type { RoomAmbientPlanner } from "./participation-planner.js";
import { RoomSendError, type RoomControlAction, type RoomDependencies, type RoomInput,
  type RoomParticipationMode, type RoomPrompt } from "./types.js";
import { roomRecord } from "./fish.js";

const AMBIENT_PLANNER_TRANSPORT_MAX_CHARS = 1000;

export interface RoomQqNotice {
  type: "connected" | "disconnected" | "rejected" | "received" | "error" | "participation" | "voice-preparation";
  code: string;
  elapsedMs?: number;
}
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Local reverse Universal WS. One path/token/self-id per account; never starts ordinary QQ bridge. */
export async function startRoomQq(settings: RoomQqSettings,
  deps: Pick<RoomDependencies, "persona" | "permitsText" | "permitsPrompt" | "now" | "onContextCompacted">
    & Partial<Pick<RoomDependencies, "generate" | "translateVoice">>
    & { lifecycleModel?: RoomLifecycleModelPort },
  onNotice: (notice: RoomQqNotice) => void = () => {},
  voice?: { synthesize: RoomDependencies["synthesize"] }) {
  const config = checkRoomConfig(settings.room);
  const workerSelected = settings.execution === "worker", closePolicy = checkClosePolicy(settings.closePolicy);
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
  const generate: RoomDependencies["generate"] = deps.generate
    ?? (async () => { throw new Error("room-lifecycle-legacy-generator-unavailable"); });
  const room = new VoiceRoom(join(settings.dataDir, "room.sqlite"), config, {
    persona: deps.persona, generate, ...(deps.translateVoice ? { translateVoice: deps.translateVoice } : {}),
    permitsText: deps.permitsText, ...(deps.permitsPrompt ? { permitsPrompt: deps.permitsPrompt } : {}),
    ...(deps.now ? { now: deps.now } : {}), ...(deps.onContextCompacted ? { onContextCompacted: deps.onContextCompacted } : {}),
    voiceAvailable: Boolean(voice), onParticipation: decision => notice("participation", decision.reason),
    onVoicePreparation: decision => notice("voice-preparation", decision.code, decision.elapsedMs),
    synthesize: voice?.synthesize ?? (async () => { throw new Error("room-voice-unavailable"); }),
    sendAudio: async (delivery, bytes, signal) => {
      if (!voice || signal.aborted || closing) throw new RoomSendError("rejected");
      const peer = peers.get(delivery.accountKey);
      if (!peer?.open) throw new RoomSendError("rejected");
      let record;
      try { record = roomRecord(bytes); } catch { throw new RoomSendError("rejected"); }
      try { return await peer.request("send_group_msg", { group_id: Number(config.groupId), message: [record] }); }
      catch (error) { throw new RoomSendError(error instanceof QqApiError && error.code === "api-rejected" ? "rejected" : "uncertain"); }
    },
    sendText: async (delivery, signal) => {
      if (signal.aborted || closing) throw new RoomSendError("rejected");
      const peer = peers.get(delivery.accountKey);
      if (!peer?.open) throw new RoomSendError("rejected");
      try {
        return await peer.request("send_group_msg", { group_id: Number(config.groupId),
          message: [{ type: "text", data: { text: delivery.text } }], auto_escape: true });
      } catch (error) {
        throw new RoomSendError(error instanceof QqApiError && error.code === "api-rejected" ? "rejected" : "uncertain");
      }
    },
  }, { execution: workerSelected ? "lifecycle" : "legacy" });
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
          const receipt = workerSelected ? room.receiveLifecycle(input, workerQueue!) : room.receive(input);
          notice("received", receipt);
          if (workerSelected && receipt === "control") {
            const lifecycle = room.store.lifecycleControlState();
            const text = /^\/room\s+mode$/.test(input.text.trim())
              ? `房间模式：${lifecycle.mode === "ambient" ? "ambient" : "mention_only"}`
              : `房间模式已切换为 ${lifecycle.mode === "ambient" ? "ambient" : "mention_only"}。`;
            void acknowledge(account.accountKey, text);
          } else if (!workerSelected && (receipt === "control" || (receipt === "scheduled" && input.text.startsWith("/room start")))) {
            const status = room.status();
            const delivery = { text: "仅文字", both: "文字＋语音", voice: "仅语音", auto: "自动投递" }[status.deliveryMode];
            const text = input.text === "/room status"
              ? `房间：${status.paused ? "暂停" : "观察中"}；${status.busy ? "正在回复" : "空闲"}；${voice ? delivery : "仅文字"}；角色：${status.characters.join("、")}；自动参与：${status.automaticStopped || !config.participation.enabled ? "已停" : "开启"}；本次启动判定 ${status.participation.evaluated}，触发 ${status.participation.scheduled}`
              : input.text === "/room stop" ? "本轮已停止，自动参与已关闭；/room resume 恢复。" : "房间控制已生效。";
            void acknowledge(account.accountKey, text);
          } else if (!voice && receipt === "rejected" && input.senderId === config.ownerId && /^\/room (?:voice|voice-only|both|auto)$/.test(input.text)
            && account.accountKey === config.ingressAccountKey) void acknowledge(account.accountKey, "当前为文字接入阶段，语音尚未启用。");
        } catch {
          try {
            if (workerSelected) room.store.cancelLifecycleAll("ingress_failed", Date.now());
            else { room.stop(); room.store.setPaused(true); }
          } catch { /* Do not continue on unavailable storage. */ }
          notice("error", "room-input-failed");
        }
      });
      peers.set(account.accountKey, peer);
      room.setOnline(account.accountKey, true);
      if (workerSelected && !workerStarted && peers.size === config.characters.length) {
        workerStarted = true;
        void room.startLifecycleProductionWorker({ model: deps.lifecycleModel!, ambientPlanner,
          apiTimeoutMs: settings.apiTimeoutMs,
          closePolicy, dispatch: async request => {
            if (closing || request.signal.aborted) throw new RoomSendError("rejected");
            const peer = peers.get(request.attempt.accountKey);
            if (!peer?.open) throw new RoomSendError("rejected");
            if (request.medium === "audio" && !request.bytes) throw new RoomSendError("rejected");
            const message = request.medium === "audio" ? [roomRecord(request.bytes!)]
              : [{ type: "text", data: { text: request.item.segment.text } }];
            try { return await peer.requestAttempt("send_group_msg", { group_id: Number(config.groupId), message, auto_escape: true },
              { attemptId: request.attempt.attemptId, beforeSend: request.beforeSend, observe: request.observe,
                released: request.released, physicalSettled: request.physicalSettled, notSent: request.notSent,
                capacity: closePolicy.perAccountCapacity }); }
            catch (error) { throw new RoomSendError(error instanceof QqApiError && error.code === "api-rejected" ? "rejected" : "uncertain"); }
          }, beginClose: until => { for (const p of peers.values()) p.beginObservationClose(until); },
          sealObservations: () => Promise.all([...peers.values()].map(p => p.sealObservations())).then(() => {}),
        }).catch(() => notice("error", "room-worker-startup-failed"));
      }
      notice("connected", "account-online");
      ws.once("close", () => {
        if (peers.get(account.accountKey) !== peer) return;
        peers.delete(account.accountKey);
        if (!closing) {
          try { room.setOnline(account.accountKey, false); } catch { notice("error", "disconnect-state-failed"); }
          notice("disconnected", "account-offline");
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
  const poll = setInterval(() => {
    if (workerSelected) return;
    try { room.tick(); } catch { notice("error", "room-tick-failed"); try { room.stop(); room.store.setPaused(true); } catch {} }
  }, 500);
  const heartbeat = setInterval(() => {
    for (const peer of peers.values()) { if (!peer.alive) peer.close(); else { peer.alive = false; try { peer.socket.ping(); } catch { peer.close(); } } }
  }, 15000);
  poll.unref(); heartbeat.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    room, url: `ws://127.0.0.1:${port}`,
    status: () => ({ online: peers.size, ...room.status() }),
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
