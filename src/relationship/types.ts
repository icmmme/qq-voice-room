export type RelationshipStage = "初识" | "熟悉" | "心动" | "亲密" | "恋人" | "挚爱";
export type Mood = "neutral" | "happy" | "shy" | "proud" | "annoyed" | "sad";
export type RelationshipEventKind = "intimacy" | "milestone" | "mood";
export type RelationshipEvidenceKind = "intimacy" | "milestone" | "repair" | "confession";

export interface RelationshipState {
  roleId: string;
  intimacy: number;
  stage: RelationshipStage;
  stageFloor: number;
  competenceTrust: number;
  mood: Mood;
  moodIntensity: number;
  boundaries: Record<string, unknown>;
  consent: { adult: false };
  proactiveRomanceEnabled: boolean;
  lastUserAt: string | null;
  updatedAt: string;
}

export interface RelationshipEvent {
  id: string;
  roleId: string;
  kind: RelationshipEventKind | RelationshipEvidenceKind;
  summary: string;
  emotionalWeight: number;
  sourceMessageIds: string[];
  createdAt: string;
  sourceExcerpts?: string[];
  memoryId?: string | null;
}
