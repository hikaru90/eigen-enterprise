import type { NoticeDeps } from './notices'
import type { RhythmDeps, RhythmTarget, TargetAccess } from './rhythms'

/**
 * Live wiring of the rhythms and the "Needs you" notices (C6): the Postgres
 * stores, the co-workers service, Messages for who may post and see where, and
 * this process's co-worker turns to start a queued run.
 */

/** Messages decides: a co-worker posts where it may post (canUse 'edit'); a member sees what they may view, anyone else public channels. */
export const liveRhythmTargets: TargetAccess = {
  async coworkerMayPost(coworkerUserId, conversationId) {
    const [{ messagesDeps }, { canUse, isId }] = await Promise.all([import('../../../../modules/messages/live'), import('../../../../modules/messages/service')])
    if (!isId(conversationId)) return false
    const d = await messagesDeps()
    const c = await d.store.getConversation(conversationId)
    return c !== null && (await canUse(d, coworkerUserId, c, 'edit'))
  },
  async titleFor(readerId, conversationId, coworkerUserId) {
    const [{ messagesDeps }, { canUse, isId }] = await Promise.all([import('../../../../modules/messages/live'), import('../../../../modules/messages/service')])
    if (!isId(conversationId)) return null
    const d = await messagesDeps()
    const c = await d.store.getConversation(conversationId)
    if (!c) return null
    const member = (await d.directory.role(readerId)) !== null
    const may = member ? await canUse(d, readerId, c, 'view') : c.kind === 'channel' && !c.private && !c.archived
    if (!may) return null
    if (c.kind === 'channel') return `#${c.name}`
    const people = new Map((await d.directory.listPeople()).map((p) => [p.id, p.name]))
    const others = (await d.store.memberIds(c.id)).filter((id) => id !== coworkerUserId)
    return others.map((id) => people.get(id) ?? 'Former member').join(', ')
  },
  // Only what a target needs: may the co-worker post, may the reader see it, its title. Not
  // Messages' listConversations — that summarizes every conversation (unread counts …) one by
  // one, and with a few hundred channels Settings → Co-workers took 20 s per co-worker.
  async listFor(coworkerUserId, readerId) {
    const [{ messagesDeps }, { canUse }] = await Promise.all([
      import('../../../../modules/messages/live'),
      import('../../../../modules/messages/service'),
    ])
    const d = await messagesDeps()
    const [role, channels, dms, people] = await Promise.all([
      d.directory.role(readerId),
      d.store.listChannels(),
      d.store.listDmsFor(coworkerUserId),
      d.directory.listPeople(),
    ])
    const member = role !== null
    const names = new Map(people.map((p) => [p.id, p.name.trim() || p.email]))
    const open = channels.filter((c) => !c.archived).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    const dmsNewestFirst = [...dms].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const checked = await Promise.all(
      [...open, ...dmsNewestFirst].map(async (c) => {
        if (!(await canUse(d, coworkerUserId, c, 'edit'))) return null
        const readable = member ? await canUse(d, readerId, c, 'view') : c.kind === 'channel' && !c.private
        if (!readable) return null
        if (c.kind === 'channel') return { id: c.id, kind: c.kind, title: `#${c.name ?? ''}` }
        const others = (await d.store.memberIds(c.id)).filter((id) => id !== coworkerUserId)
        const title = others.length === 0 ? 'Just you' : others.map((id) => names.get(id) ?? 'Former member').join(', ')
        return { id: c.id, kind: c.kind, title }
      }),
    )
    return checked.filter((t): t is RhythmTarget => t !== null)
  },
}

export async function liveRhythmDeps(): Promise<RhythmDeps> {
  const [{ liveRhythmStore }, { liveCoworkerRunStore }, coworkers, { startCoworkerWork, runningCoworkerTurns }] = await Promise.all([
    import('./db-rhythm-store'),
    import('./db-run-store'),
    import('./index'),
    import('./task-work'),
  ])
  return {
    store: liveRhythmStore,
    runs: liveCoworkerRunStore,
    coworkers: { get: coworkers.getCoworker },
    targets: liveRhythmTargets,
    start: startCoworkerWork,
    ready: () => {
      runningCoworkerTurns()
    },
  }
}

export async function liveNoticeDeps(): Promise<NoticeDeps> {
  const [{ liveCoworkerRunStore }, coworkers, { messagesDeps }, { canUse }] = await Promise.all([
    import('./db-run-store'),
    import('./index'),
    import('../../../../modules/messages/live'),
    import('../../../../modules/messages/service'),
  ])
  return {
    runs: liveCoworkerRunStore,
    nameOf: async (id) => (await coworkers.getCoworker(id)).name,
    visible: async (readerId, ids) => {
      const d = await messagesDeps()
      const out = new Set<string>()
      for (const id of new Set(ids)) {
        const c = await d.store.getConversation(id)
        if (c && (await canUse(d, readerId, c))) out.add(id)
      }
      return out
    },
  }
}
