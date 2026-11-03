import { describe, expect, it, vi } from 'vitest'
import { mentionedIds, notifyNewMessage, type PushPort } from './notify'
import { createChannel, openDm, postMessage, setViewing } from './service'
import { fixture } from './test-fixtures'

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
})
