import type { ParticipationNotice, ParticipationReason } from "./participation-policy.js";
import type { RoomPageReadProvider, RoomSearchProvider } from "./websearch.js";
import type { RoomGitHubReadProvider } from "./github.js";
import type { RoomContextWindowSource } from "../prompting/context-budget.js";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import type { WebProvider } from "../web.js";
import type { MonotonicDeadline, WebTaskCallScope, WebTaskUsage } from "../web-task.js";

export type RoomLanguage = "zh" | "ja";
export type RoomDeliveryMode = "text" | "both" | "voice" | "auto";
export type ResolvedDeliveryMode = Exclude<RoomDeliveryMode, "auto">;
export interface CharacterLanguage {
  textLanguage: "zh";
  voiceLanguage: RoomLanguage;
  translateForVoice: boolean;
}

export interface RoomCharacter {
  id: string;
  accountKey: string;
  selfId: string;
  name: string;
  voiceKey: string;
}


/** `session` remains readable only by the frozen Legacy schema; the active lifecycle path rejects it. */
export type RoomParticipationMode = "mention_only" | "ambient" | "session";
export type RoomControlAction = "stop" | "pause" | "resume" | "status" | "start_session" | "extend_session" | "set_mode";
export type RoomControlKind = "applied" | "ignored" | "duplicate" | "rejected" | "observed";
export interface RoomControlResult {
  kind: RoomControlKind;
  action: RoomControlAction;
  reason: string | null;
  mode: RoomParticipationMode;
  paused: boolean;
  epoch: number;
  executionRevision: number;
  sessionExpiresAt: number | null;
  cancelledQueued: number;
  cancelledActive: boolean;
}
/** Same strict boundary for persisted control results and newly written results. */
export function checkedRoomControlResult(value: unknown): Readonly<RoomControlResult> {
  const bad = () => { throw new Error("room-control-result-invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "action,cancelledActive,cancelledQueued,epoch,executionRevision,kind,mode,paused,reason,sessionExpiresAt"
    || typeof v.kind !== "string" || !["applied", "ignored", "duplicate", "rejected", "observed"].includes(v.kind)
    || typeof v.action !== "string" || !["stop", "pause", "resume", "status", "start_session", "extend_session", "set_mode"].includes(v.action)
    || typeof v.mode !== "string" || !["mention_only", "ambient", "session"].includes(v.mode)
    || typeof v.paused !== "boolean" || typeof v.cancelledActive !== "boolean"
    || (v.reason !== null && (typeof v.reason !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/.test(v.reason)))
    || ![v.epoch, v.executionRevision, v.cancelledQueued].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    || (v.sessionExpiresAt !== null && (typeof v.sessionExpiresAt !== "number" || !Number.isSafeInteger(v.sessionExpiresAt) || v.sessionExpiresAt < 0))) return bad();
  return Object.freeze({ ...v }) as unknown as Readonly<RoomControlResult>;
}
/** Internal execution authorization; never persisted as a public delivery contract. */
export interface RoomGatePermit {
  readonly gateId: string;
  readonly roomId: string;
  readonly workItemId: string;
  readonly burstId: string;
  readonly eventKey: string;
  readonly executionEpoch: number;
  readonly executionRevision: number;
  readonly policyRevision: number;
  readonly issuedAt: number;
  readonly slot: string;
}

export type ResponseTier = "daily" | "formal" | "detailed";
export interface ResponseBudget { readonly maxTextChars: number; readonly outputTokens: number }
export type ResponseBudgets = Readonly<Record<ResponseTier, ResponseBudget>>;
export interface ResponseFields {
  readonly intent: "chat" | "explain" | "analyze" | "advise";
  readonly depth: "brief" | "standard" | "detailed";
  readonly rigor: "casual" | "careful";
  readonly tone: "casual" | "formal";
  readonly personaIntensity: "normal" | "restrained";
}
export type ResponseField = keyof ResponseFields;
export interface ResponsePlan extends ResponseFields {
  readonly planId: string;
  readonly sources: Readonly<Record<ResponseField, "requested" | "inferred" | "approved_default">>;
  readonly tier: ResponseTier;
  readonly budget: ResponseBudget;
  readonly assistance: "not_needed" | "used" | "unavailable" | "error" | "timeout" | "invalid";
}
/** Accepted target stays separate from rolling public history, even after pruning. */
export interface WorkerTarget {
  readonly messageRowId: number;
  readonly messageId: string;
  readonly senderKey: string;
  readonly text: string;
  readonly characterIds: readonly string[];
}
export interface WorkerContext {
  readonly contextRevision: string;
  readonly target: WorkerTarget;
  readonly history: readonly RoomMessage[];
  readonly primaryText: Readonly<{ turnId: string; messageRowId: number; text: string }> | null;
}
export interface WorkerDecision {
  readonly decisionId: string;
  readonly decisionRevision: 1;
  readonly kind: "primary" | "supplement";
  readonly characterId: string;
}
export interface WorkerTurnBinding {
  readonly workItemId: string; readonly burstId: string; readonly eventKey: string;
  readonly targetId: number; readonly targetHash: string;
  readonly turnId: string; readonly turnIndex: number; readonly characterId: string;
  readonly contextRevision: string; readonly plan: ResponsePlan; readonly decision: WorkerDecision;
  readonly gate: RoomGatePermit; readonly grantId: string;
  readonly slotConsumed: true; readonly slotReturned: false;
}
export interface WorkerContextBudgetComponent {
  readonly chars: number;
  readonly tokens: number;
}
export interface WorkerContextBudgetDiagnostic {
  readonly reason: "room-context-budget";
  readonly contextTokens: number;
  readonly outputReserve: number;
  readonly safetyReserve: number;
  readonly budget: number;
  readonly historyRows: number;
  readonly historyWindowRows: number;
  readonly historyPagesRead: number;
  readonly retainedHistory: number;
  readonly trimmedHistory: number;
  readonly trimmedByWindow: number;
  readonly trimmedByBudget: number;
  readonly systemChars: number;
  readonly systemTokens: number;
  readonly payloadChars: number;
  readonly payloadTokens: number;
  readonly usedTokens: number;
  readonly overBy: number;
  readonly history: WorkerContextBudgetComponent;
  readonly evidence: {
    readonly searchResults: WorkerContextBudgetComponent | null;
    readonly searchPages: WorkerContextBudgetComponent | null;
    readonly github: WorkerContextBudgetComponent | null;
    readonly directPage: WorkerContextBudgetComponent | null;
  };
  readonly output: {
    readonly reserveTokens: number;
    readonly maxTextChars: number;
  };
}
export interface WorkerObligation {
  readonly characterId: string;
  readonly status: "pending" | "fulfilled" | "failed" | "blocked" | "cancelled" | "unavailable";
  readonly reason: string | null;
  readonly turnId: string | null;
  readonly diagnostic?: WorkerContextBudgetDiagnostic;
}
export interface WorkerGenerationRequest {
  readonly binding: WorkerTurnBinding;
  readonly context: WorkerContext;
  readonly prompt: RoomPrompt;
  readonly budget: ResponseBudget;
}
export interface RoomToolHost {
  readonly declarations: readonly Tool[];
  execute(call: ToolCall, scope: WebTaskCallScope): Promise<{ readonly value: unknown; readonly isError: boolean }>;
  /** True when any model-supplied string or key is protected. */
  containsProtectedText(value: unknown): boolean;
  /** Counts a protected call as an attempt without invoking a provider. */
  rejectProtected(call: ToolCall, scope: WebTaskCallScope): Promise<{ readonly value: unknown; readonly isError: boolean }>;
  /** Counts-only task usage for bounded termination diagnostics. */
  usage(): WebTaskUsage;
}
/** A public-only tool session plus the parent deadline that applies to this reply loop. */
export interface RoomModelToolScope {
  readonly tools: RoomToolHost;
  readonly turnDeadline: MonotonicDeadline;
  /** Called before each model round after the first; false means the visible quota is exhausted. */
  authorizeModelRound?: () => boolean;
  /** Counts-only observation; compaction never silently discards the current task. */
  readonly onContextCompacted?: (notice: Readonly<{ compactedResults: number; usedTokens: number; inputBudget: number }>) => void;
}
export type RoomContextCompactionNotice = Readonly<{
  compactedResults: number;
  usedTokens: number;
  inputBudget: number;
}>;
/** All three ports are synthetic, explicit test-only calls. No production adapter implements them. */
export interface SyntheticResponsePort {
  plan?: (request: Readonly<{ context: WorkerContext; rulePlan: ResponsePlan; unresolved: readonly ResponseField[] }>, signal: AbortSignal) => Promise<unknown>;
  generate(request: WorkerGenerationRequest, signal: AbortSignal, tools?: RoomModelToolScope): Promise<unknown>;
  text(request: Readonly<{ binding: WorkerTurnBinding; text: string }>, signal: AbortSignal): Promise<unknown>;
}

export interface RoomLimits {
  maxTextChars: number;
  /** Compatibility page-size hint; never a total retained or prompt row cap. */
  maxHistory: number;
  /** Finite database page size; older pages are read only while budget remains. */
  historyPageRows: number;
  contextTokens: number;
  outputTokens: number;
  /** null disables this per-minute cap; attempts remain recorded for diagnostics. */
  turnsPerMinute: number | null;
  /** null disables this hourly cap; attempts remain recorded for diagnostics. */
  modelAttemptsPerHour: number | null;
  ttsAttemptsPerHour: number | null;
  requestTimeoutMs: number;
  /** One monotonic parent deadline for a Legacy Burst or Worker WorkItem. */
  replyDeadlineMs: number;
  ambientMessages: number;
  ambientPeople: number;
  ambientQuietMs: number;
  ambientCooldownMs: number;
}

export interface RoomConfig {
  roomId: string;
  groupId: string;
  ownerId: string;
  ingressAccountKey: string;
  characters: readonly RoomCharacter[];
  limits?: Partial<RoomLimits>;
  /** Runtime-normalized source carried after pre-merge Room cap detection. */
  contextWindowSource?: RoomContextWindowSource;
  /** Worker-only response profiles; never changes Legacy limits or model.ts. */
  workerResponseBudgets?: Readonly<Partial<Record<ResponseTier, ResponseBudget>>>;
  characterLanguages?: Readonly<Record<string, CharacterLanguage>>;
  deliveryMode?: RoomDeliveryMode;
  participation?: {
    enabled?: boolean;
    aliases?: Readonly<Record<string, readonly string[]>>;
  };
}

/** The future transport must authenticate the connection before constructing this event. */
export interface RoomInput {
  accountKey: string;
  selfId: string;
  groupId: string;
  senderId: string;
  messageId: string;
  text: string;
  mentions?: readonly string[];
  replyToMessageId?: string;
  unsupported?: boolean;
}

export type Trigger = "direct" | "manual" | "ambient";
export interface RoomMessage {
  id: number;
  speakerType: "user" | "bot";
  speakerId: string;
  accountKey: string;
  targetId: number | null;
  text: string;
  platformId: string;
  createdAt?: number;
  /** voice rows contain Chinese semantics, not a claim that Chinese text was sent. */
  medium?: "text" | "voice";
}

export interface RoomPrompt {
  systemPrompt: string;
  messages: readonly [{ role: "user"; content: string }];
  /** Public-only declarations. Private PA tools must never appear here. */
  tools: readonly Tool[];
  personaHash: string;
  characterId: string;
  accountKey: string;
  voiceKey: string;
  targetId: number;
}
export type RoomAnswer = { kind: "skip" } | { kind: "reply"; text: string };
export interface PreparedReply {
  characterId: string;
  text: string;
  voiceText?: string;
  voiceLanguage?: RoomLanguage;
}
export interface RoomDelivery extends PreparedReply {
  accountKey: string;
  voiceKey: string;
  turnId: string;
  text: string;
}
export interface RoomAmbientParticipationNotice {
  readonly code: `ambient_rule_${ParticipationReason}` | "ambient_planner_skip" | "ambient_stale_anchor";
  readonly anchorRowId: number;
}

export interface RoomDependencies {
  now?: () => number;
  /** Injected monotonic clock for deadline tests; production defaults to performance.now(). */
  monotonicNow?: () => number;
  /** Sanitized counts-only observer for bounded tool-result compaction. */
  onContextCompacted?: (notice: RoomContextCompactionNotice) => void;
  /** R1 text transport explicitly disables voice; omitted preserves the audio-capable core. */
  voiceAvailable?: boolean;
  /** Loads an independent public persona snapshot. Never supply the private PA loader. */
  persona: (character: RoomCharacter) => string;
  generate: (prompt: RoomPrompt, signal: AbortSignal, tools?: RoomModelToolScope) => Promise<RoomAnswer>;
  /** Same tools-free model endpoint; only used for voice translation, never text-only replies. */
  translateVoice?: (prompt: RoomPrompt, signal: AbortSignal) => Promise<string>;
  /** Shared Tavily provider used by the public Web tool loop. */
  webProvider?: WebProvider;
  /** @deprecated Compatibility-only fixed pre-fetch ports; runtime reply paths do not use them. */
  search?: RoomSearchProvider;
  /** @deprecated Compatibility-only fixed pre-fetch ports; runtime reply paths do not use them. */
  fetchPage?: RoomPageReadProvider;
  /** Narrow public-GitHub read port; never exposes ordinary PA tools to the model. */
  githubRead?: RoomGitHubReadProvider;
  synthesize: (delivery: RoomDelivery, signal: AbortSignal) => Promise<Uint8Array>;
  sendText: (delivery: RoomDelivery, signal: AbortSignal) => Promise<string>;
  sendAudio: (delivery: RoomDelivery, audio: Uint8Array, signal: AbortSignal) => Promise<string>;
  /** Required at both provider and public output boundaries. Fail closed on exceptions. */
  permitsText: (text: string) => boolean;
  /** Separate system-rule validation from user/output content filtering. Exceptions deny the request. */
  permitsPrompt?: (prompt: RoomPrompt) => boolean;
  /** Fixed policy metadata only; never include input text or raw platform IDs. */
  onParticipation?: (notice: ParticipationNotice) => void;
  onAmbientParticipation?: (notice: RoomAmbientParticipationNotice) => void;
  onVoicePreparation?: (notice: { code: "translated" | "failed" | "budget" | "unavailable" | "cancelled"; elapsedMs: number }) => void;
}

export class RoomSendError extends Error {
  constructor(readonly outcome: "rejected" | "uncertain") { super(outcome); }
}

/** Fixed diagnostic codes only; exceptions from providers are never copied into notices. */
export type TurnState = "generating" | "skipped" | "generation_failed" | "budget" | "rate_limited"
  | "text_sending" | "text_sent" | "text_failed" | "text_uncertain" | "sent_unrecorded"
  | "translating" | "synthesizing" | "text_only" | "audio_sending" | "audio_failed" | "audio_uncertain"
  | "delivered" | "stopped" | "interrupted";
