export const CONTEXT_SAFETY_MARGIN_TOKENS = 1024;
export const HIGH_CONTEXT_WINDOW_THRESHOLD = 262144;
export const SAFE_ROOM_CONTEXT_WINDOW = 65536;

export type PaContextWindowSource = "env" | "default";
export type RoomContextWindowSource = "explicit-room" | "default-safe";

export interface ContextBudget {
  readonly effectiveWindow: number;
  readonly outputReserve: number;
  readonly safetyMargin: number;
  readonly inputBudget: number;
}

export interface ContextBudgetUsage extends ContextBudget {
  readonly usedTokens: number;
  readonly fits: boolean;
  readonly overBy: number;
}

export interface RoomContextWindowResolution {
  readonly effectiveWindow: number;
  readonly roomCapSource: RoomContextWindowSource;
  readonly configuredModelWindow: number;
  readonly modelWindowSource: PaContextWindowSource;
  readonly modelWindowVerified: boolean;
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}-invalid`);
  return value;
};

/** Shared PA/Room arithmetic. It contains no session, room, URL, or prompt data. */
export function calculateContextBudget(effectiveWindow: number, outputReserve: number,
  safetyMargin = CONTEXT_SAFETY_MARGIN_TOKENS): Readonly<ContextBudget> {
  positiveInteger(effectiveWindow, "context-window");
  positiveInteger(outputReserve, "output-reserve");
  if (!Number.isSafeInteger(safetyMargin) || safetyMargin < 0) throw new Error("context-safety-margin-invalid");
  return Object.freeze({
    effectiveWindow,
    outputReserve,
    safetyMargin,
    inputBudget: effectiveWindow - outputReserve - safetyMargin,
  });
}

export function measureContextBudget(effectiveWindow: number, outputReserve: number,
  usedTokens: number, safetyMargin = CONTEXT_SAFETY_MARGIN_TOKENS): Readonly<ContextBudgetUsage> {
  if (!Number.isSafeInteger(usedTokens) || usedTokens < 0) throw new Error("context-used-tokens-invalid");
  const budget = calculateContextBudget(effectiveWindow, outputReserve, safetyMargin);
  return Object.freeze({ ...budget, usedTokens, fits: usedTokens <= budget.inputBudget,
    overBy: Math.max(0, usedTokens - budget.inputBudget) });
}

/** C7: preserve the pre-merge Room cap source instead of inferring it from a later min(). */
export function selectRoomContextWindow(input: {
  roomCap: number;
  roomCapSource: RoomContextWindowSource;
  configuredModelWindow: number;
  modelWindowSource: PaContextWindowSource;
  modelWindowVerified: boolean;
}): Readonly<RoomContextWindowResolution> {
  const roomCap = positiveInteger(input.roomCap, "room-context-window");
  const modelWindow = positiveInteger(input.configuredModelWindow, "model-context-window");
  if (input.roomCapSource !== "explicit-room" && input.roomCapSource !== "default-safe") {
    throw new Error("room-context-window-source-invalid");
  }
  if (input.modelWindowSource !== "env" && input.modelWindowSource !== "default") {
    throw new Error("model-context-window-source-invalid");
  }
  if (typeof input.modelWindowVerified !== "boolean") throw new Error("model-context-window-verification-invalid");
  const effectiveWindow = input.roomCapSource === "explicit-room"
    ? Math.min(roomCap, modelWindow)
    : input.modelWindowVerified ? modelWindow : Math.min(SAFE_ROOM_CONTEXT_WINDOW, modelWindow);
  return Object.freeze({
    effectiveWindow,
    roomCapSource: input.roomCapSource,
    configuredModelWindow: modelWindow,
    modelWindowSource: input.modelWindowSource,
    modelWindowVerified: input.modelWindowVerified,
  });
}

export function paCompactionKeepRecentTokens(contextWindow: number): number {
  return Math.max(1024, Math.floor(positiveInteger(contextWindow, "context-window") / 4));
}
