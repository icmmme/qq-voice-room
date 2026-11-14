/**
 * Shared, app-owned memory types.
 *
 * `MemorySource` is produced by the host application (session / message / tool
 * call identifiers). It is never read from model tool arguments. Notes and
 * events only accept it through explicit application API parameters.
 */
export interface MemorySource {
  /** Pi session identity, or null when the app writes without a session. */
  sessionId: string | null;
  /** Pi message identifiers that caused this write. */
  messageIds: string[];
  /** Pi tool-call identifiers, when the evidence includes a tool result. */
  toolCallIds?: string[];
}

/** Provenance persisted with a note or a retraction. */
export interface ProvenanceRecord {
  /** "legacy" is reserved for rows created before provenance existed. */
  kind: "app" | "legacy";
  recordedAt: string | null;
  sessionId: string | null;
  messageIds: string[];
  toolCallIds: string[];
}

export type EventKind = "promise" | "correction" | "outcome";
export type EventSubject = "user" | "assistant";
export type EvidenceKind = "user_statement" | "assistant_statement" | "tool_result";
export type EventStatus = "active" | "resolved" | "superseded" | "retracted";

/**
 * One candidate event supplied by the (later) extractor.
 *
 * `sourceMessageIds` and `sourceToolCallIds` point at the real transcript;
 * `sourceExcerpts` are short, exact quotes used as evidence. The extractor and
 * storage never accept a timestamp, scope, database path, or relationship
 * score from the model.
 */
export interface EventInput {
  kind: EventKind;
  summary: string;
  subject: EventSubject;
  evidenceKind: EvidenceKind;
  sourceMessageIds: string[];
  sourceToolCallIds: string[];
  relatedEventId?: string;
  sourceExcerpts: string[];
}

/** One extraction unit for a single assistant turn. */
export interface EventBatch {
  sessionId: string;
  turnId: string;
  events: EventInput[];
  extractorVersion: string;
}

export interface MemoryEvent {
  id: string;
  sessionId: string;
  turnId: string;
  kind: EventKind;
  summary: string;
  subject: EventSubject;
  evidenceKind: EvidenceKind;
  sourceMessageIds: string[];
  sourceToolCallIds: string[];
  sourceExcerpts: string[];
  relatedEventId: string | null;
  status: EventStatus;
  /** Set on a promise currently resolved by an outcome. */
  resolvedByEventId: string | null;
  /** Set on an event replaced by a correction. */
  supersededByEventId: string | null;
  retractedAt: string | null;
  retractionReason: string | null;
  retractionSource: ProvenanceRecord | null;
  extractorVersion: string;
  /** Assigned by the application when the batch is applied. */
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessedTurn {
  sessionId: string;
  turnId: string;
  extractorVersion: string;
  batchHash: string;
  eventIds: string[];
  appliedAt: string;
}

export interface EventBatchResult {
  sessionId: string;
  turnId: string;
  extractorVersion: string;
  batchHash: string;
  appliedAt: string;
  /** True when this exact batch had already been applied. */
  duplicate: boolean;
  /** Number of newly inserted events (0 for a duplicate replay). */
  appliedCount: number;
  /** Events applied by this batch, or the previously applied events on replay. */
  events: MemoryEvent[];
}

export interface EventRetractionResult {
  event: MemoryEvent;
  /** Events restored to their previous active/resolved status. */
  restoredEventIds: string[];
  /** Dependent events invalidated by this retraction. */
  retractedDependentEventIds: string[];
  alreadyRetracted: boolean;
}
