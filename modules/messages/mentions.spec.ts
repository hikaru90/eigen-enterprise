import { describe, expect, it } from 'vitest'
import { mentionsOf } from './mentions'
import { createChannel, deleteMessage, editMessage, openDm, postMessage } from './service'
import { fixture } from './test-fixtures'

describe('mentions of a person (the bell, notifications.inbox)', () => {
  it('records who a message mentions when it is posted, and lists it for them with where and who', async () => {
    const { deps } = fixture()
    const general = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'owner', general.id, 'hey @bea, the van?')
    expect(await mentionsOf(deps, 'bea')).toEqual([
      {
        messageId: message.id,
        conversationId: general.id,
        parentId: null,
        where: '#general',
        author: { id: 'owner', name: 'Olga Owner' },
        body: 'hey @bea, the van?',
        at: message.createdAt,
      },
    ])
    expect(await mentionsOf(deps, 'carl')).toEqual([])
  })

  it('a thread reply mention carries its thread; DMs and self-mentions are not mentions', async () => {
    const { deps } = fixture()
    const general = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: root } = await postMessage(deps, 'owner', general.id, 'plan')
    await postMessage(deps, 'carl', general.id, 'agree @bea', { parentId: root.id })
    await postMessage(deps, 'bea', general.id, 'note to @bea')
    const dm = await openDm(deps, 'carl', ['bea'])
    await postMessage(deps, 'carl', dm.id, '@bea psst')
    const got = await mentionsOf(deps, 'bea')
    expect(got.map((m) => [m.author.id, m.parentId])).toEqual([['carl', root.id]])
  })

  it('never lists a mention in a conversation the person may not see', async () => {
    const { deps, access } = fixture()
    const lead = await createChannel(deps, 'owner', { name: 'leadership', private: true, userIds: ['carl'] })
    await postMessage(deps, 'owner', lead.id, 'ask @bea later')
    expect(await mentionsOf(deps, 'bea')).toEqual([])
    const pub = await createChannel(deps, 'owner', { name: 'pub', private: false })
    await postMessage(deps, 'owner', pub.id, '@carl look')
    expect(await mentionsOf(deps, 'carl')).toHaveLength(1)
    await access.setGrants('owner', 'channel', pub.id, [{ subject: { kind: 'user', userId: 'owner' }, level: 'manage' }])
    expect(await mentionsOf(deps, 'carl')).toEqual([])
  })

  it('an edit re-records the mentions; a deleted message drops out', async () => {
    const { deps } = fixture()
    const general = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'owner', general.id, '@bea hi')
    await editMessage(deps, 'owner', message.id, '@carl hi')
    expect(await mentionsOf(deps, 'bea')).toEqual([])
    expect((await mentionsOf(deps, 'carl')).map((m) => m.body)).toEqual(['@carl hi'])
    await deleteMessage(deps, 'owner', message.id)
    expect(await mentionsOf(deps, 'carl')).toEqual([])
  })
})
