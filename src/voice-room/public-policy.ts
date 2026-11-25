import { PrivacyGuard } from "../privacy.js";
import { suspectedAdult, textVariants } from "../identity-safety.js";
import { readFilePersona } from "../file-persona.js";
import type { ModelConfig } from "../config.js";
import type { RoomQqSettings } from "./qq-config.js";
import type { RoomCharacter, RoomPrompt } from "./types.js";

/** Pure public-room privacy boundary; never reads PA business stores or private files. */
export function roomPublicPolicy(settings: RoomQqSettings, model: ModelConfig, configFile: string, additionalProtected: readonly string[] = []) {
  const guard = new PrivacyGuard({
    secrets: [
      model.apiKey, model.visionApiKey, model.tavilyApiKey, model.bochaApiKey, model.exaApiKey,
      model.jinaApiKey, model.githubToken,
      ...settings.accounts.map(a => a.token), ...additionalProtected,
    ].filter((value): value is string => typeof value === "string" && value.length > 0),
    identityIds: [settings.room.ownerId, settings.room.groupId, ...settings.room.characters.map(c => c.selfId)],
    internalValues: [
      settings.dataDir, model.baseUrl, model.visionBaseUrl, configFile,
      ...settings.accounts.map(a => a.personaFile),
    ].filter((value): value is string => typeof value === "string" && value.length > 0),
  });
  const privacy = (text: string) => textVariants(text).every(v =>
    guard.sanitizeForModel(v) === v && guard.redactOutbound(v) === v);
  const permitsText = (text: string) => privacy(text) && !suspectedAdult(text);
  /**
   * Sanitize fetched public web text:
   * - Fail closed (return null) if it contains local secrets, internal paths, or room identities.
   * - Mask ordinary third-party PII (emails/phones/etc. in public blog footers) instead of rejecting the page.
   */
  const sanitizeWebText = (text: string): string | null => {
    if (typeof text !== "string" || text.includes("\0")) return null;
    if (textVariants(text).some(v => guard.sanitizeKnownValues(v) !== v || guard.redactOutbound(v) !== v)) {
      return null;
    }
    const masked = guard.sanitizeForModel(text);
    if (suspectedAdult(masked)) return null;
    return masked;
  };
  const validWebEvidence = (value: unknown): boolean => {
    if (value === undefined) return true;
    if (!Array.isArray(value) || value.length > 10) return false;
    return value.every(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      if (typeof row.content !== "string") return false;
      if (row.title !== undefined && typeof row.title !== "string") return false;
      if (row.url !== undefined && typeof row.url !== "string") return false;
      return sanitizeWebText(row.content) === row.content
        && (row.title === undefined || sanitizeWebText(row.title) === row.title)
        && (row.url === undefined || sanitizeWebText(row.url) === row.url);
    });
  };
  return {
    permitsText,
    sanitizeWebText,
    permitsPrompt: (prompt: RoomPrompt) => {
      const payload = JSON.parse(prompt.messages[0].content) as Record<string, unknown>;
      const toolsFree = Array.isArray(prompt.tools) && prompt.tools.length === 0
        && Reflect.ownKeys(prompt.tools).every(key => key === "length");
      const noLegacyExternalBlocks = payload.search === undefined && payload.github === undefined && payload.directPage === undefined;
      const voiceTranslation = payload.voiceTranslation as { sourceText?: unknown } | undefined;
      const quoted = payload.quotedMessage as { text?: unknown } | undefined;
      return toolsFree && noLegacyExternalBlocks && privacy(prompt.systemPrompt) && Array.isArray(payload.visibleHistory)
        && payload.visibleHistory.every((m: unknown) => Boolean(m && typeof m === "object"
          && typeof (m as { text?: unknown }).text === "string" && permitsText((m as { text: string }).text)))
        && (quoted === undefined || (Boolean(quoted && typeof quoted === "object"
          && typeof quoted.text === "string" && permitsText(quoted.text))))
        && validWebEvidence(payload.webEvidence)
        && (voiceTranslation === undefined || (typeof voiceTranslation?.sourceText === "string"
          && permitsText(voiceTranslation.sourceText)));
    },
    persona: (c: RoomCharacter) => {
      const account = settings.accounts.find(a => a.accountKey === c.accountKey);
      if (!account) throw new Error("room-public-persona-missing");
      const snapshot = readFilePersona(account.personaFile, c.id);
      if (!permitsText(snapshot.content) || !permitsText(c.name)) throw new Error("room-public-persona-unsafe");
      return snapshot.content;
    },
  };
}
