import type { ResolvedDeliveryMode, RoomDeliveryMode } from "./types.js";
export type { RoomDeliveryMode } from "./types.js";

export function requestsVoiceOnly(text: string): boolean {
  const request = text.replace(/「[^」]*」|“[^”]*”|"[^"]*"|`[^`]*`/gu, "");
  return !/(?:不要|不用|不必|别).{0,4}语音/u.test(request)
    && /(?:只|仅)(?:发|用)?语音|语音(?:就行|就好|即可)/u.test(request);
}

/** Deterministic delivery only. Neither role names nor voice language force voice output. */
export class DeliveryPolicy {
  decide(mode: RoomDeliveryMode | boolean, voiceAvailable: boolean, text = "", voiceOnlyRequested = false): ResolvedDeliveryMode {
    if (!voiceAvailable || mode === false || mode === "text") return "text";
    if (mode === true) return "both"; // Existing boolean caller compatibility.
    if (mode !== "auto") return mode;
    if ([...text].length > 40 || /https?:\/\/|www\.|```|`[^`]+`|<\/?[A-Za-z][^>]*>|(?:^|\n)\s*(?:const |let |function |import |SELECT |def )/iu.test(text)) return "text";
    return voiceOnlyRequested ? "voice" : "both";
  }
}
