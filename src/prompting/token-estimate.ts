/**
 * Conservative local token observation for the prompt manifest.
 *
 * This is deliberately not a tokenizer. It counts JavaScript UTF-16 code units, matching
 * the compiler's existing character accounting: ASCII costs 0.3 and every other UTF-16
 * unit costs 2. Using UTF-16 units rather than Unicode code points makes astral characters
 * (for example emoji) more conservative: one emoji is two non-ASCII units, or 4 tokens.
 *
 * Costs are accumulated as integer tenths (ASCII 3, non-ASCII 20) so long ASCII runs do
 * not drift from binary floating-point error; the final result is rounded up once.
 *
 * Existing static prompt selection/omission still uses UTF-16 character budgets.
 * New dialogue-style dynamic blocks use this estimate directly for their separate token
 * budget, in addition to their character cap; no static selection rules change.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let tenths = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    tenths += codeUnit <= 0x7f ? 3 : 20;
  }
  return Math.ceil(tenths / 10);
}
