import { PrivacyGuard } from "../privacy.js";
import { containsSensitive } from "../memory-safety.js";
import { suspectedAdult, textVariants } from "../identity-safety.js";
import { readFilePersona } from "../file-persona.js";
import type { ModelConfig } from "../config.js";
import type { RoomQqSettings } from "./qq-config.js";
import type { RoomCharacter, RoomPrompt } from "./types.js";

/** Pure public-room privacy boundary; never reads PA business stores or private files. */
export function roomPublicPolicy(settings: RoomQqSettings, model: ModelConfig, configFile: string, additionalProtected: readonly string[] = []) {
  const guard = new PrivacyGuard({
    secrets: [model.apiKey, model.tavilyApiKey, ...settings.accounts.map(a => a.token), ...additionalProtected]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
    identityIds: [settings.room.ownerId, settings.room.groupId, ...settings.room.characters.map(c => c.selfId)],
    internalValues: [settings.dataDir, model.baseUrl, configFile, ...settings.accounts.map(a => a.personaFile)],
  });
  const privacy = (text: string) => textVariants(text).every(v => !containsSensitive(v)
    && guard.sanitizeForModel(v) === v && guard.redactOutbound(v) === v);
  const permitsText = (text: string) => privacy(text) && !suspectedAdult(text);
  return {
    permitsText,
    permitsPrompt: (prompt: RoomPrompt) => {
      const payload = JSON.parse(prompt.messages[0].content) as Record<string, unknown>;
      const toolsFree = Array.isArray(prompt.tools) && prompt.tools.length === 0
        && Reflect.ownKeys(prompt.tools).every(key => key === "length");
      const noExternalBlocks = payload.search === undefined && payload.github === undefined && payload.directPage === undefined;
      const voiceTranslation = payload.voiceTranslation as { sourceText?: unknown } | undefined;
      return toolsFree && noExternalBlocks && privacy(prompt.systemPrompt) && Array.isArray(payload.visibleHistory)
        && payload.visibleHistory.every((m: unknown) => Boolean(m && typeof m === "object"
          && typeof (m as { text?: unknown }).text === "string" && permitsText((m as { text: string }).text)))
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
