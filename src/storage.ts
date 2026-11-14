import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_TIMEZONE, relationshipDay, resolveTimezone } from "./relationship/timezone.js";
import {
  initialRelationshipState, increaseIntimacy, increaseTrust, positiveDelta, validateMood,
} from "./relationship/state.js";
import type {
  Mood, RelationshipEvent, RelationshipEventKind, RelationshipEvidenceKind, RelationshipState,
} from "./relationship/types.js";
import type {
  EventBatch, EventBatchResult, EventInput, EventKind, EventRetractionResult, EventStatus,
  EventSubject, EvidenceKind, MemoryEvent, MemorySource, ProcessedTurn, ProvenanceRecord,
} from "./memory/types.js";

export type {
  EventBatch, EventBatchResult, EventInput, EventKind, EventRetractionResult, EventStatus,
  EventSubject, EvidenceKind, MemoryEvent, MemorySource, ProcessedTurn, ProvenanceRecord,
} from "./memory/types.js";

export interface Note {
  id: string;
  title: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  provenance: ProvenanceRecord;
  deletedBy: ProvenanceRecord | null;
}

export type MemoryLayer = "profile" | "relationship" | "group";
export type MemoryKind = "identity" | "preference" | "constraint" | "relationship" | "event" | "note";
export type MemoryStatus = "active" | "superseded" | "deleted";

export interface Memory {
  id: string;
  layer: MemoryLayer;
  kind: MemoryKind;
  key: string;
  content: string;
  subjectId: string;
  characterId: string | null;
  groupId: string | null;
  speakerId: string | null;
  source: string;
  evidence: string;
  confidence: number;
  status: MemoryStatus;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface SaveMemoryInput {
  layer: MemoryLayer;
  kind: MemoryKind;
  key?: string;
  content: string;
  subjectId?: string;
  characterId?: string | null;
  groupId?: string | null;
  speakerId?: string | null;
  source?: string;
  evidence?: string;
  confidence?: number;
}

export interface MemoryExtractionJob {
  id: string;
  text: string;
  actorId: string;
  isOwner: boolean;
  attempts: number;
  sourceMessageIds: string[];
  relationshipRoleId: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  status: "pending" | "done";
  createdAt: string;
  completedAt: string | null;
}

type Row = Record<string, unknown>;

/** Public limits for callers that must bound legacy data before it reaches memory rows. */
export const MEMORY_CONTENT_LIMIT = 4000;
export const MEMORY_SOURCE_LIMIT = 1000;
export const MEMORY_EVIDENCE_LIMIT = 2000;
export const MEMORY_KEY_LIMIT = 200;

const TRUNCATION_MARKER = "\n（旧笔记内容过长，已截断；原文保留在 notes 表）";

/** The searchable memory copy of a note stays bounded while the notes table keeps the full text. */
export function noteMemoryContent(title: string, content: string): string {
  const combined = `${title}\n${content}`;
  if (combined.length <= MEMORY_CONTENT_LIMIT) return combined;
  const keep = Math.max(0, MEMORY_CONTENT_LIMIT - TRUNCATION_MARKER.length);
  return combined.slice(0, keep) + TRUNCATION_MARKER;
}

interface NormalizedMemory {
  layer: MemoryLayer;
  kind: MemoryKind;
  key: string;
  content: string;
  subjectId: string;
  characterId: string | null;
  groupId: string | null;
  speakerId: string | null;
  source: string;
  evidence: string;
  confidence: number;
}

const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_KINDS: EventKind[] = ["promise", "correction", "outcome"];
const EVENT_SUBJECTS: EventSubject[] = ["user", "assistant"];
const EVIDENCE_KINDS: EvidenceKind[] = ["user_statement", "assistant_statement", "tool_result"];

interface NormalizedEventInput extends Omit<EventInput, "relatedEventId"> {
  relatedEventId: string | null;
}

function legacyProvenance(): ProvenanceRecord {
  return { kind: "legacy", recordedAt: null, sessionId: null, messageIds: [], toolCallIds: [] };
}

function parseProvenance(text: unknown): ProvenanceRecord {
  if (typeof text !== "string" || !text) return legacyProvenance();
  try {
    const value = JSON.parse(text) as Partial<ProvenanceRecord>;
    if (value.kind !== "app" || typeof value.recordedAt !== "string"
      || !(value.sessionId === null || typeof value.sessionId === "string")
      || !Array.isArray(value.messageIds) || !value.messageIds.every(item => typeof item === "string")
      || !Array.isArray(value.toolCallIds) || !value.toolCallIds.every(item => typeof item === "string")) {
      return legacyProvenance();
    }
    return {
      kind: "app", recordedAt: value.recordedAt, sessionId: value.sessionId,
      messageIds: [...value.messageIds], toolCallIds: [...value.toolCallIds],
    };
  } catch {
    return legacyProvenance();
  }
}

function storedStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function textList(value: unknown, name: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是字符串数组。`);
  if (value.length > maximumItems) throw new Error(`${name} 最多 ${maximumItems} 项。`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${name} 中的每一项都必须是字符串。`);
    const text = item.trim();
    if (!text || text.length > maximumLength) {
      throw new Error(`${name} 中的每一项都必须非空，且最多 ${maximumLength} 个字符。`);
    }
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

/** Validate app-provided source metadata like any other untrusted boundary input. */
function sourceIdentity(source: MemorySource | undefined): {
  sessionId: string | null; messageIds: string[]; toolCallIds: string[];
} {
  if (source === undefined || source === null) return { sessionId: null, messageIds: [], toolCallIds: [] };
  if (typeof source !== "object") throw new Error("记忆来源必须是应用提供的来源对象。");
  const record = source as unknown as Record<string, unknown>;
  const rawSession = record.sessionId;
  if (!(rawSession === null || (typeof rawSession === "string" && rawSession.trim() && rawSession.trim().length <= 300))) {
    throw new Error("记忆来源的 sessionId 无效：必须是 null 或非空字符串（最多 300 个字符）。");
  }
  const messageIds = textList(record.messageIds, "记忆来源 messageIds", 50, 300);
  const toolCallIds = record.toolCallIds === undefined
    ? [] : textList(record.toolCallIds, "记忆来源 toolCallIds", 50, 300);
  return { sessionId: rawSession === null ? null : rawSession.trim(), messageIds, toolCallIds };
}

function appProvenance(source: MemorySource | undefined): ProvenanceRecord {
  return { kind: "app", recordedAt: new Date().toISOString(), ...sourceIdentity(source) };
}

function note(row: Row): Note {
  const createdAt = String(row.created_at);
  return {
    id: String(row.id), title: String(row.title), content: String(row.content),
    source: String(row.source), createdAt,
    updatedAt: row.updated_at == null ? createdAt : String(row.updated_at),
    deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
    provenance: parseProvenance(row.provenance_json),
    deletedBy: row.deleted_by_json == null ? null : parseProvenance(row.deleted_by_json),
  };
}

function memory(row: Row): Memory {
  return {
    id: String(row.id), layer: String(row.layer) as MemoryLayer, kind: String(row.kind) as MemoryKind,
    key: String(row.memory_key), content: String(row.content), subjectId: String(row.subject_id),
    characterId: row.character_id == null ? null : String(row.character_id),
    groupId: row.group_id == null ? null : String(row.group_id),
    speakerId: row.speaker_id == null ? null : String(row.speaker_id),
    source: String(row.source), evidence: String(row.evidence), confidence: Number(row.confidence),
    status: String(row.status) as MemoryStatus,
    supersedesId: row.supersedes_id == null ? null : String(row.supersedes_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastSeenAt: String(row.last_seen_at),
  };
}

function task(row: Row): Task {
  return { id: String(row.id), title: String(row.title), status: row.status === "done" ? "done" : "pending",
    createdAt: String(row.created_at), completedAt: row.completed_at == null ? null : String(row.completed_at) };
}

function relationshipState(row: Row): RelationshipState {
  return {
    roleId: String(row.role_id), intimacy: Number(row.intimacy),
    stage: String(row.stage) as RelationshipState["stage"], stageFloor: Number(row.stage_floor),
    competenceTrust: Number(row.competence_trust), mood: String(row.mood) as Mood,
    moodIntensity: Number(row.mood_intensity), boundaries: JSON.parse(String(row.boundaries_json)),
    consent: { adult: false }, proactiveRomanceEnabled: Number(row.proactive_romance_enabled) === 1,
    lastUserAt: row.last_user_at == null ? null : String(row.last_user_at), updatedAt: String(row.updated_at),
  };
}

function relationshipEvent(row: Row): RelationshipEvent {
  return {
    id: String(row.id), roleId: String(row.role_id), kind: String(row.event_type ?? row.kind) as RelationshipEvent["kind"],
    summary: String(row.summary), emotionalWeight: Number(row.emotional_weight),
    sourceMessageIds: storedStringArray(row.source_message_ids_json), createdAt: String(row.created_at),
    sourceExcerpts: storedStringArray(row.source_excerpts_json),
    memoryId: row.memory_id == null ? null : String(row.memory_id),
  };
}

function required(text: string, name: string, maximum: number): string {
  const value = text.trim();
  if (!value || value.length > maximum) throw new Error(`${name} 不能为空，且最多 ${maximum} 个字符。`);
  return value;
}

function pageSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("查询条数必须在 1–50 之间。");
  return limit;
}

function idArgument(id: string, name: string): string {
  const value = id.trim();
  if (!UUID_PATTERN.test(value)) throw new Error(`${name}无效，请使用查询结果中的完整 ID。`);
  return value;
}

function event(row: Row): MemoryEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    kind: String(row.kind) as EventKind,
    summary: String(row.summary),
    subject: String(row.subject) as EventSubject,
    evidenceKind: String(row.evidence_kind) as EvidenceKind,
    sourceMessageIds: storedStringArray(row.source_message_ids_json),
    sourceToolCallIds: storedStringArray(row.source_tool_call_ids_json),
    sourceExcerpts: storedStringArray(row.source_excerpts_json),
    relatedEventId: row.related_event_id == null ? null : String(row.related_event_id),
    status: String(row.status) as EventStatus,
    resolvedByEventId: row.resolved_by == null ? null : String(row.resolved_by),
    supersededByEventId: row.superseded_by == null ? null : String(row.superseded_by),
    retractedAt: row.retracted_at == null ? null : String(row.retracted_at),
    retractionReason: row.retraction_reason == null ? null : String(row.retraction_reason),
    retractionSource: row.retracted_by_json == null ? null : parseProvenance(row.retracted_by_json),
    extractorVersion: String(row.extractor_version),
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function processedTurn(row: Row): ProcessedTurn {
  return {
    sessionId: String(row.session_id), turnId: String(row.turn_id),
    extractorVersion: String(row.extractor_version), batchHash: String(row.batch_hash),
    eventIds: storedStringArray(row.event_ids_json), appliedAt: String(row.applied_at),
  };
}

function validateEventInput(input: EventInput, index: number): NormalizedEventInput {
  const position = index + 1;
  if (typeof input !== "object" || input === null) throw new Error(`第 ${position} 条事件格式无效。`);
  const kind = input.kind;
  if (!EVENT_KINDS.includes(kind)) throw new Error(`第 ${position} 条事件的 kind 无效。`);
  const subject = input.subject;
  if (!EVENT_SUBJECTS.includes(subject)) throw new Error(`第 ${position} 条事件的 subject 无效。`);
  const evidenceKind = input.evidenceKind;
  if (!EVIDENCE_KINDS.includes(evidenceKind)) throw new Error(`第 ${position} 条事件的 evidenceKind 无效。`);
  if (typeof input.summary !== "string") throw new Error(`第 ${position} 条事件的 summary 必须是字符串。`);
  const summary = required(input.summary, `第 ${position} 条事件的 summary`, 500);
  const sourceMessageIds = textList(input.sourceMessageIds, `第 ${position} 条事件的 sourceMessageIds`, 20, 300);
  const sourceToolCallIds = textList(input.sourceToolCallIds, `第 ${position} 条事件的 sourceToolCallIds`, 20, 300);
  const sourceExcerpts = textList(input.sourceExcerpts, `第 ${position} 条事件的 sourceExcerpts`, 8, 200);
  if (!sourceExcerpts.length) throw new Error(`第 ${position} 条事件必须提供至少一条原文证据（sourceExcerpts）。`);
  if (sourceMessageIds.length + sourceToolCallIds.length === 0) {
    throw new Error(`第 ${position} 条事件必须提供 sourceMessageIds 或 sourceToolCallIds 证据引用。`);
  }
  if (evidenceKind === "tool_result" && sourceToolCallIds.length === 0) {
    throw new Error(`第 ${position} 条事件声明为工具结果，必须提供 sourceToolCallIds。`);
  }
  if (evidenceKind !== "tool_result" && sourceMessageIds.length === 0) {
    throw new Error(`第 ${position} 条事件声明为对话陈述，必须提供 sourceMessageIds。`);
  }
  const rawRelated = input.relatedEventId;
  if (rawRelated !== undefined && rawRelated !== null && typeof rawRelated !== "string") {
    throw new Error(`第 ${position} 条事件的 relatedEventId 必须是字符串。`);
  }
  const relatedEventId = rawRelated === undefined || rawRelated === null ? null : idArgument(rawRelated, `第 ${position} 条事件的 relatedEventId`);
  return {
    kind, summary, subject, evidenceKind, sourceMessageIds, sourceToolCallIds, sourceExcerpts, relatedEventId,
  };
}

function stableEventShape(input: NormalizedEventInput) {
  return {
    kind: input.kind, summary: input.summary, subject: input.subject, evidenceKind: input.evidenceKind,
    sourceMessageIds: input.sourceMessageIds, sourceToolCallIds: input.sourceToolCallIds,
    sourceExcerpts: input.sourceExcerpts, relatedEventId: input.relatedEventId,
  };
}

function eventDedupeKey(sessionId: string, turnId: string, input: NormalizedEventInput): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, turnId, stableEventShape(input)]))
    .digest("hex");
}

/** Application data belongs to the PA. Pi owns conversation history separately. */
export class PaStore {
  private readonly db: DatabaseSync;
  private hasTable(name: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }

  constructor(filename: string, private readonly relationshipClock: () => Date = () => new Date(),
    private readonly relationshipTimezone = DEFAULT_TIMEZONE, private readonly readOnly = false) {
    this.relationshipTimezone = resolveTimezone(relationshipTimezone);
    if (!readOnly) mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { readOnly: readOnly });
    if (readOnly) return; // No business schema migration or extraction-job recovery.
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
      `);
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Additive migration. Existing note databases (including imported-role
   * databases) keep their IDs, data, and fingerprints; new columns are added
   * in place. Re-running on an already migrated database is a no-op.
   */
  private migrate(): void {
    const versionRow = this.db.prepare("PRAGMA user_version").get() as Row | undefined;
    const version = Number(versionRow?.user_version ?? 0);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("数据库结构版本无效，无法安全打开。");
    if (version > SCHEMA_VERSION) {
      throw new Error(`数据库结构版本（${version}）高于当前程序支持的版本（${SCHEMA_VERSION}），请升级程序后再打开。`);
    }
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT, deleted_at TEXT,
          provenance_json TEXT, deleted_by_json TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done')),
          created_at TEXT NOT NULL, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL,
          layer TEXT NOT NULL CHECK(layer IN ('profile', 'relationship', 'group')),
          kind TEXT NOT NULL CHECK(kind IN ('identity', 'preference', 'constraint', 'relationship', 'event', 'note')),
          memory_key TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
          subject_id TEXT NOT NULL DEFAULT 'owner', character_id TEXT, group_id TEXT, speaker_id TEXT,
          source TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded', 'deleted')),
          supersedes_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memories_active_scope ON memories(status, layer, subject_id, character_id, group_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
          id TEXT PRIMARY KEY, text TEXT NOT NULL, actor_id TEXT NOT NULL, is_owner INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', worker_pid INTEGER,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_jobs_status ON memory_extraction_jobs(status, created_at);
        CREATE TABLE IF NOT EXISTS tool_audit (
          id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, route TEXT NOT NULL, actor_id TEXT NOT NULL,
          status TEXT NOT NULL, duration_ms INTEGER NOT NULL, args_summary TEXT NOT NULL,
          error_code TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('promise', 'correction', 'outcome')),
          summary TEXT NOT NULL,
          subject TEXT NOT NULL CHECK(subject IN ('user', 'assistant')),
          evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('user_statement', 'assistant_statement', 'tool_result')),
          source_message_ids_json TEXT NOT NULL,
          source_tool_call_ids_json TEXT NOT NULL,
          source_excerpts_json TEXT NOT NULL,
          related_event_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('active', 'resolved', 'superseded', 'retracted')),
          resolved_by TEXT, superseded_by TEXT,
          status_before_resolve TEXT, status_before_supersede TEXT,
          retracted_at TEXT, retraction_reason TEXT, retracted_by_json TEXT,
          dedupe_key TEXT NOT NULL UNIQUE,
          extractor_version TEXT NOT NULL,
          occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS processed_turns (
          session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          extractor_version TEXT NOT NULL, batch_hash TEXT NOT NULL,
          event_ids_json TEXT NOT NULL, applied_at TEXT NOT NULL,
          PRIMARY KEY(session_id, turn_id)
        );
        CREATE TABLE IF NOT EXISTS event_source_refs (
          event_id TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('message', 'tool')),
          source_id TEXT NOT NULL, PRIMARY KEY(event_id, source_kind, source_id)
        );
        CREATE INDEX IF NOT EXISTS event_sources_index ON event_source_refs(source_kind, source_id);
        CREATE INDEX IF NOT EXISTS events_status_index ON memory_events(status, occurred_at);
        CREATE INDEX IF NOT EXISTS events_related_index ON memory_events(related_event_id);
        CREATE INDEX IF NOT EXISTS events_session_turn_index ON memory_events(session_id, turn_id);
        CREATE TABLE IF NOT EXISTS relationship_state (
          role_id TEXT PRIMARY KEY,
          intimacy INTEGER NOT NULL CHECK(intimacy BETWEEN 0 AND 100 AND intimacy >= stage_floor),
          stage TEXT NOT NULL CHECK(stage IN ('初识', '熟悉', '心动', '亲密', '恋人', '挚爱')),
          stage_floor INTEGER NOT NULL DEFAULT 0 CHECK(stage_floor IN (0,20,40,60,80,95)),
          competence_trust INTEGER NOT NULL DEFAULT 0 CHECK(competence_trust BETWEEN 0 AND 100),
          mood TEXT NOT NULL DEFAULT 'neutral' CHECK(mood IN ('neutral','happy','shy','proud','annoyed','sad')),
          mood_intensity REAL NOT NULL DEFAULT 0 CHECK(mood_intensity BETWEEN 0 AND 1),
          boundaries_json TEXT NOT NULL DEFAULT '{}',
          consent_json TEXT NOT NULL DEFAULT '{"adult":false}',
          proactive_romance_enabled INTEGER NOT NULL DEFAULT 1,
          last_user_at TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relationship_events (
          id TEXT PRIMARY KEY, role_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('intimacy','milestone','mood')),
          summary TEXT NOT NULL, emotional_weight INTEGER NOT NULL,
          source_message_ids_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS relationship_events_role_time ON relationship_events(role_id, created_at);
      `);
      const columns = new Set(this.db.prepare("PRAGMA table_info(notes)").all()
        .map(column => String(column.name)));
      const additions: Array<[string, string]> = [
        ["updated_at", "TEXT"], ["deleted_at", "TEXT"],
        ["provenance_json", "TEXT"], ["deleted_by_json", "TEXT"],
      ];
      for (const [name, type] of additions) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE notes ADD COLUMN ${name} ${type}`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS notes_active_index ON notes(deleted_at, created_at)");
      const jobColumns = new Set(this.db.prepare("PRAGMA table_info(memory_extraction_jobs)").all()
        .map(column => String(column.name)));
      if (!jobColumns.has("worker_pid")) {
        this.db.exec("ALTER TABLE memory_extraction_jobs ADD COLUMN worker_pid INTEGER");
      }
      if (!jobColumns.has("source_message_ids_json")) {
        this.db.exec("ALTER TABLE memory_extraction_jobs ADD COLUMN source_message_ids_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!jobColumns.has("relationship_role_id")) {
        this.db.exec("ALTER TABLE memory_extraction_jobs ADD COLUMN relationship_role_id TEXT");
      }
      const relationshipColumns = new Set(this.db.prepare("PRAGMA table_info(relationship_events)").all()
        .map(column => String(column.name)));
      for (const [name, definition] of [
        ["event_type", "TEXT"], ["source_excerpts_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["memory_id", "TEXT"], ["dedupe_key", "TEXT"],
      ] as const) {
        if (!relationshipColumns.has(name)) this.db.exec(`ALTER TABLE relationship_events ADD COLUMN ${name} ${definition}`);
      }
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS relationship_evidence_dedupe ON relationship_events(dedupe_key) WHERE dedupe_key IS NOT NULL");
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    // Reclaim only jobs whose owning process no longer exists; another live PA may share this database.
    for (const row of this.db.prepare("SELECT id, worker_pid FROM memory_extraction_jobs WHERE status = 'running'").all()) {
      const pid = Number(row.worker_pid);
      let alive = Number.isSafeInteger(pid) && pid > 0;
      if (alive) try { process.kill(pid, 0); } catch (error) {
        alive = error instanceof Error && "code" in error && error.code === "EPERM";
      }
      if (!alive) this.db.prepare("UPDATE memory_extraction_jobs SET status = 'pending', worker_pid = NULL WHERE id = ?").run(String(row.id));
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  saveNote(title: string, content: string, source = "", provenance?: MemorySource): Note {
    title = required(title, "标题", 200);
    content = required(content, "正文", 12000);
    source = source.trim();
    if (source.length > 2000) throw new Error("来源最多 2000 个字符。");
    const fingerprint = createHash("sha256").update(JSON.stringify([title, content, source])).digest("hex");
    const recorded = appProvenance(provenance);
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT * FROM notes WHERE fingerprint = ? AND deleted_at IS NULL").get(fingerprint);
      if (existing) return note(existing);
      const now = new Date().toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO notes
        (id, fingerprint, title, content, source, created_at, updated_at, deleted_at, provenance_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(randomUUID(), fingerprint, title, content, source, now, now, JSON.stringify(recorded));
      const saved = this.db.prepare(
        "SELECT * FROM notes WHERE fingerprint = ? AND deleted_at IS NULL").get(fingerprint);
      if (!saved) {
        throw new Error("保存笔记失败：相同内容已有删除记录，请确认后使用不同的标题、正文或来源明确重新保存。");
      }
      return note(saved);
    });
  }

  searchNotes(query = "", limit = 10): Note[] {
    if (query.length > 200) throw new Error("搜索词最多 200 个字符。");
    const terms = query.trim().split(/\s+/).filter(Boolean);
    // Literal substring matching works for Chinese as well as English.
    const conditions = ["deleted_at IS NULL"];
    if (terms.length) {
      conditions.push(...terms.map(() =>
        "(title || char(10) || content || char(10) || source) LIKE ? ESCAPE '\\'"));
    }
    const patterns = terms.map(term => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    return this.db.prepare(`SELECT * FROM notes WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC, id LIMIT ?`)
      .all(...patterns, pageSize(limit)).map(note);
  }

  /** Stable keyset pagination over the notes table for one-time migration. */
  notesAfter(cursor: { createdAt: string; id: string } | null, limit = 50): Note[] {
    const size = pageSize(limit);
    if (!cursor) return this.db.prepare("SELECT * FROM notes ORDER BY created_at, id LIMIT ?").all(size).map(note);
    return this.db.prepare(`SELECT * FROM notes WHERE created_at > ? OR (created_at = ? AND id > ?)
      ORDER BY created_at, id LIMIT ?`).all(cursor.createdAt, cursor.createdAt, cursor.id, size).map(note);
  }

  isLegacyNoteMigrated(noteId: string): boolean {
    return this.db.prepare("SELECT 1 FROM app_state WHERE key = ?")
      .get(`legacy_note_migrated:${noteId}`) !== undefined;
  }

  markLegacyNoteMigrated(noteId: string, memoryId: string): void {
    this.db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`legacy_note_migrated:${noteId}`, memoryId);
  }

  getNote(id: string): Note {
    id = idArgument(id, "笔记 ID");
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!row) throw new Error("笔记不存在或已删除；请先使用 search_notes 查询，或明确要求重新保存。");
    return note(row);
  }

  /** Explicit tombstone access for extractors and maintenance; never used by normal tools. */
  getNoteTombstone(id: string): Note | null {
    id = idArgument(id, "笔记 ID");
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NOT NULL").get(id);
    return row ? note(row) : null;
  }

  updateNote(id: string, title: string, content: string, source?: string, provenance?: MemorySource): Note {
    id = idArgument(id, "笔记 ID");
    title = required(title, "标题", 200);
    content = required(content, "正文", 12000);
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL").get(id);
      if (!current) throw new Error("笔记不存在或已删除，无法修改；请先使用 search_notes 查询完整 ID。");
      const nextSource = source === undefined ? String(current.source) : source.trim();
      if (nextSource.length > 2000) throw new Error("来源最多 2000 个字符。");
      const fingerprint = createHash("sha256").update(JSON.stringify([title, content, nextSource])).digest("hex");
      const collision = this.db.prepare(
        "SELECT id FROM notes WHERE fingerprint = ? AND id <> ? AND deleted_at IS NULL").get(fingerprint, id);
      if (collision) {
        throw new Error(`已有内容相同的笔记（ID: ${String(collision.id)}），未修改当前笔记。请使用 update_note 修改该笔记，或调整标题、正文或来源。`);
      }
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE notes SET title = ?, content = ?, source = ?, fingerprint = ?,
        updated_at = ?, provenance_json = ? WHERE id = ? AND deleted_at IS NULL`)
        .run(title, content, nextSource, fingerprint, now, JSON.stringify(appProvenance(provenance)), id);
      const saved = note(this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id)!);
      // Keep searchable memory copies in the same physical store in sync inside this transaction.
      this.syncNoteMemoryUpdate(saved);
      return saved;
    });
  }

  /**
   * Soft deletion: keeps the row as a tombstone for extractor checks. Repeating
   * the same deletion succeeds and returns the original deletion timestamp.
   * This does not delete any conversation transcript.
   */
  deleteNote(id: string, provenance?: MemorySource): Note {
    id = idArgument(id, "笔记 ID");
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
      if (!current) throw new Error("笔记不存在；请先使用 search_notes 查询完整 ID。");
      if (current.deleted_at != null) return note(current);
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE notes SET deleted_at = ?, updated_at = ?, fingerprint = ?,
        deleted_by_json = ? WHERE id = ? AND deleted_at IS NULL`)
        .run(now, now, `deleted:${id}`,
          JSON.stringify(appProvenance(provenance)), id);
      this.syncNoteMemoryDelete(id);
      return note(this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id)!);
    });
  }

  /** Update an active note memory copy without resurrecting one the owner already forgot. */
  private syncNoteMemoryUpdate(saved: Note): void {
    const key = `note:${saved.id}`;
    const row = this.db.prepare(`SELECT * FROM memories WHERE memory_key = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1`).get(key);
    if (!row) return;
    const current = memory(row);
    this.updateMemory(current.id, noteMemoryContent(saved.title, saved.content),
      "由 update_note 同步更新", saved.source.slice(0, MEMORY_SOURCE_LIMIT));
  }

  /** Forget every active searchable copy of a soft-deleted note. */
  private syncNoteMemoryDelete(noteId: string): void {
    const rows = this.db.prepare("SELECT id FROM memories WHERE memory_key = ? AND status = 'active'")
      .all(`note:${noteId}`);
    for (const row of rows) this.deleteMemory(String(row.id));
  }

  addTask(title: string): Task {
    title = required(title, "待办标题", 300);
    const id = randomUUID();
    this.db.prepare("INSERT INTO tasks (id, title, created_at) VALUES (?, ?, ?)")
      .run(id, title, new Date().toISOString());
    return task(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)!);
  }

  listTasks(status: "pending" | "done" | "all" = "pending", limit = 20): Task[] {
    if (!["pending", "done", "all"].includes(status)) throw new Error("待办状态无效。");
    const rows = status === "all"
      ? this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, id LIMIT ?").all(pageSize(limit))
      : this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC, id LIMIT ?").all(status, pageSize(limit));
    return rows.map(task);
  }

  completeTask(id: string): Task {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("请先查询待办，再使用查询结果中的完整 ID。");
    const existing = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!existing) throw new Error("待办不存在，请先使用 list_tasks 查询。");
    this.db.prepare("UPDATE tasks SET status = 'done', completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), id);
    return task(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)!);
  }

  /** True when a memory already exists for this layer/key scope, in any status. */
  hasMemoryForKey(layer: MemoryLayer, key: string, characterId: string | null, groupId: string | null): boolean {
    return this.db.prepare(`SELECT 1 FROM memories WHERE layer = ? AND memory_key = ?
      AND character_id IS ? AND group_id IS ? LIMIT 1`).get(layer, key, characterId, groupId) !== undefined;
  }

  saveMemory(input: SaveMemoryInput): Memory {
    const normalized = this.normalizeMemory(input);
    const fingerprint = this.memoryFingerprint(normalized);
    const same = this.db.prepare("SELECT * FROM memories WHERE fingerprint = ?").get(fingerprint);
    if (same) {
      if (String(same.status) === "active") {
        // A byte-identical active save is idempotent: refresh timestamps, keep one active row.
        this.touchMemory(String(same.id));
        if (normalized.key) this.supersedeKey(normalized.layer, normalized.key, normalized.subjectId,
          normalized.characterId, normalized.groupId, String(same.id), new Date().toISOString());
        return this.getMemory(String(same.id));
      }
      // Inactive rows keep their history but must not be revived in place. Recycle the dedupe
      // fingerprint and create a fresh active version with a new ID.
      this.retireFingerprint(same, fingerprint);
    }
    return this.insertMemory(normalized, fingerprint);
  }

  private normalizeMemory(input: SaveMemoryInput): NormalizedMemory {
    const layers: MemoryLayer[] = ["profile", "relationship", "group"];
    const kinds: MemoryKind[] = ["identity", "preference", "constraint", "relationship", "event", "note"];
    if (!layers.includes(input.layer)) throw new Error("记忆层级无效。");
    if (!kinds.includes(input.kind)) throw new Error("记忆类型无效。");
    const content = required(input.content, "记忆内容", MEMORY_CONTENT_LIMIT);
    const key = (input.key ?? "").trim();
    if (key.length > MEMORY_KEY_LIMIT) throw new Error(`记忆键最多 ${MEMORY_KEY_LIMIT} 个字符。`);
    const subjectId = required(input.subjectId ?? "owner", "记忆主体", 100);
    const characterId = input.characterId?.trim() || null;
    const groupId = input.groupId?.trim() || null;
    const speakerId = input.speakerId?.trim() || null;
    const source = (input.source ?? "").trim();
    const evidence = (input.evidence ?? "").trim();
    if (source.length > MEMORY_SOURCE_LIMIT || evidence.length > MEMORY_EVIDENCE_LIMIT) throw new Error("记忆来源或证据过长。");
    const confidence = input.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("记忆置信度必须在 0–1 之间。");
    if (input.layer === "group" && !groupId) throw new Error("群记忆必须绑定群号。");
    if (input.layer === "relationship" && !characterId) throw new Error("关系记忆必须绑定角色。");
    return { layer: input.layer, kind: input.kind, key, content, subjectId, characterId, groupId,
      speakerId, source, evidence, confidence };
  }

  private memoryFingerprint(input: NormalizedMemory): string {
    return createHash("sha256").update(JSON.stringify([
      input.layer, input.kind, input.key, input.content, input.subjectId,
      input.characterId, input.groupId, input.speakerId, input.source,
    ])).digest("hex");
  }

  private insertMemory(input: NormalizedMemory, fingerprint: string, previousId?: string): Memory {
    const now = new Date().toISOString();
    const id = randomUUID();
    const active = input.key
      ? this.findActiveMemoryByKey(input.layer, input.key, input.subjectId, input.characterId, input.groupId)
      : undefined;
    const supersedes = previousId ?? (active ? String(active.id) : null);
    this.db.prepare(`INSERT INTO memories
      (id, fingerprint, layer, kind, memory_key, content, subject_id, character_id, group_id, speaker_id,
       source, evidence, confidence, status, supersedes_id, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, fingerprint, input.layer, input.kind, input.key, input.content, input.subjectId,
        input.characterId, input.groupId, input.speakerId, input.source, input.evidence, input.confidence,
        supersedes, now, now, now);
    if (input.key) this.supersedeKey(input.layer, input.key, input.subjectId, input.characterId, input.groupId, id, now);
    return this.getMemory(id);
  }

  /** Free a canonical fingerprint held by an inactive row without touching its content history. */
  private retireFingerprint(row: Row, fingerprint: string): void {
    this.db.prepare("UPDATE memories SET fingerprint = ? WHERE id = ?")
      .run(`${fingerprint}:retired:${String(row.id)}`, String(row.id));
  }

  private touchMemory(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE memories SET updated_at = ?, last_seen_at = ? WHERE id = ?").run(now, now, id);
  }

  private findActiveMemoryByKey(layer: MemoryLayer, key: string, subjectId: string,
    characterId: string | null, groupId: string | null): Row | undefined {
    return this.db.prepare(`SELECT * FROM memories WHERE status = 'active' AND layer = ? AND memory_key = ?
      AND subject_id = ? AND character_id IS ? AND group_id IS ? ORDER BY updated_at DESC LIMIT 1`)
      .get(layer, key, subjectId, characterId, groupId);
  }

  private supersedeKey(layer: MemoryLayer, key: string, subjectId: string,
    characterId: string | null, groupId: string | null, keepId: string, now: string): void {
    this.db.prepare(`UPDATE memories SET status = 'superseded', updated_at = ?
      WHERE status = 'active' AND layer = ? AND memory_key = ? AND subject_id = ?
        AND character_id IS ? AND group_id IS ? AND id <> ?`)
      .run(now, layer, key, subjectId, characterId, groupId, keepId);
  }

  getMemory(id: string): Memory {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!row) throw new Error("记忆不存在，请先查询完整 ID。");
    return memory(row);
  }

  /** Application-owned lookup used for note-copy authorization and migration checks. */
  findMemoryByKey(key: string, includeInactive = false, scope?: {
    layer: MemoryLayer; characterId?: string | null; groupId?: string | null;
  }): Memory | null {
    const clauses = ["memory_key = ?"];
    const values: Array<string | null> = [key];
    if (!includeInactive) clauses.push("status = 'active'");
    if (scope) {
      clauses.push("layer = ?"); values.push(scope.layer);
      if (scope.characterId !== undefined) { clauses.push("character_id IS ?"); values.push(scope.characterId); }
      if (scope.groupId !== undefined) { clauses.push("group_id IS ?"); values.push(scope.groupId); }
    }
    const row = this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC LIMIT 1`).get(...values);
    return row ? memory(row) : null;
  }

  searchMemories(query = "", limit = 10, options: {
    layers?: MemoryLayer[]; kinds?: MemoryKind[]; includeInactive?: boolean;
    characterId?: string | null; groupId?: string | null; excludeSources?: string[];
    excludeKinds?: MemoryKind[];
  } = {}): Memory[] {
    if (query.length > 300) throw new Error("搜索词最多 300 个字符。");
    if (this.readOnly && !this.hasTable("memories")) return [];
    const layers = options.layers?.length ? options.layers : undefined;
    const kinds = options.kinds?.length ? options.kinds : undefined;
    const clauses = [options.includeInactive ? "1=1" : "status = 'active'"];
    const values: Array<string | null> = [];
    if (options.characterId !== undefined) {
      clauses.push("character_id IS ?"); values.push(options.characterId);
    }
    if (options.groupId !== undefined) {
      clauses.push("group_id IS ?"); values.push(options.groupId);
    }
    if (options.excludeSources?.length) {
      clauses.push(`source NOT IN (${options.excludeSources.map(() => "?").join(",")})`);
      values.push(...options.excludeSources);
    }
    if (options.excludeKinds?.length) {
      clauses.push(`kind NOT IN (${options.excludeKinds.map(() => "?").join(",")})`);
      values.push(...options.excludeKinds);
    }
    if (layers) { clauses.push(`layer IN (${layers.map(() => "?").join(",")})`); values.push(...layers); }
    if (kinds) { clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`); values.push(...kinds); }
    // Scan every matching row so an older exact match cannot be hidden by newer rows.
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, id`).all(...values).map(memory);
    const normalized = query.normalize("NFKC").toLowerCase().trim();
    if (!normalized) return rows.slice(0, pageSize(limit));
    const latin = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
    const compact = normalized.replace(/\s+/g, "");
    const grams = new Set<string>(latin);
    for (const size of [2, 3]) for (let i = 0; i + size <= compact.length; i++) grams.add(compact.slice(i, i + size));
    return rows.map((item, index) => {
      const haystack = `${item.key}\n${item.content}\n${item.source}\n${item.evidence}`.normalize("NFKC").toLowerCase();
      let score = haystack.includes(normalized) ? 20 : 0;
      for (const token of grams) if (token && haystack.includes(token)) score += token.length >= 3 ? 3 : 1;
      if (item.key && normalized.includes(item.key.toLowerCase())) score += 8;
      score += Math.max(0, 2 - index / 100);
      return { item, score };
    }).filter(value => value.score > 2).sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
      .slice(0, pageSize(limit)).map(value => value.item);
  }

  updateMemory(id: string, content: string, evidence = "", source?: string): Memory {
    const current = this.getMemory(id);
    if (current.status !== "active") throw new Error("只能修改当前有效的记忆。");
    const normalized = this.normalizeMemory({
      layer: current.layer, kind: current.kind, key: current.key, content,
      subjectId: current.subjectId, characterId: current.characterId, groupId: current.groupId,
      speakerId: current.speakerId, source: source === undefined ? current.source : source,
      evidence: evidence || current.evidence,
      confidence: current.confidence,
    });
    if (normalized.content === current.content && normalized.evidence === current.evidence
      && normalized.source === current.source) {
      this.touchMemory(current.id);
      return this.getMemory(current.id);
    }
    const fingerprint = this.memoryFingerprint(normalized);
    const same = this.db.prepare("SELECT * FROM memories WHERE fingerprint = ?").get(fingerprint);
    // An update always creates an auditable version, even when only evidence changed and the
    // fingerprint is unchanged. Free the fingerprint before inserting the replacement.
    if (same) this.retireFingerprint(same, fingerprint);
    const updated = this.insertMemory(normalized, fingerprint, current.id);
    if (!current.key) {
      this.db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?")
        .run(updated.updatedAt, current.id);
      return this.getMemory(updated.id);
    }
    return updated;
  }

  deleteMemory(id: string): Memory {
    const existing = this.getMemory(id);
    if (existing.status === "deleted") return existing;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, id);
    return this.getMemory(id);
  }

  enqueueMemoryExtraction(text: string, actorId: string, isOwner: boolean,
    sourceMessageIds: string[] = [], relationshipRoleId: string | null = null): MemoryExtractionJob {
    text = required(text, "待提取消息", 8000);
    actorId = required(actorId, "消息发送者", 100);
    const sources = textList(sourceMessageIds, "提取来源 ID", 20, 300);
    if (relationshipRoleId !== null) relationshipRoleId = required(relationshipRoleId, "关系角色 ID", 300);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO memory_extraction_jobs
      (id, text, actor_id, is_owner, status, attempts, created_at, updated_at, source_message_ids_json, relationship_role_id)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`).run(id, text, actorId, isOwner ? 1 : 0, now, now,
        JSON.stringify(sources), relationshipRoleId);
    return { id, text, actorId, isOwner, attempts: 0, sourceMessageIds: sources, relationshipRoleId, createdAt: now };
  }

  claimMemoryExtraction(id: string): MemoryExtractionJob | null {
    const now = new Date().toISOString();
    const changed = this.db.prepare(`UPDATE memory_extraction_jobs SET status = 'running', worker_pid = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run(process.pid, now, id);
    if (Number(changed.changes) !== 1) return null;
    const row = this.db.prepare("SELECT * FROM memory_extraction_jobs WHERE id = ?").get(id)!;
    return { id: String(row.id), text: String(row.text), actorId: String(row.actor_id),
      isOwner: Number(row.is_owner) === 1, attempts: Number(row.attempts),
      sourceMessageIds: storedStringArray(row.source_message_ids_json),
      relationshipRoleId: row.relationship_role_id == null ? null : String(row.relationship_role_id), createdAt: String(row.created_at) };
  }

  pendingMemoryExtractions(limit = 20): MemoryExtractionJob[] {
    return this.db.prepare("SELECT * FROM memory_extraction_jobs WHERE status = 'pending' ORDER BY created_at LIMIT ?")
      .all(pageSize(limit)).map(row => ({ id: String(row.id), text: String(row.text), actorId: String(row.actor_id),
        isOwner: Number(row.is_owner) === 1, attempts: Number(row.attempts),
        sourceMessageIds: storedStringArray(row.source_message_ids_json),
        relationshipRoleId: row.relationship_role_id == null ? null : String(row.relationship_role_id), createdAt: String(row.created_at) }));
  }

  finishMemoryExtraction(id: string): void {
    this.db.prepare("UPDATE memory_extraction_jobs SET status = 'done', text = '', worker_pid = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  failMemoryExtraction(id: string, code: string): void {
    const row = this.db.prepare("SELECT attempts FROM memory_extraction_jobs WHERE id = ?").get(id);
    if (!row) return;
    const attempts = Number(row.attempts) + 1;
    this.db.prepare(`UPDATE memory_extraction_jobs SET status = ?, attempts = ?, last_error = ?, worker_pid = NULL,
      text = CASE WHEN ? >= 3 THEN '' ELSE text END, updated_at = ? WHERE id = ?`)
      .run(attempts >= 3 ? "failed" : "pending", attempts, code.slice(0, 120), attempts, new Date().toISOString(), id);
  }

  recordToolAudit(toolName: string, route: string, actorId: string, status: "ok" | "error",
    durationMs: number, argsSummary: unknown, errorCode = ""): void {
    this.db.prepare(`INSERT INTO tool_audit
      (id, tool_name, route, actor_id, status, duration_ms, args_summary, error_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), toolName.slice(0, 100), route.slice(0, 200), actorId.slice(0, 100), status,
        Math.max(0, Math.round(durationMs)), JSON.stringify(argsSummary).slice(0, 1000), errorCode.slice(0, 100), new Date().toISOString());
  }

  getConversationGeneration(scope: string): string | null {
    if (this.readOnly && !this.hasTable("app_state")) return null;
    scope = required(scope, "会话作用域", 300);
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(`conversation_generation:${scope}`);
    if (!row) return null;
    const value = String(row.value);
    return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  }

  rotateConversationGeneration(scope: string): string {
    scope = required(scope, "会话作用域", 300);
    const value = randomUUID();
    this.db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`conversation_generation:${scope}`, value);
    return value;
  }

  // ---------------------------------------------------------------------------
  // Evidence-backed events. Each PaStore is already scoped to one role's
  // database, so no caller can choose a scope or database path.
  // ---------------------------------------------------------------------------

  applyEventBatch(batch: EventBatch): EventBatchResult {
    if (typeof batch !== "object" || batch === null) throw new Error("事件批次格式无效。");
    const sessionId = required(batch.sessionId, "事件批次 sessionId", 300);
    const turnId = required(batch.turnId, "事件批次 turnId", 300);
    const extractorVersion = required(batch.extractorVersion, "extractorVersion", 100);
    if (!Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 50) {
      throw new Error("事件批次必须包含 1–50 条事件。");
    }
    const events = batch.events.map((input, index) => validateEventInput(input, index));
    const batchHash = createHash("sha256").update(JSON.stringify({
      sessionId, turnId, extractorVersion, events: events.map(stableEventShape),
    })).digest("hex");

    return this.transaction(() => {
      const previous = this.getProcessedTurn(sessionId, turnId);
      if (previous) {
        if (previous.batchHash !== batchHash) {
          throw new Error(`轮次（${turnId}）已处理过不同的事件批次；未写入任何内容。如需纠正，请使用 correction 事件。`);
        }
        return {
          sessionId, turnId, extractorVersion, batchHash, appliedAt: previous.appliedAt,
          duplicate: true, appliedCount: 0,
          events: previous.eventIds.map(id => this.getEvent(id)),
        };
      }
      // Validate every relation before writing anything.
      for (const input of events) this.validateRelation(input);
      const now = new Date().toISOString();
      const applied: MemoryEvent[] = [];
      let appliedCount = 0;
      for (const input of events) {
        const dedupeKey = eventDedupeKey(sessionId, turnId, input);
        const existing = this.db.prepare("SELECT * FROM memory_events WHERE dedupe_key = ?").get(dedupeKey);
        if (existing) {
          applied.push(event(existing));
          continue;
        }
        this.validateRelationForApplication(input);
        const id = randomUUID();
        this.db.prepare(`INSERT INTO memory_events
          (id, session_id, turn_id, kind, summary, subject, evidence_kind,
           source_message_ids_json, source_tool_call_ids_json, source_excerpts_json,
           related_event_id, status, resolved_by, superseded_by,
           status_before_resolve, status_before_supersede,
           retracted_at, retraction_reason, retracted_by_json,
           dedupe_key, extractor_version, occurred_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, ?, ?, ?, ?, ?)`)
          .run(id, sessionId, turnId, input.kind, input.summary, input.subject, input.evidenceKind,
            JSON.stringify(input.sourceMessageIds), JSON.stringify(input.sourceToolCallIds),
            JSON.stringify(input.sourceExcerpts), input.relatedEventId,
            dedupeKey, extractorVersion, now, now, now);
        const insertRef = this.db.prepare(`INSERT OR IGNORE INTO event_source_refs
          (event_id, source_kind, source_id) VALUES (?, ?, ?)`);
        for (const messageId of input.sourceMessageIds) insertRef.run(id, "message", messageId);
        for (const toolCallId of input.sourceToolCallIds) insertRef.run(id, "tool", toolCallId);
        if (input.kind === "correction" && input.relatedEventId) {
          this.supersedeEvent(input.relatedEventId, id, now, new Set());
        } else if (input.kind === "outcome" && input.relatedEventId) {
          this.resolveCommitment(input.relatedEventId, id, now);
        }
        applied.push(this.getEvent(id));
        appliedCount += 1;
      }
      const eventIds = applied.map(item => item.id);
      this.db.prepare(`INSERT INTO processed_turns
        (session_id, turn_id, extractor_version, batch_hash, event_ids_json, applied_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(sessionId, turnId, extractorVersion, batchHash, JSON.stringify(eventIds), now);
      return {
        sessionId, turnId, extractorVersion, batchHash, appliedAt: now,
        duplicate: false, appliedCount, events: applied,
      };
    });
  }

  searchEvents(query = "", limit = 10): MemoryEvent[] {
    if (query.length > 200) throw new Error("事件搜索词最多 200 个字符。");
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const conditions = ["status IN ('active', 'resolved')"];
    if (terms.length) {
      conditions.push(...terms.map(() =>
        "(summary || char(10) || source_excerpts_json || char(10) || kind || char(10) || subject) LIKE ? ESCAPE '\\'"));
    }
    const patterns = terms.map(term => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    return this.db.prepare(`SELECT * FROM memory_events WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC, created_at DESC, id LIMIT ?`)
      .all(...patterns, pageSize(limit)).map(event);
  }

  /** Explicit lookup; unlike search, this also reveals retracted/superseded status. */
  getEvent(id: string): MemoryEvent {
    id = idArgument(id, "事件 ID");
    const row = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(id);
    if (!row) throw new Error("事件不存在；请先使用 search_events 查询完整 ID。");
    return event(row);
  }

  /**
   * Extractor-facing tombstone check: find every event (including retracted and
   * superseded ones) that cites a given transcript message or tool call.
   */
  findEventsBySource(sourceKind: "message" | "tool", sourceId: string, limit = 20): MemoryEvent[] {
    if (sourceKind !== "message" && sourceKind !== "tool") throw new Error("事件来源类型必须是 message 或 tool。");
    sourceId = required(sourceId, "事件来源 ID", 300);
    return this.db.prepare(`SELECT e.* FROM memory_events e
      JOIN event_source_refs r ON r.event_id = e.id
      WHERE r.source_kind = ? AND r.source_id = ?
      ORDER BY e.occurred_at DESC, e.created_at DESC, e.id LIMIT ?`)
      .all(sourceKind, sourceId, pageSize(limit)).map(event);
  }

  getProcessedTurn(sessionId: string, turnId: string): ProcessedTurn | null {
    sessionId = required(sessionId, "sessionId", 300);
    turnId = required(turnId, "turnId", 300);
    const row = this.db.prepare(
      "SELECT * FROM processed_turns WHERE session_id = ? AND turn_id = ?").get(sessionId, turnId);
    return row ? processedTurn(row) : null;
  }

  hasProcessedTurn(sessionId: string, turnId: string): boolean {
    return this.getProcessedTurn(sessionId, turnId) !== null;
  }

  retractEvent(id: string, source?: MemorySource): EventRetractionResult {
    id = idArgument(id, "事件 ID");
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(id);
      if (!current) throw new Error("事件不存在；请先使用 search_events 查询完整 ID。");
      if (current.status === "retracted") {
        return { event: event(current), restoredEventIds: [], retractedDependentEventIds: [], alreadyRetracted: true };
      }
      if (current.status === "superseded") {
        const correctionId = current.superseded_by == null ? "未知" : String(current.superseded_by);
        throw new Error(`事件（ID: ${id}）已被纠正事件（ID: ${correctionId}）取代。请撤回该纠正事件以恢复原结论。`);
      }
      const restoredEventIds: string[] = [];
      const retractedDependentEventIds: string[] = [];
      this.retractOne(id, appProvenance(source), "retracted_explicitly",
        restoredEventIds, retractedDependentEventIds, new Set(), true);
      return {
        event: this.getEvent(id), restoredEventIds, retractedDependentEventIds, alreadyRetracted: false,
      };
    });
  }

  private validateRelation(input: NormalizedEventInput): void {
    if (!input.relatedEventId) return;
    const target = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(input.relatedEventId);
    if (!target) {
      throw new Error(`关联事件不存在或不属于当前角色作用域（ID: ${input.relatedEventId}）；未写入任何内容。`);
    }
    if (target.status === "retracted") {
      throw new Error(`关联事件（ID: ${input.relatedEventId}）已撤回，不能继续引用。`);
    }
    if (input.kind === "correction") {
      if (target.status === "superseded") {
        const correctionId = target.superseded_by == null ? "未知" : String(target.superseded_by);
        throw new Error(`关联事件（ID: ${input.relatedEventId}）已被纠正事件（ID: ${correctionId}）取代；请改为纠正该事件或撤回原纠正。`);
      }
      return;
    }
    if (input.kind === "outcome") {
      if (target.status !== "active") {
        throw new Error(`关联事件（ID: ${input.relatedEventId}）当前状态为 ${String(target.status)}，不能再次以 outcome 解决。`);
      }
      if (!this.tracesToPromise(String(target.id))) {
        throw new Error(`outcome 只能关联当前有效的承诺，或能追溯到承诺的纠正事件（ID: ${input.relatedEventId}）；未写入任何内容。`);
      }
      return;
    }
    if (target.status === "superseded") {
      throw new Error(`关联事件（ID: ${input.relatedEventId}）已被纠正，不能作为当前结论引用。`);
    }
  }

  private validateRelationForApplication(input: NormalizedEventInput): void {
    // Relations can change earlier in the same batch (for example two
    // corrections targeting one event), so re-check before each mutation.
    this.validateRelation(input);
  }

  private supersedeEvent(targetId: string, correctionId: string, now: string, visited: Set<string>): void {
    if (visited.has(targetId)) return;
    visited.add(targetId);
    const target = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(targetId);
    if (!target) throw new Error(`要纠正的事件不存在（ID: ${targetId}）；未写入任何内容。`);
    const status = String(target.status);
    if (status === "retracted") throw new Error(`要纠正的事件（ID: ${targetId}）已撤回；未写入任何内容。`);
    if (status === "superseded") {
      const existing = target.superseded_by == null ? "未知" : String(target.superseded_by);
      throw new Error(`要纠正的事件（ID: ${targetId}）已被事件（ID: ${existing}）纠正；请改为纠正该事件或撤回原纠正。`);
    }
    this.db.prepare(`UPDATE memory_events SET status = 'superseded', superseded_by = ?,
      status_before_supersede = ?, updated_at = ? WHERE id = ?`)
      .run(correctionId, status, now, targetId);
    const dependents = this.db.prepare(`SELECT id FROM memory_events
      WHERE related_event_id = ? AND status IN ('active', 'resolved') AND id <> ?`).all(targetId, correctionId);
    for (const dependent of dependents) {
      this.supersedeEvent(String(dependent.id), correctionId, now, visited);
    }
  }

  /**
   * A commitment is either a promise or a correction whose relation chain
   * ends at a promise. Traversal is bounded and rejects cycles, retracted
   * links, and chains that end at an outcome or another unrelated event.
   */
  private tracesToPromise(eventId: string): boolean {
    const visited = new Set<string>();
    let currentId: string | null = eventId;
    while (currentId !== null && visited.size < 20) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      const row: Row | undefined = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(currentId);
      if (!row) return false;
      const kind = String(row.kind);
      const status = String(row.status);
      if (kind === "promise") return status !== "retracted";
      if (kind !== "correction" || status === "retracted") return false;
      currentId = row.related_event_id == null ? null : String(row.related_event_id);
    }
    return false;
  }

  private resolveCommitment(commitmentId: string, outcomeId: string, now: string): void {
    const commitment = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(commitmentId);
    if (!commitment) throw new Error(`要解决的事件不存在（ID: ${commitmentId}）；未写入任何内容。`);
    if (commitment.status !== "active") {
      throw new Error(`事件（ID: ${commitmentId}）当前状态为 ${String(commitment.status)}，不能以 outcome 解决。`);
    }
    if (!this.tracesToPromise(commitmentId)) {
      throw new Error(`outcome 只能关联当前有效的承诺，或能追溯到承诺的纠正事件（ID: ${commitmentId}）。`);
    }
    this.db.prepare(`UPDATE memory_events SET status = 'resolved', resolved_by = ?,
      status_before_resolve = 'active', updated_at = ? WHERE id = ?`)
      .run(outcomeId, now, commitmentId);
  }

  private clearResolutionPointer(id: string, now: string): void {
    this.db.prepare(`UPDATE memory_events SET resolved_by = NULL, status_before_resolve = NULL,
      status_before_supersede = CASE WHEN status_before_supersede = 'resolved' THEN 'active'
        ELSE status_before_supersede END,
      updated_at = ? WHERE id = ? AND resolved_by IS NOT NULL`).run(now, id);
  }

  private retractOne(eventId: string, source: ProvenanceRecord, reason: string,
    restored: string[], cascaded: string[], visited: Set<string>, root: boolean): void {
    if (visited.has(eventId)) return;
    visited.add(eventId);
    const row = this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(eventId);
    if (!row || row.status === "retracted") return;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE memory_events SET status = 'retracted', retracted_at = ?,
      retraction_reason = ?, retracted_by_json = ?, updated_at = ?,
      resolved_by = NULL, status_before_resolve = NULL WHERE id = ?`)
      .run(now, reason, JSON.stringify(source), now, eventId);
    if (!root) cascaded.push(eventId);

    // Withdrawing a correction restores what it superseded. Validate every
    // candidate first because a resolved state is only valid when its outcome
    // is active or is itself being restored by this same withdrawal.
    const superseded = this.db.prepare(`SELECT * FROM memory_events
      WHERE superseded_by = ? AND status = 'superseded'`).all(eventId);
    const restorable = new Map<string, "active" | "resolved">();
    for (const target of superseded) {
      const before = String(target.status_before_supersede ?? "active");
      let status: "active" | "resolved" | null = before === "active" || before === "resolved" ? before : null;
      if (status === "resolved") {
        const outcomeId = target.resolved_by == null ? null : String(target.resolved_by);
        const outcome = outcomeId
          ? this.db.prepare("SELECT * FROM memory_events WHERE id = ?").get(outcomeId) : undefined;
        const outcomeWillBeActive = outcome != null && (
          outcome.status === "active"
          || (outcome.status === "superseded" && String(outcome.superseded_by) === eventId
            && String(outcome.status_before_supersede ?? "active") === "active"));
        if (!outcome || outcome.kind !== "outcome" || !outcomeWillBeActive) status = "active";
      }
      if (status) restorable.set(String(target.id), status);
    }
    for (const [targetId, status] of restorable) {
      if (status === "resolved") {
        this.db.prepare(`UPDATE memory_events SET status = 'resolved', superseded_by = NULL,
          status_before_supersede = NULL, updated_at = ? WHERE id = ?`).run(now, targetId);
      } else {
        this.db.prepare(`UPDATE memory_events SET status = 'active', superseded_by = NULL,
          status_before_supersede = NULL, resolved_by = NULL, status_before_resolve = NULL,
          updated_at = ? WHERE id = ?`).run(now, targetId);
      }
      restored.push(targetId);
    }

    // Withdrawing an outcome reopens the promise or correction it resolved.
    if (row.kind === "outcome" && row.related_event_id != null) {
      const target = this.db.prepare("SELECT * FROM memory_events WHERE id = ?")
        .get(String(row.related_event_id));
      if (target && target.resolved_by === eventId) {
        if (target.status === "resolved") {
          this.db.prepare(`UPDATE memory_events SET status = 'active', resolved_by = NULL,
            status_before_resolve = NULL, updated_at = ? WHERE id = ?`)
            .run(now, String(target.id));
          restored.push(String(target.id));
        } else {
          // The target was corrected after being resolved. Its pre-correction
          // "resolved" state is no longer valid, so never restore it later.
          this.clearResolutionPointer(String(target.id), now);
        }
      }
    }

    // Any remaining dependent conclusion cannot outlive its source event.
    const dependents = this.db.prepare(`SELECT id FROM memory_events
      WHERE related_event_id = ? AND status IN ('active', 'resolved') AND id <> ?`)
      .all(eventId, eventId);
    for (const dependent of dependents) {
      this.retractOne(String(dependent.id), source, "dependency_retracted", restored, cascaded, visited, false);
    }
  }

  /** Reads do not create rows: opening a group/work session cannot initialize private state. */
  getRelationshipState(roleId: string): RelationshipState {
    roleId = required(roleId, "关系角色 ID", 300);
    if (this.readOnly && !this.hasTable("relationship_state")) return initialRelationshipState(roleId, this.relationshipClock().toISOString());
    const row = this.db.prepare("SELECT * FROM relationship_state WHERE role_id = ?").get(roleId);
    return row ? relationshipState(row) : initialRelationshipState(roleId, this.relationshipClock().toISOString());
  }

  private writeRelationshipState(state: RelationshipState): void {
    this.db.prepare(`INSERT INTO relationship_state
      (role_id, intimacy, stage, stage_floor, competence_trust, mood, mood_intensity,
       boundaries_json, consent_json, proactive_romance_enabled, last_user_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET intimacy=excluded.intimacy, stage=excluded.stage,
        stage_floor=excluded.stage_floor, competence_trust=excluded.competence_trust,
        mood=excluded.mood, mood_intensity=excluded.mood_intensity,
        last_user_at=excluded.last_user_at, updated_at=excluded.updated_at`)
      .run(state.roleId, state.intimacy, state.stage, state.stageFloor, state.competenceTrust,
        state.mood, state.moodIntensity, JSON.stringify(state.boundaries), JSON.stringify(state.consent),
        state.proactiveRomanceEnabled ? 1 : 0, state.lastUserAt, state.updatedAt);
  }

  /** Cap and source deduplication share the write transaction across every private channel. */
  applyIntimacySignal(roleId: string, delta: number, summary: string,
    sourceMessageIds: string[], mood?: Mood, sourceExcerpts: string[] = [], memoryId: string | null = null): RelationshipState {
    roleId = required(roleId, "关系角色 ID", 300);
    positiveDelta(delta);
    summary = required(summary, "关系事件摘要", 500);
    const sources = textList(sourceMessageIds, "关系来源 ID", 20, 300);
    const excerpts = textList(sourceExcerpts, "关系证据摘录", 10, 500);
    if (memoryId !== null) memoryId = idArgument(memoryId, "关系记忆 ID");
    if (!sources.length) throw new Error("亲密度信号必须提供真实用户消息 ID。");
    if (mood !== undefined) validateMood(mood, mood === "shy" ? 0.6 : 0.4);
    return this.transaction(() => {
      const current = this.getRelationshipState(roleId);
      const duplicate = this.db.prepare(`SELECT 1 FROM relationship_events e, json_each(e.source_message_ids_json) s
        WHERE e.role_id = ? AND e.kind = 'intimacy' AND s.value IN (${sources.map(() => "?").join(",")}) LIMIT 1`)
        .get(roleId, ...sources);
      const now = this.relationshipClock().toISOString();
      const day = relationshipDay(new Date(now), this.relationshipTimezone);
      // A bounded timestamp window includes even 25-hour local dates and all IANA offsets.
      const start = new Date(Date.parse(now) - 48 * 3600000).toISOString();
      const end = new Date(Date.parse(now) + 48 * 3600000).toISOString();
      const earned = this.db.prepare(`SELECT emotional_weight, created_at FROM relationship_events
        WHERE role_id = ? AND kind = 'intimacy' AND created_at >= ? AND created_at <= ?`)
        .all(roleId, start, end).filter(row =>
          relationshipDay(new Date(String(row.created_at)), this.relationshipTimezone) === day)
        .reduce((sum, row) => sum + Number(row.emotional_weight), 0);
      const applied = Math.min(delta, Math.max(0, 3 - earned), 100 - current.intimacy);
      if (duplicate || applied <= 0) return current;
      let next = increaseIntimacy(current, applied, now);
      if (mood !== undefined) next = { ...next, mood, moodIntensity: mood === "shy" ? 0.6 : 0.4 };
      this.writeRelationshipState(next);
      const event = this.insertRelationshipEvent(roleId, "intimacy", summary, applied, sources, now);
      this.db.prepare("UPDATE relationship_events SET source_excerpts_json = ?, memory_id = ? WHERE id = ?")
        .run(JSON.stringify(excerpts), memoryId, event.id);
      return next;
    });
  }

  /** Explicit application API only; no model tool or automatic signal awards trust. */
  increaseCompetenceTrust(roleId: string, delta: number): RelationshipState {
    roleId = required(roleId, "关系角色 ID", 300);
    positiveDelta(delta);
    return this.transaction(() => {
      const next = increaseTrust(this.getRelationshipState(roleId), delta, this.relationshipClock().toISOString());
      this.writeRelationshipState(next);
      return next;
    });
  }

  setRelationshipMood(roleId: string, mood: Mood, intensity: number): RelationshipState {
    roleId = required(roleId, "关系角色 ID", 300);
    validateMood(mood, intensity);
    return this.transaction(() => {
      const next = { ...this.getRelationshipState(roleId), mood, moodIntensity: intensity,
        updatedAt: this.relationshipClock().toISOString() };
      this.writeRelationshipState(next);
      return next;
    });
  }

  recordRelationshipEvent(roleId: string, kind: RelationshipEventKind, summary: string,
    weight: number, sourceMessageIds: string[]): RelationshipEvent {
    roleId = required(roleId, "关系角色 ID", 300);
    if (!["intimacy", "milestone", "mood"].includes(kind)) throw new Error("关系事件类型无效。");
    summary = required(summary, "关系事件摘要", 500);
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > 100) throw new Error("关系事件权重必须在 0–100 之间。");
    const sources = textList(sourceMessageIds, "关系来源 ID", 20, 300);
    return this.transaction(() => this.insertRelationshipEvent(roleId, kind, summary, weight,
      sources, this.relationshipClock().toISOString()));
  }

  private insertRelationshipEvent(roleId: string, kind: RelationshipEventKind, summary: string,
    weight: number, sources: string[], now: string): RelationshipEvent {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO relationship_events
      (id, role_id, kind, summary, emotional_weight, source_message_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, roleId, kind, summary, weight, JSON.stringify(sources), now);
    return { id, roleId, kind, summary, emotionalWeight: weight, sourceMessageIds: sources, createdAt: now };
  }

  listRelationshipEvents(roleId: string, limit = 5): RelationshipEvent[] {
    roleId = required(roleId, "关系角色 ID", 300);
    return this.db.prepare(`SELECT * FROM relationship_events WHERE role_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(roleId, pageSize(limit)).map(relationshipEvent);
  }

  /** Read-only projection source; all filters are applied before rows leave this DB. */
  readScopedMemoryProjection(layer: MemoryLayer, characterId: string | null = null,
    groupId: string | null = null): Memory[] {
    if (this.readOnly && !this.hasTable("memories")) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE status = 'active' AND layer = ?
      AND character_id IS ? AND group_id IS ? ORDER BY updated_at DESC, created_at DESC, id`)
      .all(layer, characterId, groupId).map(memory);
  }

  readPendingProjection(): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at, id").all().map(task);
  }

  /** Evidence ledger references facts in memories; it is never a second runtime fact store. */
  recordRelationshipEvidence(roleId: string, kind: RelationshipEvidenceKind, memoryId: string,
    sources: string[], excerpts: string[], dedupeKey: string): void {
    roleId = required(roleId, "关系角色 ID", 300);
    if (!["intimacy", "milestone", "repair", "confession"].includes(kind)) throw new Error("关系候选类型无效。");
    memoryId = idArgument(memoryId, "关系记忆 ID");
    sources = textList(sources, "关系来源 ID", 20, 300);
    excerpts = textList(excerpts, "关系证据摘录", 10, 500);
    if (!sources.length || !excerpts.length) throw new Error("关系候选缺少用户来源或逐字证据。");
    dedupeKey = required(dedupeKey, "关系去重键", 100);
    this.transaction(() => {
      // Keep the legacy kind CHECK and rows intact; event_type is an additive extension.
      this.db.prepare(`INSERT OR IGNORE INTO relationship_events
        (id, role_id, kind, summary, emotional_weight, source_message_ids_json, created_at,
         event_type, source_excerpts_json, memory_id, dedupe_key)
        VALUES (?, ?, 'milestone', '已校验的用户关系证据（事实以关联记忆当前状态为准）', 0, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), roleId, JSON.stringify(sources), this.relationshipClock().toISOString(),
          kind, JSON.stringify(excerpts), memoryId, dedupeKey);
      this.db.prepare(`UPDATE relationship_events SET memory_id = ? WHERE role_id = ?
        AND kind = 'intimacy' AND memory_id IS NULL AND EXISTS
        (SELECT 1 FROM json_each(source_message_ids_json) WHERE value IN (${sources.map(() => "?").join(",")}))`)
        .run(memoryId, roleId, ...sources);
    });
  }

  close(): void { this.db.close(); }
}
