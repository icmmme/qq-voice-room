import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { roomInputId, type CheckedRoomConfig } from "./config.js";
import { validResponsePlan } from "./response-planner.js";
import { checkedRoomControlResult } from "./types.js";
import { qqMessageId } from "../qq-message.js";
import type { WorkerObligation, WorkerTurnBinding, RoomGatePermit } from "./types.js";
import type { RoomControlResult, RoomCharacter, RoomDelivery, RoomDeliveryMode, RoomInput, RoomMessage, RoomParticipationMode, ResolvedDeliveryMode, Trigger, TurnState } from "./types.js";
import { sanitizeWorkerContextBudgetDiagnostic } from "./context.js";
import type { AmbientCursor, AmbientPlannerCursorOutcome } from "./participation-planner.js";

interface State { paused: number; epoch: number; voice: number; next_index: number; ambient_at: number | null; delivery_mode: RoomDeliveryMode | null; next_accept_seq: number; mode: RoomParticipationMode; lifecycle_mode: "mention_only" | "ambient"; execution_revision: number; session_expires_at: number | null }
const ACTIVE = "'generating','translating','text_sending','text_sent','synthesizing','audio_sending'";


export const ROOM_SCHEMA_VERSION = 9;
export interface RoomDeliveryAttempt {
  attemptId: string; turnId: string; workItemId: string; accountKey: string; medium: "text" | "audio";
  revision: number; grantId: string; intentAt: number; startedAt: number | null;
}
export type RoomDeliveryObservation = { kind: "ack"; messageId: string } | { kind: "rejected" | "uncertain" };
export const ROOM_WORK_PAYLOAD_VERSION = 2;
export type WorkItemStatus = "queued" | "claimed" | "completed" | "cancelled" | "failed" |
  "expired" | "recorded_only" | "rejected" | "restart_not_resumed";
export interface RoomWorkPayload {
  readonly input: Readonly<Omit<RoomInput, "senderId" | "unsupported"> & { senderKey: string }>; readonly characterIds: readonly string[]; readonly messageRowId: number;
}
export interface RoomWorkItem {
  readonly workItemId: string; readonly eventKey: string; readonly acceptSeq: number | null;
  readonly status: WorkItemStatus; readonly terminalReason: string | null; readonly source: Trigger;
  readonly memberKey: string; readonly receivedAt: number; readonly expiresAt: number | null;
  readonly executionEpoch: number; readonly burstId: string | null; readonly payloadVersion: number;
  readonly payloadJson: string; readonly payload: RoomWorkPayload | null;
  readonly createdAt: number; readonly updatedAt: number;
}
export interface RoomControlState {
  readonly mode: RoomParticipationMode; readonly paused: boolean; readonly epoch: number;
  readonly executionRevision: number; readonly sessionExpiresAt: number | null;
}
export interface RoomControlMutation {
  eventKey: string; now: number; expectedEpoch: number; expectedRevision: number;
  mode?: RoomParticipationMode; paused?: boolean; sessionExpiresAt?: number | null;
  bumpRevision: boolean; cancelQueuedReason?: string;
  outcome?: { action: RoomControlResult["action"]; kind: "applied" | "ignored" | "rejected"; reason: string | null; cancelledActive: boolean };
}
export interface RoomControlApplyResult {
  kind: "applied" | "duplicate" | "stale"; state: RoomControlState; cancelledQueued: number;
  localResult?: RoomControlResult;
}

export interface RoomQueuePolicy {
  capacity: number;
  memberWindowMs: number;
  /** null disables this member cap; admission attempts remain recorded. */
  memberLimit: number | null;
  ttlMs: number;
}
export interface RoomQueueView {
  readonly epoch: number; readonly paused: number; readonly queuedCount: number; readonly claimedCount: number;
  readonly runningBurstCount: number; readonly futureCount: number;
  readonly headId: string | null; readonly headSeq: number | null; readonly headEpoch: number | null;
  readonly claimedWorkItemId: string | null; readonly burstId: string | null;
}
export type LifecycleRequestStatus = "queued" | "generating" | "delivering" | "completed" | "failed"
  | "cancelled" | "restart_not_resumed";
export type LifecycleTurnStatus = "pending" | "generating" | "ready" | "delivering" | "completed"
  | "failed" | "unknown" | "cancelled" | "blocked" | "skipped";
export type LifecycleDeliveryMode = "text" | "both";
export type LifecycleSegmentState = "pending" | "text_sending" | "text_sent" | "audio_sending"
  | "audio_sent" | "completed" | "failed" | "unknown" | "cancelled" | "blocked" | "skipped";
const LIFECYCLE_REQUEST_ACTIVE = new Set<LifecycleRequestStatus>(["queued", "generating", "delivering"]);
const LIFECYCLE_REQUEST_TERMINAL = new Set<LifecycleRequestStatus>(["completed", "failed", "cancelled", "restart_not_resumed"]);
const LIFECYCLE_TURN_ACTIVE = new Set<LifecycleTurnStatus>(["pending", "generating", "ready", "delivering"]);
const LIFECYCLE_TURN_TERMINAL = new Set<LifecycleTurnStatus>(["completed", "failed", "unknown", "cancelled", "blocked", "skipped"]);
const LIFECYCLE_SEGMENT_ACTIVE = new Set<LifecycleSegmentState>(["pending", "text_sending", "text_sent",
  "audio_sending", "audio_sent"]);
const LIFECYCLE_SEGMENT_TERMINAL = new Set<LifecycleSegmentState>(["completed", "failed", "unknown", "cancelled",
  "blocked", "skipped"]);
export interface LifecycleRequest {
  readonly requestId: string;
  readonly eventKey: string;
  readonly acceptSeq: number;
  readonly status: LifecycleRequestStatus;
  readonly outcomeReason: string | null;
  readonly source: Trigger;
  readonly executionEpoch: number;
  readonly executionRevision: number;
  readonly expiresAt: number;
  readonly messageRowId: number;
  readonly characterIds: readonly string[];
  readonly deliveryMode: LifecycleDeliveryMode;
  readonly senderKey: string;
  readonly input: Readonly<Omit<RoomInput, "senderId" | "unsupported">>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface LifecycleTurn {
  readonly turnId: string;
  readonly requestId: string;
  readonly characterId: string;
  readonly mentionIndex: number;
  readonly status: LifecycleTurnStatus;
  readonly reason: string | null;
  readonly segmentCount: number;
}
export interface LifecycleSegment {
  readonly segmentId: string;
  readonly turnId: string;
  readonly segmentIndex: number;
  readonly text: string;
  readonly voiceText: string | null;
  readonly voiceLanguage: "zh" | "ja" | null;
  readonly deliveryMode: LifecycleDeliveryMode;
  readonly state: LifecycleSegmentState;
  readonly reason: string | null;
}
export interface LifecycleAttempt {
  readonly attemptId: string;
  readonly segmentId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly accountKey: string;
  readonly medium: "text" | "audio";
  readonly revision: number;
  readonly intentAt: number;
  readonly startedAt: number | null;
  readonly ownerToken: string;
  readonly committedRowId: number | null;
}
export interface LifecycleAdmission {
  readonly kind: "enqueue" | "record_only" | "reject" | "duplicate";
  readonly request: LifecycleRequest | null;
  readonly reason: string | null;
  readonly messageRowId?: number;
}
export interface LifecycleControlState {
  readonly mode: "mention_only" | "ambient";
  readonly paused: boolean;
  readonly epoch: number;
  readonly executionRevision: number;
  readonly sessionExpiresAt: null;
}
export interface LifecycleDeliveryItem {
  readonly request: LifecycleRequest;
  readonly turn: LifecycleTurn;
  readonly segment: LifecycleSegment;
  readonly character: RoomCharacter;
}
export interface LifecycleAuditRow {
  readonly requestId: string;
  readonly acceptSeq: number;
  readonly requestStatus: LifecycleRequestStatus;
  readonly requestReason: string | null;
  readonly source: Trigger;
  readonly turnId: string;
  readonly characterId: string;
  readonly mentionIndex: number;
  readonly turnStatus: LifecycleTurnStatus;
  readonly turnReason: string | null;
  readonly segmentId: string | null;
  readonly segmentIndex: number | null;
  readonly segmentStatus: LifecycleSegmentState | null;
  readonly segmentReason: string | null;
  readonly attemptId: string | null;
  readonly medium: "text" | "audio" | null;
  readonly startedAt: number | null;
  readonly receipts: readonly ("ack" | "rejected" | "uncertain")[];
}
export interface LifecycleGenerationClaim {
  readonly request: LifecycleRequest;
  readonly turn: LifecycleTurn;
  readonly character: RoomCharacter;
}
export interface LifecycleDispatchClaim extends LifecycleDeliveryItem {
  readonly attempt: LifecycleAttempt;
}
export interface LifecycleRecovery {
  readonly previousEpoch: number;
  readonly epoch: number;
}
export interface LifecycleAcceptOptions {
  now: number;
  expectedEpoch: number;
  ownerToken: string;
  source: Trigger;
  policy: RoomQueuePolicy;
  enqueue: boolean;
  deliveryMode: LifecycleDeliveryMode;
}
export interface AmbientAcceptOptions {
  now: number;
  expectedEpoch: number;
  ownerToken: string;
  policy: RoomQueuePolicy;
  deliveryMode: LifecycleDeliveryMode;
  eventKey: string;
}
type AcceptOptions = { now: number; expectedEpoch: number; source: Trigger } & (
  | { mode: "enqueue"; policy: RoomQueuePolicy }
  | { mode: "record_only" }
  | { mode: "reject"; reason: string; recordHistory?: boolean }
);
export type WorkAdmissionResult = { kind: "enqueue" | "record_only" | "reject" | "duplicate";
  item: RoomWorkItem | null; reason: string | null };
type WorkRow = {
  work_item_id: string; event_key: string; accept_seq: number | null; status: WorkItemStatus;
  terminal_reason: string | null; source: Trigger; member_key: string; received_at: number;
  expires_at: number | null; execution_epoch: number; burst_id: string | null; payload_version: number;
  payload_json: string; created_at: number; updated_at: number;
};
const WORK_TERMINAL = new Set<WorkItemStatus>(["completed", "cancelled", "failed", "expired",
  "recorded_only", "rejected", "restart_not_resumed"]);
// One state mapping serves migration audits and SQL binding/settlement triggers.
const BURST_STATE_BY_WORK = { claimed: "running", completed: "completed", failed: "failed",
  cancelled: "stopped", restart_not_resumed: "interrupted" } as const;
const burstStateSql = (expression: string) => "CASE " + expression + Object.entries(BURST_STATE_BY_WORK)
  .map(([work, burst]) => " WHEN '" + work + "' THEN '" + burst + "'").join("") + " ELSE '' END";
const timestamp = (n: number) => Number.isSafeInteger(n) && n >= 0;
const code = (s: string) => typeof s === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(s);
const POST_MVP_SCHEMA_OBJECTS = [
  "room_work_items", "room_work_fifo", "room_work_member_window", "room_work_single_claim",
  "room_work_identity", "room_work_terminal", "room_burst_single_running", "room_work_initial",
  "room_work_binding_insert", "room_work_binding_update", "room_burst_reference_update",
  "room_burst_reference_delete", "room_burst_state_binding", "room_work_settle_burst",
  "room_delivery_attempts", "room_delivery_receipts", "room_receipt_owners", "room_delivery_medium_once",
  "room_attempt_identity", "room_attempt_delete", "room_receipt_update", "room_receipt_delete", "room_owner_update", "room_owner_delete",
  "room_lifecycle_requests", "room_lifecycle_turns", "room_lifecycle_segments",
  "room_lifecycle_attempts", "room_lifecycle_receipts", "room_lifecycle_owner", "room_lifecycle_audio_fence",
] as const;
const STORE_RUNBOOK = "docs/AI_VOICE_ROOM_STORE_OPERATIONS.md";
// Fixed metadata only: callers may show these fields without printing payloads or raw causes.
const storeFailure = (message: string, diagnostic: string, cause: unknown) =>
  Object.assign(new Error(message, { cause }), { code: message, diagnostic, runbook: STORE_RUNBOOK });
const bindingDiagnostic = "WorkItem/Burst绑定或状态不一致；事务已回滚。停止该房间执行，不跳过claimed、不重新入队；按运维手册离线核对并人工修复。";

/** Owns only room.sqlite and its lock. No PA business stores or session APIs; migrations remain room-local. */
export class RoomStore {
  private db: DatabaseSync;
  private readonly lock: string;
  private readonly lockValue: string;
  private closed = false;
  private nonBlockingDeliveryWrites = false;
  private readonly actorKey: string;
  private ownsWorkerLock = false;
  private lifecyclePauseListener?: (paused: boolean) => void;
  constructor(file: string, readonly config: CheckedRoomConfig,
    options: { lifecycle?: "runtime" | "connection" } = {}) {
    if (basename(file) !== "room.sqlite") throw new Error("room-store-path-invalid");
    if (options.lifecycle !== undefined && !["runtime", "connection"].includes(options.lifecycle)) throw new Error("room-store-lifecycle-invalid");
    file = resolve(file); mkdirSync(dirname(file), { recursive: true });
    this.lock = `${file}.worker.lock`;
    this.lockValue = JSON.stringify({ format: "pa-room-worker-lock-v2", pid: process.pid, instance: randomUUID() });
    // A connection owns SQLite data only: no Worker ownership and no boot recovery.
    const runtime = options.lifecycle !== "connection";
    if (runtime) this.acquireWorkerLock();
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file); this.db = db;
      db.exec("PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
      this.migrate();
      this.actorKey = (db.prepare("SELECT value FROM room_meta WHERE key='actor_key'").get() as { value: string }).value;
      if (runtime) this.transaction(() => {
        if (db!.prepare(`SELECT 1 FROM room_deliveries WHERE worker_binding IS NULL AND state IN
          ('text_sending','audio_sending','text_uncertain','audio_uncertain','sent_unrecorded','interrupted') LIMIT 1`).get())
          db!.prepare("INSERT OR REPLACE INTO room_meta VALUES ('delivery_hold','legacy_delivery_unresolved')").run();
        this.recoverDeliveryFacts();
        db!.exec(`UPDATE room_state SET paused=1, epoch=epoch+1;
          UPDATE room_bursts SET state='interrupted' WHERE state='running'
            AND NOT EXISTS (SELECT 1 FROM room_work_items w WHERE w.burst_id=room_bursts.id AND w.status='claimed');
          UPDATE room_deliveries SET state='interrupted' WHERE state IN (${ACTIVE});`);
      });
    } catch (error) { db?.close(); this.releaseLock(); throw error; }
  }
  /** Complete bytes are fsynced and closed before a no-replace hard-link publishes ownership. */
  private publishLock(target: string, value = this.lockValue): void {
    const pending = target + ".pending-" + randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(pending, "wx", 0o600);
      writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(pending, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("room-worker-locked");
        throw error;
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(pending)) unlinkSync(pending);
    }
  }
  private lockOwner(path: string): { value: string; instance: string; dead: boolean } | null {
    let value: string;
    try { value = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    let owner: { format?: unknown; pid?: unknown; instance?: unknown };
    try { owner = JSON.parse(value); }
    catch { throw new Error("room-worker-locked-unrecognized-manual-check"); }
    if (!owner || owner.format !== "pa-room-worker-lock-v2"
      || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || Number(owner.pid) > 2147483647
      || typeof owner.instance !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.instance)) {
      throw new Error("room-worker-locked-unrecognized-manual-check");
    }
    let dead = false;
    try { process.kill(Number(owner.pid), 0); }
    catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    return { value, instance: owner.instance, dead };
  }
  private acquireReapingGuard(path: string, depth = 0): () => void {
    if (depth >= 64) throw new Error("room-worker-locked-recovery-depth");
    const value = JSON.stringify({ format: "pa-room-worker-lock-v2", pid: process.pid, instance: randomUUID() });
    try { this.publishLock(path, value); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "room-worker-locked") throw error;
      const observed = this.lockOwner(path);
      if (!observed) return this.acquireReapingGuard(path, depth + 1);
      if (!observed.dead) throw new Error("room-worker-locked");
      // A successor belongs to this immutable incarnation, not to a later owner of path.
      // Every reaper must own that same successor before checking/deleting observed.
      // Crashed successors are recovered recursively under fresh incarnation names.
      const release = this.acquireReapingGuard(this.lock + ".recovery-" + observed.instance, depth + 1);
      try {
        const current = this.lockOwner(path);
        if (current?.value === observed.value) {
          if (!current.dead) throw new Error("room-worker-locked");
          unlinkSync(path);
        }
      } finally { release(); }
      return this.acquireReapingGuard(path, depth + 1);
    }
    return () => { if (existsSync(path) && readFileSync(path, "utf8") === value) unlinkSync(path); };
  }
  private acquireWorkerLock(): void {
    // Unknown/live guards also block an absent target; no acquisition path bypasses the guard.
    const release = this.acquireReapingGuard(this.lock + ".reaping");
    try {
      const observed = this.lockOwner(this.lock);
      if (observed) {
        if (!observed.dead || readFileSync(this.lock, "utf8") !== observed.value) throw new Error("room-worker-locked");
        unlinkSync(this.lock);
      }
      this.publishLock(this.lock); this.ownsWorkerLock = true;
    } finally { release(); }
  }
  private releaseLock() {
    if (this.ownsWorkerLock && existsSync(this.lock) && readFileSync(this.lock, "utf8") === this.lockValue) unlinkSync(this.lock);
    this.ownsWorkerLock = false;
  }
  private migrate(): void {
    // All required steps share one outer transaction: a failed 1→2 also rolls back 0→1.
    try { this.transaction(() => {
      let version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (!Number.isSafeInteger(version) || version < 0 || version > ROOM_SCHEMA_VERSION) throw new Error("room-schema-version-unsupported");
      const hasMeta = Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='room_meta'").get());
      const scope = createHash("sha256").update(JSON.stringify({ roomId: this.config.roomId, groupId: this.config.groupId,
        ownerId: this.config.ownerId, ingress: this.config.ingressAccountKey, characters: this.config.characters })).digest("hex");
      const old = hasMeta ? this.db.prepare("SELECT value FROM room_meta WHERE key='scope'").get() : undefined;
      if (old && old.value !== scope) throw new Error("room-scope-mismatch");
      if (version === 0) {
        const partial = this.db.prepare("SELECT name,type FROM sqlite_schema WHERE name IN ("
          + POST_MVP_SCHEMA_OBJECTS.map(() => "?").join(",") + ")").all(...POST_MVP_SCHEMA_OBJECTS);
        if (partial.length) {
          throw storeFailure("room-schema-invalid", "v0数据库含队列阶段对象；拒绝升级，原数据保留。按运维手册核对部分迁移。",
            { code: "room-schema-partial-migration", objects: partial });
        }
        this.migrateZeroToOne(scope); version = 1;
      }
      this.checkSchema(version);
      if (version === 1) { this.migrateOneToTwo(); version = 2; }
      if (version === 2) { this.migrateTwoToThree(); version = 3; }
      if (version === 3) { this.migrateThreeToFour(); version = 4; }
      if (version === 4) { this.migrateFourToFive(); version = 5; }
      if (version === 5) { this.migrateFiveToSix(); version = 6; }
      if (version === 6) { this.migrateSixToSeven(); version = 7; }
      if (version === 7) { this.migrateSevenToEight(); version = 8; }
      if (version === 8) { this.migrateEightToNine(); version = 9; }
      this.checkSchema(version);
      // Audit the original fence before runtime boot can absorb an E+1 corruption.
      this.assertNoFutureWork(this.state().epoch);
      this.checkWorkBindings();
      this.checkWorkerBindings();
    }); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ERR_SQLITE_ERROR") {
        throw storeFailure("room-migration-failed", "SQLite迁移失败，事务已回滚；停止启动，保留原库并按运维手册离线检查。原始cause仅供本地诊断。", error);
      }
      throw error;
    }
  }
  private migrateZeroToOne(scope: string): void {
      this.db.exec(`CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL,
          epoch INTEGER NOT NULL, voice INTEGER NOT NULL, next_index INTEGER NOT NULL, ambient_at INTEGER);
        CREATE TABLE IF NOT EXISTS room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, speaker_type TEXT NOT NULL,
          speaker_id TEXT NOT NULL, account_key TEXT NOT NULL, target_id INTEGER, text TEXT NOT NULL,
          platform_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS room_bursts (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, trigger TEXT NOT NULL,
          target_id INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS room_deliveries (id TEXT PRIMARY KEY, burst_id TEXT NOT NULL,
          character_id TEXT NOT NULL, account_key TEXT NOT NULL, voice_key TEXT NOT NULL, state TEXT NOT NULL,
          text_id TEXT, audio_id TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS room_seen (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS room_budget (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL);`);
      const addColumns = (table: string, columns: readonly string[]) => {
        const names = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => String(c.name)));
        for (const definition of columns) if (!names.has(definition.split(" ")[0]!)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      };
      addColumns("room_state", ["delivery_mode TEXT", "next_accept_seq INTEGER NOT NULL DEFAULT 0 CHECK(next_accept_seq>=0)"]);
      addColumns("room_messages", ["medium TEXT NOT NULL DEFAULT 'text'"]);
      addColumns("room_deliveries", ["semantic_text TEXT", "voice_text TEXT", "voice_language TEXT", "delivery_mode TEXT"]);
      this.db.exec(`CREATE TABLE IF NOT EXISTS room_work_items (
        work_item_id TEXT PRIMARY KEY NOT NULL, event_key TEXT NOT NULL UNIQUE, accept_seq INTEGER UNIQUE CHECK(accept_seq>0),
        status TEXT NOT NULL CHECK(status IN ('queued','claimed','completed','cancelled','failed','expired','recorded_only','rejected','restart_not_resumed')),
        terminal_reason TEXT, source TEXT NOT NULL CHECK(source IN ('direct','manual','ambient')),
        member_key TEXT NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER,
        execution_epoch INTEGER NOT NULL CHECK(execution_epoch>=0), burst_id TEXT UNIQUE,
        payload_version INTEGER NOT NULL CHECK(payload_version>0), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        admission_attempt INTEGER NOT NULL CHECK(admission_attempt IN (0,1)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK((status IN ('recorded_only','rejected') AND accept_seq IS NULL AND burst_id IS NULL AND expires_at IS NULL)
          OR (status NOT IN ('recorded_only','rejected') AND accept_seq IS NOT NULL AND expires_at IS NOT NULL)),
        CHECK((status IN ('queued','claimed') AND terminal_reason IS NULL)
          OR (status NOT IN ('queued','claimed') AND terminal_reason IS NOT NULL AND length(terminal_reason)>0)),
        CHECK(status!='queued' OR burst_id IS NULL), CHECK(status!='claimed' OR burst_id IS NOT NULL),
        CHECK(status!='completed' OR burst_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS room_work_fifo ON room_work_items(status,accept_seq);
      CREATE INDEX IF NOT EXISTS room_work_member_window ON room_work_items(member_key,admission_attempt,created_at);
      CREATE TRIGGER IF NOT EXISTS room_work_identity BEFORE UPDATE ON room_work_items
        WHEN NEW.work_item_id IS NOT OLD.work_item_id OR NEW.event_key IS NOT OLD.event_key
          OR NEW.accept_seq IS NOT OLD.accept_seq OR NEW.source IS NOT OLD.source
          OR NEW.member_key IS NOT OLD.member_key OR NEW.received_at IS NOT OLD.received_at
          OR NEW.expires_at IS NOT OLD.expires_at OR NEW.execution_epoch IS NOT OLD.execution_epoch
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT,'room-work-identity-immutable'); END;
      CREATE TRIGGER IF NOT EXISTS room_work_terminal BEFORE UPDATE ON room_work_items
        WHEN (OLD.status NOT IN ('queued','claimed') AND (NEW.status IS NOT OLD.status
          OR NEW.terminal_reason IS NOT OLD.terminal_reason OR NEW.burst_id IS NOT OLD.burst_id))
          OR (OLD.status='claimed' AND NEW.status='queued')
        BEGIN SELECT RAISE(ABORT,'room-work-transition-invalid'); END;
      CREATE UNIQUE INDEX IF NOT EXISTS room_work_single_claim ON room_work_items((1)) WHERE status='claimed';`);
      this.db.prepare("INSERT OR IGNORE INTO room_meta(key,value) VALUES ('scope',?)").run(scope);
      this.db.prepare("INSERT OR IGNORE INTO room_meta(key,value) VALUES ('actor_key',?)").run(randomBytes(32).toString("hex"));
      this.db.exec(`INSERT OR IGNORE INTO room_state (id,paused,epoch,voice,next_index,ambient_at) VALUES (1,1,0,1,0,NULL);
        PRAGMA user_version=1;`);

  }
  private checkSchema(version: number): void {
    const columns: Record<string, readonly string[]> = {
      room_meta: ["key","value"], room_state: ["id","paused","epoch","voice","next_index","ambient_at","delivery_mode","next_accept_seq",
        ...(version >= 4 ? ["mode","execution_revision","session_expires_at"] : []),
        ...(version >= 9 ? ["lifecycle_mode"] : [])],
      room_messages: ["id","speaker_type","speaker_id","account_key","target_id","text","platform_id","created_at","medium"],
      room_bursts: ["id","epoch","trigger","target_id","state","created_at", ...(version >= 6 ? ["worker_obligations"] : [])],
      room_deliveries: ["id","burst_id","character_id","account_key","voice_key","state","text_id","audio_id","created_at","semantic_text","voice_text","voice_language","delivery_mode", ...(version >= 6 ? ["worker_binding","worker_text_row_id"] : []), ...(version >= 7 ? ["worker_projection"] : [])],
      room_seen: ["id","created_at", ...(version >= 5 ? ["control_result"] : [])], room_budget: ["id","kind","created_at"],
      room_work_items: ["work_item_id","event_key","accept_seq","status","terminal_reason","source","member_key","received_at","expires_at","execution_epoch","burst_id","payload_version","payload_json","admission_attempt","created_at","updated_at"],
      ...(version >= 8 ? {
        room_delivery_attempts: ["attempt_id","turn_id","work_item_id","account_key","medium","revision","grant_id","intent_at","started_at"],
        room_delivery_receipts: ["attempt_id","kind","message_id","observed_at"],
        room_receipt_owners: ["account_key","message_id","attempt_id"],
      } : {}),
      ...(version >= 9 ? {
        room_lifecycle_requests: ["request_id","event_key","accept_seq","status","outcome_reason","source",
          "execution_epoch","execution_revision","expires_at","message_row_id","delivery_mode","payload_json","created_at","updated_at"],
        room_lifecycle_turns: ["turn_id","request_id","character_id","mention_index","status","reason","created_at","updated_at"],
        room_lifecycle_segments: ["segment_id","turn_id","segment_index","semantic_text","voice_text","voice_language",
          "delivery_mode","state","reason","created_at","updated_at"],
        room_lifecycle_attempts: ["attempt_id","segment_id","request_id","turn_id","account_key","medium","revision",
          "intent_at","started_at","owner_token","committed_row_id"],
        room_lifecycle_receipts: ["attempt_id","kind","message_id","observed_at"],
        room_lifecycle_owner: ["id","owner_token","lease_until","execution_epoch","execution_revision"],
        room_lifecycle_audio_fence: ["id","attempt_id","started_at"],
      } : {}),
    };
    for (const [table, names] of Object.entries(columns)) {
      const actual = new Set(this.db.prepare("PRAGMA table_info(" + table + ")").all().map(c => c.name));
      if (names.some(n => !actual.has(n))) throw new Error("room-schema-invalid");
    }
    const objects = new Map(this.db.prepare("SELECT name,type FROM sqlite_schema").all().map(o => [o.name, o.type]));
    for (const name of ["room_work_fifo","room_work_member_window","room_work_single_claim",
      ...(version >= 2 ? ["room_burst_single_running"] : []), ...(version >= 6 ? ["room_worker_turn_ordinal"] : []), ...(version >= 7 ? ["room_worker_projection_row"] : []),
      ...(version >= 8 ? ["room_delivery_medium_once"] : []),
      ...(version >= 9 ? ["room_lifecycle_request_fifo","room_lifecycle_turn_order","room_lifecycle_segment_order",
        "room_lifecycle_attempt_started"] : [])]) {
      if (objects.get(name) !== "index") throw new Error("room-schema-invalid");
    }
    for (const name of ["room_work_identity","room_work_terminal", ...(version >= 2
      ? ["room_work_initial","room_work_binding_insert","room_work_binding_update","room_burst_reference_update","room_burst_reference_delete"] : []),
      ...(version >= 3 ? ["room_work_settle_burst","room_burst_state_binding"] : []), ...(version >= 6 ? ["room_worker_binding_immutable"] : []),
      ...(version >= 8 ? ["room_attempt_identity", "room_attempt_delete", "room_receipt_update", "room_receipt_delete", "room_owner_update", "room_owner_delete"] : []),
      ...(version >= 9 ? ["room_lifecycle_attempt_identity","room_lifecycle_attempt_delete",
        "room_lifecycle_receipt_immutable","room_lifecycle_receipt_delete"] : [])]) {
      if (objects.get(name) !== "trigger") throw new Error("room-schema-invalid");
    }
    const key = this.db.prepare("SELECT value FROM room_meta WHERE key='actor_key'").get()?.value;
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)
      || !this.db.prepare("SELECT 1 FROM room_meta WHERE key='scope'").get()
      || this.db.prepare("SELECT count(*) AS n FROM room_state").get()!.n !== 1
      || !this.db.prepare(`SELECT 1 FROM room_state WHERE id=1
        AND next_accept_seq >= (SELECT COALESCE(max(accept_seq),0) FROM room_work_items)
        ${version >= 9 ? "AND next_accept_seq >= (SELECT COALESCE(max(accept_seq),0) FROM room_lifecycle_requests)" : ""}`).get()) {
      throw new Error("room-schema-invalid");
    }
  }
  private migrateOneToTwo(): void {
    if (Number(this.db.prepare("SELECT count(*) AS n FROM room_bursts WHERE state='running'").get()!.n) > 1) {
      throw new Error("room-schema-active-bursts-conflict");
    }
    const rows = this.db.prepare("SELECT * FROM room_work_items").all() as WorkRow[];
    // Validate and convert every row before changing any payload, including terminal rows.
    const converted = rows.map(row => {
      if (row.payload_version !== 1) throw new Error("room-work-payload-version");
      return { row, json: JSON.stringify(this.decodePayload(row, true)) };
    });
    this.db.exec("DROP TRIGGER room_work_terminal;");
    for (const { row, json } of converted) {
      this.db.prepare("UPDATE room_work_items SET payload_json=?,payload_version=2 WHERE work_item_id=?").run(json, row.work_item_id);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX room_burst_single_running ON room_bursts((1)) WHERE state='running';
      CREATE TRIGGER room_work_terminal BEFORE UPDATE ON room_work_items
      WHEN (OLD.status NOT IN ('queued','claimed') AND (NEW.status IS NOT OLD.status
        OR NEW.terminal_reason IS NOT OLD.terminal_reason OR NEW.burst_id IS NOT OLD.burst_id
        OR NEW.payload_json IS NOT OLD.payload_json OR NEW.payload_version IS NOT OLD.payload_version
        OR NEW.admission_attempt IS NOT OLD.admission_attempt))
        OR (OLD.status='claimed' AND (NEW.burst_id IS NOT OLD.burst_id
          OR NEW.status NOT IN ('claimed','completed','failed','cancelled','restart_not_resumed')))
        OR (OLD.status='queued' AND NEW.status NOT IN ('queued','claimed','cancelled','expired','restart_not_resumed'))
      BEGIN SELECT RAISE(ABORT,'room-work-transition-invalid'); END;
      CREATE TRIGGER room_work_initial BEFORE INSERT ON room_work_items
      WHEN NEW.status NOT IN ('queued','recorded_only','rejected')
      BEGIN SELECT RAISE(ABORT,'room-work-transition-invalid'); END;
      CREATE TRIGGER room_burst_reference_update BEFORE UPDATE OF id,epoch,trigger,target_id ON room_bursts
      WHEN EXISTS (SELECT 1 FROM room_work_items WHERE burst_id=OLD.id)
        AND (NEW.id IS NOT OLD.id OR NEW.epoch IS NOT OLD.epoch OR NEW.trigger IS NOT OLD.trigger OR NEW.target_id IS NOT OLD.target_id)
      BEGIN SELECT RAISE(ABORT,'room-work-burst-binding-invalid'); END;
      CREATE TRIGGER room_burst_reference_delete BEFORE DELETE ON room_bursts
      WHEN EXISTS (SELECT 1 FROM room_work_items WHERE burst_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'room-work-burst-binding-invalid'); END;`);
    // Trigger references avoid rebuilding either historical table to add a foreign key.
    const invalidBinding = `NEW.burst_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM room_bursts b WHERE b.id=NEW.burst_id AND b.epoch=NEW.execution_epoch
       AND b.trigger=NEW.source AND b.target_id=json_extract(NEW.payload_json,'$.messageRowId')
       AND b.state=${burstStateSql("NEW.status")})`;
    for (const event of ["INSERT","UPDATE"]) {
      this.db.exec("CREATE TRIGGER room_work_binding_" + event.toLowerCase() + " BEFORE " + event
        + " ON room_work_items WHEN " + invalidBinding
        + " BEGIN SELECT RAISE(ABORT,'room-work-burst-binding-invalid'); END;");
    }
    this.checkWorkBindings();
    this.db.exec("PRAGMA user_version=2;");
  }
  private checkWorkBindings(): void {
    for (const row of this.db.prepare("SELECT * FROM room_work_items").all() as WorkRow[]) {
      if (row.status !== "queued" && row.status !== "claimed" && !WORK_TERMINAL.has(row.status)) throw new Error("room-work-payload-invalid");
      if (row.payload_version !== ROOM_WORK_PAYLOAD_VERSION) throw new Error("room-work-payload-version");
      const payload = this.decodePayload(row);
      const expected = BURST_STATE_BY_WORK[row.status as keyof typeof BURST_STATE_BY_WORK];
      if (["claimed","completed","failed"].includes(row.status) && !row.burst_id) throw new Error("room-work-burst-binding-invalid");
      if (row.burst_id) {
        const b = this.db.prepare("SELECT * FROM room_bursts WHERE id=?").get(row.burst_id);
        if (!b || !payload || !expected || b.epoch !== row.execution_epoch || b.trigger !== row.source
          || b.target_id !== payload.messageRowId || b.state !== expected) throw new Error("room-work-burst-binding-invalid");
      }
    }
  }
  private migrateTwoToThree(): void {
    this.checkWorkBindings();
    this.db.exec("DROP TRIGGER room_work_binding_update;");
    this.db.exec(`
      CREATE TRIGGER room_work_binding_update BEFORE UPDATE ON room_work_items
      WHEN NEW.burst_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM room_bursts b WHERE b.id=NEW.burst_id AND b.epoch=NEW.execution_epoch
          AND b.trigger=NEW.source AND b.target_id=json_extract(NEW.payload_json,'$.messageRowId')
          AND b.state=CASE WHEN OLD.status='claimed' AND NEW.status!='claimed' THEN 'running'
            ELSE ${burstStateSql("NEW.status")} END)
      BEGIN SELECT RAISE(ABORT,'room-work-burst-binding-invalid'); END;
      CREATE TRIGGER room_burst_state_binding BEFORE UPDATE OF state ON room_bursts
      WHEN EXISTS (SELECT 1 FROM room_work_items w WHERE w.burst_id=OLD.id
        AND NEW.state!=${burstStateSql("w.status")})
      BEGIN SELECT RAISE(ABORT,'room-work-burst-binding-invalid'); END;
      CREATE TRIGGER room_work_settle_burst AFTER UPDATE OF status ON room_work_items
      WHEN OLD.status='claimed' AND NEW.status!='claimed'
      BEGIN
        UPDATE room_bursts SET state=${burstStateSql("NEW.status")}
          WHERE id=OLD.burst_id AND epoch=OLD.execution_epoch AND state='running';
        SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'room-work-burst-stale') END;
      END;
      PRAGMA user_version=3;`);
  }
  private migrateThreeToFour(): void {
    this.db.exec(`ALTER TABLE room_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'mention_only' CHECK(mode IN ('mention_only','session'));
      ALTER TABLE room_state ADD COLUMN execution_revision INTEGER NOT NULL DEFAULT 0 CHECK(execution_revision>=0);
      ALTER TABLE room_state ADD COLUMN session_expires_at INTEGER;
      PRAGMA user_version=4;`);
  }

  private migrateFourToFive(): void {
    this.db.exec(`ALTER TABLE room_seen ADD COLUMN control_result TEXT;
      PRAGMA user_version=5;`);
  }

  private migrateFiveToSix(): void {
    this.db.exec(`ALTER TABLE room_bursts ADD COLUMN worker_obligations TEXT CHECK(worker_obligations IS NULL OR json_valid(worker_obligations));
      ALTER TABLE room_deliveries ADD COLUMN worker_binding TEXT CHECK(worker_binding IS NULL OR json_valid(worker_binding));
      ALTER TABLE room_deliveries ADD COLUMN worker_text_row_id INTEGER;
      CREATE UNIQUE INDEX room_worker_turn_ordinal ON room_deliveries(burst_id,json_extract(worker_binding,'$.turnIndex')) WHERE worker_binding IS NOT NULL;
      CREATE TRIGGER room_worker_binding_immutable BEFORE UPDATE OF worker_binding ON room_deliveries
        WHEN OLD.worker_binding IS NOT NULL AND NEW.worker_binding IS NOT OLD.worker_binding
        BEGIN SELECT RAISE(ABORT,'room-worker-binding-immutable'); END;
      PRAGMA user_version=6;`);
  }

  private migrateSixToSeven(): void {
    this.db.exec(`ALTER TABLE room_deliveries ADD COLUMN worker_projection TEXT CHECK(worker_projection IS NULL OR json_valid(worker_projection));
      CREATE UNIQUE INDEX room_worker_projection_row ON room_deliveries(worker_text_row_id)
        WHERE worker_binding IS NOT NULL AND worker_text_row_id IS NOT NULL;`);
    // No time/rowid inference: old successful facts must still have their real projection.
    for (const row of this.db.prepare("SELECT id,burst_id,worker_binding FROM room_deliveries WHERE worker_binding IS NOT NULL").all()) {
      const binding = JSON.parse(String(row.worker_binding)) as WorkerTurnBinding;
      const work = this.db.prepare("SELECT work_item_id FROM room_work_items WHERE burst_id=?").get(row.burst_id!);
      const item = work ? this.workItem(String(work.work_item_id)) : null;
      if (!item?.payload || !this.validWorkerBinding(binding, item)) throw new Error("room-worker-binding-invalid");
      const d = this.db.prepare("SELECT * FROM room_deliveries WHERE id=?").get(row.id!)!;
      if (d.state === "text_only") {
        const message = this.realWorkerProjection(binding, item);
        const fact = { version: 1, state: "retained", rowId: d.worker_text_row_id, receiptId: d.text_id, committedAt: message.created_at,
          textSHA256: createHash("sha256").update(String(message.text)).digest("hex") };
        if (this.db.prepare("UPDATE room_deliveries SET worker_projection=? WHERE id=?").run(JSON.stringify(fact), row.id!).changes !== 1)
          throw new Error("room-worker-projection-conflict");
      } else if (d.worker_text_row_id !== null || d.text_id !== null) throw new Error("room-worker-projection-invalid");
    }
    this.db.exec("PRAGMA user_version=7");
  }
  private migrateSevenToEight(): void {
    this.db.exec(`CREATE TABLE room_delivery_attempts (
      attempt_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
      account_key TEXT NOT NULL, medium TEXT NOT NULL CHECK(medium IN ('text','audio')),
      revision INTEGER NOT NULL CHECK(revision>=0), grant_id TEXT NOT NULL,
      intent_at INTEGER NOT NULL CHECK(intent_at>=0), started_at INTEGER CHECK(started_at>=intent_at));
      CREATE UNIQUE INDEX room_delivery_medium_once ON room_delivery_attempts(turn_id,medium);
      CREATE TABLE room_delivery_receipts (
        attempt_id TEXT NOT NULL REFERENCES room_delivery_attempts(attempt_id),
        kind TEXT NOT NULL CHECK(kind IN ('ack','rejected','uncertain')), message_id TEXT,
        observed_at INTEGER NOT NULL CHECK(observed_at>=0), PRIMARY KEY(attempt_id,kind),
        CHECK((kind='ack' AND length(message_id)>0) OR (kind!='ack' AND message_id IS NULL)));
      CREATE TABLE room_receipt_owners (
        account_key TEXT NOT NULL, message_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        PRIMARY KEY(account_key,message_id));
      CREATE TRIGGER room_attempt_identity BEFORE UPDATE ON room_delivery_attempts
        WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.turn_id IS NOT OLD.turn_id
          OR NEW.work_item_id IS NOT OLD.work_item_id OR NEW.account_key IS NOT OLD.account_key
          OR NEW.medium IS NOT OLD.medium OR NEW.revision IS NOT OLD.revision OR NEW.grant_id IS NOT OLD.grant_id
          OR NEW.intent_at IS NOT OLD.intent_at OR OLD.started_at IS NOT NULL OR NEW.started_at IS NULL
        BEGIN SELECT RAISE(ABORT,'room-delivery-attempt-immutable'); END;
      CREATE TRIGGER room_attempt_delete BEFORE DELETE ON room_delivery_attempts
        BEGIN SELECT RAISE(ABORT,'room-delivery-attempt-immutable'); END;
      CREATE TRIGGER room_receipt_update BEFORE UPDATE ON room_delivery_receipts
        BEGIN SELECT RAISE(ABORT,'room-delivery-receipt-immutable'); END;
      CREATE TRIGGER room_receipt_delete BEFORE DELETE ON room_delivery_receipts
        BEGIN SELECT RAISE(ABORT,'room-delivery-receipt-immutable'); END;
      CREATE TRIGGER room_owner_update BEFORE UPDATE ON room_receipt_owners
        BEGIN SELECT RAISE(ABORT,'room-receipt-owner-immutable'); END;
      CREATE TRIGGER room_owner_delete BEFORE DELETE ON room_receipt_owners
        BEGIN SELECT RAISE(ABORT,'room-receipt-owner-immutable'); END;`);
    // Existing IDs establish ownership, never manufacture a platform ACK or dispatch fact.
    for (const row of this.db.prepare("SELECT id,account_key,text_id,audio_id FROM room_deliveries").all()) {
      for (const medium of ["text", "audio"] as const) {
        const id = row[medium + "_id"];
        if (id !== null) this.ownReceipt(String(row.account_key), String(id), `legacy:${row.id}:${medium}`);
      }
    }
    this.db.exec("PRAGMA user_version=8");
  }
  private migrateEightToNine(): void {
    this.db.exec(`ALTER TABLE room_state ADD COLUMN lifecycle_mode TEXT NOT NULL DEFAULT 'mention_only'
        CHECK(lifecycle_mode IN ('mention_only','ambient'));
      UPDATE room_state SET lifecycle_mode='mention_only';
      CREATE TABLE room_lifecycle_requests (
        request_id TEXT PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        accept_seq INTEGER NOT NULL UNIQUE CHECK(accept_seq>0),
        status TEXT NOT NULL CHECK(status IN ('queued','generating','delivering','completed','failed','cancelled','restart_not_resumed')),
        outcome_reason TEXT,
        source TEXT NOT NULL CHECK(source IN ('direct','manual','ambient')),
        execution_epoch INTEGER NOT NULL CHECK(execution_epoch>=0),
        execution_revision INTEGER NOT NULL CHECK(execution_revision>=0),
        expires_at INTEGER NOT NULL CHECK(expires_at>=created_at),
        message_row_id INTEGER NOT NULL CHECK(message_row_id>0),
        delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('text','both')),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at INTEGER NOT NULL CHECK(created_at>=0),
        updated_at INTEGER NOT NULL CHECK(updated_at>=0)
      );
      CREATE INDEX room_lifecycle_request_fifo ON room_lifecycle_requests(status,accept_seq);
      CREATE TABLE room_lifecycle_turns (
        turn_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES room_lifecycle_requests(request_id),
        character_id TEXT NOT NULL,
        mention_index INTEGER NOT NULL CHECK(mention_index>=0 AND mention_index<2),
        status TEXT NOT NULL CHECK(status IN ('pending','generating','ready','delivering','completed','failed','unknown','cancelled','blocked','skipped')),
        reason TEXT,
        created_at INTEGER NOT NULL CHECK(created_at>=0),
        updated_at INTEGER NOT NULL CHECK(updated_at>=0),
        UNIQUE(request_id,character_id),
        UNIQUE(request_id,mention_index)
      );
      CREATE INDEX room_lifecycle_turn_order ON room_lifecycle_turns(request_id,mention_index);
      CREATE TABLE room_lifecycle_segments (
        segment_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES room_lifecycle_turns(turn_id),
        segment_index INTEGER NOT NULL CHECK(segment_index>=0 AND segment_index<2),
        semantic_text TEXT NOT NULL CHECK(length(semantic_text)>0),
        voice_text TEXT,
        voice_language TEXT CHECK(voice_language IS NULL OR voice_language IN ('zh','ja')),
        delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('text','both')),
        state TEXT NOT NULL CHECK(state IN ('pending','text_sending','text_sent','audio_sending','audio_sent','completed','failed','unknown','cancelled','blocked','skipped')),
        reason TEXT,
        created_at INTEGER NOT NULL CHECK(created_at>=0),
        updated_at INTEGER NOT NULL CHECK(updated_at>=0),
        UNIQUE(turn_id,segment_index)
      );
      CREATE INDEX room_lifecycle_segment_order ON room_lifecycle_segments(turn_id,segment_index);
      CREATE TABLE room_lifecycle_attempts (
        attempt_id TEXT PRIMARY KEY,
        segment_id TEXT NOT NULL REFERENCES room_lifecycle_segments(segment_id),
        request_id TEXT NOT NULL REFERENCES room_lifecycle_requests(request_id),
        turn_id TEXT NOT NULL REFERENCES room_lifecycle_turns(turn_id),
        account_key TEXT NOT NULL,
        medium TEXT NOT NULL CHECK(medium IN ('text','audio')),
        revision INTEGER NOT NULL CHECK(revision>=0),
        intent_at INTEGER NOT NULL CHECK(intent_at>=0),
        started_at INTEGER CHECK(started_at>=intent_at),
        owner_token TEXT NOT NULL,
        committed_row_id INTEGER,
        UNIQUE(segment_id,medium)
      );
      CREATE TABLE room_lifecycle_receipts (
        attempt_id TEXT NOT NULL REFERENCES room_lifecycle_attempts(attempt_id),
        kind TEXT NOT NULL CHECK(kind IN ('ack','rejected','uncertain')),
        message_id TEXT,
        observed_at INTEGER NOT NULL CHECK(observed_at>=0),
        PRIMARY KEY(attempt_id,kind),
        CHECK((kind='ack' AND length(message_id)>0) OR (kind!='ack' AND message_id IS NULL))
      );
      CREATE TRIGGER room_lifecycle_attempt_identity BEFORE UPDATE ON room_lifecycle_attempts
        WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.segment_id IS NOT OLD.segment_id
          OR NEW.request_id IS NOT OLD.request_id OR NEW.turn_id IS NOT OLD.turn_id
          OR NEW.account_key IS NOT OLD.account_key OR NEW.medium IS NOT OLD.medium
          OR NEW.revision IS NOT OLD.revision OR NEW.intent_at IS NOT OLD.intent_at
          OR NEW.owner_token IS NOT OLD.owner_token OR NEW.started_at IS NULL
          OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
          OR (OLD.committed_row_id IS NOT NULL AND NEW.committed_row_id IS NOT OLD.committed_row_id)
        BEGIN SELECT RAISE(ABORT,'room-lifecycle-attempt-immutable'); END;
      CREATE TRIGGER room_lifecycle_attempt_delete BEFORE DELETE ON room_lifecycle_attempts
        BEGIN SELECT RAISE(ABORT,'room-lifecycle-attempt-immutable'); END;
      CREATE TRIGGER room_lifecycle_receipt_immutable BEFORE UPDATE ON room_lifecycle_receipts
        BEGIN SELECT RAISE(ABORT,'room-lifecycle-receipt-immutable'); END;
      CREATE TRIGGER room_lifecycle_receipt_delete BEFORE DELETE ON room_lifecycle_receipts
        BEGIN SELECT RAISE(ABORT,'room-lifecycle-receipt-immutable'); END;
      CREATE TABLE room_lifecycle_owner (
        id INTEGER PRIMARY KEY CHECK(id=1),
        owner_token TEXT NOT NULL,
        lease_until INTEGER NOT NULL CHECK(lease_until>=0),
        execution_epoch INTEGER NOT NULL CHECK(execution_epoch>=0),
        execution_revision INTEGER NOT NULL CHECK(execution_revision>=0)
      );
      CREATE TABLE room_lifecycle_audio_fence (
        id INTEGER PRIMARY KEY CHECK(id=1),
        attempt_id TEXT NOT NULL UNIQUE REFERENCES room_lifecycle_attempts(attempt_id),
        started_at INTEGER NOT NULL CHECK(started_at>=0)
      );
      CREATE INDEX room_lifecycle_attempt_started ON room_lifecycle_attempts(started_at,attempt_id);
      PRAGMA user_version=9;`);
  }
  private ownReceipt(accountKey: string, messageId: string, attemptId: string): void {
    const old = this.db.prepare("SELECT attempt_id FROM room_receipt_owners WHERE account_key=? AND message_id=?").get(accountKey, messageId);
    if (old) {
      if (old.attempt_id !== attemptId) throw new Error("room-receipt-owner-conflict");
      return;
    }
    if (this.db.prepare("INSERT INTO room_receipt_owners(account_key,message_id,attempt_id) VALUES (?,?,?)")
      .run(accountKey, messageId, attemptId).changes !== 1) throw new Error("room-receipt-owner-conflict");
  }
  deliveryAttempt(id: string): RoomDeliveryAttempt | undefined {
    return this.db.prepare(`SELECT attempt_id AS attemptId,turn_id AS turnId,work_item_id AS workItemId,
      account_key AS accountKey,medium,revision,grant_id AS grantId,intent_at AS intentAt,started_at AS startedAt
      FROM room_delivery_attempts WHERE attempt_id=?`).get(id) as unknown as RoomDeliveryAttempt | undefined;
  }
  deliveryReceipts(id: string): readonly { kind: RoomDeliveryObservation["kind"]; messageId: string | null; observedAt: number }[] {
    return this.db.prepare("SELECT kind,message_id AS messageId,observed_at AS observedAt FROM room_delivery_receipts WHERE attempt_id=? ORDER BY observed_at,rowid")
      .all(id) as unknown as { kind: RoomDeliveryObservation["kind"]; messageId: string | null; observedAt: number }[];
  }
  /** Persist identity before the gateway is allowed to observe or dispatch an attempt. */
  recordDeliveryIntent(binding: WorkerTurnBinding, medium: "text" | "audio", now: number): RoomDeliveryAttempt {
    return this.transaction(() => {
      const item = this.workerWork(binding.workItemId, binding.gate);
      if (!timestamp(now) || !["text", "audio"].includes(medium) || !this.validWorkerBinding(binding, item)) throw new Error("room-delivery-intent-invalid");
      const turn = this.db.prepare("SELECT worker_binding FROM room_deliveries WHERE id=?").get(binding.turnId);
      if (turn?.worker_binding !== JSON.stringify(binding)) throw new Error("room-delivery-intent-invalid");
      const id = randomUUID();
      const inserted = this.db.prepare("INSERT INTO room_delivery_attempts VALUES (?,?,?,?,?,?,?,?,NULL)")
        .run(id, binding.turnId, item.workItemId, this.config.characters.find(c => c.id === binding.characterId)!.accountKey,
          medium, binding.gate.executionRevision, binding.grantId, now);
      if (inserted.changes !== 1 || !this.deliveryAttempt(id)) throw new Error("room-delivery-intent-not-recorded");
      return Object.freeze(this.deliveryAttempt(id)!);
    });
  }
  /** started and the real send-attempt charge are committed together, before any socket send. */
  recordDeliveryStarted(id: string, gate: RoomGatePermit, now: number): void {
    this.transaction(() => {
      const a = this.deliveryAttempt(id);
      if (!a || a.startedAt !== null || !timestamp(now) || now < a.intentAt || a.workItemId !== gate.workItemId
        || a.revision !== gate.executionRevision || this.deliveryHold()) throw new Error("room-delivery-start-invalid");
      this.workerWork(a.workItemId, gate);
      if (!this.canSpend("send", now)) throw new Error("room-delivery-send-budget");
      if (this.db.prepare("UPDATE room_delivery_attempts SET started_at=? WHERE attempt_id=? AND started_at IS NULL").run(now, id).changes !== 1)
        throw new Error("room-delivery-start-conflict");
      if (this.db.prepare("UPDATE room_deliveries SET state=? WHERE id=?").run(a.medium === "text" ? "text_sending" : "audio_sending", a.turnId).changes !== 1)
        throw new Error("room-delivery-start-conflict");
      const charged = this.db.prepare("INSERT INTO room_budget(kind,created_at) VALUES ('send',?)").run(now);
      if (charged.changes !== 1 || !this.db.prepare("SELECT 1 FROM room_budget WHERE id=? AND kind='send' AND created_at=?").get(charged.lastInsertRowid, now))
        throw new Error("room-delivery-start-conflict");
    });
  }
  /** Append an immutable observation. Late ACK adds evidence; it never erases an earlier unknown. */
  recordDeliveryObservation(id: string, observation: RoomDeliveryObservation, now: number,
    fault?: "sent_unrecorded" | "storage_fault"): boolean {
    return this.transaction(() => {
      const a = this.deliveryAttempt(id);
      if (!a || a.startedAt === null || !timestamp(now) || now < a.startedAt
        || !["ack", "rejected", "uncertain"].includes(observation.kind)
        || (observation.kind === "ack" && (typeof observation.messageId !== "string" || qqMessageId(observation.messageId) !== observation.messageId)))
        throw new Error("room-delivery-receipt-invalid");
      const previous = this.deliveryReceipts(id);
      if (fault) this.holdDelivery(fault);
      const same = previous.find(r => r.kind === observation.kind);
      if (same) {
        if (same.messageId !== (observation.kind === "ack" ? observation.messageId : null)) throw new Error("room-delivery-receipt-conflict");
        if (observation.kind === "ack") this.projectPlatformReceipt(a, observation.messageId, same.observedAt);
        return false;
      }
      if ((observation.kind === "ack" && previous.some(r => r.kind === "rejected"))
        || (observation.kind === "rejected" && previous.some(r => r.kind === "ack"))) throw new Error("room-delivery-receipt-conflict");
      if (observation.kind === "ack") this.ownReceipt(a.accountKey, observation.messageId, id);
      if (this.db.prepare("INSERT INTO room_delivery_receipts VALUES (?,?,?,?)")
        .run(id, observation.kind, observation.kind === "ack" ? observation.messageId : null, now).changes !== 1)
        throw new Error("room-delivery-receipt-not-recorded");
      if (observation.kind === "ack") this.projectPlatformReceipt(a, observation.messageId, now);
      if (observation.kind === "uncertain") this.db.prepare("INSERT OR IGNORE INTO room_meta VALUES ('delivery_hold','delivery_unknown')").run();
      return true;
    });
  }
  deliveryHold(): string | null {
    const persisted = this.db.prepare("SELECT value FROM room_meta WHERE key='delivery_hold'").get()?.value;
    if (persisted) return String(persisted);
    return this.db.prepare(`SELECT 1 FROM room_delivery_attempts a WHERE started_at IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM room_delivery_receipts r WHERE r.attempt_id=a.attempt_id AND r.kind IN ('ack','rejected')) LIMIT 1`).get() ? "delivery_unknown" : null;
  }
  holdDelivery(reason: "sent_unrecorded" | "storage_fault"): void {
    this.db.prepare("INSERT OR REPLACE INTO room_meta VALUES ('delivery_hold',?)").run(reason);
  }
  beginDeliveryExecution(): void { this.nonBlockingDeliveryWrites = true; this.db.exec("PRAGMA busy_timeout=0"); }
  beginDeliveryClose(): void { this.beginDeliveryExecution(); }
  deliveryWrite<T>(write: () => T): T {
    this.db.exec("PRAGMA busy_timeout=0");
    try { return write(); } finally { if (!this.nonBlockingDeliveryWrites) this.db.exec("PRAGMA busy_timeout=5000"); }
  }
  hasUnresolvedDelivery(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM room_delivery_attempts a WHERE started_at IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM room_delivery_receipts r WHERE r.attempt_id=a.attempt_id AND r.kind IN ('ack','rejected')) LIMIT 1`).get());
  }
  /** No replay or new attempts: derive uncertainty from durable started, and repair only proven ACK projections. */
  recoverDeliveryFacts(): void {
    const work = () => {
      this.checkDeliveryLedger();
      for (const row of this.db.prepare("SELECT attempt_id FROM room_delivery_attempts WHERE started_at IS NOT NULL").all()) {
        const a = this.deliveryAttempt(String(row.attempt_id))!;
        const receipts = this.deliveryReceipts(a.attemptId), ack = receipts.find(r => r.kind === "ack");
        if (ack) this.projectPlatformReceipt(a, ack.messageId!, ack.observedAt);
        else if (!receipts.some(r => r.kind === "rejected")) {
          this.db.prepare("INSERT OR IGNORE INTO room_delivery_receipts VALUES (?,'uncertain',NULL,?)").run(a.attemptId, a.startedAt!);
          if (!this.deliveryReceipts(a.attemptId).some(r => r.kind === "uncertain")) throw new Error("room-delivery-receipt-not-recorded");
          this.db.prepare("INSERT OR IGNORE INTO room_meta VALUES ('delivery_hold','delivery_unknown')").run();
        }
      }
    };
    if (this.db.isTransaction) work(); else this.transaction(work);
  }
  private checkDeliveryLedger(): void {
    for (const row of this.db.prepare("SELECT attempt_id FROM room_delivery_attempts").all()) {
      const a = this.deliveryAttempt(String(row.attempt_id))!;
      const d = this.db.prepare("SELECT * FROM room_deliveries WHERE id=?").get(a.turnId), item = this.workItem(a.workItemId);
      const b = d?.worker_binding ? JSON.parse(String(d.worker_binding)) as WorkerTurnBinding : undefined;
      if (!b || !item?.payload || !this.validWorkerBinding(b, item) || a.turnId !== b.turnId
        || a.grantId !== b.grantId || a.revision !== b.gate.executionRevision || a.accountKey !== d!.account_key
        || !["text", "audio"].includes(a.medium) || !timestamp(a.intentAt)
        || (a.startedAt !== null && (!timestamp(a.startedAt) || a.startedAt < a.intentAt))) throw new Error("room-delivery-ledger-invalid");
      const receipts = this.deliveryReceipts(a.attemptId);
      if (receipts.length && a.startedAt === null) throw new Error("room-delivery-ledger-invalid");
      if (receipts.some(r => !timestamp(r.observedAt) || r.observedAt < a.startedAt!
        || (r.kind === "ack" ? typeof r.messageId !== "string" || qqMessageId(r.messageId) !== r.messageId : r.messageId !== null))
        || (receipts.some(r => r.kind === "ack") && receipts.some(r => r.kind === "rejected"))) throw new Error("room-delivery-ledger-invalid");
      for (const r of receipts) if (r.kind === "ack"
        && this.db.prepare("SELECT attempt_id FROM room_receipt_owners WHERE account_key=? AND message_id=?")
          .get(a.accountKey, r.messageId!)?.attempt_id !== a.attemptId) throw new Error("room-delivery-ledger-invalid");
    }
    if (this.db.prepare("SELECT 1 FROM room_delivery_receipts r LEFT JOIN room_delivery_attempts a ON r.attempt_id=a.attempt_id WHERE a.attempt_id IS NULL LIMIT 1").get())
      throw new Error("room-delivery-ledger-invalid");
  }
  private projectPlatformReceipt(a: RoomDeliveryAttempt, messageId: string, observedAt: number): void {
    const d = this.db.prepare("SELECT * FROM room_deliveries WHERE id=?").get(a.turnId);
    const item = this.workItem(a.workItemId);
    if (!d || !item?.payload || !d.worker_binding) throw new Error("room-delivery-binding-invalid");
    const binding = JSON.parse(String(d.worker_binding)) as WorkerTurnBinding;
    const c = this.config.characters.find(c => c.id === binding.characterId)!;
    if (!this.validWorkerBinding(binding, item) || d.account_key !== a.accountKey || c.accountKey !== a.accountKey
      || binding.turnId !== a.turnId || binding.grantId !== a.grantId || binding.gate.executionRevision !== a.revision)
      throw new Error("room-delivery-binding-invalid");
    const column = a.medium === "text" ? "text_id" : "audio_id";
    if (d[column] !== null) {
      if (d[column] !== messageId) throw new Error("room-delivery-receipt-conflict");
      if (d.worker_projection) { this.checkWorkerProjection(binding, item); return; }
    }
    const needsHistory = a.medium === "text" || d.delivery_mode === "voice";
    if (needsHistory && (typeof d.semantic_text !== "string" || !d.semantic_text.trim())) {
      this.db.prepare("INSERT OR REPLACE INTO room_meta VALUES ('delivery_hold','delivery_history_gap')").run();
      return; // Preserve the real receipt, never fabricate a body after retention.
    }
    let rowId: number | undefined;
    if (needsHistory) {
      const rows = this.db.prepare("SELECT * FROM room_messages WHERE account_key=? AND platform_id=? AND speaker_type='bot'")
        .all(c.accountKey, messageId);
      const row = rows[0];
      if (rows.length > 1 || (row && (row.speaker_id !== c.id || row.target_id !== item.payload.messageRowId
        || row.text !== d.semantic_text || row.medium !== (a.medium === "audio" ? "voice" : "text")))) throw new Error("room-worker-projection-invalid");
      rowId = row ? Number(row.id) : this.append("bot", c.id, c.accountKey, item.payload.messageRowId,
        String(d.semantic_text), messageId, observedAt, a.medium === "audio" ? "voice" : "text");
    }
    const terminal = WORK_TERMINAL.has(item.status);
    const state = terminal ? (item.status === "cancelled" ? "stopped" : "interrupted") : a.medium === "text" ? "text_sent" : "delivered";
    if (this.db.prepare(`UPDATE room_deliveries SET ${column}=?,state=? WHERE id=?`).run(messageId, state, a.turnId).changes !== 1
      || this.db.prepare(`SELECT ${column} AS id,state FROM room_deliveries WHERE id=?`).get(a.turnId)?.id !== messageId)
      throw new Error("room-delivery-projection-conflict");
    if (rowId !== undefined) {
      const proof = { version: 2, medium: a.medium === "audio" ? "voice" : "text", state: "retained", rowId,
        receiptId: messageId, committedAt: observedAt, textSHA256: createHash("sha256").update(String(d.semantic_text)).digest("hex") };
      const json = JSON.stringify(proof);
      if (this.db.prepare("UPDATE room_deliveries SET worker_text_row_id=?,worker_projection=? WHERE id=?").run(rowId, json, a.turnId).changes !== 1
        || this.db.prepare("SELECT worker_projection FROM room_deliveries WHERE id=?").get(a.turnId)?.worker_projection !== json)
        throw new Error("room-delivery-projection-conflict");
    }
    this.checkWorkerBindings();
  }
  finishPlatformTurn(binding: WorkerTurnBinding, state: "text_only" | "delivered",
    reason = "platform_delivery_committed"): number {
    return this.transaction(() => {
      const item = this.workerWork(binding.workItemId, binding.gate);
      const d = this.db.prepare("SELECT * FROM room_deliveries WHERE id=?").get(binding.turnId);
      if (!d || !d.worker_projection || (state === "delivered" && !d.audio_id)
        || (state === "text_only" && !d.text_id) || !code(reason) || this.deliveryHold()) throw new Error("room-delivery-terminal-invalid");
      this.checkWorkerProjection(binding, item);
      if (state === "text_only" && this.db.prepare("SELECT 1 FROM room_delivery_attempts WHERE turn_id=? AND medium='audio' AND started_at IS NOT NULL").get(binding.turnId))
        throw new Error("room-delivery-terminal-invalid");
      const obligations = this.workerObligations(item.burstId!);
      const updated = obligations.map((o, i) => i === binding.turnIndex ? { ...o, status: "fulfilled", reason } : o);
      if (this.db.prepare("UPDATE room_deliveries SET state=? WHERE id=?").run(state, binding.turnId).changes !== 1
        || this.db.prepare("UPDATE room_bursts SET worker_obligations=? WHERE id=?").run(JSON.stringify(updated), item.burstId!).changes !== 1
        || JSON.stringify(this.workerObligations(item.burstId!)) !== JSON.stringify(updated)) throw new Error("room-delivery-terminal-conflict");
      this.checkWorkerBindings(); return Number(d.worker_text_row_id);
    });
  }
  /** Actual row relationship, also used BEFORE giving an old schema6 fact new metadata. */
  private realWorkerProjection(binding: WorkerTurnBinding, item: RoomWorkItem) {
    const d = this.db.prepare("SELECT * FROM room_deliveries WHERE id=?").get(binding.turnId);
    const m = d ? this.db.prepare("SELECT * FROM room_messages WHERE id=?").get(d.worker_text_row_id!) : undefined;
    const c = this.config.characters.find(c => c.id === binding.characterId);
    if (!d || !m || !c || d.worker_binding !== JSON.stringify(binding) || d.burst_id !== item.burstId
      || d.character_id !== c.id || d.account_key !== c.accountKey || d.voice_key !== c.voiceKey
      || d.state !== "text_only" || d.delivery_mode !== "text" || !/^synthetic-[a-zA-Z0-9_-]{1,100}$/.test(String(d.text_id))
      || m.speaker_type !== "bot" || m.speaker_id !== c.id || m.account_key !== c.accountKey
      || m.target_id !== item.payload!.messageRowId || m.medium !== "text" || m.platform_id !== d.text_id
      || typeof m.text !== "string" || !m.text.trim() || m.text.includes("\0") || [...m.text].length > binding.plan.budget.maxTextChars
      || !timestamp(Number(m.created_at)) || Number(m.created_at) < Number(d.created_at)
      || (d.semantic_text !== null && d.semantic_text !== m.text)) throw new Error("room-worker-projection-invalid");
    return m;
  }
  private checkWorkerProjection(binding: WorkerTurnBinding, item: RoomWorkItem, active = false): void {
    const d = this.db.prepare("SELECT * FROM room_deliveries WHERE id=?").get(binding.turnId)!;
    if (typeof d.worker_projection !== "string") throw new Error("room-worker-projection-invalid");
    const fact = JSON.parse(d.worker_projection);
    if (fact?.version === 2) { this.checkPlatformProjection(binding, item, d, fact, active); return; }
    if (!fact || fact.version !== 1 || !["retained", "pruned"].includes(fact.state)
      || fact.rowId !== d.worker_text_row_id || fact.receiptId !== d.text_id
      || !timestamp(fact.committedAt) || fact.committedAt < Number(d.created_at)
      || !/^[0-9a-f]{64}$/.test(fact.textSHA256) || !Number.isSafeInteger(d.worker_text_row_id)
      || Number(d.worker_text_row_id) <= 0 || d.state !== "text_only" || d.delivery_mode !== "text"
      || !/^synthetic-[a-zA-Z0-9_-]{1,100}$/.test(String(d.text_id))
      || (d.semantic_text !== null && createHash("sha256").update(String(d.semantic_text)).digest("hex") !== fact.textSHA256))
      throw new Error("room-worker-projection-invalid");
    if (fact.state === "retained") {
      if (Object.keys(fact).sort().join() !== "committedAt,receiptId,rowId,state,textSHA256,version") throw new Error("room-worker-projection-invalid");
      const m = this.realWorkerProjection(binding, item);
      if (m.created_at !== fact.committedAt || createHash("sha256").update(String(m.text)).digest("hex") !== fact.textSHA256)
        throw new Error("room-worker-projection-invalid");
    } else if (active || Object.keys(fact).sort().join() !== "committedAt,prunedAt,reason,receiptId,rowId,state,textSHA256,version"
      || !timestamp(fact.prunedAt) || fact.prunedAt < fact.committedAt || !["age", "count"].includes(fact.reason)
      || this.db.prepare("SELECT 1 FROM room_messages WHERE id=?").get(d.worker_text_row_id!))
      throw new Error("room-worker-projection-invalid");
  }
  private checkPlatformProjection(binding: WorkerTurnBinding, item: RoomWorkItem,
    d: Record<string, unknown>, fact: Record<string, unknown>, active: boolean): void {
    const medium = fact.medium === "text" ? "text" : fact.medium === "voice" ? "voice" : null;
    const receipt = medium === "text" ? d.text_id : d.audio_id;
    const ack = this.db.prepare(`SELECT a.*,r.message_id FROM room_delivery_attempts a JOIN room_delivery_receipts r
      ON r.attempt_id=a.attempt_id AND r.kind='ack' WHERE a.turn_id=? AND a.medium=?`).get(binding.turnId, medium === "voice" ? "audio" : "text");
    const c = this.config.characters.find(c => c.id === binding.characterId)!;
    if (!medium || !ack || ack.started_at === null || ack.account_key !== c.accountKey || ack.work_item_id !== item.workItemId
      || ack.message_id !== receipt || fact.receiptId !== receipt || fact.rowId !== d.worker_text_row_id
      || !Number.isSafeInteger(fact.rowId) || Number(fact.rowId) < 1 || !timestamp(Number(fact.committedAt))
      || Number(fact.committedAt) < Number(d.created_at) || !/^[0-9a-f]{64}$/.test(String(fact.textSHA256))
      || (active && (medium !== "text" || !["text_only", "delivered"].includes(String(d.state))))) throw new Error("room-worker-projection-invalid");
    const owner = this.db.prepare("SELECT attempt_id FROM room_receipt_owners WHERE account_key=? AND message_id=?").get(c.accountKey, String(receipt));
    if (owner?.attempt_id !== ack.attempt_id) throw new Error("room-worker-projection-invalid");
    const row = this.db.prepare("SELECT * FROM room_messages WHERE id=?").get(Number(fact.rowId));
    if (fact.state === "retained") {
      if (Object.keys(fact).sort().join() !== "committedAt,medium,receiptId,rowId,state,textSHA256,version"
        || !row || row.speaker_type !== "bot" || row.speaker_id !== c.id || row.account_key !== c.accountKey
        || row.medium !== medium || row.platform_id !== receipt || row.target_id !== item.payload!.messageRowId
        || typeof row.text !== "string" || !row.text.trim() || [...row.text].length > binding.plan.budget.maxTextChars
        || createHash("sha256").update(row.text).digest("hex") !== fact.textSHA256
        || (d.semantic_text !== null && row.text !== d.semantic_text)) throw new Error("room-worker-projection-invalid");
    } else if (fact.state !== "pruned" || active || row
      || Object.keys(fact).sort().join() !== "committedAt,medium,prunedAt,reason,receiptId,rowId,state,textSHA256,version"
      || !timestamp(Number(fact.prunedAt)) || Number(fact.prunedAt) < Number(fact.committedAt)
      || !["age", "count"].includes(String(fact.reason))) throw new Error("room-worker-projection-invalid");
  }

  /** Target binding derives from immutable accepted payload, never the latest history row. */
  workerTargetHash(item: RoomWorkItem): string {
    if (!item.payload) throw new Error("room-worker-binding-invalid");
    return createHash("sha256").update(JSON.stringify({ messageRowId: item.payload.messageRowId,
      messageId: item.payload.input.messageId, senderKey: item.payload.input.senderKey,
      text: item.payload.input.text, characterIds: item.payload.characterIds })).digest("hex");
  }
  private workerWork(id: string, gate?: RoomGatePermit): RoomWorkItem {
    const item = this.workItem(id);
    if (!item || item.status !== "claimed" || !item.burstId || !item.payload) throw new Error("room-worker-binding-invalid");
    if (gate) {
      const state = this.controlState();
      if (state.paused || state.epoch !== gate.executionEpoch || state.executionRevision !== gate.executionRevision
        || gate.roomId !== this.config.roomId || gate.workItemId !== item.workItemId || gate.burstId !== item.burstId
        || gate.eventKey !== item.eventKey || gate.executionEpoch !== item.executionEpoch || gate.slot !== `work:${item.workItemId}`) {
        throw new Error("room-worker-grant-stale");
      }
    }
    return item;
  }
  workerObligations(burstId: string): readonly WorkerObligation[] {
    const raw = this.db.prepare("SELECT worker_obligations FROM room_bursts WHERE id=?").get(burstId)?.worker_obligations;
    if (raw === null || raw === undefined) return Object.freeze([]);
    const value: unknown = JSON.parse(String(raw));
    const legacyKeys = "characterId,reason,status,turnId";
    const diagnosticKeys = "characterId,diagnostic,reason,status,turnId";
    if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(o => {
      if (!o || typeof o !== "object") return true;
      const keys = Object.keys(o).sort().join(",");
      const hasDiagnostic = keys === diagnosticKeys;
      return (keys !== legacyKeys && !hasDiagnostic)
        || !this.config.characters.some(c => c.id === o.characterId)
        || !["pending","fulfilled","failed","blocked","cancelled","unavailable"].includes(o.status)
        || (o.reason !== null && !code(o.reason)) || (o.turnId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(o.turnId))
        || (hasDiagnostic && (o.status !== "failed" || o.reason !== "worker_context_invalid"
          || !sanitizeWorkerContextBudgetDiagnostic(o.diagnostic)));
    })
      || new Set(value.map(o => o.characterId)).size !== value.length) throw new Error("room-worker-binding-invalid");
    return Object.freeze(value.map(o => {
      const diagnostic = Object.hasOwn(o, "diagnostic")
        ? sanitizeWorkerContextBudgetDiagnostic(o.diagnostic) : undefined;
      return Object.freeze({ characterId: o.characterId, status: o.status, reason: o.reason, turnId: o.turnId,
        ...(diagnostic ? { diagnostic } : {}) });
    }));
  }
  beginWorkerBurst(workItemId: string, gate: RoomGatePermit): readonly WorkerObligation[] {
    return this.transaction(() => {
      const item = this.workerWork(workItemId, gate);
      const ids = item.payload!.characterIds;
      if (!ids.length || ids.length > 2 || this.workerObligations(item.burstId!).length) throw new Error("room-worker-binding-invalid");
      const obligations = ids.map(characterId => ({ characterId, status: "pending", reason: null, turnId: null }));
      if (this.db.prepare("UPDATE room_bursts SET worker_obligations=? WHERE id=? AND state='running' AND worker_obligations IS NULL")
        .run(JSON.stringify(obligations), item.burstId).changes !== 1) throw new Error("room-worker-binding-conflict");
      return this.workerObligations(item.burstId!);
    });
  }
  private validWorkerBinding(binding: WorkerTurnBinding, item: RoomWorkItem): boolean {
    const b = binding;
    const character = this.config.characters.find(c => c.id === b?.characterId);
    const identifier = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
    return Boolean(b && typeof b === "object" && Object.keys(b).sort().join(",") === "burstId,characterId,contextRevision,decision,eventKey,gate,grantId,plan,slotConsumed,slotReturned,targetHash,targetId,turnId,turnIndex,workItemId"
      && character && b.workItemId === item.workItemId && b.burstId === item.burstId && b.eventKey === item.eventKey
      && b.targetId === item.payload?.messageRowId && b.targetHash === this.workerTargetHash(item)
      && (b.turnIndex === 0 || b.turnIndex === 1) && item.payload.characterIds[b.turnIndex] === b.characterId
      && identifier(b.turnId) && identifier(b.grantId) && /^[a-f0-9]{64}$/.test(b.contextRevision)
      && validResponsePlan(b.plan) && b.decision && Object.keys(b.decision).sort().join(",") === "characterId,decisionId,decisionRevision,kind"
      && identifier(b.decision.decisionId) && b.decision.decisionRevision === 1 && b.decision.characterId === b.characterId
      && b.decision.kind === (b.turnIndex === 0 ? "primary" : "supplement") && b.slotConsumed === true && b.slotReturned === false
      && b.gate && b.gate.roomId === this.config.roomId && b.gate.burstId === item.burstId && b.gate.workItemId === item.workItemId
      && b.gate.eventKey === item.eventKey && b.gate.executionEpoch === item.executionEpoch
      && timestamp(b.gate.executionRevision) && b.gate.policyRevision === 1 && timestamp(b.gate.issuedAt)
      && identifier(b.gate.gateId) && b.gate.slot === `work:${item.workItemId}`);
  }
  workerTurns(burstId: string): readonly { binding: WorkerTurnBinding; state: string; textRowId: number | null }[] {
    return this.db.prepare("SELECT id,worker_binding,state,worker_text_row_id FROM room_deliveries WHERE burst_id=? AND worker_binding IS NOT NULL ORDER BY rowid").all(burstId)
      .map(r => {
        const binding = JSON.parse(String(r.worker_binding)) as WorkerTurnBinding;
        if (!binding || binding.turnId !== r.id) throw new Error("room-worker-binding-invalid");
        return Object.freeze({ binding, state: String(r.state), textRowId: r.worker_text_row_id === null ? null : Number(r.worker_text_row_id) });
      });
  }
  /** One new Turn/Plan/Decision/grant only; a previous committed text fact is mandatory for T2. */
  authorizeWorkerTurn(binding: WorkerTurnBinding, now: number): boolean {
    return this.transaction(() => {
      const item = this.workerWork(binding.workItemId, binding.gate);
      if (!timestamp(now) || !this.validWorkerBinding(binding, item)) throw new Error("room-worker-binding-invalid");
      const obligations = this.workerObligations(item.burstId!);
      const turns = this.workerTurns(item.burstId!);
      const current = obligations[binding.turnIndex];
      if (!current || current.status !== "pending" || current.turnId !== null || turns.length !== binding.turnIndex) throw new Error("room-worker-binding-conflict");
      if (binding.turnIndex === 1) {
        const prior = turns[0];
        if (prior) this.checkWorkerProjection(prior.binding, item, true);
        if (obligations[0]?.status !== "fulfilled" || !prior || !["text_only", "delivered"].includes(prior.state) || !prior.textRowId
          || prior.binding.contextRevision === binding.contextRevision || prior.binding.plan.planId === binding.plan.planId
          || prior.binding.decision.decisionId === binding.decision.decisionId || prior.binding.grantId === binding.grantId
          || prior.binding.gate.gateId !== binding.gate.gateId) throw new Error("room-worker-primary-text-required");
      }
      if (!this.canSpend("model", now)) return false;
      const c = this.config.characters.find(c => c.id === binding.characterId)!;
      if (this.db.prepare("INSERT INTO room_deliveries(id,burst_id,character_id,account_key,voice_key,state,created_at,worker_binding) VALUES (?,?,?,?,?,'generating',?,?)")
        .run(binding.turnId, item.burstId, c.id, c.accountKey, c.voiceKey, now, JSON.stringify(binding)).changes !== 1) throw new Error("room-worker-binding-conflict");
      const updated = obligations.map((o, i) => i === binding.turnIndex ? { ...o, turnId: binding.turnId } : o);
      if (this.db.prepare("UPDATE room_bursts SET worker_obligations=? WHERE id=? AND state='running'")
        .run(JSON.stringify(updated), item.burstId).changes !== 1) throw new Error("room-worker-binding-conflict");
      if (this.db.prepare("INSERT INTO room_budget(kind,created_at) VALUES ('model',?)").run(now).changes !== 1) throw new Error("room-worker-binding-conflict");
      return true;
    });
  }
  /** Synthetic confirmed-text fact, public projection and Turn terminal state commit atomically. */
  commitWorkerText(binding: WorkerTurnBinding, text: string, receiptId: string, now: number,
    reason = "synthetic_text_committed"): number {
    return this.transaction(() => {
      const item = this.workerWork(binding.workItemId, binding.gate);
      if (!this.validWorkerBinding(binding, item) || typeof text !== "string" || !text.trim() || text.includes("\0")
        || [...text].length > binding.plan.budget.maxTextChars || !/^synthetic-[a-zA-Z0-9_-]{1,100}$/.test(receiptId)
        || !timestamp(now) || !code(reason)) throw new Error("room-worker-text-invalid");
      const stored = this.db.prepare("SELECT worker_binding,state FROM room_deliveries WHERE id=?").get(binding.turnId);
      if (!stored || stored.worker_binding !== JSON.stringify(binding) || stored.state !== "generating") throw new Error("room-worker-binding-conflict");
      const c = this.config.characters.find(c => c.id === binding.characterId)!;
      this.ownReceipt(c.accountKey, receiptId, `synthetic:${binding.turnId}:text`);
      const rowId = this.append("bot", c.id, c.accountKey, item.payload!.messageRowId, text, receiptId, now);
      const fact = JSON.stringify({ version: 1, state: "retained", rowId, receiptId, committedAt: now,
        textSHA256: createHash("sha256").update(text).digest("hex") });
      if (this.db.prepare("UPDATE room_deliveries SET state='text_only',text_id=?,semantic_text=?,delivery_mode='text',worker_text_row_id=?,worker_projection=? WHERE id=? AND state='generating'")
        .run(receiptId, text, rowId, fact, binding.turnId).changes !== 1) throw new Error("room-worker-text-conflict");
      const obligations = this.workerObligations(item.burstId!);
      if (obligations[binding.turnIndex]?.turnId !== binding.turnId || obligations[binding.turnIndex]?.status !== "pending") throw new Error("room-worker-binding-conflict");
      const updated = obligations.map((o, i) => i === binding.turnIndex ? { ...o, status: "fulfilled", reason } : o);
      if (this.db.prepare("UPDATE room_bursts SET worker_obligations=? WHERE id=? AND state='running'").run(JSON.stringify(updated), item.burstId).changes !== 1) throw new Error("room-worker-binding-conflict");
      this.checkWorkerProjection(binding, item, true);
      if (JSON.stringify(this.workerObligations(item.burstId!)) !== JSON.stringify(updated)) throw new Error("room-worker-binding-conflict");
      return rowId;
    });
  }
  failWorkerObligation(workItemId: string, index: number, reason: string,
    state: "failed" | "cancelled" | "unavailable" = "failed", contextBudgetDiagnostic?: unknown): void {
    this.transaction(() => {
      const item = this.workerWork(workItemId);
      const obligations = this.workerObligations(item.burstId!);
      if (!code(reason) || !["failed","cancelled","unavailable"].includes(state) || !obligations[index]) throw new Error("room-worker-binding-invalid");
      const diagnostic = reason === "worker_context_invalid" && state === "failed"
        ? sanitizeWorkerContextBudgetDiagnostic(contextBudgetDiagnostic) : undefined;
      const updated = obligations.map((o, i) => o.status !== "pending" ? o : i === index
        ? { ...o, status: state, reason, ...(diagnostic ? { diagnostic } : {}) }
        : { ...o, status: state === "cancelled" ? "cancelled" : "blocked", reason: state === "cancelled" ? reason : "primary_text_not_acked" });
      for (const o of updated) if (o.turnId && o.status !== "fulfilled") this.db.prepare(`UPDATE room_deliveries SET state=? WHERE id=? AND state IN (${ACTIVE})`)
        .run(state === "cancelled" ? "stopped" : reason === "explicit_no_answer" ? "skipped" : "generation_failed", o.turnId);
      if (this.db.prepare("UPDATE room_bursts SET worker_obligations=? WHERE id=? AND state='running'").run(JSON.stringify(updated), item.burstId).changes !== 1) throw new Error("room-worker-binding-conflict");
    });
  }
  private checkWorkerBindings(): void {
    const bursts = this.db.prepare("SELECT id FROM room_bursts WHERE worker_obligations IS NOT NULL").all();
    for (const burst of bursts) {
      const row = this.db.prepare("SELECT work_item_id FROM room_work_items WHERE burst_id=?").get(burst.id!);
      const item = row ? this.workItem(String(row.work_item_id)) : null;
      const obligations = this.workerObligations(String(burst.id));
      if (!item?.payload || JSON.stringify(obligations.map(o => o.characterId)) !== JSON.stringify(item.payload.characterIds)) throw new Error("room-worker-binding-invalid");
      const turns = this.workerTurns(String(burst.id));
      const unique = new Set<string>();
      for (const turn of turns) {
        const binding = turn.binding;
        if (!this.validWorkerBinding(binding, item) || obligations[binding.turnIndex]?.turnId !== binding.turnId) throw new Error("room-worker-binding-invalid");
        for (const id of [binding.turnId, binding.grantId, binding.plan.planId, binding.decision.decisionId]) {
          if (unique.has(id)) throw new Error("room-worker-binding-invalid"); unique.add(id);
        }
        const stored = this.db.prepare("SELECT id,character_id,account_key,voice_key,text_id,worker_projection FROM room_deliveries WHERE id=?").get(binding.turnId);
        const c = this.config.characters.find(c => c.id === binding.characterId)!;
        const platform = this.db.prepare("SELECT 1 FROM room_delivery_attempts WHERE turn_id=? LIMIT 1").get(binding.turnId);
        if (platform) {
          if (!stored || stored.character_id !== c.id || stored.account_key !== c.accountKey || stored.voice_key !== c.voiceKey)
            throw new Error("room-worker-binding-invalid");
          if (stored.worker_projection !== null) this.checkWorkerProjection(binding, item);
          if (obligations[binding.turnIndex]?.status === "fulfilled" && (!stored.worker_projection || !["text_only", "delivered"].includes(turn.state)))
            throw new Error("room-worker-binding-invalid");
          continue;
        }
        if (!stored || stored.character_id !== c.id || stored.account_key !== c.accountKey || stored.voice_key !== c.voiceKey
          || (obligations[binding.turnIndex]?.status === "fulfilled" && (turn.state !== "text_only" || !turn.textRowId || !stored.text_id))) throw new Error("room-worker-binding-invalid");
        if (obligations[binding.turnIndex]?.status === "fulfilled") this.checkWorkerProjection(binding, item);
        else if (turn.state === "text_only" || turn.textRowId !== null || stored.text_id !== null || stored.worker_projection !== null)
          throw new Error("room-worker-projection-invalid");
      }
      if (obligations.some(o => o.turnId !== null && !turns.some(t => t.binding.turnId === o.turnId))) throw new Error("room-worker-binding-invalid");
      if (turns.length > 1 && obligations[0]?.status !== "fulfilled") throw new Error("room-worker-primary-text-required");
      if (WORK_TERMINAL.has(item.status) && obligations.some(o => o.status === "pending")) throw new Error("room-worker-binding-invalid");
      if (item.status === "completed" && obligations.some(o => o.status !== "fulfilled")) throw new Error("room-worker-binding-invalid");
    }
    if (this.db.prepare("SELECT 1 FROM room_deliveries d LEFT JOIN room_bursts b ON d.burst_id=b.id WHERE d.worker_binding IS NOT NULL AND b.worker_obligations IS NULL").get()) throw new Error("room-worker-binding-invalid");
  }
  /** Called inside Work settlement/Recovery, never as a separate scheduler or transaction. */
  private closeWorkerObligations(burstId: string, status: string, reason: string): void {
    const obligations = this.workerObligations(burstId);
    if (!obligations.length) return;
    const pending = obligations.filter(o => o.status === "pending");
    if (status === "completed" && pending.length) throw new Error("room-worker-obligation-incomplete");
    const cancelled = status === "cancelled" || status === "restart_not_resumed";
    const updated = obligations.map(o => o.status !== "pending" ? o : { ...o, status: cancelled ? "cancelled" : "blocked", reason });
    for (const o of pending) if (o.turnId) this.db.prepare(`UPDATE room_deliveries SET state=? WHERE id=? AND state IN (${ACTIVE},'interrupted')`)
      .run(status === "restart_not_resumed" ? "interrupted" : cancelled ? "stopped" : "generation_failed", o.turnId);
    if (this.db.prepare("UPDATE room_bursts SET worker_obligations=? WHERE id=? AND state='running'").run(JSON.stringify(updated), burstId).changes !== 1) throw new Error("room-worker-binding-conflict");
  }

  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) throw new Error("room-transaction-nested");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("room-transaction-async");
      this.db.exec("COMMIT"); return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof Error && ["room-work-burst-stale", "room-work-burst-binding-invalid"].includes(error.message)) {
        throw storeFailure(error.message, bindingDiagnostic, error);
      }
      throw error;
    }
  }
  /** Stable key is byte-compatible with the MVP room_seen key. */
  eventKey(input: Pick<RoomInput, "accountKey" | "selfId" | "groupId" | "messageId">): string {
    return createHash("sha256").update(JSON.stringify([input.accountKey, input.selfId, input.groupId, input.messageId])).digest("hex");
  }
  private normalizedMessage(input: Omit<RoomInput, "senderId">): Omit<RoomInput, "senderId" | "unsupported"> {
    const numeric = (s: unknown): s is string => typeof s === "string" && /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s));
    const account = input && this.config.characters.find(c => c.accountKey === input.accountKey);
    if (!account || input.selfId !== account.selfId || input.groupId !== this.config.groupId
      || !roomInputId(input.messageId) || input.unsupported
      || typeof input.text !== "string" || !input.text.trim() || input.text.length > 8000 || input.text.includes("\0")
      || (input.replyToMessageId !== undefined && !roomInputId(input.replyToMessageId))
      || (input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.some(id => !numeric(id))))) {
      throw new Error("room-work-input-invalid");
    }
    return { accountKey: input.accountKey, selfId: input.selfId, groupId: input.groupId,
      messageId: input.messageId, text: input.text, mentions: [...(input.mentions ?? [])],
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }) };
  }
  private normalizedInput(input: RoomInput): RoomInput {
    if (!input || typeof input.senderId !== "string" || !/^[1-9]\d{0,15}$/.test(input.senderId)
      || !Number.isSafeInteger(Number(input.senderId)) || this.config.characters.some(c => c.selfId === input.senderId)) {
      throw new Error("room-work-input-invalid");
    }
    return { ...this.normalizedMessage(input), senderId: input.senderId };
  }
  private assertEpoch(epoch: number): void {
    if (!timestamp(epoch) || this.state().epoch !== epoch) throw new Error("room-work-stale-epoch");
  }
  private decodePayload(row: WorkRow, legacy = false): RoomWorkPayload | null {
    try {
      const data: unknown = JSON.parse(row.payload_json);
      if (data === null) {
        if (row.accept_seq !== null || !["recorded_only","rejected"].includes(row.status)) throw new Error();
        return null;
      }
      if (["recorded_only","rejected"].includes(row.status)) throw new Error();
      if (!data || typeof data !== "object" || Array.isArray(data)
        || Object.keys(data).sort().join(",") !== "characterIds,input,messageRowId") throw new Error();
      const p = data as RoomWorkPayload;
      if (!p.input || typeof p.input !== "object" || Array.isArray(p.input)) throw new Error();
      const raw = p.input as unknown as RoomInput & { senderKey?: string };
      const permitted = ["accountKey","selfId","groupId","messageId","text","mentions","replyToMessageId",legacy ? "senderId" : "senderKey"];
      if (Object.keys(raw).some(k => !permitted.includes(k))) throw new Error();
      const input = this.normalizedMessage(raw);
      const key = this.db.prepare("SELECT value FROM room_meta WHERE key='actor_key'").get()?.value;
      const senderKey = legacy
        ? "member-" + createHmac("sha256", String(key)).update(this.normalizedInput(raw).senderId).digest("hex").slice(0,16)
        : raw.senderKey;
      const ids = [...new Set(input.mentions!.flatMap(id => {
        const c = this.config.characters.find(c => c.selfId === id); return c ? [c.id] : [];
      }))];
      if (typeof senderKey !== "string" || !/^member-[0-9a-f]{16}$/.test(senderKey)
        || senderKey !== row.member_key || !Number.isSafeInteger(p.messageRowId) || p.messageRowId <= 0
        || !Array.isArray(p.characterIds) || JSON.stringify(p.characterIds) !== JSON.stringify(ids)
        || this.eventKey(input) !== row.event_key) throw new Error();
      return Object.freeze({ input: Object.freeze({ ...input, senderKey, mentions: Object.freeze([...input.mentions!]) }),
        characterIds: Object.freeze(ids), messageRowId: p.messageRowId });
    } catch { throw new Error("room-work-payload-invalid"); }
  }
  private workView(row: WorkRow): RoomWorkItem {
    if (row.payload_version !== ROOM_WORK_PAYLOAD_VERSION) throw new Error("room-work-payload-version");
    const payload = this.decodePayload(row);
    return Object.freeze({ workItemId: row.work_item_id, eventKey: row.event_key, acceptSeq: row.accept_seq,
      status: row.status, terminalReason: row.terminal_reason, source: row.source, memberKey: row.member_key,
      receivedAt: row.received_at, expiresAt: row.expires_at, executionEpoch: row.execution_epoch,
      burstId: row.burst_id, payloadVersion: row.payload_version, payloadJson: row.payload_json, payload,
      createdAt: row.created_at, updatedAt: row.updated_at });
  }
  workItem(workItemId: string): RoomWorkItem | null {
    const row = this.db.prepare("SELECT * FROM room_work_items WHERE work_item_id=?").get(workItemId) as WorkRow | undefined;
    return row ? this.workView(row) : null;
  }
  workItems(): readonly RoomWorkItem[] {
    return this.db.prepare("SELECT * FROM room_work_items ORDER BY accept_seq IS NULL,accept_seq,created_at,work_item_id").all()
      .map(row => this.workView(row as WorkRow));
  }
  /** Runtime supplies admission/recording decisions. This method never grants execution permission. */
  acceptInput(raw: RoomInput, options: AcceptOptions): WorkAdmissionResult {
    const input = this.normalizedInput(raw);
    if (!timestamp(options.now) || !timestamp(options.expectedEpoch)
      || !["direct", "manual", "ambient"].includes(options.source)
      || !["enqueue", "record_only", "reject"].includes(options.mode)) throw new Error("room-work-options-invalid");
    if (options.mode === "enqueue") {
      const p = options.policy;
      if (!p || [p.capacity, p.memberWindowMs, p.ttlMs]
        .some(n => !Number.isSafeInteger(n) || n <= 0)
        || (p.memberLimit !== null && (!Number.isSafeInteger(p.memberLimit) || p.memberLimit <= 0))
        || !timestamp(options.now + p.ttlMs)) throw new Error("room-queue-policy-invalid");
    }
    if (options.mode === "reject" && (!code(options.reason)
      || (options.recordHistory !== undefined && typeof options.recordHistory !== "boolean"))) throw new Error("room-work-reason-invalid");
    return this.transaction(() => {
      const eventKey = this.eventKey(input);
      const existing = this.db.prepare("SELECT * FROM room_work_items WHERE event_key=?").get(eventKey) as WorkRow | undefined;
      if (existing) {
        const item = this.workView(existing);
        return { kind: "duplicate", item, reason: item.terminalReason };
      }
      if (this.db.prepare("SELECT 1 FROM room_seen WHERE id=?").get(eventKey)) {
        return { kind: "duplicate", item: null, reason: "legacy_seen" };
      }
      this.assertEpoch(options.expectedEpoch);
      if (!this.rememberInput(input, options.now)) throw new Error("room-work-dedup-conflict");
      const record = options.mode !== "reject" || options.recordHistory === true;
      const reply = input.replyToMessageId === undefined ? undefined : this.replyTarget(input.accountKey, input.replyToMessageId);
      const messageRowId = record ? this.appendUser(input, options.now, reply?.id ?? null) : null;
      let status: WorkItemStatus = options.mode === "enqueue" ? "queued" : options.mode === "record_only" ? "recorded_only" : "rejected";
      let reason: string | null = options.mode === "record_only" ? "record_only" : options.mode === "reject" ? options.reason : null;
      const memberKey = this.actor(input.senderId);
      if (options.mode === "enqueue") {
        const p = options.policy;
        const attempts = this.db.prepare("SELECT count(*) AS n FROM room_work_items WHERE member_key=? AND admission_attempt=1 AND created_at>? AND created_at<=?")
          .get(memberKey, options.now - p.memberWindowMs, options.now) as { n: number };
        const pending = this.db.prepare("SELECT count(*) AS n FROM room_work_items WHERE status='queued'").get() as { n: number };
        if (p.memberLimit !== null && attempts.n >= p.memberLimit) { status = "rejected"; reason = "member_rate_limited"; }
        else if (pending.n >= p.capacity) { status = "rejected"; reason = "queue_full"; }
      }
      let acceptSeq: number | null = null, expiresAt: number | null = null, payloadJson = "null";
      if (status === "queued" && options.mode === "enqueue") {
        const sequence = this.state().next_accept_seq;
        if (!timestamp(sequence + 1)) throw new Error("room-accept-sequence-overflow");
        acceptSeq = sequence + 1; expiresAt = options.now + options.policy.ttlMs;
        this.db.prepare("UPDATE room_state SET next_accept_seq=? WHERE id=1").run(acceptSeq);
        const characterIds = [...new Set(input.mentions!.flatMap(id => {
          const c = this.config.characters.find(c => c.selfId === id); return c ? [c.id] : [];
        }))];
        const { senderId: _senderId, ...message } = input;
        payloadJson = JSON.stringify({ input: { ...message, senderKey: memberKey }, characterIds, messageRowId });
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO room_work_items(work_item_id,event_key,accept_seq,status,terminal_reason,source,member_key,received_at,expires_at,execution_epoch,burst_id,payload_version,payload_json,admission_attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)")
        .run(id, eventKey, acceptSeq, status, reason, options.source, memberKey, options.now, expiresAt,
          options.expectedEpoch, ROOM_WORK_PAYLOAD_VERSION, payloadJson, Number(options.mode === "enqueue"), options.now, options.now);
      return { kind: status === "queued" ? "enqueue" : status === "recorded_only" ? "record_only" : "reject",
        item: this.workItem(id)!, reason };
    });
  }
  /** Atomically binds the oldest queued item to a caller-supplied Burst ID. No Gate or role choice. */
  claimNext(options: { expectedEpoch: number; now: number; burstId: string }): RoomWorkItem | null {
    if (!timestamp(options.now) || typeof options.burstId !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(options.burstId)) throw new Error("room-work-claim-invalid");
    return this.transaction(() => {
      this.assertEpoch(options.expectedEpoch);
      if (this.db.prepare("SELECT 1 FROM room_work_items WHERE status='claimed'").get()
        || this.db.prepare("SELECT 1 FROM room_bursts WHERE state='running'").get()) return null;
      this.db.prepare("UPDATE room_work_items SET status='expired',terminal_reason='ttl_expired',updated_at=? WHERE status='queued' AND expires_at<=?")
        .run(options.now, options.now);
      const row = this.db.prepare("SELECT * FROM room_work_items WHERE status='queued' ORDER BY accept_seq LIMIT 1").get() as WorkRow | undefined;
      if (!row) return null;
      if (row.execution_epoch !== options.expectedEpoch) throw new Error("room-work-stale-epoch");
      const item = this.workView(row);
      if (!item.payload) throw new Error("room-work-payload-invalid");
      this.db.prepare("INSERT INTO room_bursts(id,epoch,trigger,target_id,state,created_at) VALUES (?,?,?,?,'running',?)")
        .run(options.burstId, row.execution_epoch, row.source, item.payload.messageRowId, options.now);
      if (this.db.prepare("UPDATE room_work_items SET status='claimed',burst_id=?,updated_at=? WHERE work_item_id=? AND status='queued' AND execution_epoch=?")
        .run(options.burstId, options.now, row.work_item_id, options.expectedEpoch).changes !== 1) throw new Error("room-work-claim-conflict");
      return this.workItem(row.work_item_id);
    });
  }
  settleWorkItem(workItemId: string, options: { expectedEpoch: number; burstId: string | null; now: number;
    status: "completed" | "cancelled" | "failed" | "expired" | "restart_not_resumed"; reason: string }): boolean {
    if (!timestamp(options.now) || !code(options.reason)
      || !["completed", "cancelled", "failed", "expired", "restart_not_resumed"].includes(options.status)) throw new Error("room-work-settlement-invalid");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM room_work_items WHERE work_item_id=?").get(workItemId) as WorkRow | undefined;
      if (!row || WORK_TERMINAL.has(row.status)) return false;
      this.assertEpoch(options.expectedEpoch);
      if (row.burst_id !== options.burstId) return false;
      if ((options.status === "completed" || options.status === "failed") && row.execution_epoch !== options.expectedEpoch) throw new Error("room-work-stale-epoch");
      if (((options.status === "completed" || options.status === "failed") && row.status !== "claimed")
        || (options.status === "expired" && (row.status !== "queued" || row.expires_at! > options.now))
        || (options.status === "restart_not_resumed" && row.execution_epoch >= options.expectedEpoch)) throw new Error("room-work-transition-invalid");
      // Updating the WorkItem settles its linked Burst through an AFTER trigger in this transaction.
      if (row.burst_id) this.closeWorkerObligations(row.burst_id, options.status, options.reason);
      return this.db.prepare("UPDATE room_work_items SET status=?,terminal_reason=?,updated_at=? WHERE work_item_id=? AND status=? AND execution_epoch=?")
        .run(options.status, options.reason, options.now, workItemId, row.status, row.execution_epoch).changes === 1;
    });
  }
  /** Explicit Runtime request only. Opening a connection or receiving Stop does not call this. */
  recoverWorkItems(options: { expectedEpoch: number; now: number }): { previousEpoch: number; epoch: number; recovered: number } {
    if (!timestamp(options.now) || !timestamp(options.expectedEpoch + 1)) throw new Error("room-work-recovery-invalid");
    return this.transaction(() => {
      this.assertEpoch(options.expectedEpoch);
      this.assertNoFutureWork(options.expectedEpoch);
      for (const row of this.db.prepare("SELECT burst_id FROM room_work_items WHERE status='claimed' AND execution_epoch<=?").all(options.expectedEpoch)) {
        this.closeWorkerObligations(String(row.burst_id), "restart_not_resumed", "restart_not_resumed");
      }
      const recovered = this.db.prepare("UPDATE room_work_items SET status='restart_not_resumed',terminal_reason='restart_not_resumed',updated_at=? WHERE status IN ('queued','claimed') AND execution_epoch<=?")
        .run(options.now, options.expectedEpoch).changes;
      this.assertRecoveryComplete();
      const epoch = options.expectedEpoch + 1;
      this.db.prepare("UPDATE room_state SET epoch=? WHERE id=1").run(epoch);
      if (this.state().epoch !== epoch) throw this.recoveryFailure();
      this.assertRecoveryComplete();
      return { previousEpoch: options.expectedEpoch, epoch, recovered: Number(recovered) };
    });
  }
  private assertNoFutureWork(epoch: number): void {
    if (this.db.prepare("SELECT 1 FROM room_work_items WHERE status IN ('queued','claimed') AND execution_epoch>? LIMIT 1").get(epoch)) {
      throw storeFailure("room-work-future-epoch", "队列包含未来世代；启动/恢复已拒绝且事务已回滚。停止房间，不推进世代吸收异常；按运维手册人工核对。", undefined);
    }
  }
  private recoveryFailure(): Error {
    return storeFailure("room-work-recovery-incomplete", "恢复存在残留或世代未提交；事务已回滚。停止房间，不跳过或重新入队；按运维手册人工核对。", undefined);
  }
  private assertRecoveryComplete(): void {
    if (this.db.prepare("SELECT 1 FROM room_work_items WHERE status IN ('queued','claimed') LIMIT 1").get()) throw this.recoveryFailure();
  }
  /** One SQLite statement/snapshot, metadata only. It grants no execution permission. */
  inspectQueue(): Readonly<RoomQueueView> {
    return Object.freeze(this.db.prepare(`SELECT epoch,paused,
      (SELECT count(*) FROM room_work_items WHERE status='queued') AS queuedCount,
      (SELECT count(*) FROM room_work_items WHERE status='claimed') AS claimedCount,
      (SELECT count(*) FROM room_bursts WHERE state='running') AS runningBurstCount,
      (SELECT count(*) FROM room_work_items WHERE status IN ('queued','claimed') AND execution_epoch>room_state.epoch) AS futureCount,
      (SELECT work_item_id FROM room_work_items WHERE status='queued' ORDER BY accept_seq LIMIT 1) AS headId,
      (SELECT accept_seq FROM room_work_items WHERE status='queued' ORDER BY accept_seq LIMIT 1) AS headSeq,
      (SELECT execution_epoch FROM room_work_items WHERE status='queued' ORDER BY accept_seq LIMIT 1) AS headEpoch,
      (SELECT work_item_id FROM room_work_items WHERE status='claimed' LIMIT 1) AS claimedWorkItemId,
      (SELECT burst_id FROM room_work_items WHERE status='claimed' LIMIT 1) AS burstId
      FROM room_state WHERE id=1`).get() as unknown as RoomQueueView);
  }
  state(): State { return this.db.prepare("SELECT * FROM room_state WHERE id=1").get() as unknown as State; }
  controlState(): RoomControlState {
    const s = this.state();
    return Object.freeze({ mode: s.mode, paused: Boolean(s.paused), epoch: s.epoch,
      executionRevision: s.execution_revision, sessionExpiresAt: s.session_expires_at });
  }
  seenEvent(eventKey: string): boolean {
    if (typeof eventKey !== "string" || !/^[0-9a-f]{64}$/.test(eventKey)) throw new Error("room-control-invalid");
    return Boolean(this.db.prepare("SELECT 1 FROM room_seen WHERE id=?").get(eventKey));
  }
  /** Original local result only; no expiry, revision or dispatch side effects during replay. */
  controlResultForEvent(eventKey: string): RoomControlResult | undefined {
    if (typeof eventKey !== "string" || !/^[0-9a-f]{64}$/.test(eventKey)) throw new Error("room-control-invalid");
    const row = this.db.prepare("SELECT control_result FROM room_seen WHERE id=?").get(eventKey);
    if (!row || row.control_result === null) return undefined;
    try { return checkedRoomControlResult(JSON.parse(String(row.control_result))); }
    catch { throw new Error("room-control-result-invalid"); }
  }
  /** New process profile: mention_only, not paused, no old Session; a new revision fences old gates. */
  initializeWorkerControl(expectedEpoch: number, now: number): RoomControlState {
    if (!timestamp(now) || !timestamp(expectedEpoch)) throw new Error("room-control-invalid");
    return this.transaction(() => {
      this.assertEpoch(expectedEpoch);
      this.db.prepare(`UPDATE room_state SET paused=0,mode='mention_only',session_expires_at=NULL,
        execution_revision=execution_revision+1 WHERE id=1`).run();
      this.db.prepare("UPDATE room_state SET lifecycle_mode='mention_only' WHERE id=1").run();
      this.db.prepare("DELETE FROM room_lifecycle_owner").run();
      return this.controlState();
    });
  }
  lifecycleControlState(): LifecycleControlState {
    const s = this.state();
    if (s.lifecycle_mode !== "mention_only" && s.lifecycle_mode !== "ambient") throw new Error("room-lifecycle-mode-invalid");
    return Object.freeze({ mode: s.lifecycle_mode, paused: Boolean(s.paused), epoch: s.epoch,
      executionRevision: s.execution_revision, sessionExpiresAt: null });
  }
  /** Process startup only: invalidate old active work, then choose mention_only and a fenced owner lease. */
  initializeLifecycleControl(expectedEpoch: number, now: number, ownerToken: string, leaseUntil: number): LifecycleControlState {
    if (!timestamp(expectedEpoch) || !timestamp(now) || !timestamp(leaseUntil) || leaseUntil < now
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerToken)) throw new Error("room-lifecycle-initialize-invalid");
    return this.transaction(() => {
      this.assertEpoch(expectedEpoch);
      const revision = this.state().execution_revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("room-lifecycle-initialize-invalid");
      this.db.prepare(`UPDATE room_state SET paused=0,mode='mention_only',lifecycle_mode='mention_only',
        session_expires_at=NULL,execution_revision=? WHERE id=1`).run(revision);
      this.db.prepare("DELETE FROM room_lifecycle_owner").run();
      this.db.prepare(`INSERT INTO room_lifecycle_owner
        (id,owner_token,lease_until,execution_epoch,execution_revision) VALUES (1,?,?,?,?)`)
        .run(ownerToken, leaseUntil, expectedEpoch, revision);
      return this.lifecycleControlState();
    });
  }
  /** Session expiry changes mode only; accepted queued and in-flight work may finish. */
  expireSession(now: number): boolean {
    if (!timestamp(now)) throw new Error("room-control-invalid");
    return this.transaction(() => {
      const s = this.state();
      if (s.mode !== "session" || s.session_expires_at === null || now < s.session_expires_at) return false;
      this.db.prepare("UPDATE room_state SET mode='mention_only',session_expires_at=NULL WHERE id=1").run();
      return true;
    });
  }
  /** Storage/availability fault pauses and fences every old gate without erasing mode. */
  faultControl(): RoomControlState {
    return this.transaction(() => {
      this.db.prepare("UPDATE room_state SET paused=1,execution_revision=execution_revision+1 WHERE id=1").run();
      return this.controlState();
    });
  }
  /**
   * One short control UoW. Runtime decides the mutation and expected revision; Store only CASes,
   * persists, dedupes the control event and (for Stop) cancels accepted queued work.
   */
  applyControl(options: RoomControlMutation): RoomControlApplyResult {
    if (typeof options.eventKey !== "string" || !/^[0-9a-f]{64}$/.test(options.eventKey)
      || !timestamp(options.now) || !timestamp(options.expectedEpoch)
      || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0
      || typeof options.bumpRevision !== "boolean"
      || (options.mode !== undefined && !["mention_only", "session"].includes(options.mode))
      || (options.paused !== undefined && typeof options.paused !== "boolean")
      || (Object.prototype.hasOwnProperty.call(options, "sessionExpiresAt")
        && options.sessionExpiresAt !== null && !timestamp(options.sessionExpiresAt!))
      || (options.cancelQueuedReason !== undefined && !code(options.cancelQueuedReason))) {
      throw new Error("room-control-invalid");
    }
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM room_seen WHERE id=?").get(options.eventKey)) {
        return { kind: "duplicate", state: this.controlState(), cancelledQueued: 0,
          localResult: this.controlResultForEvent(options.eventKey) } as const;
      }
      const s = this.state();
      if (s.epoch !== options.expectedEpoch || s.execution_revision !== options.expectedRevision) {
        return { kind: "stale", state: this.controlState(), cancelledQueued: 0 } as const;
      }
      let cancelledQueued = 0;
      if (options.cancelQueuedReason !== undefined) {
        cancelledQueued = Number(this.db.prepare(`UPDATE room_work_items SET status='cancelled',
          terminal_reason=?,updated_at=? WHERE status='queued' AND execution_epoch=?`)
          .run(options.cancelQueuedReason, options.now, options.expectedEpoch).changes);
      }
      const sets: string[] = [], values: Array<string | number | null> = [];
      if (options.mode !== undefined) { sets.push("mode=?"); values.push(options.mode); }
      if (options.paused !== undefined) { sets.push("paused=?"); values.push(Number(options.paused)); }
      if (Object.prototype.hasOwnProperty.call(options, "sessionExpiresAt")) {
        sets.push("session_expires_at=?"); values.push(options.sessionExpiresAt ?? null);
      }
      if (options.bumpRevision) sets.push("execution_revision=execution_revision+1");
      if (sets.length) this.db.prepare(`UPDATE room_state SET ${sets.join(",")} WHERE id=1`).run(...values);
      if (options.bumpRevision) {
        this.db.prepare(`UPDATE room_lifecycle_owner SET execution_revision=
          (SELECT execution_revision FROM room_state WHERE id=1) WHERE id=1`).run();
      }
      const state = this.controlState();
      const localResult: RoomControlResult | undefined = options.outcome && checkedRoomControlResult({
        ...options.outcome, ...state, cancelledQueued,
      });
      // A failed result insert also rolls back state/revision and Stop's queued settlements.
      const inserted = this.db.prepare("INSERT INTO room_seen(id,created_at,control_result) VALUES (?,?,?)")
        .run(options.eventKey, options.now, localResult ? JSON.stringify(localResult) : null);
      if (inserted.changes !== 1) throw new Error("room-control-result-not-recorded");
      return { kind: "applied", state, cancelledQueued, localResult } as const;
    });
  }
  private normalizedLifecycleInput(input: RoomInput): RoomInput {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.accountKey !== "string" || typeof input.selfId !== "string"
      || typeof input.groupId !== "string" || typeof input.senderId !== "string"
      || typeof input.messageId !== "string" || typeof input.text !== "string"
      || input.text.length > 8000 || input.text.includes("\0")
      || !/^[1-9]\d{0,15}$/.test(input.senderId) || !Number.isSafeInteger(Number(input.senderId))
      || this.config.characters.some(c => c.selfId === input.senderId)
      || (input.mentions !== undefined && (!Array.isArray(input.mentions)
        || input.mentions.some(id => typeof id !== "string" || !/^[1-9]\d{0,15}$/.test(id)
          || !Number.isSafeInteger(Number(id)))))
      || (input.replyToMessageId !== undefined && !roomInputId(input.replyToMessageId))
      || input.unsupported) throw new Error("room-lifecycle-input-invalid");
    const account = this.config.characters.find(c => c.accountKey === input.accountKey);
    if (!account || input.selfId !== account.selfId || input.groupId !== this.config.groupId
      || !roomInputId(input.messageId)) throw new Error("room-lifecycle-input-invalid");
    const mentions = [...(input.mentions ?? [])];
    if (!input.text.trim() && !mentions.some(id => this.config.characters.some(c => c.selfId === id))) {
      throw new Error("room-lifecycle-input-invalid");
    }
    return { accountKey: input.accountKey, selfId: input.selfId, groupId: input.groupId,
      senderId: input.senderId, messageId: input.messageId, text: input.text.trim(), mentions,
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }) };
  }
  private lifecycleRequest(row: Record<string, unknown>): LifecycleRequest {
    const payload = JSON.parse(String(row.payload_json)) as {
      input?: unknown; characterIds?: unknown; messageRowId?: unknown; senderKey?: unknown;
    };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)
      || !Array.isArray(payload.characterIds)
      || !payload.characterIds.every(id => typeof id === "string" && this.config.characters.some(c => c.id === id))
      || typeof payload.senderKey !== "string" || !/^member-[0-9a-f]{16}$/.test(payload.senderKey)
      || !Number.isSafeInteger(payload.messageRowId) || Number(payload.messageRowId) <= 0) throw new Error("room-lifecycle-payload-invalid");
    if (!["text", "both"].includes(String(row.delivery_mode))) throw new Error("room-lifecycle-payload-invalid");
    return Object.freeze({ requestId: String(row.request_id), eventKey: String(row.event_key),
      acceptSeq: Number(row.accept_seq), status: String(row.status) as LifecycleRequestStatus,
      outcomeReason: row.outcome_reason === null ? null : String(row.outcome_reason),
      source: String(row.source) as Trigger, executionEpoch: Number(row.execution_epoch),
      executionRevision: Number(row.execution_revision), expiresAt: Number(row.expires_at),
      messageRowId: Number(row.message_row_id), characterIds: Object.freeze([...payload.characterIds]),
      deliveryMode: String(row.delivery_mode) as LifecycleDeliveryMode,
      senderKey: payload.senderKey,
      input: Object.freeze(payload.input as Omit<RoomInput, "senderId" | "unsupported">),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
  }
  lifecycleRequestById(requestId: string): LifecycleRequest | null {
    const row = this.db.prepare("SELECT * FROM room_lifecycle_requests WHERE request_id=?").get(requestId);
    return row ? this.lifecycleRequest(row as Record<string, unknown>) : null;
  }
  lifecycleRequests(): readonly LifecycleRequest[] {
    return Object.freeze(this.db.prepare("SELECT * FROM room_lifecycle_requests ORDER BY accept_seq")
      .all().map(row => this.lifecycleRequest(row as Record<string, unknown>)));
  }
  lifecycleTurns(requestId: string): readonly LifecycleTurn[] {
    return this.db.prepare(`SELECT turn_id,request_id,character_id,mention_index,status,reason,
      (SELECT count(*) FROM room_lifecycle_segments s WHERE s.turn_id=t.turn_id) AS segment_count
      FROM room_lifecycle_turns t WHERE request_id=? ORDER BY mention_index`).all(requestId).map(row => Object.freeze({
        turnId: String(row.turn_id), requestId: String(row.request_id), characterId: String(row.character_id),
        mentionIndex: Number(row.mention_index), status: String(row.status) as LifecycleTurnStatus,
        reason: row.reason === null ? null : String(row.reason), segmentCount: Number(row.segment_count),
      }));
  }
  lifecycleSegments(turnId: string): readonly LifecycleSegment[] {
    return this.db.prepare(`SELECT segment_id,turn_id,segment_index,semantic_text,voice_text,voice_language,
      delivery_mode,state,reason FROM room_lifecycle_segments WHERE turn_id=? ORDER BY segment_index`).all(turnId)
      .map(row => Object.freeze({ segmentId: String(row.segment_id), turnId: String(row.turn_id),
        segmentIndex: Number(row.segment_index), text: String(row.semantic_text),
        voiceText: row.voice_text === null ? null : String(row.voice_text),
        voiceLanguage: row.voice_language === null ? null : String(row.voice_language) as "zh" | "ja",
        deliveryMode: String(row.delivery_mode) as LifecycleDeliveryMode,
        state: String(row.state) as LifecycleSegmentState,
        reason: row.reason === null ? null : String(row.reason),
      }));
  }
  private lifecycleActive(requestId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM room_lifecycle_requests WHERE request_id=? AND status IN ('generating','delivering')").get(requestId));
  }
  private lifecycleTurnTerminal(status: LifecycleTurnStatus): boolean {
    return LIFECYCLE_TURN_TERMINAL.has(status);
  }
  private lifecycleSegmentTerminal(status: LifecycleSegmentState): boolean {
    return LIFECYCLE_SEGMENT_TERMINAL.has(status);
  }
  private lifecycleSettleTurn(turnId: string, now: number): void {
    const row = this.db.prepare("SELECT request_id,status,reason FROM room_lifecycle_turns WHERE turn_id=?").get(turnId);
    if (!row) return;
    const current = String(row.status) as LifecycleTurnStatus;
    if (this.lifecycleTurnTerminal(current) || current === "pending" || current === "generating") return;
    const segments = this.lifecycleSegments(turnId);
    if (segments.some(segment => !this.lifecycleSegmentTerminal(segment.state))) return;
    const failed = segments.find(segment =>
      segment.state === "unknown" || segment.state === "failed"
      || segment.state === "cancelled" || segment.state === "blocked");
    const status: LifecycleTurnStatus = failed
      ? failed.state === "unknown" ? "unknown" : failed.state === "blocked" ? "blocked"
        : failed.state === "cancelled" ? "cancelled" : "failed"
      : "completed";
    const reason = failed?.reason ?? (status === "completed"
      ? row.reason === null ? null : String(row.reason)
      : "lifecycle_delivery_failed");
    this.db.prepare("UPDATE room_lifecycle_turns SET status=?,reason=?,updated_at=? WHERE turn_id=?")
      .run(status, reason, now, turnId);
  }
  private lifecycleSettleRequest(requestId: string, now: number): void {
    const request = this.lifecycleRequestById(requestId);
    if (!request || ["completed","failed","cancelled","restart_not_resumed"].includes(request.status)) return;
    const turns = this.lifecycleTurns(requestId);
    for (const turn of turns) this.lifecycleSettleTurn(turn.turnId, now);
    const settledTurns = this.lifecycleTurns(requestId);
    if (settledTurns.some(turn => !this.lifecycleTurnTerminal(turn.status))) return;
    const segments = settledTurns.flatMap(t => this.lifecycleSegments(t.turnId));
    if (segments.some(segment => !this.lifecycleSegmentTerminal(segment.state))) return;
    const failed = settledTurns.some(t => ["failed","unknown","cancelled","blocked"].includes(t.status))
      || segments.some(s => ["failed","unknown","cancelled","blocked"].includes(s.state));
    const status: LifecycleRequestStatus = failed ? "failed" : "completed";
    const reason = failed
      ? settledTurns.find(t => ["failed","unknown","cancelled","blocked"].includes(t.status))?.reason
        ?? segments.find(s => ["failed","unknown","cancelled","blocked"].includes(s.state))?.reason
        ?? "lifecycle_failed"
      : "all_obligations_terminal";
    this.db.prepare("UPDATE room_lifecycle_requests SET status=?,outcome_reason=?,updated_at=? WHERE request_id=? AND status IN ('generating','delivering')")
      .run(status, reason, now, requestId);
  }
  private expireLifecycleRequests(now: number): void {
    const rows = this.db.prepare(`SELECT request_id FROM room_lifecycle_requests
      WHERE status IN ('queued','generating','delivering') AND expires_at<=? ORDER BY accept_seq`).all(now);
    for (const row of rows) {
      const requestId = String(row.request_id);
      this.cancelLifecycleRequests("all-for-request", "ttl_expired", now, requestId);
    }
  }
  private blockDependentLifecycleSegments(turnId: string, afterSegmentId: string, reason: string, now: number): void {
    this.db.prepare(`UPDATE room_lifecycle_segments SET state='blocked',reason=?,updated_at=?
      WHERE turn_id=? AND segment_index>(SELECT segment_index FROM room_lifecycle_segments WHERE segment_id=?)
        AND state NOT IN ('completed','failed','unknown','cancelled','blocked','skipped')`)
      .run(reason, now, turnId, afterSegmentId);
  }
  /**
   * Terminalize one unfinished segment without erasing an external-send fact.
   * A started attempt with an ACK is projected into public history when its
   * commit did not win the race; a started attempt without a receipt remains
   * unknown forever and is never eligible for automatic retransmission.
   */
  private abandonLifecycleSegment(segmentId: string, reason: string, now: number): void {
    const row = this.db.prepare(`SELECT s.state,s.segment_index,s.semantic_text,s.voice_text,s.delivery_mode,
      t.turn_id,t.character_id,t.request_id,r.message_row_id
      FROM room_lifecycle_segments s JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
      JOIN room_lifecycle_requests r ON r.request_id=t.request_id WHERE s.segment_id=?`).get(segmentId);
    if (!row || this.lifecycleSegmentTerminal(String(row.state) as LifecycleSegmentState)) return;
    const interrupted = String(row.state) === "text_sending" || String(row.state) === "audio_sending"
      ? this.db.prepare(`SELECT attempt_id,medium,committed_row_id FROM room_lifecycle_attempts
        WHERE segment_id=? AND started_at IS NOT NULL
          AND medium=? ORDER BY intent_at DESC,rowid DESC LIMIT 1`).get(segmentId,
        String(row.state) === "text_sending" ? "text" : "audio")
      : undefined;
    if (interrupted) {
      const receipts = this.lifecycleReceipts(String(interrupted.attempt_id));
      const ack = receipts.find(receipt => receipt.kind === "ack");
      const rejected = receipts.some(receipt => receipt.kind === "rejected");
      if (ack) {
        const character = this.config.characters.find(c => c.id === String(row.character_id));
        if (!character) throw new Error("room-lifecycle-payload-invalid");
        let committed = interrupted.committed_row_id === null ? null : Number(interrupted.committed_row_id);
        if (committed === null) {
          committed = this.append("bot", character.id, character.accountKey, Number(row.message_row_id),
            String(interrupted.medium) === "audio" ? String(row.voice_text ?? "") : String(row.semantic_text),
            ack.messageId!, now, interrupted.medium === "audio" ? "voice" : "text");
          const attemptId = interrupted.attempt_id;
          if (typeof attemptId !== "string") throw new Error("room-lifecycle-attempt-invalid");
          if (this.db.prepare("UPDATE room_lifecycle_attempts SET committed_row_id=? WHERE attempt_id=? AND committed_row_id IS NULL")
            .run(committed, attemptId).changes !== 1) throw new Error("room-lifecycle-attempt-invalid");
        }
        if (interrupted.medium === "text" && String(row.delivery_mode) === "both") {
          this.db.prepare("UPDATE room_lifecycle_segments SET state='failed',reason=?,updated_at=? WHERE segment_id=?")
            .run(code(reason) ? reason : "audio_cancelled", now, segmentId);
          this.blockDependentLifecycleSegments(String(row.turn_id), segmentId, "dependency_unknown", now);
        } else {
          this.db.prepare("UPDATE room_lifecycle_segments SET state='completed',reason=NULL,updated_at=? WHERE segment_id=?")
            .run(now, segmentId);
        }
        return;
      }
      this.db.prepare("UPDATE room_lifecycle_segments SET state=?,reason=?,updated_at=? WHERE segment_id=?")
        .run(rejected ? "failed" : "unknown", rejected ? "delivery_rejected" : "delivery_unknown", now, segmentId);
      this.blockDependentLifecycleSegments(String(row.turn_id), segmentId, "dependency_unknown", now);
      return;
    }
    // `text_sent` means the text is already public; only its dependent audio
    // remains. Preserve that fact and settle the segment as a partial failure.
    if (String(row.state) === "text_sent") {
      this.db.prepare("UPDATE room_lifecycle_segments SET state='failed',reason=?,updated_at=? WHERE segment_id=?")
        .run(code(reason) ? reason : "audio_cancelled", now, segmentId);
      return;
    }
    this.db.prepare("UPDATE room_lifecycle_segments SET state='cancelled',reason=?,updated_at=? WHERE segment_id=?")
      .run(reason, now, segmentId);
  }
  private cancelLifecycleRequests(where: "ambient" | "all" | "all-for-request", reason: string, now: number,
    requestId?: string): void {
    if (where === "all-for-request" && requestId === undefined) throw new Error("room-lifecycle-request-invalid");
    const requests = where === "ambient"
      ? this.db.prepare("SELECT request_id FROM room_lifecycle_requests WHERE source='ambient' AND status IN ('queued','generating','delivering')").all()
      : where === "all-for-request"
        ? this.db.prepare("SELECT request_id FROM room_lifecycle_requests WHERE request_id=? AND status IN ('queued','generating','delivering')").all(requestId!)
        : this.db.prepare("SELECT request_id FROM room_lifecycle_requests WHERE status IN ('queued','generating','delivering')").all();
    for (const request of requests) {
      const requestId = String(request.request_id);
      const turns = this.lifecycleTurns(requestId);
      for (const turn of turns) {
        const segments = this.lifecycleSegments(turn.turnId);
        for (const segment of segments) this.abandonLifecycleSegment(segment.segmentId, reason, now);
        this.lifecycleSettleTurn(turn.turnId, now);
        const settled = this.lifecycleTurns(requestId).find(item => item.turnId === turn.turnId);
        if (settled && ["pending","generating","ready","delivering"].includes(settled.status)) {
          this.db.prepare("UPDATE room_lifecycle_turns SET status=?,reason=?,updated_at=? WHERE turn_id=?")
            .run("cancelled", reason, now, turn.turnId);
        }
      }
      const settledTurns = this.lifecycleTurns(requestId);
      const status = settledTurns.some(turn => turn.status === "unknown") ? "failed"
        : settledTurns.some(turn => turn.status === "failed") ? "failed"
          : settledTurns.every(turn => turn.status === "completed") ? "completed" : "cancelled";
      const outcomeReason = status === "failed"
        ? settledTurns.find(turn => turn.status === "unknown")?.reason
          ?? settledTurns.find(turn => turn.status === "failed")?.reason ?? "lifecycle_failed"
        : status === "completed" ? "all_obligations_terminal" : reason;
      this.db.prepare("UPDATE room_lifecycle_requests SET status=?,outcome_reason=?,updated_at=? WHERE request_id=? AND status IN ('queued','generating','delivering')")
        .run(status, outcomeReason, now, requestId);
    }
  }
  /** Preserve a started attempt's actual receipt fact while ending all automatic work. */
  abandonLifecycleAttempt(attemptId: string, reason: string, now: number): void {
    if (!code(reason) || !timestamp(now)) throw new Error("room-lifecycle-segment-invalid");
    this.transaction(() => {
      const attempt = this.lifecycleAttempt(attemptId);
      if (!attempt) throw new Error("room-lifecycle-attempt-invalid");
      this.abandonLifecycleSegment(attempt.segmentId, reason, now);
      this.lifecycleSettleTurn(attempt.turnId, now);
      this.lifecycleSettleRequest(attempt.requestId, now);
    });
  }
  acceptLifecycleInput(raw: RoomInput, options: LifecycleAcceptOptions): LifecycleAdmission {
    const input = this.normalizedLifecycleInput(raw);
    if (typeof options.ownerToken !== "string"
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.ownerToken)) throw new Error("room-lifecycle-owner-lost");
    if (!timestamp(options.now) || !timestamp(options.expectedEpoch)
      || !["direct","manual","ambient"].includes(options.source)
      || !["text","both"].includes(options.deliveryMode)
      || !Number.isSafeInteger(options.policy.capacity) || options.policy.capacity <= 0
      || !Number.isSafeInteger(options.policy.ttlMs) || options.policy.ttlMs <= 0
      || !timestamp(options.now + options.policy.ttlMs)) throw new Error("room-lifecycle-options-invalid");
    return this.transaction(() => {
      this.assertLifecycleOwner(options.ownerToken, options.now);
      const eventKey = this.eventKey(input);
      const existing = this.db.prepare("SELECT * FROM room_lifecycle_requests WHERE event_key=?").get(eventKey);
      if (existing) {
        const request = this.lifecycleRequest(existing as Record<string, unknown>);
        return { kind: "duplicate", request, reason: "duplicate", messageRowId: request.messageRowId } as const;
      }
      if (this.seenEvent(eventKey)) return { kind: "duplicate", request: null, reason: "legacy_seen" } as const;
      this.assertEpoch(options.expectedEpoch);
      if (!this.rememberInput(input, options.now)) throw new Error("room-lifecycle-dedup-conflict");
      const characterIds = [...new Set((input.mentions ?? []).flatMap(id => {
        const c = this.config.characters.find(c => c.selfId === id); return c ? [c.id] : [];
      }))];
      if (!options.enqueue || !characterIds.length) {
        const reply = input.replyToMessageId === undefined ? undefined : this.replyTarget(input.accountKey, input.replyToMessageId);
        const messageRowId = this.appendUser(input, options.now, reply?.id ?? null);
        return { kind: options.enqueue ? "reject" : "record_only", request: null,
          reason: options.enqueue ? "no_real_mention" : "record_only", messageRowId } as const;
      }
      if (options.source === "direct") this.cancelLifecycleRequests("ambient", "user_request_priority", options.now);
      const reply = input.replyToMessageId === undefined ? undefined : this.replyTarget(input.accountKey, input.replyToMessageId);
      // Record the admission attempt before capacity/member rejection so a
      // caller cannot bypass the abuse window by retrying a denied request.
      const messageRowId = this.appendUser(input, options.now, reply?.id ?? null);
      const active = this.db.prepare("SELECT count(*) AS n FROM room_lifecycle_requests WHERE status IN ('queued','generating','delivering')").get() as { n: number };
      if (Number(active.n) >= options.policy.capacity) {
        return { kind: "reject", request: null, reason: "queue_full", messageRowId } as const;
      }
      // Member limits are abuse controls, never a participation quota. The
      // attempt is recorded even when it is rejected.
      if (options.policy.memberLimit !== null) {
        const memberKey = this.actor(input.senderId);
        const recent = Number(this.db.prepare(`SELECT count(*) AS n FROM room_messages
          WHERE speaker_type='user' AND speaker_id=? AND created_at>?`)
          .get(memberKey, options.now - options.policy.memberWindowMs)!.n);
        if (recent >= options.policy.memberLimit) {
          return { kind: "reject", request: null, reason: "member_rate_limited", messageRowId } as const;
        }
      }
      const sequence = this.state().next_accept_seq;
      if (!timestamp(sequence + 1)) throw new Error("room-accept-sequence-overflow");
      this.db.prepare("UPDATE room_state SET next_accept_seq=? WHERE id=1").run(sequence + 1);
      const requestId = randomUUID();
      const { senderId: _senderId, unsupported: _unsupported, ...message } = input;
      const payload = JSON.stringify({ input: message, characterIds, messageRowId,
        senderKey: this.actor(input.senderId) });
      this.db.prepare(`INSERT INTO room_lifecycle_requests
        (request_id,event_key,accept_seq,status,outcome_reason,source,execution_epoch,execution_revision,expires_at,message_row_id,delivery_mode,payload_json,created_at,updated_at)
        VALUES (?,?,?,'queued',NULL,?,?,?,?,?,?,?,?,?)`).run(requestId, eventKey, sequence + 1, options.source,
        options.expectedEpoch, this.state().execution_revision, options.now + options.policy.ttlMs, messageRowId,
        options.deliveryMode, payload,
        options.now, options.now);
      for (let index = 0; index < characterIds.length; index++) {
        const characterId = characterIds[index];
        if (!characterId) throw new Error("room-lifecycle-input-invalid");
        this.db.prepare(`INSERT INTO room_lifecycle_turns
          (turn_id,request_id,character_id,mention_index,status,reason,created_at,updated_at)
          VALUES (?,?,?,?,'pending',NULL,?,?)`).run(randomUUID(), requestId, characterId, index, options.now, options.now);
      }
      return { kind: "enqueue", request: this.lifecycleRequestById(requestId), reason: null, messageRowId } as const;
    });
  }
  /**
   * Admit a planner-selected ambient request against an existing public human
   * row. The pause read is repeated inside this transaction immediately before
   * the first insert, so a direct paused-state transition cannot slip between
   * the planner and admission.
   */
  acceptAmbientLifecycle(anchorRowId: number, rawCharacterIds: readonly string[],
    options: AmbientAcceptOptions): LifecycleAdmission {
    if (!Number.isSafeInteger(anchorRowId) || anchorRowId <= 0 || !Array.isArray(rawCharacterIds)
      || rawCharacterIds.length < 1 || rawCharacterIds.length > 2
      || rawCharacterIds.some(id => typeof id !== "string")
      || new Set(rawCharacterIds).size !== rawCharacterIds.length
      || !timestamp(options.now) || !timestamp(options.expectedEpoch)
      || typeof options.ownerToken !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.ownerToken)
      || !["text", "both"].includes(options.deliveryMode)
      || typeof options.eventKey !== "string" || !/^[0-9a-f]{64}$/.test(options.eventKey)
      || !Number.isSafeInteger(options.policy.capacity) || options.policy.capacity <= 0
      || !Number.isSafeInteger(options.policy.ttlMs) || options.policy.ttlMs <= 0
      || !timestamp(options.now + options.policy.ttlMs)) {
      throw new Error("room-ambient-admission-invalid");
    }
    return this.transaction(() => {
      this.assertLifecycleOwner(options.ownerToken, options.now);
      this.assertEpoch(options.expectedEpoch);
      const state = this.state();
      if (state.paused) {
        return { kind: "reject", request: null, reason: "paused", messageRowId: anchorRowId } as const;
      }
      if (state.lifecycle_mode !== "ambient") {
        return { kind: "reject", request: null, reason: "mode", messageRowId: anchorRowId } as const;
      }
      const existing = this.db.prepare("SELECT * FROM room_lifecycle_requests WHERE event_key=?").get(options.eventKey);
      if (existing) {
        const request = this.lifecycleRequest(existing as Record<string, unknown>);
        return { kind: "duplicate", request, reason: "duplicate", messageRowId: request.messageRowId } as const;
      }
      const anchor = this.db.prepare(`SELECT id,speaker_type AS speakerType,speaker_id AS speakerId,
        account_key AS accountKey,text,platform_id AS platformId,target_id AS targetId,created_at AS createdAt
        FROM room_messages WHERE id=?`).get(anchorRowId) as {
          id: number; speakerType: string; speakerId: string; accountKey: string; text: string;
          platformId: string; targetId: number | null; createdAt: number;
        } | undefined;
      if (!anchor || anchor.speakerType !== "user"
        || !/^member-[0-9a-f]{16}$/.test(anchor.speakerId)) {
        return { kind: "reject", request: null, reason: "anchor", messageRowId: anchorRowId } as const;
      }
      const latestHuman = this.db.prepare(`SELECT id FROM room_messages
        WHERE speaker_type='user' ORDER BY id DESC LIMIT 1`).get() as { id: number } | undefined;
      if (!latestHuman || Number(latestHuman.id) !== anchorRowId) {
        return { kind: "reject", request: null, reason: "stale_anchor", messageRowId: anchorRowId } as const;
      }
      const requested = new Set(rawCharacterIds);
      const characterIds = this.config.characters.filter(character => requested.has(character.id))
        .map(character => character.id);
      if (characterIds.length !== rawCharacterIds.length) {
        return { kind: "reject", request: null, reason: "character", messageRowId: anchorRowId } as const;
      }
      const active = this.db.prepare(`SELECT count(*) AS n FROM room_lifecycle_requests
        WHERE status IN ('queued','generating','delivering')`).get() as { n: number };
      if (Number(active.n) >= options.policy.capacity || Number(active.n) > 0) {
        return { kind: "reject", request: null, reason: "busy", messageRowId: anchorRowId } as const;
      }
      // Re-read the authority after all validation and immediately before insert.
      if (this.state().paused) {
        return { kind: "reject", request: null, reason: "paused", messageRowId: anchorRowId } as const;
      }
      const sequence = this.state().next_accept_seq;
      if (!timestamp(sequence + 1)) throw new Error("room-accept-sequence-overflow");
      this.db.prepare("UPDATE room_state SET next_accept_seq=? WHERE id=1").run(sequence + 1);
      const selfId = this.config.characters.find(character => character.accountKey === anchor.accountKey)?.selfId
        ?? this.config.characters.find(character => character.accountKey === this.config.ingressAccountKey)!.selfId;
      const input: Omit<RoomInput, "senderId" | "unsupported"> = {
        accountKey: anchor.accountKey,
        selfId,
        groupId: this.config.groupId,
        messageId: anchor.platformId,
        text: anchor.text,
        mentions: [],
      };
      const payload = JSON.stringify({ input, characterIds, messageRowId: anchorRowId, senderKey: anchor.speakerId });
      const requestId = randomUUID();
      this.db.prepare(`INSERT INTO room_lifecycle_requests
        (request_id,event_key,accept_seq,status,outcome_reason,source,execution_epoch,execution_revision,expires_at,message_row_id,delivery_mode,payload_json,created_at,updated_at)
        VALUES (?,?,?,'queued',NULL,'ambient',?,?,?,?,?,?,?,?)`).run(requestId, options.eventKey,
        sequence + 1, options.expectedEpoch, this.state().execution_revision, options.now + options.policy.ttlMs,
        anchorRowId, options.deliveryMode, payload, options.now, options.now);
      for (let index = 0; index < characterIds.length; index++) {
        this.db.prepare(`INSERT INTO room_lifecycle_turns
          (turn_id,request_id,character_id,mention_index,status,reason,created_at,updated_at)
          VALUES (?,?,?,?,'pending',NULL,?,?)`).run(randomUUID(), requestId, characterIds[index]!, index,
          options.now, options.now);
      }
      this.ambientAttempt(options.now);
      return { kind: "enqueue", request: this.lifecycleRequestById(requestId), reason: null,
        messageRowId: anchorRowId } as const;
    });
  }
  claimLifecycleGenerations(limit: number, ownerToken: string, expectedEpoch: number, now: number): readonly LifecycleGenerationClaim[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 64 || !timestamp(now)) throw new Error("room-lifecycle-claim-invalid");
    return this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      this.assertEpoch(expectedEpoch);
      if (this.state().paused) return Object.freeze([] as LifecycleGenerationClaim[]);
      this.expireLifecycleRequests(now);
      const rows = this.db.prepare(`SELECT t.turn_id,t.request_id,t.character_id,t.mention_index,t.status,t.reason
        FROM room_lifecycle_turns t JOIN room_lifecycle_requests r ON r.request_id=t.request_id
        WHERE t.status='pending' AND r.status IN ('queued','generating','delivering')
        ORDER BY r.accept_seq,t.mention_index LIMIT ?`).all(limit);
      const claimed: LifecycleGenerationClaim[] = [];
      for (const row of rows) {
        const turnId = String(row.turn_id), requestId = String(row.request_id);
        if (this.db.prepare("UPDATE room_lifecycle_turns SET status='generating',updated_at=? WHERE turn_id=? AND status='pending'")
          .run(now, turnId).changes !== 1) continue;
        // Re-stamp at claim time: a pause advances the fence, and the next
        // claim after resume makes this pending work live under the new revision.
        this.db.prepare(`UPDATE room_lifecycle_requests SET status='generating',
          execution_revision=?,updated_at=? WHERE request_id=? AND status IN ('queued','generating')`)
          .run(this.state().execution_revision, now, requestId);
        const request = this.lifecycleRequestById(requestId);
        const turn = this.lifecycleTurns(requestId).find(item => item.turnId === turnId);
        const character = this.config.characters.find(item => item.id === String(row.character_id));
        if (!request || !turn || !character) throw new Error("room-lifecycle-claim-invalid");
        claimed.push(Object.freeze({ request, turn, character }));
      }
      return claimed;
    });
  }
  /** Return one in-flight generation to pending after a pause/revision fence. */
  releaseLifecycleGeneration(turnId: string, ownerToken: string, now: number): void {
    if (typeof turnId !== "string" || !/^[0-9a-f-]{36}$/.test(turnId) || !timestamp(now)) {
      throw new Error("room-lifecycle-release-invalid");
    }
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      this.db.prepare(`UPDATE room_lifecycle_turns SET status='pending',reason=NULL,updated_at=?
        WHERE turn_id=? AND status='generating'
        AND request_id IN (SELECT request_id FROM room_lifecycle_requests
          WHERE status IN ('queued','generating'))`).run(now, turnId);
    });
  }
  /** Pause fence: all claimed-but-unfinished generations wait for resume. */
  suspendLifecycleGenerations(ownerToken: string, now: number): number {
    if (!timestamp(now)) throw new Error("room-lifecycle-release-invalid");
    return this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      return Number(this.db.prepare(`UPDATE room_lifecycle_turns SET status='pending',reason=NULL,updated_at=?
        WHERE status='generating'
        AND request_id IN (SELECT request_id FROM room_lifecycle_requests
          WHERE status IN ('queued','generating'))`).run(now).changes);
    });
  }
  completeLifecycleTurn(turnId: string, segments: readonly { text: string; voiceText?: string; voiceLanguage?: "zh" | "ja" }[],
    mode: LifecycleDeliveryMode, ownerToken: string, now: number,
    permittedOutput: ((text: string) => boolean) | undefined = undefined,
    turnReason: string | null = null): void {
    if (!Array.isArray(segments) || segments.length < 1 || segments.length > 2
      || !["text","both"].includes(mode) || (turnReason !== null && !code(turnReason)))
      throw new Error("room-lifecycle-turn-invalid");
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      const turn = this.db.prepare("SELECT request_id,status,character_id FROM room_lifecycle_turns WHERE turn_id=?").get(turnId);
      if (!turn || turn.status !== "generating") throw new Error("room-lifecycle-turn-invalid");
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]!;
        if (!segment || typeof segment.text !== "string" || !segment.text.trim() || segment.text.includes("\0")
          || [...segment.text.trim()].length > this.config.limits.maxTextChars
          || (segment.voiceText !== undefined && (typeof segment.voiceText !== "string" || !segment.voiceText.trim()
            || segment.voiceText.includes("\0") || [...segment.voiceText].length > 1000))
          || (mode === "text" && segment.voiceText !== undefined)
          || ((segment.voiceText === undefined) !== (segment.voiceLanguage === undefined))
          || (segment.voiceLanguage !== undefined && !["zh","ja"].includes(segment.voiceLanguage))
          || !this.permitsLifecycleOutput(segment.text, permittedOutput)
          || (segment.voiceText !== undefined && !this.permitsLifecycleOutput(segment.voiceText, permittedOutput))) {
          throw new Error("room-lifecycle-segment-invalid");
        }
        this.db.prepare(`INSERT INTO room_lifecycle_segments
          (segment_id,turn_id,segment_index,semantic_text,voice_text,voice_language,delivery_mode,state,reason,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'pending',NULL,?,?)`).run(randomUUID(), turnId, index, segment.text.trim(),
          segment.voiceText ?? null, segment.voiceLanguage ?? null, mode, now, now);
      }
      this.db.prepare("UPDATE room_lifecycle_turns SET status='ready',reason=?,updated_at=? WHERE turn_id=? AND status='generating'")
        .run(turnReason, now, turnId);
      this.lifecycleSettleRequest(String(turn.request_id), now);
    });
  }
  private permitsLifecycleOutput(text: string, permittedOutput?: (text: string) => boolean): boolean {
    try {
      return text.trim().length > 0 && !text.includes("\0")
        && (permittedOutput === undefined || permittedOutput(text) === true);
    } catch { return false; }
  }
  prepareLifecycleVoice(segmentId: string, voiceText: string, voiceLanguage: "zh" | "ja",
    ownerToken: string, now: number, permittedOutput?: (text: string) => boolean): void {
    if (typeof voiceText !== "string" || !["zh","ja"].includes(voiceLanguage)
      || !this.permitsLifecycleOutput(voiceText, permittedOutput)
      || [...voiceText.trim()].length > 1000) throw new Error("room-lifecycle-segment-invalid");
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      const row = this.db.prepare(`SELECT s.delivery_mode,s.state,r.status AS request_status,
        r.execution_epoch,r.execution_revision
        FROM room_lifecycle_segments s JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
        JOIN room_lifecycle_requests r ON r.request_id=t.request_id WHERE s.segment_id=?`).get(segmentId);
      if (!row || row.delivery_mode !== "both" || row.state !== "text_sent"
        || row.request_status !== "delivering"
        || Number(row.execution_epoch) !== this.state().epoch
        || Number(row.execution_revision) !== this.state().execution_revision) {
        throw new Error("room-lifecycle-segment-invalid");
      }
      if (this.db.prepare(`UPDATE room_lifecycle_segments SET voice_text=?,voice_language=?,updated_at=?
        WHERE segment_id=? AND state='text_sent'`).run(voiceText.trim(), voiceLanguage, now, segmentId).changes !== 1) {
        throw new Error("room-lifecycle-segment-invalid");
      }
    });
  }
  failLifecycleTurn(turnId: string, status: "failed" | "unknown" | "cancelled" | "blocked", reason: string,
    ownerToken: string, now: number): void {
    if (!code(reason) || !["failed","unknown","cancelled","blocked"].includes(status)) throw new Error("room-lifecycle-turn-invalid");
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      const turn = this.db.prepare("SELECT request_id,status FROM room_lifecycle_turns WHERE turn_id=?").get(turnId);
      if (!turn || !["pending","generating"].includes(String(turn.status))) return;
      this.db.prepare("UPDATE room_lifecycle_turns SET status=?,reason=?,updated_at=? WHERE turn_id=?").run(status, reason, now, turnId);
      this.db.prepare(`UPDATE room_lifecycle_segments SET state=?,reason=?,updated_at=?
        WHERE turn_id=? AND state NOT IN ('completed','failed','unknown','cancelled','blocked','skipped')`)
        .run(status, reason, now, turnId);
      this.lifecycleSettleRequest(String(turn.request_id), now);
    });
  }
  claimLifecycleDelivery(requestId: string, ownerToken: string, now: number): boolean {
    return this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      if (this.state().paused) return false;
      this.expireLifecycleRequests(now);
      const request = this.lifecycleRequestById(requestId);
      if (!request || !["queued","generating","delivering"].includes(request.status)) return false;
      const head = this.db.prepare("SELECT request_id FROM room_lifecycle_requests WHERE status IN ('queued','generating','delivering') ORDER BY accept_seq LIMIT 1").get();
      if (String(head?.request_id ?? "") !== requestId) return false;
      const turns = this.lifecycleTurns(requestId);
      if (turns.some(t => t.status === "pending" || t.status === "generating")) return false;
      if (!turns.some(t => t.status === "ready" || t.status === "delivering")) return false;
      if (this.db.prepare(`UPDATE room_lifecycle_requests SET status='delivering',
        execution_revision=?,updated_at=? WHERE request_id=? AND status IN ('queued','generating','delivering')`)
        .run(this.state().execution_revision, now, requestId).changes !== 1) return false;
      this.db.prepare("UPDATE room_lifecycle_turns SET status='delivering',updated_at=? WHERE request_id=? AND status='ready'")
        .run(now, requestId);
      this.lifecycleSettleRequest(requestId, now);
      return true;
    });
  }
  lifecycleHeadRequest(): LifecycleRequest | null {
    const row = this.db.prepare(`SELECT * FROM room_lifecycle_requests
      WHERE status IN ('queued','generating','delivering') ORDER BY accept_seq LIMIT 1`).get();
    return row ? this.lifecycleRequest(row as Record<string, unknown>) : null;
  }
  lifecycleDeliveryItems(requestId: string): readonly LifecycleDeliveryItem[] {
    const request = this.lifecycleRequestById(requestId);
    if (!request) return [];
    const turns = this.lifecycleTurns(requestId);
    return turns.flatMap(turn => turn.status === "ready" || turn.status === "delivering"
      ? this.lifecycleSegments(turn.turnId).flatMap(segment => {
        if (segment.state !== "pending" && segment.state !== "text_sent") return [];
        const character = this.config.characters.find(c => c.id === turn.characterId);
        if (!character) throw new Error("room-lifecycle-payload-invalid");
        return [Object.freeze({ request, turn, segment, character })];
      }) : []);
  }
  lifecycleAudit(limit = 500): readonly LifecycleAuditRow[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000) throw new Error("room-lifecycle-audit-invalid");
    const requests = this.db.prepare(`SELECT request_id,accept_seq,status,outcome_reason,source
      FROM room_lifecycle_requests ORDER BY accept_seq DESC LIMIT ?`).all(limit);
    const rows: LifecycleAuditRow[] = [];
    for (const request of requests) {
      const requestId = String(request.request_id);
      for (const turn of this.lifecycleTurns(requestId)) {
        const segments = this.lifecycleSegments(turn.turnId);
        if (!segments.length) {
          rows.push(Object.freeze({ requestId, acceptSeq: Number(request.accept_seq),
            requestStatus: String(request.status) as LifecycleRequestStatus,
            requestReason: request.outcome_reason === null ? null : String(request.outcome_reason),
            source: String(request.source) as Trigger, turnId: turn.turnId, characterId: turn.characterId,
            mentionIndex: turn.mentionIndex, turnStatus: turn.status, turnReason: turn.reason,
            segmentId: null, segmentIndex: null, segmentStatus: null, segmentReason: null,
            attemptId: null, medium: null, startedAt: null, receipts: Object.freeze([]) }));
          continue;
        }
        for (const segment of segments) {
          const attempts = this.db.prepare(`SELECT attempt_id,medium,started_at
            FROM room_lifecycle_attempts WHERE segment_id=? ORDER BY intent_at,rowid`).all(segment.segmentId);
          if (!attempts.length) {
            rows.push(Object.freeze({ requestId, acceptSeq: Number(request.accept_seq),
              requestStatus: String(request.status) as LifecycleRequestStatus,
              requestReason: request.outcome_reason === null ? null : String(request.outcome_reason),
              source: String(request.source) as Trigger, turnId: turn.turnId, characterId: turn.characterId,
              mentionIndex: turn.mentionIndex, turnStatus: turn.status, turnReason: turn.reason,
              segmentId: segment.segmentId, segmentIndex: segment.segmentIndex, segmentStatus: segment.state,
              segmentReason: segment.reason, attemptId: null, medium: null, startedAt: null,
              receipts: Object.freeze([]) }));
            continue;
          }
          for (const attempt of attempts) {
            const attemptId = String(attempt.attempt_id);
            rows.push(Object.freeze({ requestId, acceptSeq: Number(request.accept_seq),
              requestStatus: String(request.status) as LifecycleRequestStatus,
              requestReason: request.outcome_reason === null ? null : String(request.outcome_reason),
              source: String(request.source) as Trigger, turnId: turn.turnId, characterId: turn.characterId,
              mentionIndex: turn.mentionIndex, turnStatus: turn.status, turnReason: turn.reason,
              segmentId: segment.segmentId, segmentIndex: segment.segmentIndex, segmentStatus: segment.state,
              segmentReason: segment.reason, attemptId, medium: String(attempt.medium) as "text" | "audio",
              startedAt: attempt.started_at === null ? null : Number(attempt.started_at),
              receipts: Object.freeze(this.lifecycleReceipts(attemptId).map(receipt => receipt.kind)) }));
          }
        }
      }
    }
    return Object.freeze(rows);
  }
  setLifecycleSegment(segmentId: string, state: LifecycleSegmentState, reason: string | null, ownerToken: string, now: number): void {
    if (!["text_sending","text_sent","audio_sending","audio_sent","completed","failed","unknown","cancelled","blocked"].includes(state)
      || (reason !== null && !code(reason))) throw new Error("room-lifecycle-segment-invalid");
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      this.db.prepare("UPDATE room_lifecycle_segments SET state=?,reason=?,updated_at=? WHERE segment_id=? AND state NOT IN ('completed','failed','unknown','cancelled','blocked')")
        .run(state, reason, now, segmentId);
    });
  }
  markLifecycleDependencyUnknown(segmentId: string, reason: string, ownerToken: string, now: number): void {
    if (!code(reason)) throw new Error("room-lifecycle-segment-invalid");
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      const row = this.db.prepare("SELECT s.turn_id,t.request_id FROM room_lifecycle_segments s JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id WHERE s.segment_id=?").get(segmentId);
      if (!row) return;
      this.db.prepare("UPDATE room_lifecycle_segments SET state='unknown',reason=?,updated_at=? WHERE segment_id=? AND state NOT IN ('completed','failed','unknown','cancelled','blocked')")
        .run(reason, now, segmentId);
      this.db.prepare(`UPDATE room_lifecycle_segments SET state='blocked',reason='dependency_unknown',updated_at=?
        WHERE turn_id=? AND segment_index>(SELECT segment_index FROM room_lifecycle_segments WHERE segment_id=?)
          AND state NOT IN ('completed','failed','unknown','cancelled','blocked')`).run(now, String(row.turn_id), segmentId);
      this.db.prepare("UPDATE room_lifecycle_turns SET status='unknown',reason=?,updated_at=? WHERE turn_id=? AND status IN ('ready','delivering','generating')")
        .run(reason, now, String(row.turn_id));
      this.lifecycleSettleRequest(String(row.request_id), now);
    });
  }
  finishLifecycleSegment(segmentId: string, outcome: "completed" | "failed" | "unknown" | "cancelled" | "blocked",
    reason: string, ownerToken: string, now: number): void {
    if (!code(reason)) throw new Error("room-lifecycle-segment-invalid");
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      const row = this.db.prepare(`SELECT s.turn_id,s.state,t.request_id,t.mention_index
        FROM room_lifecycle_segments s JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
        WHERE s.segment_id=?`).get(segmentId);
      if (!row) return;
      if (this.lifecycleSegmentTerminal(String(row.state) as LifecycleSegmentState)) return;
      const changed = this.db.prepare(`UPDATE room_lifecycle_segments SET state=?,reason=?,updated_at=?
        WHERE segment_id=? AND state NOT IN ('completed','failed','unknown','cancelled','blocked','skipped')`)
        .run(outcome, reason, now, segmentId).changes;
      if (changed !== 1) return;
      const turn = String(row.turn_id), requestId = String(row.request_id);
      const remaining = this.lifecycleSegments(turn).some(s => s.state === "pending");
      if (!remaining) {
        const failure = this.lifecycleSegments(turn).find(s =>
          s.state === "unknown" || s.state === "failed" || s.state === "cancelled" || s.state === "blocked");
        const state = failure?.state ?? "completed";
        this.db.prepare(`UPDATE room_lifecycle_turns SET status=?,reason=?,updated_at=?
          WHERE turn_id=? AND status NOT IN ('completed','failed','unknown','cancelled','blocked','skipped')`)
          .run(state, failure?.reason ?? (state === "completed" ? null : reason), now, turn);
        if (outcome !== "completed") {
          this.db.prepare(`UPDATE room_lifecycle_segments SET state='blocked',reason='dependency_unknown',updated_at=?
            WHERE turn_id=? AND segment_index>(SELECT segment_index FROM room_lifecycle_segments WHERE segment_id=?)
              AND state='pending'`).run(now, turn, segmentId);
        }
      }
      this.lifecycleSettleRequest(requestId, now);
    });
  }
  applyLifecycleMode(mode: "mention_only" | "ambient", eventKey: string, expectedEpoch: number, ownerToken: string, now: number): RoomControlResult {
    if ((mode !== "mention_only" && mode !== "ambient") || typeof eventKey !== "string"
      || !/^[0-9a-f]{64}$/.test(eventKey) || !timestamp(now)) throw new Error("room-lifecycle-mode-invalid");
    return this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      this.assertEpoch(expectedEpoch);
      const existing = this.controlResultForEvent(eventKey);
      if (existing) {
        return checkedRoomControlResult({
          kind: "duplicate", action: "set_mode", reason: "duplicate_control",
          ...this.lifecycleControlState(), cancelledQueued: 0, cancelledActive: false,
        });
      }
      const before = this.lifecycleControlState();
      if (before.mode === mode) {
        const result = { kind: "ignored" as const, action: "set_mode" as const, reason: "already_in_mode", ...before,
          cancelledQueued: 0, cancelledActive: false };
        this.db.prepare("INSERT INTO room_seen(id,created_at,control_result) VALUES (?,?,?)").run(eventKey, now, JSON.stringify(result));
        return result;
      }
      const cancelledQueued = Number(this.db.prepare(`SELECT count(*) AS n FROM room_lifecycle_requests
        WHERE status IN ('queued','generating','delivering')`).get()!.n);
      this.cancelLifecycleRequests("all", "mode_changed", now);
      const revision = before.executionRevision + 1;
      this.db.prepare("UPDATE room_state SET mode='mention_only',lifecycle_mode=?,paused=0,execution_revision=?,session_expires_at=NULL WHERE id=1")
        .run(mode, revision);
      if (this.db.prepare("UPDATE room_lifecycle_owner SET execution_revision=? WHERE id=1 AND owner_token=?")
        .run(revision, ownerToken).changes !== 1) throw new Error("room-lifecycle-owner-lost");
      const after = this.lifecycleControlState();
      const result = { kind: "applied" as const, action: "set_mode" as const, reason: null, ...after,
        cancelledQueued, cancelledActive: cancelledQueued > 0 };
      this.db.prepare("INSERT INTO room_seen(id,created_at,control_result) VALUES (?,?,?)").run(eventKey, now, JSON.stringify(result));
      return result;
    });
  }
  cancelLifecycleAll(reason: string, now: number): void {
    if (!code(reason) || !timestamp(now)) throw new Error("room-lifecycle-cancel-invalid");
    this.transaction(() => {
      this.cancelLifecycleRequests("all", reason, now);
      this.db.prepare("UPDATE room_state SET execution_revision=execution_revision+1 WHERE id=1").run();
      const revision = this.state().execution_revision;
      if (this.db.prepare("UPDATE room_lifecycle_owner SET execution_revision=? WHERE id=1").run(revision).changes !== 1)
        throw new Error("room-lifecycle-owner-lost");
    });
  }
  recoverLifecycle(now: number): void {
    if (!timestamp(now)) throw new Error("room-lifecycle-recovery-invalid");
    this.transaction(() => {
      for (const request of this.db.prepare("SELECT request_id FROM room_lifecycle_requests WHERE status IN ('queued','generating','delivering')").all()) {
        const requestId = String(request.request_id);
        for (const turn of this.lifecycleTurns(requestId)) {
          for (const segment of this.lifecycleSegments(turn.turnId)) {
            this.abandonLifecycleSegment(segment.segmentId, "restart_not_resumed", now);
          }
          this.lifecycleSettleTurn(turn.turnId, now);
          const settled = this.lifecycleTurns(requestId).find(item => item.turnId === turn.turnId);
          if (settled && ["pending","generating","ready","delivering"].includes(settled.status)) {
            this.db.prepare("UPDATE room_lifecycle_turns SET status='cancelled',reason='restart_not_resumed',updated_at=? WHERE turn_id=?")
              .run(now, turn.turnId);
          }
        }
        this.lifecycleSettleRequest(requestId, now);
        this.db.prepare(`UPDATE room_lifecycle_requests SET status='restart_not_resumed',
          outcome_reason='restart_not_resumed',updated_at=?
          WHERE request_id=? AND status IN ('queued','generating','delivering')`).run(now, requestId);
      }
      this.recoverNotSentLifecycleAudioFence();
      this.db.prepare("DELETE FROM room_lifecycle_owner").run();
    });
  }
  acquireLifecycleOwner(token: string, expectedEpoch: number, leaseUntil: number, now: number): void {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token) || !timestamp(expectedEpoch) || !timestamp(leaseUntil) || leaseUntil < now) throw new Error("room-lifecycle-owner-invalid");
    this.transaction(() => {
      this.assertEpoch(expectedEpoch);
      const row = this.db.prepare("SELECT owner_token,lease_until FROM room_lifecycle_owner WHERE id=1").get();
      if (row && row.owner_token !== token && Number(row.lease_until) >= now) throw new Error("room-lifecycle-owner-held");
      if (row && row.owner_token !== token) {
        // Replacing an expired owner is a new execution revision, never an
        // implicit continuation of its unsent work.
        this.cancelLifecycleRequests("all", "owner_expired", now);
        this.db.prepare("UPDATE room_state SET execution_revision=execution_revision+1 WHERE id=1").run();
      }
      const revision = this.state().execution_revision;
      this.db.prepare("INSERT INTO room_lifecycle_owner(id,owner_token,lease_until,execution_epoch,execution_revision) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_token=excluded.owner_token,lease_until=excluded.lease_until,execution_epoch=excluded.execution_epoch,execution_revision=excluded.execution_revision")
        .run(token, leaseUntil, expectedEpoch, revision);
    });
  }
  renewLifecycleOwner(token: string, leaseUntil: number, now: number): void {
    if (!timestamp(leaseUntil) || leaseUntil < now) throw new Error("room-lifecycle-owner-invalid");
    this.db.prepare("UPDATE room_lifecycle_owner SET lease_until=? WHERE id=1 AND owner_token=? AND lease_until>=?")
      .run(leaseUntil, token, now);
    if (!this.lifecycleOwnerValid(token, now)) throw new Error("room-lifecycle-owner-lost");
  }
  lifecycleOwnerValid(token: string, now: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM room_lifecycle_owner WHERE id=1 AND owner_token=? AND lease_until>=? AND execution_epoch=? AND execution_revision=?")
      .get(token, now, this.state().epoch, this.state().execution_revision));
  }
  private assertLifecycleOwner(token: string, now: number): void {
    if (!this.lifecycleOwnerValid(token, now)) throw new Error("room-lifecycle-owner-lost");
  }
  lifecycleAttempt(id: string): LifecycleAttempt | undefined {
    return this.db.prepare(`SELECT attempt_id AS attemptId,segment_id AS segmentId,request_id AS requestId,
      turn_id AS turnId,account_key AS accountKey,medium,revision,intent_at AS intentAt,started_at AS startedAt,
      owner_token AS ownerToken,committed_row_id AS committedRowId
      FROM room_lifecycle_attempts WHERE attempt_id=?`).get(id) as unknown as LifecycleAttempt | undefined;
  }
  lifecycleReceipts(id: string): readonly { kind: "ack" | "rejected" | "uncertain"; messageId: string | null; observedAt: number }[] {
    return this.db.prepare("SELECT kind,message_id AS messageId,observed_at AS observedAt FROM room_lifecycle_receipts WHERE attempt_id=? ORDER BY observed_at,rowid")
      .all(id) as unknown as { kind: "ack" | "rejected" | "uncertain"; messageId: string | null; observedAt: number }[];
  }
  recordLifecycleIntent(segmentId: string, medium: "text" | "audio", ownerToken: string, now: number): LifecycleAttempt {
    return this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      const row = this.db.prepare(`SELECT s.turn_id,s.segment_index,s.delivery_mode,s.state AS segment_state,
        t.request_id,t.mention_index,t.character_id,t.status AS turn_status,
        r.status AS request_status,r.accept_seq,r.expires_at,r.execution_epoch,r.execution_revision
        FROM room_lifecycle_segments s JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
        JOIN room_lifecycle_requests r ON r.request_id=t.request_id
        WHERE s.segment_id=?`).get(segmentId);
      if (!row || !["text","audio"].includes(medium) || row.request_status !== "delivering"
        || !["ready","delivering"].includes(String(row.turn_status))
        || Number(row.expires_at) <= now
        || Number(row.execution_epoch) !== this.state().epoch
        || Number(row.execution_revision) !== this.state().execution_revision) {
        throw new Error("room-lifecycle-attempt-invalid");
      }
      const head = this.db.prepare(`SELECT request_id FROM room_lifecycle_requests
        WHERE status IN ('queued','generating','delivering') ORDER BY accept_seq LIMIT 1`).get();
      if (String(head?.request_id ?? "") !== String(row.request_id)) throw new Error("room-lifecycle-fifo-blocked");
      if (medium === "text") {
        if (row.segment_state !== "pending" || row.delivery_mode === "voice") throw new Error("room-lifecycle-attempt-invalid");
        const earlier = this.db.prepare(`SELECT 1 FROM room_lifecycle_segments s
          JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
          WHERE t.request_id=? AND s.state NOT IN ('completed','failed','unknown','cancelled','blocked','skipped')
            AND (t.mention_index<? OR (t.mention_index=? AND s.segment_index<?)) LIMIT 1`)
          .get(String(row.request_id), Number(row.mention_index), Number(row.mention_index), Number(row.segment_index));
        if (earlier) throw new Error("room-lifecycle-fifo-blocked");
      } else {
        if (row.delivery_mode !== "both" || row.segment_state !== "text_sent") throw new Error("room-lifecycle-attempt-invalid");
      }
      const character = this.config.characters.find(item => item.id === String(row.character_id));
      if (!character) throw new Error("room-lifecycle-attempt-invalid");
      const attemptId = randomUUID();
      this.db.prepare(`INSERT INTO room_lifecycle_attempts
        (attempt_id,segment_id,request_id,turn_id,account_key,medium,revision,intent_at,started_at,owner_token,committed_row_id)
        VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL)`).run(attemptId, segmentId, String(row.request_id), String(row.turn_id),
        character.accountKey, medium, this.state().execution_revision, now, ownerToken);
      return this.lifecycleAttempt(attemptId)!;
    });
  }
  recordLifecycleStarted(id: string, ownerToken: string, now: number): void {
    this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      const attempt = this.lifecycleAttempt(id);
      if (!attempt || attempt.startedAt !== null || attempt.ownerToken !== ownerToken
        || attempt.revision !== this.state().execution_revision || now < attempt.intentAt)
        throw new Error("room-lifecycle-attempt-invalid");
      const request = this.lifecycleRequestById(attempt.requestId);
      if (!request || request.expiresAt <= now || request.executionEpoch !== this.state().epoch
        || request.executionRevision !== this.state().execution_revision
        || !["generating","delivering"].includes(request.status)) {
        throw new Error("room-lifecycle-attempt-invalid");
      }
      if (!this.canSpend("send", now)) throw new Error("room-delivery-send-budget");
      if (attempt.medium === "audio") {
        if (this.db.prepare("SELECT 1 FROM room_lifecycle_audio_fence WHERE id=1").get())
          throw new Error("room-lifecycle-audio-busy");
        this.db.prepare("INSERT INTO room_lifecycle_audio_fence(id,attempt_id,started_at) VALUES (1,?,?)")
          .run(id, now);
      }
      if (this.db.prepare("UPDATE room_lifecycle_attempts SET started_at=? WHERE attempt_id=? AND started_at IS NULL").run(now, id).changes !== 1)
        throw new Error("room-lifecycle-attempt-invalid");
      const expected = attempt.medium === "text" ? "pending" : "text_sent";
      if (this.db.prepare("UPDATE room_lifecycle_segments SET state=?,updated_at=? WHERE segment_id=? AND state=?")
        .run(attempt.medium === "text" ? "text_sending" : "audio_sending", now, attempt.segmentId, expected).changes !== 1)
        throw new Error("room-lifecycle-attempt-invalid");
      this.db.prepare("INSERT INTO room_budget(kind,created_at) VALUES ('send',?)").run(now);
      this.db.prepare("UPDATE room_lifecycle_turns SET status='delivering',updated_at=? WHERE turn_id=? AND status='ready'")
        .run(now, attempt.turnId);
    });
  }
  recordLifecycleObservation(id: string, observation: RoomDeliveryObservation, ownerToken: string | null, now: number): void {
    if (!observation || !["ack", "rejected", "uncertain"].includes(observation.kind)
      || (observation.kind === "ack" && (typeof observation.messageId !== "string"
        || qqMessageId(observation.messageId) !== observation.messageId))) {
      throw new Error("room-lifecycle-receipt-invalid");
    }
    this.transaction(() => {
      const attempt = this.lifecycleAttempt(id);
      if (!attempt || attempt.startedAt === null || now < attempt.startedAt
        || (ownerToken !== null && ownerToken !== attempt.ownerToken))
        throw new Error("room-lifecycle-receipt-invalid");
      const previous = this.lifecycleReceipts(id);
      const same = previous.find(r => r.kind === observation.kind);
      if (same) return;
      if ((observation.kind === "ack" && previous.some(r => r.kind === "rejected"))
        || (observation.kind === "rejected" && previous.some(r => r.kind === "ack"))) throw new Error("room-lifecycle-receipt-conflict");
      this.db.prepare("INSERT INTO room_lifecycle_receipts VALUES (?,?,?,?)").run(id, observation.kind,
        observation.kind === "ack" ? observation.messageId : null, now);
    });
  }
  lifecycleCanSend(segmentId: string, ownerToken: string, now: number): boolean {
    if (!this.lifecycleOwnerValid(ownerToken, now)) return false;
    const state = this.state();
    return Boolean(this.db.prepare(`SELECT 1 FROM room_lifecycle_segments s
      JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
      JOIN room_lifecycle_requests r ON r.request_id=t.request_id
      WHERE s.segment_id=? AND s.state IN ('pending','text_sent') AND r.status='delivering'
        AND r.execution_epoch=? AND r.execution_revision=?
        AND t.status IN ('ready','delivering')`).get(segmentId, state.epoch, state.execution_revision));
  }
  commitLifecycleText(attemptId: string, receiptId: string, ownerToken: string, now: number): number {
    return this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      if (!qqMessageId(receiptId)) throw new Error("room-lifecycle-receipt-invalid");
      const attempt = this.lifecycleAttempt(attemptId);
      if (!attempt || attempt.medium !== "text" || attempt.startedAt === null || attempt.ownerToken !== ownerToken
        || attempt.revision !== this.state().execution_revision
        || !this.lifecycleReceipts(attemptId).some(receipt => receipt.kind === "ack" && receipt.messageId === receiptId))
        throw new Error("room-lifecycle-attempt-invalid");
      const row = this.db.prepare(`SELECT s.segment_id,s.semantic_text,s.state,s.delivery_mode,t.turn_id,t.character_id,r.message_row_id
        FROM room_lifecycle_segments s JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
        JOIN room_lifecycle_requests r ON r.request_id=t.request_id WHERE s.segment_id=?`).get(attempt.segmentId);
      if (!row || row.state !== "text_sending") throw new Error("room-lifecycle-segment-invalid");
      const character = this.config.characters.find(c => c.id === String(row.character_id));
      if (!character) throw new Error("room-lifecycle-segment-invalid");
      const messageId = this.append("bot", character.id, character.accountKey, Number(row.message_row_id),
        String(row.semantic_text), receiptId, now, "text");
      if (this.db.prepare("UPDATE room_lifecycle_attempts SET committed_row_id=? WHERE attempt_id=? AND committed_row_id IS NULL")
        .run(messageId, attemptId).changes !== 1) throw new Error("room-lifecycle-attempt-invalid");
      this.db.prepare("UPDATE room_lifecycle_segments SET state=?,updated_at=? WHERE segment_id=? AND state='text_sending'")
        .run(row.delivery_mode === "text" ? "completed" : "text_sent", now, attempt.segmentId);
      this.lifecycleSettleTurn(String(row.turn_id), now);
      this.lifecycleSettleRequest(attempt.requestId, now);
      return messageId;
    });
  }
  commitLifecycleVoice(attemptId: string, receiptId: string, ownerToken: string, now: number): number {
    return this.transaction(() => {
      this.assertLifecycleOwner(ownerToken, now);
      if (!qqMessageId(receiptId)) throw new Error("room-lifecycle-receipt-invalid");
      const attempt = this.lifecycleAttempt(attemptId);
      if (!attempt || attempt.medium !== "audio" || attempt.startedAt === null || attempt.ownerToken !== ownerToken
        || attempt.revision !== this.state().execution_revision
        || !this.lifecycleReceipts(attemptId).some(receipt => receipt.kind === "ack" && receipt.messageId === receiptId))
        throw new Error("room-lifecycle-attempt-invalid");
      const row = this.db.prepare(`SELECT s.segment_id,s.voice_text,s.state,s.delivery_mode,t.turn_id,t.character_id,r.message_row_id
        FROM room_lifecycle_segments s JOIN room_lifecycle_turns t ON t.turn_id=s.turn_id
        JOIN room_lifecycle_requests r ON r.request_id=t.request_id WHERE s.segment_id=?`).get(attempt.segmentId);
      if (!row || row.state !== "audio_sending" || typeof row.voice_text !== "string" || !String(row.voice_text).trim())
        throw new Error("room-lifecycle-segment-invalid");
      const character = this.config.characters.find(c => c.id === String(row.character_id));
      if (!character) throw new Error("room-lifecycle-segment-invalid");
      const messageId = this.append("bot", character.id, character.accountKey, Number(row.message_row_id),
        String(row.voice_text), receiptId, now, "voice");
      if (this.db.prepare("UPDATE room_lifecycle_attempts SET committed_row_id=? WHERE attempt_id=? AND committed_row_id IS NULL")
        .run(messageId, attemptId).changes !== 1) throw new Error("room-lifecycle-attempt-invalid");
      this.db.prepare("UPDATE room_lifecycle_segments SET state='completed',updated_at=? WHERE segment_id=? AND state='audio_sending'")
        .run(now, attempt.segmentId);
      this.lifecycleSettleTurn(String(row.turn_id), now);
      this.lifecycleSettleRequest(attempt.requestId, now);
      return messageId;
    });
  }
  finishLifecycleAttempt(attemptId: string, outcome: "failed" | "unknown" | "cancelled" | "blocked",
    reason: string, ownerToken: string, now: number): void {
    if (!code(reason) || !["failed","unknown","cancelled","blocked"].includes(outcome))
      throw new Error("room-lifecycle-segment-invalid");
    this.transaction(() => {
      this.settleLifecycleAttempt(attemptId, outcome, reason, ownerToken, now);
    });
  }
  finishLifecycleAttemptNotSent(attemptId: string, ownerToken: string, now: number): void {
    if (!timestamp(now)) throw new Error("room-lifecycle-attempt-invalid");
    this.transaction(() => {
      const attempt = this.lifecycleAttempt(attemptId);
      if (!attempt || attempt.startedAt === null || attempt.ownerToken !== ownerToken)
        throw new Error("room-lifecycle-attempt-invalid");
      if (attempt.medium === "audio") {
        const fence = this.db.prepare("SELECT attempt_id AS attemptId,started_at AS startedAt FROM room_lifecycle_audio_fence WHERE id=1")
          .get();
        if (!fence || fence.attemptId !== attemptId || Number(fence.startedAt) !== attempt.startedAt)
          throw new Error("room-lifecycle-attempt-invalid");
      }
      if (!this.settleLifecycleAttempt(attemptId, "failed", "delivery_not_sent", ownerToken, now))
        throw new Error("room-lifecycle-attempt-invalid");
      if (attempt.medium === "audio"
        && this.db.prepare("DELETE FROM room_lifecycle_audio_fence WHERE id=1 AND attempt_id=? AND started_at=?")
          .run(attemptId, attempt.startedAt).changes !== 1) {
        throw new Error("room-lifecycle-attempt-invalid");
      }
    });
  }
  private settleLifecycleAttempt(attemptId: string, outcome: "failed" | "unknown" | "cancelled" | "blocked",
    reason: string, ownerToken: string, now: number): boolean {
    const attempt = this.lifecycleAttempt(attemptId);
    if (!attempt || attempt.ownerToken !== ownerToken) throw new Error("room-lifecycle-attempt-invalid");
    const segment = this.db.prepare("SELECT turn_id,state FROM room_lifecycle_segments WHERE segment_id=?")
      .get(attempt.segmentId);
    if (!segment || this.lifecycleSegmentTerminal(String(segment.state) as LifecycleSegmentState)) return false;
    const changed = this.db.prepare(`UPDATE room_lifecycle_segments SET state=?,reason=?,updated_at=?
      WHERE segment_id=? AND state NOT IN ('completed','failed','unknown','cancelled','blocked','skipped')`)
      .run(outcome, reason, now, attempt.segmentId).changes;
    if (changed !== 1) return false;
    this.blockDependentLifecycleSegments(String(segment.turn_id), attempt.segmentId, "dependency_unknown", now);
    this.db.prepare(`UPDATE room_lifecycle_turns SET status=?,reason=?,updated_at=?
      WHERE turn_id=? AND status NOT IN ('completed','failed','unknown','cancelled','blocked','skipped')`)
      .run(outcome, reason, now, attempt.turnId);
    this.lifecycleSettleRequest(attempt.requestId, now);
    return true;
  }
  private recoverNotSentLifecycleAudioFence(): void {
    const row = this.db.prepare(`SELECT f.attempt_id AS attemptId,f.started_at AS startedAt
      FROM room_lifecycle_audio_fence f
      JOIN room_lifecycle_attempts a ON a.attempt_id=f.attempt_id
      JOIN room_lifecycle_segments s ON s.segment_id=a.segment_id
      JOIN room_lifecycle_turns t ON t.turn_id=a.turn_id
      WHERE f.id=1 AND a.medium='audio' AND a.started_at IS NOT NULL
        AND a.committed_row_id IS NULL AND length(a.owner_token)>0
        AND f.started_at=a.started_at
        AND s.state='failed' AND s.reason='delivery_not_sent'
        AND t.status='failed' AND t.reason='delivery_not_sent'
        AND NOT EXISTS (SELECT 1 FROM room_lifecycle_receipts r WHERE r.attempt_id=a.attempt_id)`).get();
    if (!row) return;
    if (this.db.prepare("DELETE FROM room_lifecycle_audio_fence WHERE id=1 AND attempt_id=? AND started_at=?")
      .run(String(row.attemptId), Number(row.startedAt)).changes !== 1) {
      throw new Error("room-lifecycle-recovery-invalid");
    }
  }
  releaseLifecycleAudioFence(attemptId: string, physicalSettled: boolean): boolean {
    if (!physicalSettled || typeof attemptId !== "string" || !attemptId) return false;
    const attempt = this.lifecycleAttempt(attemptId);
    if (!attempt || attempt.medium !== "audio" || attempt.startedAt === null) return false;
    return this.db.prepare("DELETE FROM room_lifecycle_audio_fence WHERE id=1 AND attempt_id=?").run(attemptId).changes === 1;
  }
  lifecycleAudioFence(): string | null {
    const row = this.db.prepare("SELECT attempt_id FROM room_lifecycle_audio_fence WHERE id=1").get();
    return row ? String(row.attempt_id) : null;
  }
  hasUnresolvedLifecycleDelivery(): boolean {
    // ACK/rejected/uncertain receipts settle the durable delivery fact. Only
    // an audio physical call that has not returned still owns a cross-process
    // fence that close/recovery must not erase.
    return Boolean(this.lifecycleAudioFence());
  }
  setLifecyclePauseListener(listener: ((paused: boolean) => void) | undefined): void {
    this.lifecyclePauseListener = listener;
  }
  /**
   * Pausing is a lifecycle fence: it advances execution_revision so in-flight
   * generation/delivery controllers fail their revision checks. Resuming does
   * not advance it, so admitted work can be re-stamped by the next claim.
   */
  setPaused(paused: boolean): void {
    const changed = this.transaction(() => {
      if (Boolean(this.state().paused) === paused) return false;
      if (paused) {
        this.db.prepare("UPDATE room_state SET paused=1,execution_revision=execution_revision+1 WHERE id=1").run();
        this.db.prepare(`UPDATE room_lifecycle_owner SET execution_revision=
          (SELECT execution_revision FROM room_state WHERE id=1) WHERE id=1`).run();
      } else {
        this.db.prepare("UPDATE room_state SET paused=0 WHERE id=1").run();
      }
      return true;
    });
    if (changed) {
      try { this.lifecyclePauseListener?.(paused); }
      catch { /* The committed fence stands even if the runtime notification fails. */ }
    }
  }
  deliveryMode(): RoomDeliveryMode { const s = this.state(); return s.delivery_mode ?? (s.voice ? "both" : "text"); }
  setDeliveryMode(mode: RoomDeliveryMode) {
    this.db.prepare("UPDATE room_state SET delivery_mode=?,voice=? WHERE id=1").run(mode, Number(mode !== "text"));
  }
  setVoice(voice: boolean) { this.setDeliveryMode(voice ? "both" : "text"); }
  actor(rawId: string): string { return `member-${createHmac("sha256", this.actorKey).update(rawId).digest("hex").slice(0, 16)}`; }
  rememberInput(input: RoomInput, now: number): boolean {
    const id = this.eventKey(input);
    return this.db.prepare("INSERT OR IGNORE INTO room_seen(id,created_at) VALUES (?,?)").run(id, now).changes === 1;
  }
  appendUser(input: RoomInput, now: number, targetId: number | null = null): number {
    return this.append("user", this.actor(input.senderId), input.accountKey, targetId, input.text, input.messageId, now);
  }
  private append(kind: "user" | "bot", actor: string, account: string, target: number | null,
    text: string, platformId: string, now: number, medium: "text" | "voice" = "text"): number {
    const write = () => {
      const result = this.db.prepare(`INSERT INTO room_messages
        (speaker_type,speaker_id,account_key,target_id,text,platform_id,created_at,medium) VALUES (?,?,?,?,?,?,?,?)`)
        .run(kind, actor, account, target, text, platformId, now, medium);
      if (result.changes !== 1) throw new Error("room-message-not-inserted");
      const id = Number(result.lastInsertRowid);
      const row = this.db.prepare("SELECT * FROM room_messages WHERE id=?").get(id);
      if (!row || row.speaker_type !== kind || row.speaker_id !== actor || row.account_key !== account
        || row.target_id !== target || row.text !== text || row.platform_id !== platformId || row.created_at !== now || row.medium !== medium)
        throw new Error("room-message-insert-conflict");
      // Validate BEFORE pruning: cleanup must never launder a missing/mismatched fact.
      this.checkWorkerBindings();
      const age = this.db.prepare("SELECT id FROM room_messages WHERE created_at < ?").all(now - 7 * 86400000);
      this.pruneWorkerMessages(age.map(r => Number(r.id)), "age", now);
      const cutoff = now - 7 * 86400000;
      this.db.prepare("UPDATE room_deliveries SET semantic_text=NULL,voice_text=NULL WHERE created_at < ?").run(cutoff);
      if (this.db.prepare("SELECT 1 FROM room_deliveries WHERE created_at < ? AND (semantic_text IS NOT NULL OR voice_text IS NOT NULL)").get(cutoff))
        throw new Error("room-message-prune-conflict");
      this.checkWorkerBindings();
      return id;
    };
    return this.db.isTransaction ? write() : this.transaction(write);
  }
  private pruneWorkerMessages(ids: number[], reason: "age" | "count", now: number): void {
    for (const id of ids) {
      const d = this.db.prepare("SELECT id,worker_projection FROM room_deliveries WHERE worker_binding IS NOT NULL AND worker_text_row_id=?").get(id);
      if (d) {
        const fact = JSON.parse(String(d.worker_projection));
        const pruned = JSON.stringify({ ...fact, state: "pruned", prunedAt: now, reason });
        if (this.db.prepare("UPDATE room_deliveries SET worker_projection=? WHERE id=? AND worker_projection=?")
          .run(pruned, d.id!, d.worker_projection!).changes !== 1
          || this.db.prepare("SELECT worker_projection FROM room_deliveries WHERE id=?").get(d.id!)?.worker_projection !== pruned)
          throw new Error("room-worker-projection-prune-conflict");
      }
      if (this.db.prepare("DELETE FROM room_messages WHERE id=?").run(id).changes !== 1
        || this.db.prepare("SELECT 1 FROM room_messages WHERE id=?").get(id)) throw new Error("room-message-prune-conflict");
    }
  }

  history(): RoomMessage[] {
    return this.db.prepare(`SELECT id,speaker_type AS speakerType,speaker_id AS speakerId,account_key AS accountKey,
      target_id AS targetId,text,platform_id AS platformId,created_at AS createdAt,medium FROM room_messages ORDER BY id`).all() as unknown as RoomMessage[];
  }
  /** Finite newest page, returned chronologically. No caller may omit the page limit. */
  historyPage(limit: number, options: { beforeId?: number; since?: number } = {}): RoomMessage[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) throw new Error("room-history-page-invalid");
    if (options.beforeId !== undefined && (!Number.isSafeInteger(options.beforeId) || options.beforeId <= 0)) {
      throw new Error("room-history-page-invalid");
    }
    if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < 0)) {
      throw new Error("room-history-page-invalid");
    }
    const clauses: string[] = [];
    const values: number[] = [];
    if (options.beforeId !== undefined) { clauses.push("id < ?"); values.push(options.beforeId); }
    if (options.since !== undefined) { clauses.push("created_at >= ?"); values.push(options.since); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT id,speaker_type AS speakerType,speaker_id AS speakerId,
      account_key AS accountKey,target_id AS targetId,text,platform_id AS platformId,
      created_at AS createdAt,medium FROM room_messages${where} ORDER BY id DESC LIMIT ?`)
      .all(...values, limit) as unknown as RoomMessage[];
    return rows.reverse();
  }
  historyMessage(id: number): RoomMessage | undefined {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("room-history-message-invalid");
    return this.db.prepare(`SELECT id,speaker_type AS speakerType,speaker_id AS speakerId,
      account_key AS accountKey,target_id AS targetId,text,platform_id AS platformId,
      created_at AS createdAt,medium FROM room_messages WHERE id=?`).get(id) as unknown as RoomMessage | undefined;
  }
  /** ACK IDs are account-local. Never infer cross-account mappings or fetch quoted bodies. */
  replyTarget(accountKey: string, platformId: string): RoomMessage | undefined {
    const rows = this.db.prepare(`SELECT DISTINCT m.id,m.speaker_type AS speakerType,m.speaker_id AS speakerId,
      m.account_key AS accountKey,m.target_id AS targetId,m.text,m.platform_id AS platformId,m.created_at AS createdAt,m.medium
      FROM room_messages m LEFT JOIN room_deliveries d
      ON m.speaker_type='bot' AND d.text_id=m.platform_id AND d.character_id=m.speaker_id AND d.account_key=m.account_key
      WHERE m.account_key=? AND (m.platform_id=? OR (d.audio_id=? AND d.state='delivered')) LIMIT 2`)
      .all(accountKey, platformId, platformId) as unknown as RoomMessage[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  begin(trigger: Trigger, targetId: number, now: number): { id: string; epoch: number } {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM room_work_items WHERE status='claimed'").get()
        || this.db.prepare("SELECT 1 FROM room_bursts WHERE state='running'").get()) throw new Error("room-burst-active");
      const id = randomUUID(), epoch = this.state().epoch;
      this.db.prepare("INSERT INTO room_bursts(id,epoch,trigger,target_id,state,created_at) VALUES (?,?,?,?,'running',?)").run(id, epoch, trigger, targetId, now);
      return { id, epoch };
    });
  }
  finishBurst(id: string, state: string) {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM room_work_items WHERE burst_id=? AND status='claimed'").get(id)) {
        throw new Error("room-work-burst-active");
      }
      this.db.prepare("UPDATE room_bursts SET state=? WHERE id=? AND state='running'").run(state, id);
    });
  }
  invalidate(): void {
    this.transaction(() => {
      this.db.exec(`UPDATE room_state SET epoch=epoch+1;
        UPDATE room_bursts SET state='stopped' WHERE state='running'
          AND NOT EXISTS (SELECT 1 FROM room_work_items w WHERE w.burst_id=room_bursts.id AND w.status='claimed');
        UPDATE room_deliveries SET state=CASE state WHEN 'text_sending' THEN 'text_uncertain'
          WHEN 'audio_sending' THEN 'audio_uncertain' ELSE 'stopped' END WHERE state IN (${ACTIVE});`);
    });
  }
  nextCharacter(): RoomCharacter {
    const index = this.state().next_index;
    const c = this.config.characters[index % this.config.characters.length]!;
    this.db.prepare("UPDATE room_state SET next_index=next_index+1").run();
    return c;
  }
  ambientAttempt(now: number): void {
    if (!timestamp(now)) throw new Error("room-ambient-attempt-invalid");
    this.db.prepare("UPDATE room_state SET ambient_at=? WHERE id=1").run(now);
  }
  canSpend(kind: "model" | "tts" | "send", now: number): boolean {
    const window = kind === "send" ? 60000 : 3600000;
    const limit = kind === "model" ? this.config.limits.modelAttemptsPerHour : kind === "tts"
      ? this.config.limits.ttsAttemptsPerHour : this.config.limits.turnsPerMinute;
    if (limit === null) return true;
    const count = this.db.prepare("SELECT count(*) AS n FROM room_budget WHERE kind=? AND created_at>?")
      .get(kind, now - window) as { n: number };
    return count.n < limit;
  }
  spend(kind: "model" | "tts" | "send", now: number): boolean {
    return this.transaction(() => {
      if (!this.canSpend(kind, now)) return false;
      this.db.prepare("INSERT INTO room_budget(kind,created_at) VALUES (?,?)").run(kind, now);
      return true;
    });
  }
  turn(burstId: string, c: RoomCharacter, now: number): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO room_deliveries
      (id,burst_id,character_id,account_key,voice_key,state,created_at) VALUES (?,?,?,?,?,'generating',?)`)
      .run(id, burstId, c.id, c.accountKey, c.voiceKey, now);
    return id;
  }
  setTurn(id: string, state: TurnState) {
    this.db.prepare(`UPDATE room_deliveries SET state=? WHERE id=? AND state IN (${ACTIVE})`).run(state, id);
  }
  textSent(id: string, c: RoomCharacter, targetId: number, text: string, platformId: string, now: number): number {
    return this.transaction(() => {
      const updated = this.db.prepare("UPDATE room_deliveries SET state='text_sent',text_id=? WHERE id=? AND state='text_sending'")
        .run(platformId, id);
      if (updated.changes !== 1) throw new Error("room-turn-stale");
      this.ownReceipt(c.accountKey, platformId, `legacy:${id}:text`);
      return this.append("bot", c.id, c.accountKey, targetId, text, platformId, now);
    });
  }
  audioSent(id: string, platformId: string) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT account_key FROM room_deliveries WHERE id=? AND state='audio_sending'").get(id);
      if (!row) throw new Error("room-turn-stale");
      this.ownReceipt(String(row.account_key), platformId, `legacy:${id}:audio`);
      if (this.db.prepare("UPDATE room_deliveries SET state='delivered',audio_id=? WHERE id=? AND state='audio_sending'").run(platformId, id).changes !== 1)
        throw new Error("room-turn-stale");
    });
  }
  prepared(delivery: RoomDelivery, mode: ResolvedDeliveryMode) {
    this.db.prepare(`UPDATE room_deliveries SET semantic_text=?,voice_text=?,voice_language=?,delivery_mode=?
      WHERE id=? AND state IN (${ACTIVE})`).run(delivery.text, delivery.voiceText ?? null, delivery.voiceLanguage ?? null, mode, delivery.turnId);
  }
  /** Only an acknowledged audio send creates a voice-only history row. text_id stays NULL. */
  audioOnlySent(id: string, c: RoomCharacter, targetId: number, text: string, platformId: string, now: number): number {
    return this.transaction(() => {
      const updated = this.db.prepare("UPDATE room_deliveries SET state='delivered',audio_id=? WHERE id=? AND state='audio_sending'")
        .run(platformId, id);
      if (updated.changes !== 1) throw new Error("room-turn-stale");
      this.ownReceipt(c.accountKey, platformId, `legacy:${id}:audio`);
      return this.append("bot", c.id, c.accountKey, targetId, text, platformId, now, "voice");
    });
  }
  deliveries(): Array<{ state: TurnState; accountKey: string; characterId: string; voiceKey: string }> {
    return this.db.prepare("SELECT state,account_key AS accountKey,character_id AS characterId,voice_key AS voiceKey FROM room_deliveries ORDER BY rowid")
      .all() as unknown as ReturnType<RoomStore["deliveries"]>;
  }
  counts(): { model: number; tts: number; send: number; messages: number } {
    const count = (kind: string) => (this.db.prepare("SELECT count(*) AS n FROM room_budget WHERE kind=?").get(kind) as { n: number }).n;
    return { model: count("model"), tts: count("tts"), send: count("send"),
      messages: (this.db.prepare("SELECT count(*) AS n FROM room_messages").get() as { n: number }).n };
  }
  ambientCursor(): AmbientCursor | null {
    const row = this.db.prepare("SELECT value FROM room_meta WHERE key='ambient_cursor_v1'").get() as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || Object.keys(parsed).sort().join(",") !== "contextKey,outcome,updatedAt"
        || typeof parsed.contextKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.contextKey)
        || !["skip","join","initiate","technical_defer"].includes(String(parsed.outcome))
        || !Number.isSafeInteger(parsed.updatedAt) || Number(parsed.updatedAt) < 0) {
        throw new Error("room-ambient-cursor-invalid");
      }
      return Object.freeze({ contextKey: parsed.contextKey,
        outcome: parsed.outcome as AmbientPlannerCursorOutcome, updatedAt: Number(parsed.updatedAt) });
    } catch { throw new Error("room-ambient-cursor-invalid"); }
  }
  recordAmbientCursor(contextKey: string, outcome: AmbientPlannerCursorOutcome, now: number): void {
    if (typeof contextKey !== "string" || !/^[0-9a-f]{64}$/.test(contextKey)
      || !["skip","join","initiate","technical_defer"].includes(outcome) || !timestamp(now)) {
      throw new Error("room-ambient-cursor-invalid");
    }
    this.transaction(() => {
      const value = JSON.stringify({ contextKey, outcome, updatedAt: now });
      this.db.prepare("INSERT OR REPLACE INTO room_meta(key,value) VALUES ('ambient_cursor_v1',?)").run(value);
      if (this.db.prepare("SELECT value FROM room_meta WHERE key='ambient_cursor_v1'").get()?.value !== value) {
        throw new Error("room-ambient-cursor-invalid");
      }
    });
  }
  schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.releaseLock(); }
  }
}
