import type { CheckedRoomConfig } from "./config.js";
import type { RoomDelivery } from "./types.js";
import { validJapaneseVoice } from "./language.js";

export const FISH_MODELS = ["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free", "drama-3"] as const;
export const ROOM_AUDIO_MAX_BYTES = 2 * 1024 * 1024;
export type FishFailure = "config" | "blocked" | "cancelled" | "timeout" | "network" | "authentication"
  | "payment" | "rate-limited" | "rejected" | "invalid-audio" | "too-large";
export class FishTtsError extends Error {
  constructor(readonly code: FishFailure) { super(`fish-tts-${code}`); this.name = "FishTtsError"; }
}
export interface FishConfig {
  readonly apiKey: string;
  readonly baseUrl: "https://api.fish.audio";
  readonly model: typeof FISH_MODELS[number];
  readonly timeoutMs: number;
  readonly voices: readonly { readonly characterId: string; readonly accountKey: string; readonly voiceKey: string;
    readonly referenceId: string; readonly voiceLanguage: "zh" | "ja" }[];
}

/** No environment fields = text-only. An explicitly loaded but incomplete Fish config is an error. */
export function readFishConfig(env: NodeJS.ProcessEnv, room: CheckedRoomConfig): FishConfig | null {
  const keys = ["FISH_API_KEY", "FISH_REFERENCE_ID_A", "FISH_REFERENCE_ID_B", "FISH_BASE_URL", "FISH_MODEL", "FISH_FORMAT", "FISH_TIMEOUT_MS"];
  if (!keys.some(k => env[k] !== undefined)) return null;
  const apiKey = env.FISH_API_KEY?.trim(), model = env.FISH_MODEL?.trim();
  const baseUrl = (env.FISH_BASE_URL?.trim() || "https://api.fish.audio").replace(/\/$/, "");
  const timeoutMs = env.FISH_TIMEOUT_MS === undefined ? 30000 : Number(env.FISH_TIMEOUT_MS);
  const references = [env.FISH_REFERENCE_ID_A?.trim(), env.FISH_REFERENCE_ID_B?.trim()];
  if (!apiKey || !/^[\x21-\x7e]{8,1024}$/.test(apiKey) || !model || !(FISH_MODELS as readonly string[]).includes(model)
    || baseUrl !== "https://api.fish.audio" || (env.FISH_FORMAT !== undefined && env.FISH_FORMAT !== "mp3")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
    || room.characters.length !== 2 || references.some(r => !r || !/^[A-Za-z0-9_-]{1,128}$/.test(r))
    || references[0] === references[1]) throw new FishTtsError("config");
  return Object.freeze({ apiKey, baseUrl: "https://api.fish.audio", model: model as FishConfig["model"], timeoutMs,
    voices: Object.freeze(room.characters.map((c, i) => Object.freeze({ characterId: c.id, accountKey: c.accountKey,
      voiceKey: c.voiceKey, referenceId: references[i]!, voiceLanguage: room.characterLanguages[c.id]!.voiceLanguage }))) });
}

/** Signature sniffing, not a decoder. Actual playback compatibility still requires the NapCat probe. */
export function isRoomMp3(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
    || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0);
}

/** Explicit bytes only: no provider URL, arbitrary file path, or MP3 temp file is sent to NapCat. */
export function roomRecord(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ROOM_AUDIO_MAX_BYTES || !isRoomMp3(bytes)) throw new FishTtsError("invalid-audio");
  return { type: "record", data: { file: `base64://${Buffer.from(bytes).toString("base64")}`, magic: "0" } };
}

/** Single request. No retries, no model fallback, no reference uploads and no audio files on disk. */
export function fishSynthesizer(config: FishConfig, permitsText: (text: string) => boolean,
  fetcher: typeof fetch = fetch, onFailure: (code: FishFailure) => void = () => {}) {
  return async (delivery: RoomDelivery, parent: AbortSignal): Promise<Uint8Array> => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
    const signal = AbortSignal.any([parent, timeout.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      const voice = config.voices.find(v => v.accountKey === delivery.accountKey && v.characterId === delivery.characterId && v.voiceKey === delivery.voiceKey);
      // Japanese never falls back to the Chinese display/semantic text.
      const text = delivery.voiceText ?? (voice?.voiceLanguage === "zh" ? delivery.text : undefined);
      let allowed = false;
      try { allowed = typeof text === "string" && permitsText(delivery.text) === true && permitsText(text) === true; } catch { /* Deny on a failed guard. */ }
      if (!voice || !allowed || typeof text !== "string" || !text.trim() || [...text].length > 1000 || text.includes("\0")
        || (delivery.voiceLanguage !== undefined && delivery.voiceLanguage !== voice.voiceLanguage)
        || (voice.voiceLanguage === "ja" && (delivery.voiceLanguage !== "ja" || !validJapaneseVoice(text, delivery.text)))) throw new FishTtsError("blocked");
      const response = await fetcher(`${config.baseUrl}/v1/tts`, { method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", model: config.model, Accept: "audio/mpeg" },
        body: JSON.stringify({ text, reference_id: voice.referenceId, format: "mp3", language: voice.voiceLanguage }) });
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        throw new FishTtsError(response.status === 401 || response.status === 403 ? "authentication"
          : response.status === 402 ? "payment" : response.status === 429 ? "rate-limited" : "rejected");
      }
      const length = Number(response.headers.get("content-length"));
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (length > ROOM_AUDIO_MAX_BYTES || !["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(mime ?? "")) {
        await response.body?.cancel(); throw new FishTtsError(length > ROOM_AUDIO_MAX_BYTES ? "too-large" : "invalid-audio");
      }
      if (!response.body) throw new FishTtsError("invalid-audio");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let total = 0;
      while (true) {
        const chunk = await reader.read(); signal.throwIfAborted();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > ROOM_AUDIO_MAX_BYTES) { await reader.cancel(); throw new FishTtsError("too-large"); }
        chunks.push(chunk.value);
      }
      const bytes = Buffer.concat(chunks, total);
      if (!isRoomMp3(bytes)) throw new FishTtsError("invalid-audio");
      signal.throwIfAborted(); return bytes;
    } catch (error) {
      const safe = parent.aborted ? new FishTtsError("cancelled") : timeout.signal.aborted ? new FishTtsError("timeout")
        : error instanceof FishTtsError ? error : new FishTtsError("network");
      try { onFailure(safe.code); } catch { /* Metadata observer cannot affect delivery. */ }
      throw safe;
    } finally { clearTimeout(timer); reader?.releaseLock(); }
  };
}
