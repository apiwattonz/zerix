const THAI_CJK_REGEX = /[\u0E00-\u0E7F\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/u
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu

/**
 * Fast approximate token counting without external dependencies.
 *
 * Heuristics:
 * - English/latin-like text: ~4 chars/token
 * - Thai/CJK text: ~2 chars/token
 * - Emoji-heavy text gets a small token bump
 */
export function countTokens(text: string): number {
  if (!text || text.trim().length === 0) {
    return 0
  }

  const chars = Array.from(text)
  const totalChars = chars.length

  let thaiCjkChars = 0
  for (const ch of chars) {
    if (THAI_CJK_REGEX.test(ch)) {
      thaiCjkChars += 1
    }
  }

  const latinChars = totalChars - thaiCjkChars
  const emojiCount = (text.match(EMOJI_REGEX) ?? []).length

  const latinTokens = latinChars / 4
  const thaiCjkTokens = thaiCjkChars / 2

  const punctuationWeight = (text.match(/[.,!?;:()[\]{}"'`~@#$%^&*+=\\/|-]/g) ?? []).length * 0.08
  const emojiWeight = emojiCount * 0.35

  const estimate = latinTokens + thaiCjkTokens + punctuationWeight + emojiWeight
  return Math.max(1, Math.round(estimate))
}
