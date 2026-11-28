/**
 * The notification inbox (wishes f3fc516e, 3c1481b9): one list of what needs
 * the person, for the top bar's bell, the CLI and the agent
 * (notifications.inbox) — the team questions asked of them and not answered
 * yet, the tasks given to them and news on the tasks they gave out, and their
 * AI co-workers' "Needs you" results. Each source keeps its own meaning (a
 * question leaves when answered, a task when done, a co-worker row when
 * acknowledged); the inbox only adds "read": the person saw the item in the
 * bell (notification_reads, migration 0192). An item's key carries the moment
 * it changed, so news on a task is unread again.
 */

export type InboxKind = 'question' | 'task' | 'task_update' | 'coworker'

export type InboxItem = {
  key: string
  kind: InboxKind
  title: string
  detail: string
  href: string
  at: string
  unread: boolean
}

export type Inbox = { items: InboxItem[]; unread: number }

export type InboxSourceItem = Omit<InboxItem, 'unread'>

export type InboxDeps = {
  /** The person's items from every source, in any order. */
  sources: (userId: string) => Promise<InboxSourceItem[]>
  reads: {
    /** Of `keys`, the ones the person has read. */
    readKeys(userId: string, keys: string[]): Promise<Set<string>>
    markRead(userId: string, keys: string[], at: Date): Promise<void>
  }
  now?: () => Date
}

export async function loadInbox(d: InboxDeps, userId: string): Promise<Inbox> {
  const raw = await d.sources(userId)
  const read = raw.length ? await d.reads.readKeys(userId, raw.map((i) => i.key)) : new Set<string>()
  const items = raw
    .map((i) => ({ ...i, unread: !read.has(i.key) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)))
  return { items, unread: items.filter((i) => i.unread).length }
}

/** Marks items read; only keys of the person's own current inbox count, anything else fails loud. */
export async function markInboxRead(d: InboxDeps, userId: string, keys: string[]): Promise<Inbox> {
  const wanted = [...new Set(keys)]
  if (wanted.length === 0) throw new InboxError('Name at least one item key (from notifications.inbox).')
  const current = new Set((await d.sources(userId)).map((i) => i.key))
  const unknown = wanted.filter((k) => !current.has(k))
  if (unknown.length) throw new InboxError(`Not in your inbox: ${unknown.join(', ')} (keys come from notifications.inbox).`)
  await d.reads.markRead(userId, wanted, d.now ? d.now() : new Date())
  return loadInbox(d, userId)
}

export class InboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InboxError'
  }
}
