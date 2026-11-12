import type { CallFrame, CallsHub, CallsService } from '../../../../modules/calls'

/**
 * "In a call", read from the Calls module's live state through its public
 * seams — the CallsHub (the frames /api/calls/stream sends) and the
 * CallsService — without touching Calls' internals. The hub sends a person
 * frames for the calls they are part of, so following every company member
 * hears about every call. In a call = in the room (LiveKit's truth) of a
 * ringing or active call.
 *
 * A frame is only a "this call changed" signal: the hub builds frames of
 * concurrent dispatches concurrently, so copies can arrive out of order. Each
 * signal re-reads the call from the service, one read at a time per call and
 * again when signalled meanwhile — the last read always starts after the last
 * committed change. reconcile() re-reads the calls still believed live
 * (an end that happened while the hub's LISTEN was down sends no frame).
 */

export type CallFeed = {
  hub: Pick<CallsHub, 'subscribe' | 'snapshot'>
  service: Pick<CallsService, 'load' | 'viewFor'>
}
type CallDto = CallFrame['data']['call']

const live = (c: CallDto) => c.state === 'ringing' || c.state === 'active'

export class InCallWatcher {
  /** Live call id → who is in its room. */
  readonly #rooms = new Map<string, Set<string>>()
  /** Followed member → unsubscribe. */
  readonly #subs = new Map<string, () => void>()
  readonly #reading = new Map<string, Promise<void>>()
  readonly #again = new Set<string>()
  #reported = ''

  constructor(
    private readonly feed: CallFeed,
    private readonly onChange: (inCall: Set<string>) => void,
  ) {}

  inCall(): Set<string> {
    const out = new Set<string>()
    for (const people of this.#rooms.values()) for (const id of people) out.add(id)
    return out
  }

  /** Follows exactly these members' calls: subscribes newcomers (reading their live calls), drops who left. */
  async follow(memberIds: readonly string[]): Promise<void> {
    const wanted = new Set(memberIds)
    for (const [id, unsubscribe] of this.#subs) {
      if (wanted.has(id)) continue
      unsubscribe()
      this.#subs.delete(id)
    }
    const added = [...wanted].filter((id) => !this.#subs.has(id))
    for (const id of added) this.#subs.set(id, this.feed.hub.subscribe(id, (f) => this.#changed(f.data.call.id)))
    for (const id of added) for (const f of await this.feed.hub.snapshot(id)) this.#changed(f.data.call.id)
    await this.idle()
  }

  /** Re-reads every call still believed live. */
  async reconcile(): Promise<void> {
    for (const callId of this.#rooms.keys()) this.#changed(callId)
    await this.idle()
  }

  /** Resolves when no read is running (tests; follow/reconcile). */
  async idle(): Promise<void> {
    while (this.#reading.size > 0) await Promise.all([...this.#reading.values()])
  }

  stop(): void {
    for (const unsubscribe of this.#subs.values()) unsubscribe()
    this.#subs.clear()
  }

  #changed(callId: string): void {
    if (this.#reading.has(callId)) {
      this.#again.add(callId)
      return
    }
    const run = (async () => {
      do {
        this.#again.delete(callId)
        try {
          this.#apply(callId, await this.#read(callId))
        } catch (err) {
          console.error('[presence] reading a call for "in a call" failed', { callId, err })
        }
      } while (this.#again.has(callId))
    })().finally(() => this.#reading.delete(callId))
    this.#reading.set(callId, run)
  }

  /** The call as one of its participants sees it now (null: gone, or nobody may see it). */
  async #read(callId: string): Promise<CallDto | null> {
    const rec = await this.feed.service.load(callId)
    if (!rec) return null
    for (const p of rec.participants) {
      const view = await this.feed.service.viewFor(p.userId, rec)
      if (view) return view.call
    }
    return null
  }

  #apply(callId: string, call: CallDto | null): void {
    const inRoom = new Set(call ? call.participants.filter((p) => p.inRoom).map((p) => p.userId) : [])
    if (call && live(call) && inRoom.size > 0) this.#rooms.set(callId, inRoom)
    else this.#rooms.delete(callId)
    const now = this.inCall()
    const key = [...now].sort().join(',')
    if (key === this.#reported) return
    this.#reported = key
    this.onChange(now)
  }
}
