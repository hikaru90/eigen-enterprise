import type { NoticeDeps } from './notices'
import type { RhythmDeps, TargetAccess } from './rhythms'

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
  async listFor(coworkerUserId, readerId) {
    const [{ messagesDeps }, { canUse, listConversations }] = await Promise.all([
      import('../../../../modules/messages/live'),
      import('../../../../modules/messages/service'),
    ])
    const d = await messagesDeps()
    const member = (await d.directory.role(readerId)) !== null
    const out = []
    for (const s of await listConversations(d, coworkerUserId)) {
      const c = await d.store.getConversation(s.id)
      if (!c || !(await canUse(d, coworkerUserId, c, 'edit'))) continue
      const readable = member ? await canUse(d, readerId, c, 'view') : c.kind === 'channel' && !c.private
      if (!readable) continue
      out.push({ id: s.id, kind: s.kind, title: s.kind === 'channel' ? `#${s.title}` : s.title })
    }
    return out
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
