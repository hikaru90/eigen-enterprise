/**
 * What counts as one emoji (Contribute 89815b8d: react with any emoji, not a
 * fixed ten). The rule is Unicode's own: the string is exactly one RGI emoji
 * (`\p{RGI_Emoji}`, the recommended-for-general-interchange set: skin tones,
 * ZWJ sequences, flags and keycaps included; unqualified forms like a bare
 * "❤" refused, so the same reaction never shows as two). The server applies
 * it; the picker only offers emoji that pass it (emoji.spec.ts).
 */

/** message_reactions.emoji is CHECKed to 1–16 characters (code points) in 0111. */
export const MAX_EMOJI_CODEPOINTS = 16

const ONE_RGI_EMOJI = /^\p{RGI_Emoji}$/v

export function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  // Cheap bound first (UTF-16 units ≥ code points), then the exact cap.
  if (value.length > MAX_EMOJI_CODEPOINTS * 2 || [...value].length > MAX_EMOJI_CODEPOINTS) return false
  return ONE_RGI_EMOJI.test(value)
}
