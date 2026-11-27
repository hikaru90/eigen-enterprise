import { CompanyPresence, type CompanyPresenceEntry } from '$lib/presence/company-presence.svelte'
import type { WhereView } from '$lib/presence/where'

/**
 * A real CompanyPresence on a stand-in stream and people directory, for
 * component specs: `companyWith(me, people, directory)` connects, waits for
 * the directory and applies one snapshot frame.
 */
export type DirectoryEntry = { id: string; name: string; image?: string | null; kind?: 'human' | 'coworker' }

class Source {
  readyState = 1
  addEventListener() {}
  close() {}
}

export const onItem = (kind: 'conversation' | 'drive_file' | 'drive_folder', id: string, title: string, area = 'drive'): WhereView => ({
  area,
  path: null,
  item: { kind, id, title },
})

export async function companyWith(
  me: string,
  people: Array<Partial<CompanyPresenceEntry> & { userId: string; where: WhereView | null }>,
  directory: DirectoryEntry[],
): Promise<CompanyPresence> {
  const company = new CompanyPresence({
    me,
    open: () => new Source(),
    win: () => new EventTarget(),
    // Not a real Response: its body parses in microtasks only, so the one tick below is enough
    // in a real browser too (a real Response's json() can take longer than that there).
    fetch: async () =>
      ({ ok: true, status: 200, json: async () => ({ people: directory, groups: [] }) }) as unknown as Response,
    areaName: () => null,
  })
  company.connect()
  await new Promise((r) => setTimeout(r, 0))
  company.apply({
    replace: true,
    people: people.map((p) => ({ status: 'online', doNotDisturb: false, lastSeenAt: null, shareWhere: true, ...p })),
  })
  return company
}
