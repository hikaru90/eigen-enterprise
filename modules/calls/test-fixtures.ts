import type { CallContext, CallContextPort, ConversationKind } from './context-port'
import { livekitConfig, type RoomControl } from './livekit'
import { MemoryCallsDirectory, MemoryCallsStore } from './memory-store'
import { createCallsService, type CallsDeps } from './service'

export const TEST_LIVEKIT_ENV = {
  LIVEKIT_URL: 'wss://rtc.os.example.test',
  LIVEKIT_API_URL: 'http://127.0.0.1:4001',
  LIVEKIT_API_KEY: 'APIcallsspec',
  LIVEKIT_API_SECRET: 'calls-spec-secret-0123456789abcdefghijklmnop',
}

/** Conversations with fixed members — the Messages side of the port, faked. */
export class FakeContextPort implements CallContextPort {
  readonly conversations = new Map<string, { kind: ConversationKind; title: string; memberIds: string[]; readOnly?: string[] }>()

  async open(actorId: string, kind: ConversationKind, id: string): Promise<CallContext | null> {
    const c = this.conversations.get(id)
    if (!c || c.kind !== kind || !c.memberIds.includes(actorId) || c.readOnly?.includes(actorId)) return null
    return { title: c.title, memberIds: [...c.memberIds] }
  }

  async isMember(userId: string, kind: ConversationKind, id: string): Promise<boolean> {
    const c = this.conversations.get(id)
    return !!c && c.kind === kind && c.memberIds.includes(userId)
  }
}

/** Four members (ann, ben, cat, dan), a DM ann+ben, channel #general (ann, ben, cat), a ticking clock. */
export function fixture(opts: { env?: Record<string, string | undefined> } = {}) {
  const store = new MemoryCallsStore()
  const directory = new MemoryCallsDirectory([
    { id: 'ann', name: 'Ann Example', email: 'ann@co.test' },
    { id: 'ben', name: 'Ben Example', email: 'ben@co.test' },
    { id: 'cat', name: 'Cat Example', email: 'cat@co.test' },
    { id: 'dan', name: 'Dan Example', email: 'dan@co.test' },
  ])
  const contexts = new FakeContextPort()
  contexts.conversations.set('dm-ann-ben', { kind: 'dm', title: 'Ann Example, Ben Example', memberIds: ['ann', 'ben'] })
  contexts.conversations.set('ch-general', { kind: 'channel', title: '#general', memberIds: ['ann', 'ben', 'cat'] })
  const closed: string[] = []
  const rooms: RoomControl = {
    async closeRoom(room) {
      closed.push(room)
    },
  }
  let t = Date.UTC(2026, 10, 11, 9, 0, 0)
  let n = 0
  const clock = {
    tick: (ms: number) => (t += ms),
    now: () => new Date(t),
  }
  const env = opts.env ?? TEST_LIVEKIT_ENV
  const deps: CallsDeps = {
    store,
    contexts,
    directory,
    livekit: () => livekitConfig(env),
    rooms,
    now: clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  }
  const service = createCallsService(deps)
  const user = (userId: string) => ({ kind: 'user' as const, userId })
  return { store, directory, contexts, closed, clock, deps, service, user }
}
