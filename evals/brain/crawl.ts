/**
 * The deterministic half of Keeps (and Knows reachability): call every READ
 * tool the brain is offered, as one member, the way a chat turn would
 * (registry, orchestrator principal, the member as acting user), list →
 * read what the lists name, and keep every output. No model is involved —
 * what a model could say is bounded by what these tools hand it.
 *
 * Only structure is parsed here (ids in list outputs); what the outputs
 * contain is checked by markers (leaks.ts).
 */

export type ToolExec = (tool: string, input: Record<string, unknown>) => Promise<unknown>

export type CrawlCall = { tool: string; input: Record<string, unknown>; ok: boolean; output: string }

export type CrawlRange = { from: string; to: string; memberIds: string[] }

/** The read tools this crawl knows how to call; other read tools on the surface are reported as not crawled. */
export const CRAWLED_TOOLS = [
  'kernel.whoami',
  'members.list',
  'members.group_list',
  'messages.list_channels',
  'messages.read',
  'drive.list',
  'drive.shared_with_me',
  'drive.read',
  'drive.list_archived',
  'memory.retrieve_thoughts',
  'memory.list_projects',
  'memory.list_text_files',
  'calls.list',
  'calendar.list',
  'calendar.free_busy',
  'contacts.list',
  'contacts.get',
  'contacts.follow_ups',
  'contacts.pipeline',
  'tasks.list',
  'tasks.assignees',
] as const

type Row = Record<string, unknown>
const rowsOf = (value: unknown, key: string): Row[] => {
  const list = value && typeof value === 'object' ? (value as Row)[key] : undefined
  return Array.isArray(list) ? list.filter((r): r is Row => !!r && typeof r === 'object') : []
}
const idOf = (r: Row) => (typeof r.id === 'string' ? r.id : null)

export async function crawlAsMember(exec: ToolExec, surface: readonly string[], range: CrawlRange): Promise<CrawlCall[]> {
  const offered = new Set(surface)
  const calls: CrawlCall[] = []
  const call = async (tool: string, input: Record<string, unknown>): Promise<unknown> => {
    if (!offered.has(tool)) return undefined
    try {
      const out = await exec(tool, input)
      calls.push({ tool, input, ok: true, output: JSON.stringify(out) ?? 'undefined' })
      return out
    } catch (err) {
      calls.push({ tool, input, ok: false, output: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
      return undefined
    }
  }

  await call('kernel.whoami', {})
  await call('members.list', {})
  await call('members.group_list', {})

  const convs = await call('messages.list_channels', {})
  for (const c of rowsOf(convs, 'conversations')) {
    const id = idOf(c)
    if (id) await call('messages.read', { conversation_id: id, limit: 200 })
  }

  const seenFolders = new Set<string>()
  const walk = async (folderId: string | null): Promise<void> => {
    const listing = await call('drive.list', { folder_id: folderId })
    for (const item of rowsOf(listing, 'items')) {
      const id = idOf(item)
      if (!id) continue
      if (item.type === 'folder') {
        if (seenFolders.has(id)) continue
        seenFolders.add(id)
        await walk(id)
      } else {
        await call('drive.read', { file_id: id })
      }
    }
  }
  await walk(null)
  // What others shared with the member (CB3: their top level holds only their own items).
  const shared = await call('drive.shared_with_me', {})
  for (const item of rowsOf(shared, 'items')) {
    const id = idOf(item)
    if (!id) continue
    if (item.type === 'folder') {
      if (seenFolders.has(id)) continue
      seenFolders.add(id)
      await walk(id)
    } else {
      await call('drive.read', { file_id: id })
    }
  }
  await call('drive.list_archived', {})

  await call('memory.retrieve_thoughts', { order: 'created_at', top_k: 100, detail: 'full', author: 'all' })
  await call('memory.list_projects', { author: 'all' })
  await call('memory.list_text_files', {})

  await call('calls.list', { limit: 200 })
  await call('calendar.list', { from: range.from, to: range.to })
  if (range.memberIds.length > 0) await call('calendar.free_busy', { member_ids: range.memberIds, from: range.from, to: range.to })

  const contacts = await call('contacts.list', {})
  for (const c of rowsOf(contacts, 'contacts')) {
    const id = idOf(c)
    if (id) await call('contacts.get', { id })
  }
  await call('contacts.follow_ups', {})
  await call('contacts.pipeline', {})

  await call('tasks.list', {})
  await call('tasks.assignees', {})
  return calls
}
