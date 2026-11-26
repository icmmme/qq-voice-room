export const FORWARD_CARD_CHAR_THRESHOLD = 280;
export const FORWARD_CARD_SEGMENT_THRESHOLD = 3;

export interface ForwardCardPolicyInput {
  readonly text: string;
  readonly segmentCount: number;
  readonly hasWebEvidence?: boolean;
  readonly deep?: boolean;
}

/**
 * Decide whether a direct reply should pack into a QQ forward card (Strategy A,
 * zero TTS) instead of normal chat bubbles (which allow voice synthesis).
 *
 * Short witty banter and meme-link replies (`<= 280` Unicode chars AND `<= 2`
 * segments) stay as natural chat bubbles even when `hasWebEvidence` or `deep`
 * is true. Long researched answers (`> 280` Unicode chars OR `>= 3` segments)
 * pack into a QQ forward card with Strategy A (zero TTS).
 */
export function shouldDeliverAsForwardCard(input: ForwardCardPolicyInput): boolean {
  const charCount = [...input.text.trim()].length;
  const segmentCount = Number.isFinite(input.segmentCount) ? Math.trunc(input.segmentCount) : 0;
  return charCount > FORWARD_CARD_CHAR_THRESHOLD || segmentCount >= FORWARD_CARD_SEGMENT_THRESHOLD;
}
