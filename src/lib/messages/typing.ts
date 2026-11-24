/**
 * "<name> is typing…" in the Messages page (Contribute 14aea69d): who is
 * writing where, from the live feed (`event: typing`, one frame per
 * conversation with everyone writing there now). Today the writers are AI
 * co-workers while their turn runs; the server decides, the page only shows it.
 */

export type Typist = { userId: string; threadRootId: string | null }
export type TypingFrame = { conversationId: string; typists: Typist[] }
/** Conversation id → who is writing in it. */
export type TypingMap = Record<string, Typist[]>

export function applyTyping(current: TypingMap, f: TypingFrame): TypingMap {
  const next = { ...current }
  if (f.typists.length) next[f.conversationId] = f.typists
  else delete next[f.conversationId]
  return next
}

/** Who writes in this place: the conversation's main view (threadRootId null) or one thread; never me. */
export function typistsIn(map: TypingMap, conversationId: string, threadRootId: string | null, me: string): string[] {
  const ids = (map[conversationId] ?? []).filter((t) => t.threadRootId === threadRootId && t.userId !== me).map((t) => t.userId)
  return [...new Set(ids)]
}

/** "Ada is typing…", "Ada and Max are typing…", "Ada, Max and 2 others are typing…"; "" for nobody. */
export function typingLine(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? 'other' : 'others'} are typing…`
}
