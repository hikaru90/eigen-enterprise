import { describe, expect, it } from 'vitest'
import { CallsHub } from '../../../../modules/calls/hub'
import { fixture } from '../../../../modules/calls/test-fixtures'
import { InCallWatcher } from './calls-watch'

/** The real Calls hub over its in-memory service, every stored change "NOTIFY"-ed into dispatch. */
function setup() {
  const f = fixture()
  const hub = new CallsHub(f.service)
  const pending: Promise<void>[] = []
  f.store.onChange = (id) => pending.push(hub.dispatch(id))
  const seen: string[][] = []
  const watcher = new InCallWatcher({ hub, service: f.service }, (ids) => seen.push([...ids].sort()))
  /** Every hub dispatch delivered, and every read it triggered done. */
  const settle = async () => {
    while (pending.length) await pending.shift()
    await watcher.idle()
  }
  const joined = (callId: string, identity: string) =>
    f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${callId}`, identity })
  return { ...f, hub, settle, seen, watcher, joined }
}

const everyone = ['ann', 'ben', 'cat', 'dan']

describe('InCallWatcher (Calls live state → who is in a call)', () => {
  it('in a call = in the room of a live call; ringing alone is not, and the end clears it', async () => {
    const { service, user, settle, watcher, joined } = setup()
    await watcher.follow(everyone)
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await settle()
    expect([...watcher.inCall()]).toEqual([])
    await joined(call.id, 'ann')
    await settle()
    expect([...watcher.inCall()]).toEqual(['ann'])
    await service.accept('ben', call.id)
    await joined(call.id, 'ben')
    await settle()
    expect([...watcher.inCall()].sort()).toEqual(['ann', 'ben'])
    await service.hangup('ben', call.id)
    await service.hangup('ann', call.id)
    await settle()
    expect([...watcher.inCall()]).toEqual([])
  })

  it('reports each change once', async () => {
    const { service, user, settle, watcher, joined, seen } = setup()
    await watcher.follow(everyone)
    const call = await service.start(user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    await joined(call.id, 'ann')
    await settle()
    await service.hangup('ann', call.id)
    await settle()
    expect(seen).toEqual([['ann'], []])
  })

  it('a call already going when it starts following is seen (snapshot)', async () => {
    const { service, user, settle, watcher, joined } = setup()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await joined(call.id, 'ann')
    await settle()
    await watcher.follow(everyone)
    expect([...watcher.inCall()]).toEqual(['ann'])
  })

  it('reconcile drops a call whose end it never heard (LISTEN was down)', async () => {
    const { service, user, settle, watcher, joined, store } = setup()
    await watcher.follow(everyone)
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await joined(call.id, 'ann')
    await settle()
    store.onChange = null
    await service.hangup('ann', call.id)
    expect([...watcher.inCall()]).toEqual(['ann'])
    await watcher.reconcile()
    expect([...watcher.inCall()]).toEqual([])
  })

  it('follows the member list: someone who left is unsubscribed, a newcomer subscribed', async () => {
    const { hub, watcher } = setup()
    await watcher.follow(['ann', 'ben'])
    expect(hub.size).toBe(2)
    await watcher.follow(['ben', 'cat', 'dan'])
    expect(hub.size).toBe(3)
    watcher.stop()
    expect(hub.size).toBe(0)
  })
})
