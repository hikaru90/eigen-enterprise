/**
 * Unsent text per conversation, kept in this browser (Contribute: "soll der
 * text immer noch als entwurf da stehen"): click away, come back, the draft is
 * still in the box. A per-viewer convenience in localStorage, keyed per user
 * and conversation — not data. Storage that is missing or refuses (private
 * window, blocked site data, quota) means a draft lasts only while the page is
 * open; it never breaks the composer.
 */

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function draftKey(userId: string, conversationId: string): string {
  return `ee.messages.draft:${userId}:${conversationId}`
}

export type Drafts = {
  /** The kept draft, or '' when there is none. */
  read: (conversationId: string) => string
  /** Keeps the box's text; an empty box keeps nothing. */
  write: (conversationId: string, text: string) => void
  /** After sending. */
  clear: (conversationId: string) => void
}

export function createDrafts(userId: string, storage: () => DraftStorage): Drafts {
  /** This page's drafts: switching conversations keeps each one even when storage refuses. */
  const open = new Map<string, string>()
  function withStorage<T>(fn: (s: DraftStorage) => T): T | undefined {
    try {
      return fn(storage())
    } catch {
      return undefined
    }
  }
  return {
    read(conversationId) {
      const here = open.get(conversationId)
      if (here !== undefined) return here
      return withStorage((s) => s.getItem(draftKey(userId, conversationId))) ?? ''
    },
    write(conversationId, text) {
      const key = draftKey(userId, conversationId)
      open.set(conversationId, text)
      withStorage((s) => (text.trim() === '' ? s.removeItem(key) : s.setItem(key, text)))
    },
    clear(conversationId) {
      open.set(conversationId, '')
      withStorage((s) => s.removeItem(draftKey(userId, conversationId)))
    },
  }
}
