import { isSingleEmoji } from './emoji'

/**
 * Recently picked emoji, per browser (localStorage): the full picker shows
 * them first. Shared by reactions and the composer.
 */

export const RECENT_EMOJI_MAX = 24
const KEY = 'ee:messages:recent-emoji'

/** Most recent first, each once, at most RECENT_EMOJI_MAX. */
export function pushRecentEmoji(list: readonly string[], emoji: string): string[] {
  return [emoji, ...list.filter((e) => e !== emoji)].slice(0, RECENT_EMOJI_MAX)
}

/** The stored list; anything that is not a list of single emoji reads as none. */
export function parseRecentEmoji(raw: string | null): string[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed) ? parsed.filter(isSingleEmoji).slice(0, RECENT_EMOJI_MAX) : []
}

export function readRecentEmoji(storage: Storage = localStorage): string[] {
  return parseRecentEmoji(storage.getItem(KEY))
}

export function rememberRecentEmoji(emoji: string, storage: Storage = localStorage): string[] {
  const next = pushRecentEmoji(readRecentEmoji(storage), emoji)
  storage.setItem(KEY, JSON.stringify(next))
  return next
}
