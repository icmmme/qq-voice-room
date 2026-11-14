export interface QqRoute {
  channel: "qq";
  kind: "private" | "group";
  id: string;
}

export type ChannelRoute = QqRoute;

/** Keep numeric IDs canonical and safe for both paths and OneBot JSON numbers. */
export function channelId(value: unknown): string | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text))
    ? text : null;
}

export function checkedRoute(value: ChannelRoute): ChannelRoute {
  if (value.channel !== "qq" || !["private", "group"].includes(value.kind) || channelId(value.id) === null) {
    throw new Error("渠道路由必须使用 qq、private/group 和规范的安全正整数 ID。");
  }
  return { channel: value.channel, kind: value.kind, id: value.id };
}
