import type { Mood, RelationshipStage, RelationshipState } from "./types.js";

export const RELATIONSHIP_STAGES: readonly { stage: RelationshipStage; floor: number; register: string }[] = [
  { stage: "初识", floor: 0, register: "礼貌自然，保持距离，不突然使用亲昵称呼。" },
  { stage: "熟悉", floor: 20, register: "放松一些，可以开玩笑，但不擅自宣称恋爱关系。" },
  { stage: "心动", floor: 40, register: "对用户有轻微心动，会害羞、试探，但不突然过度亲密。" },
  { stage: "亲密", floor: 60, register: "温柔亲近，可以表达想念，尊重用户当下意愿。" },
  { stage: "恋人", floor: 80, register: "可以表达爱意、撒娇；语气不构成现实身份或共同经历的证据。" },
  { stage: "挚爱", floor: 95, register: "表达稳定深厚的依恋，尊重边界，不编造现实承诺或共同经历。" },
];
export const MOODS: readonly Mood[] = ["neutral", "happy", "shy", "proud", "annoyed", "sad"];

export function stageForIntimacy(intimacy: number) {
  return RELATIONSHIP_STAGES.findLast(item => intimacy >= item.floor) ?? RELATIONSHIP_STAGES[0]!;
}

export function positiveDelta(delta: number): number {
  if (!Number.isSafeInteger(delta) || delta <= 0) throw new Error("关系 delta 必须是正整数，不允许下降。");
  return delta;
}

export function validateMood(mood: Mood, intensity: number): void {
  if (!MOODS.includes(mood)) throw new Error("关系 mood 无效。");
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw new Error("关系 mood 强度必须在 0–1 之间。");
  }
}

export function initialRelationshipState(roleId: string, now: string): RelationshipState {
  return {
    roleId, intimacy: 0, stage: "初识", stageFloor: 0, competenceTrust: 0,
    mood: "neutral", moodIntensity: 0, boundaries: {}, consent: { adult: false },
    proactiveRomanceEnabled: true, lastUserAt: null, updatedAt: now,
  };
}

/** Pure transition; daily accounting and provenance are enforced by the store transaction. */
export function increaseIntimacy(state: RelationshipState, delta: number, now: string): RelationshipState {
  positiveDelta(delta);
  const intimacy = Math.min(100, Math.max(state.stageFloor, state.intimacy) + delta);
  const stage = stageForIntimacy(intimacy);
  return { ...state, intimacy, stage: stage.stage, stageFloor: Math.max(state.stageFloor, stage.floor),
    lastUserAt: now, updatedAt: now };
}

export function increaseTrust(state: RelationshipState, delta: number, now: string): RelationshipState {
  positiveDelta(delta);
  return { ...state, competenceTrust: Math.min(100, state.competenceTrust + delta), updatedAt: now };
}
