export type DialogueStyleMode = "off" | "experiment" | "shadow" | "on";
export interface DialogueStyleConfig {
  readonly mode: DialogueStyleMode;
  /** Reserved metadata, never opened by S0. */
  readonly packPath?: string;
  readonly buildCommit?: string;
}
export function assertDialogueStyleAvailable(style?: DialogueStyleConfig, allowExperiment = false): void {
  const mode = style === undefined ? "off" : style?.mode;
  if (mode === "off") return;
  if (mode === "experiment" && allowExperiment) return;
  if (["experiment", "shadow", "on"].includes(mode)) {
    throw new Error(`PA_DIALOGUE_STYLE=${mode} 在此入口尚未实现；仅支持 off。`);
  }
  throw new Error("PA_DIALOGUE_STYLE 无效。");
}
export function readDialogueStyleConfig(env: NodeJS.ProcessEnv): DialogueStyleConfig {
  const mode = (env.PA_DIALOGUE_STYLE ?? "off").trim().toLowerCase();
  if (!["off", "experiment", "shadow", "on"].includes(mode)) {
    throw new Error("PA_DIALOGUE_STYLE 无效。");
  }
  const config: DialogueStyleConfig = { mode: mode as DialogueStyleMode,
    packPath: env.PA_DIALOGUE_STYLE_PACK || undefined, buildCommit: env.PA_BUILD_COMMIT || "unknown" };
  assertDialogueStyleAvailable(config, true); // openPa must still validate the explicit experiment capability.
  return config;
}
