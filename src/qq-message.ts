/** OneBot message_id is signed int32: zero and negative values are valid. */
export function qqMessageId(value: unknown): string | null {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^-?(0|[1-9]\d{0,9})$/.test(text)) return null;
  const number = Number(text);
  return number >= -2147483648 && number <= 2147483647 ? String(number) : null;
}
