import type { Edit } from './composer'

/**
 * The composer's @ suggestions: the @word being typed at the caret, the
 * conversation's members it can mean, and the token that goes in for the one
 * picked. Structure only — the typed prefix is compared against names and
 * handles, the same token characters the server reads
 * (modules/messages/notify.ts mentionedIds). What goes in is the member's
 * `handle` (the server's primaryHandle: a co-worker's slug, a person's email
 * local part), the exact token that reaches them. Pure so it is unit-tested.
 */

export type Mentionable = { id: string; name: string; handle: string; kind: 'human' | 'coworker'; image?: string | null }

/** A character the server reads as part of an @handle. */
const TOKEN_CHAR = /[\w.+-]/
/** A character that, right before an @, makes it part of a word (an email address), not a mention. */
const WORD_BEFORE = /[\w@]/

/** The @word that ends at the caret: where its @ is and what follows it. Null when the caret is not in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  let i = Math.min(caret, text.length)
  while (i > 0 && TOKEN_CHAR.test(text.charAt(i - 1))) i--
  const at = i - 1
  if (at < 0 || text.charAt(at) !== '@') return null
  if (at > 0 && WORD_BEFORE.test(text.charAt(at - 1))) return null
  const query = text.slice(i, caret)
  return query ? { start: at, query } : null
}

const DEFAULT_LIMIT = 8

/** 0: handle or first name starts with the query; 1: the full name or a later word of it does; null: no match. */
function rank(m: Mentionable, q: string): number | null {
  const words = m.name.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (m.handle.toLowerCase().startsWith(q) || words[0]?.startsWith(q)) return 0
  if (m.name.trim().toLowerCase().startsWith(q) || words.some((w) => w.startsWith(q))) return 1
  return null
}

/** The members the typed @word can mean, best first. */
export function matchMentions(
  members: readonly Mentionable[],
  query: string,
  opts: { exclude?: string; limit?: number } = {},
): Mentionable[] {
  const q = query.toLowerCase()
  const ranked: Array<{ m: Mentionable; r: number }> = []
  for (const m of members) {
    if (m.id === opts.exclude) continue
    const r = rank(m, q)
    if (r !== null) ranked.push({ m, r })
  }
  ranked.sort((a, b) => a.r - b.r || a.m.name.localeCompare(b.m.name))
  return ranked.slice(0, opts.limit ?? DEFAULT_LIMIT).map((x) => x.m)
}

/** Replaces the @word (from its @ to the end of the word, past the caret) with `@handle` and a space. */
export function insertMention(text: string, start: number, caret: number, member: Mentionable): Edit {
  let end = Math.min(caret, text.length)
  while (end < text.length && TOKEN_CHAR.test(text.charAt(end))) end++
  const token = `@${member.handle}`
  const spaced = text.charAt(end) === ' '
  const inserted = spaced ? token : `${token} `
  const next = text.slice(0, start) + inserted + text.slice(end)
  const at = start + token.length + 1
  return { text: next, selectionStart: at, selectionEnd: at }
}
