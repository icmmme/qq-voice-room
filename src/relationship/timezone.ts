export const DEFAULT_TIMEZONE = "Asia/Shanghai";
const formatters = new Map<string, Intl.DateTimeFormat>();

export function resolveTimezone(value: string | undefined): string {
  const zone = value?.trim() || DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); }
  catch { throw new Error("PA_TIMEZONE 必须是有效时区，例如 Asia/Shanghai 或 UTC。"); }
  return zone;
}

/** Calendar dates, not fixed UTC offsets: handles DST and historical timezone rules. */
export function relationshipDay(date: Date, timezone = DEFAULT_TIMEZONE): string {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en", { timeZone: resolveTimezone(timezone),
      year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(date);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
