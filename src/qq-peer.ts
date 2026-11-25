import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { qqMessageId } from "./qq-message.js";

export class QqApiError extends Error {
  constructor(readonly code: "disconnected" | "api-timeout" | "api-rejected" | "api-unconfirmed") {
    super(code);
  }
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  resolve: (id: string) => void;
  reject: (error: QqApiError) => void;
}
export type QqAttemptObservation = { kind: "ack"; messageId: string } | { kind: "rejected" | "uncertain" };
export interface QqAttemptOptions {
  attemptId: string;
  /** Called after the echo/attempt association exists, immediately before the one socket send. */
  beforeSend(): void;
  observe(value: QqAttemptObservation): void | Promise<void>;
  /** Observer/capacity release; this does not prove the underlying socket send completed. */
  released?(): void;
  /** Called once when the underlying socket send callback completes, independent of observation lifetime. */
  physicalSettled?(): void;
  /** Called when a synchronous socket send throw proves this write was never initiated. */
  notSent?(): void;
  capacity?: number;
}
interface Tracked {
  options: QqAttemptOptions; chain: Promise<void>; expire: ReturnType<typeof setTimeout>; physicalSettled: boolean;
}

export class QqPeer {
  private readonly pending = new Map<string, Pending>();
  private ended = false;
  private readonly tracked = new Map<string, Tracked>();
  private readonly pendingObservations = new Set<Promise<void>>();
  private acceptingAttempts = true;
  private observationOpen = true;
  private observationCloseTimer?: ReturnType<typeof setTimeout>;
  alive = true;
  constructor(readonly socket: WebSocket, private readonly timeoutMs: number, onEvent: (value: unknown) => void) {
    socket.on("message", (raw: RawData, binary: boolean) => {
      if (binary || this.ended) return;
      let value: unknown;
      try {
        const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
        value = JSON.parse(bytes.toString("utf8"));
      } catch { return; }
      if (value && typeof value === "object" && "echo" in value && typeof value.echo === "string") {
        const tracked = this.tracked.get(value.echo);
        if (tracked && this.observationOpen) {
          const result = value as Record<string, unknown>;
          const data = result.data as Record<string, unknown> | number | string | null;
          const id = data && typeof data === "object"
            ? qqMessageId((data as Record<string, unknown>).message_id)
            : qqMessageId(data);
          const observation: QqAttemptObservation = result.status === "ok" && result.retcode === 0 && id !== null
            ? { kind: "ack", messageId: id }
            : { kind: result.status === "failed" && typeof result.retcode === "number" && result.retcode !== 0 && result.retcode !== 1 ? "rejected" : "uncertain" };
          const pending = this.take(value.echo);
          const recorded = this.observe(tracked, observation);
          void recorded.then(() => {
            if (!pending) return;
            if (observation.kind === "ack") pending.resolve(observation.messageId);
            else pending.reject(new QqApiError(observation.kind === "rejected" ? "api-rejected" : "api-unconfirmed"));
          }, () => pending?.reject(new QqApiError("api-unconfirmed")));
          return;
        }
        const pending = this.take(value.echo);
        if (!pending) return;
        const result = value as Record<string, unknown>;
        const data = result.data as Record<string, unknown> | number | string | null;
        const messageId = data && typeof data === "object"
          ? qqMessageId((data as Record<string, unknown>).message_id)
          : qqMessageId(data);
        if (result.status === "ok" && result.retcode === 0 && messageId !== null) pending.resolve(messageId);
        else pending.reject(new QqApiError(result.status === "failed" && typeof result.retcode === "number" &&
          result.retcode !== 0 && result.retcode !== 1 ? "api-rejected" : "api-unconfirmed"));
        return;
      }
      onEvent(value);
    });
    socket.on("pong", () => { this.alive = true; });
    socket.on("close", () => this.disconnect());
    socket.on("error", () => this.close());
  }
  get open(): boolean { return !this.ended && this.socket.readyState === WebSocket.OPEN; }
  get pendingCount(): number { return this.pending.size; }
  get observationCount(): number { return this.tracked.size; }
  private observe(tracked: Tracked, value: QqAttemptObservation): Promise<void> {
    if (!this.observationOpen) return Promise.resolve();
    const result = tracked.chain.then(() => tracked.options.observe(value));
    // Keep subsequent late observations possible after a persistence failure; report that failure to this waiter.
    tracked.chain = result.catch(() => {});
    this.pendingObservations.add(result);
    const finished = () => { this.pendingObservations.delete(result); };
    void result.then(finished, finished);
    return result;
  }
  private releaseObservation(echo: string): void {
    const entry = this.tracked.get(echo);
    if (!entry) return;
    clearTimeout(entry.expire); this.tracked.delete(echo);
    try { entry.options.released?.(); } catch { /* Capacity observer cannot change delivery. */ }
  }
  private take(echo: string): Pending | undefined {
    const pending = this.pending.get(echo);
    if (pending) { clearTimeout(pending.timer); this.pending.delete(echo); }
    return pending;
  }
  private disconnect(): void {
    this.ended = true;
    for (const echo of this.pending.keys()) {
      const pending = this.take(echo)!;
      const tracked = this.tracked.get(echo);
      if (tracked && this.observationOpen) void this.observe(tracked, { kind: "uncertain" }).then(
        () => pending.reject(new QqApiError("disconnected")), () => pending.reject(new QqApiError("api-unconfirmed")));
      else pending.reject(new QqApiError("disconnected"));
    }
  }
  /** Optional production seam; legacy request() retains its original behavior. No retry. */
  requestAttempt(action: "send_private_msg" | "send_group_msg" | "send_group_forward_msg", params: Record<string, unknown>, options: QqAttemptOptions): Promise<string> {
    if (!this.open || !this.acceptingAttempts || !this.observationOpen || this.socket.bufferedAmount > 1024 * 1024
      || !Number.isInteger(options.capacity ?? 16) || (options.capacity ?? 16) < 1
      || this.tracked.size >= (options.capacity ?? 16) || [...this.tracked.values()].some(t => t.options.attemptId === options.attemptId))
      return Promise.reject(new QqApiError("disconnected"));
    const echo = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const entry: Tracked = { options, chain: Promise.resolve(), physicalSettled: false,
        expire: setTimeout(() => this.releaseObservation(echo), 2 * this.timeoutMs) };
      this.tracked.set(echo, entry);
      try { options.beforeSend(); }
      catch { this.releaseObservation(echo); reject(new QqApiError("api-rejected")); return; }
      const timer = setTimeout(() => {
        const p = this.take(echo); if (!p) return;
        void this.observe(entry, { kind: "uncertain" }).then(() => p.reject(new QqApiError("api-timeout")),
          () => p.reject(new QqApiError("api-unconfirmed")));
      }, this.timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      const failed = () => {
        const p = this.take(echo); if (!p) return;
        void this.observe(entry, { kind: "uncertain" }).then(() => p.reject(new QqApiError("disconnected")),
          () => p.reject(new QqApiError("api-unconfirmed")));
      };
      const physicalSettled = () => {
        if (entry.physicalSettled) return;
        entry.physicalSettled = true;
        try { options.physicalSettled?.(); } catch { /* Physical completion cannot change the delivery protocol. */ }
      };
      try { this.socket.send(JSON.stringify({ action, params, echo }), error => {
        // The callback proves the transport call returned, not platform playback or ACK.
        physicalSettled();
        if (error) failed();
      }); }
      catch {
        try { options.notSent?.(); } catch { /* The no-send fact remains true; storage faults are reported by the caller. */ }
        this.releaseObservation(echo);
        this.take(echo)?.reject(new QqApiError("api-rejected"));
      }
    });
  }
  beginObservationClose(deadline: number): void {
    this.acceptingAttempts = false;
    if (this.observationCloseTimer) return;
    // Never extend the original observer lifetime or an already established close deadline.
    this.observationCloseTimer = setTimeout(() => this.sealObservations(), Math.max(0, deadline - Date.now()));
  }
  sealObservations(): Promise<void> {
    clearTimeout(this.observationCloseTimer);
    this.observationOpen = false; this.acceptingAttempts = false;
    for (const echo of this.tracked.keys()) this.releaseObservation(echo);
    // Include callbacks accepted before the fence but still queued behind an earlier write.
    return Promise.allSettled([...this.pendingObservations]).then(() => {});
  }
  request(action: "send_private_msg" | "send_group_msg", params: Record<string, unknown>): Promise<string> {
    if (!this.open || this.socket.bufferedAmount > 1024 * 1024) return Promise.reject(new QqApiError("disconnected"));
    const echo = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.take(echo)?.reject(new QqApiError("api-timeout")), this.timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ action, params, echo }), error => {
          if (error) this.take(echo)?.reject(new QqApiError("disconnected"));
        });
      } catch { this.take(echo)?.reject(new QqApiError("disconnected")); }
    });
  }
  close(): void { this.disconnect(); this.sealObservations(); this.socket.terminate(); }
}
