import { describe, expect, it, vi } from 'vitest'
import { coworkerEmail } from '$lib/server/coworkers/service'
import { mentionedIds, notifyNewMessage, primaryHandle, type PushPort } from './notify'
import { createChannel, openDm, postMessage, setViewing } from './service'
import { addCoworker, fixture } from './test-fixtures'

const people = [
  { id: 'bea', name: 'Bea Member', email: 'bea.m@co.test' },
  { id: 'carl', name: 'Carl Jung', email: 'cj@co.test' },
]

describe('mentionedIds', () => {
  it('matches @handles against email local parts and names', () => {
    expect(mentionedIds('hey @bea.m and @CarlJung.', people)).toEqual(['bea', 'carl'])
    expect(mentionedIds('@carl can you look', people)).toEqual(['carl'])
    expect(mentionedIds('mail bea@co.test, no mention', people)).toEqual([])
    expect(mentionedIds('@nobody', people)).toEqual([])
  })

  it('an AI co-worker is mentioned by its slug only, never by its name', () => {
    const marketing = { id: 'cw0000001xyz', name: 'Marketing Manager', email: coworkerEmail('marketing', 'cw0000001xyz'), kind: 'coworker' as const }
    const all = [...people, marketing]
    expect(mentionedIds('@marketing plan the launch', all)).toEqual(['cw0000001xyz'])
    expect(mentionedIds('ask @Marketing, then @bea.m', all)).toEqual(['bea', 'cw0000001xyz'])
    expect(mentionedIds('@marketingmanager or @Marketing.Manager', all)).toEqual([])
    expect(primaryHandle(marketing)).toBe('marketing')
    expect(primaryHandle(people[0])).toBe('bea.m')
  })

  it('a co-worker whose address is not a co-worker address fails loud (no guessed handle)', () => {
    const broken = { id: 'cw0000001xyz', name: 'Marketing', email: 'marketing@co.test', kind: 'coworker' as const }
    expect(() => mentionedIds('@marketing', [broken])).toThrow(/not a co-worker address/)
  })
})

function pushFake(subscribed: string[]) {
  const sent: Array<{ userId: string; title: string; url: string }> = []
  const port: PushPort = {
    hasSubscription: async (u) => subscribed.includes(u),
    send: vi.fn(async (userId, p) => {
      sent.push({ userId, title: p.title, url: p.url })
    }),
  }
  return { port, sent }
}

describe('notifyNewMessage', () => {
  it('DMs push to the other participants with push turned on', async () => {
    const { deps } = fixture()
    const dm = await openDm(deps, 'bea', ['carl', 'owner'])
    const { message, conversation } = await postMessage(deps, 'bea', dm.id, 'hi')
    const { port, sent } = pushFake(['carl', 'bea'])
    expect(await notifyNewMessage(deps, port, conversation, message)).toEqual(['carl'])
    expect(sent).toEqual([{ userId: 'carl', title: 'Bea Member', url: `/messages?c=${dm.id}` }])
  })

  it('channels push only to mentioned people who may see the channel', async () => {
    const { deps } = fixture()
    const priv = await createChannel(deps, 'owner', { name: 'lead', private: true })
    const { message, conversation } = await postMessage(deps, 'owner', priv.id, '@bea @carl look')
    const { port } = pushFake(['bea', 'carl'])
    expect(await notifyNewMessage(deps, port, conversation, message)).toEqual([])

    const pub = await createChannel(deps, 'owner', { name: 'general', private: false })
    const posted = await postMessage(deps, 'owner', pub.id, 'ping @bea')
    expect(await notifyNewMessage(deps, port, posted.conversation, posted.message)).toEqual(['bea'])
  })

  it('never pushes to an AI co-worker: not in a DM, not when @mentioned, not in its thread', async () => {
    const f = fixture()
    addCoworker(f, { id: 'cw-mkt', slug: 'marketing', name: 'Marketing' })
    const dm = await openDm(f.deps, 'bea', ['cw-mkt', 'carl'])
    const inDm = await postMessage(f.deps, 'bea', dm.id, 'hi both')
    const { port, sent } = pushFake(['carl', 'cw-mkt'])
    expect(await notifyNewMessage(f.deps, port, inDm.conversation, inDm.message)).toEqual(['carl'])

    const pub = await createChannel(f.deps, 'owner', { name: 'general', private: false })
    const root = await postMessage(f.deps, 'cw-mkt', pub.id, 'kick-off')
    const mention = await postMessage(f.deps, 'bea', pub.id, '@marketing and @carl', { parentId: root.message.id })
    expect(await notifyNewMessage(f.deps, port, mention.conversation, mention.message)).toEqual(['carl'])
    expect(sent.map((s) => s.userId)).toEqual(['carl', 'carl'])
  })

  it('skips people currently viewing the conversation', async () => {
    const { deps } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    await setViewing(deps, 'carl', dm.id)
    const { message, conversation } = await postMessage(deps, 'bea', dm.id, 'hi')
    const { port } = pushFake(['carl'])
    expect(await notifyNewMessage(deps, port, conversation, message)).toEqual([])
    await setViewing(deps, 'carl', null)
    expect(await notifyNewMessage(deps, port, conversation, message)).toEqual(['carl'])
  })

  it("carries the recipient's total unread for the app-icon badge", async () => {
    const { deps } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    await postMessage(deps, 'bea', dm.id, 'one')
    const pub = await createChannel(deps, 'owner', { name: 'general', private: false })
    await postMessage(deps, 'owner', pub.id, 'chatter')
    const { message, conversation } = await postMessage(deps, 'bea', dm.id, 'two')
    const badges: Array<{ userId: string; badge: number }> = []
    const port: PushPort = {
      hasSubscription: async () => true,
      send: async (userId, p) => void badges.push({ userId, badge: p.badge }),
    }
    await notifyNewMessage(deps, port, conversation, message)
    // Carl: two unread in the DM, one in #general.
    expect(badges).toEqual([{ userId: 'carl', badge: 3 }])
  })

  it('a quoted reply in a channel pushes the quoted author ("replied to you")', async () => {
    const { deps } = fixture()
    const pub = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: original } = await postMessage(deps, 'bea', pub.id, 'question')
    const { message, conversation } = await postMessage(deps, 'carl', pub.id, 'answer', { replyToId: original.id })
    const { port, sent } = pushFake(['bea', 'owner', 'carl'])
    expect(await notifyNewMessage(deps, port, conversation, message)).toEqual(['bea'])
    expect(sent[0].title).toBe('Carl Member replied to you in #general')
  })
})
