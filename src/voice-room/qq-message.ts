import { channelId } from "../channel-route.js";
import { qqMessageId } from "../qq-message.js";
import type { CheckedRoomConfig } from "./config.js";
import type { RoomInput } from "./types.js";
import { parsePublicUrl } from "./web.js";

export const ROOM_MAX_IMAGES_PER_MESSAGE = 4;

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Connection identity comes from authenticated upgrade; event fields can never switch accounts. */
export function parseRoomQqMessage(value: unknown, accountKey: string, config: CheckedRoomConfig): RoomInput | null {
  const c = config.characters.find(c => c.accountKey === accountKey), e = object(value);
  if (!c || !e || e.post_type !== "message" || e.message_type !== "group"
    || (e.sub_type !== undefined && e.sub_type !== "normal") || e.anonymous
    || channelId(e.self_id) !== c.selfId || channelId(e.group_id) !== config.groupId) return null;
  const senderId = channelId(e.user_id), messageId = qqMessageId(e.message_id);
  if (!senderId || messageId === null || config.characters.some(c => c.selfId === senderId)) return null;
  const sender = object(e.sender);
  if (sender?.user_id !== undefined && channelId(sender.user_id) !== senderId) return null;
  if (!Array.isArray(e.message) || e.message.length === 0 || e.message.length > 256) return null;
  let text = "";
  const mentions: string[] = [];
  const images: string[] = [];
  const seenImages = new Set<string>();
  let replyToMessageId: string | undefined;
  for (const entry of e.message) {
    const s = object(entry), data = object(s?.data);
    if (!s || !data) return null;
    if (s.type === "text" && typeof data.text === "string") text += data.text;
    else if (s.type === "at") {
      const id = channelId(data.qq);
      // @all is not an explicit request to a room character and is rejected as a whole.
      if (!id) return null;
      mentions.push(id);
    } else if (s.type === "reply") {
      const id = qqMessageId(data.id);
      if (replyToMessageId !== undefined || id === null) return null;
      replyToMessageId = id;
    } else if (s.type === "image") {
      const candidate = typeof data.url === "string" && data.url.trim()
        ? data.url.trim()
        : typeof data.file === "string" && /^https?:\/\//i.test(data.file.trim())
          ? data.file.trim()
          : "";
      const parsed = candidate ? parsePublicUrl(candidate) : null;
      if (parsed) {
        const canonical = parsed.toString();
        if (!seenImages.has(canonical) && images.length < ROOM_MAX_IMAGES_PER_MESSAGE) {
          seenImages.add(canonical);
          images.push(canonical);
        }
      }
    } else return null; // forward/record and other unknown payloads are never downgraded to text.
  }
  const explicitRoomMention = mentions.some(id => config.characters.some(c => c.selfId === id));
  if ((!text.trim() && !explicitRoomMention) || text.length > 8000 || /\[CQ:/i.test(text) || text.includes("\0")) return null;
  return { accountKey, selfId: c.selfId, groupId: config.groupId, senderId, messageId, text: text.trim(), mentions,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    ...(images.length ? { images: Object.freeze(images) } : {}) };
}
