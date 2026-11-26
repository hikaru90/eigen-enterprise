import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canUse, createChannel, listConversations, openDm } from '../../../../modules/messages/service'
import { addCoworker, fixture } from '../../../../modules/messages/test-fixtures'

let f: ReturnType<typeof fixture>
vi.mock('../../../../modules/messages/live', () => ({ messagesDeps: async () => f.deps }))

const { liveRhythmTargets } = await import('./rhythm-live')

/** The targets as they were computed before (from Messages' summaries): the behaviour listFor keeps. */
async function viaSummaries(coworkerId: string, readerId: string) {
  const d = f.deps
  const member = (await d.directory.role(readerId)) !== null
  const out = []
  for (const s of await listConversations(d, coworkerId)) {
    const c = (await d.store.getConversation(s.id))!
    if (!(await canUse(d, coworkerId, c, 'edit'))) continue
    const readable = member ? await canUse(d, readerId, c, 'view') : c.kind === 'channel' && !c.private
    if (!readable) continue
    out.push({ id: s.id, kind: s.kind, title: s.kind === 'channel' ? `#${s.title}` : s.title })
  }
  return out
}

describe('liveRhythmTargets.listFor', () => {
  beforeEach(async () => {
    f = fixture()
    addCoworker(f, { id: 'nova', slug: 'nova', name: 'Nova' })
    const d = f.deps
    await createChannel(d, 'owner', { name: 'general', private: false })
    await createChannel(d, 'owner', { name: 'announcements', private: false })
    await createChannel(d, 'owner', { name: 'board', private: true })
    await createChannel(d, 'owner', { name: 'brand', private: true, userIds: ['nova'] })
    await createChannel(d, 'bea', { name: 'bea-only', private: true, userIds: ['nova'] })
    // An archived public channel: nobody posts there any more.
    const old = { id: 'archived-1', kind: 'channel' as const, name: 'old', topic: '', private: false, archived: true, dmKey: null, createdBy: 'owner', createdAt: new Date() }
    await d.store.insertConversation(old, ['owner'])
    await d.access.initGrants('owner', 'channel', old.id, [{ subject: { kind: 'company' }, level: 'edit' }])
    await openDm(d, 'owner', ['nova'])
    await openDm(d, 'bea', ['nova', 'carl'])
  })

  it('lists where the co-worker may post and the owner may see: channels by name, then DMs newest first', async () => {
    const targets = await liveRhythmTargets.listFor('nova', 'owner')
    expect(targets.map((t) => t.title)).toEqual(['#announcements', '#bea-only', '#brand', '#general', 'Olga Owner'])
    expect(targets).toEqual(await viaSummaries('nova', 'owner'))
  })

  it("a member sees only the conversations they may view", async () => {
    const targets = await liveRhythmTargets.listFor('nova', 'carl')
    expect(targets).toEqual(await viaSummaries('nova', 'carl'))
    expect(targets.map((t) => t.title)).not.toContain('#bea-only')
  })

  it('someone outside the company sees public channels only', async () => {
    const targets = await liveRhythmTargets.listFor('nova', 'stranger')
    expect(targets).toEqual(await viaSummaries('nova', 'stranger'))
    expect(targets.every((t) => t.kind === 'channel')).toBe(true)
  })
})
