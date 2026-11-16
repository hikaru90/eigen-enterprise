import type { ActiveCall } from './active-call.svelte'
import { getContext, setContext } from 'svelte'

/**
 * Which call this browser is in, across its tabs. A call runs in its own tab
 * (call-tab.ts), so the main tab no longer holds the live call — yet its
 * "you're already in a call" checks (the Messages call button, /calls, the
 * incoming-call toast) must still see it. The call tab says so on a
 * BroadcastChannel; every nucleus tab listens.
 *
 * Why a BroadcastChannel and not the server's call feed: the feed knows who
 * is in a room only once LiveKit's webhook arrived, and a dropped connection
 * reads as "left" while the tab reconnects — the check would open a gap right
 * when it matters (just after Call was clicked). The call tab's own ActiveCall
 * knows the moment it starts joining and the moment it leaves. Its scope is
 * this browser, the same scope the in-tab check had before.
 *
 * Protocol: a tab that starts listening asks `who`; a call tab answers (and
 * says so on every change) with `here` while its call is joining or live, and
 * `gone` when it is not any more — hang-up, call over, tab closing (pagehide
 * leaves the call, which is a change like any other).
 */

export type PresentCall = { id: string; title: string }

export type PresenceMessage = { type: 'who' } | { type: 'here'; call: PresentCall } | { type: 'gone'; id: string }

export type PresenceChannel = {
  postMessage(message: PresenceMessage): void
  addEventListener(type: 'message', fn: (e: MessageEvent<PresenceMessage>) => void): void
  close(): void
}

/** What tracking needs of the live call (ActiveCall in the app, a fake in specs). */
export type TrackedCall = Pick<ActiveCall, 'inCall' | 'call' | 'subscribe'>

export const PRESENCE_CHANNEL = 'ee-calls-presence'

export class CallPresence {
  /** Calls live in other tabs of this browser, by id. */
  // Raw: replaced whole on every change, and posted as is (a $state proxy cannot be cloned onto the channel).
  #others = $state.raw<Record<string, PresentCall>>({})
  /** The call live in this tab (the call tab only). */
  #mine = $state.raw<PresentCall | null>(null)
  #channel: PresenceChannel | null = null

  /** The call I am in, in this tab or another one; null when none. */
  get current(): PresentCall | null {
    return this.#mine ?? Object.values(this.#others)[0] ?? null
  }

  /** Start listening (the nucleus layout, on mount — never during SSR). */
  connect(open: () => PresenceChannel): void {
    if (this.#channel) return
    const channel = open()
    this.#channel = channel
    channel.addEventListener('message', (e) => this.#receive(e.data))
    channel.postMessage({ type: 'who' })
    if (this.#mine) channel.postMessage({ type: 'here', call: this.#mine })
  }

  close(): void {
    this.#announceGone()
    this.#channel?.close()
    this.#channel = null
  }

  /**
   * The call tab: tell the other tabs while this call is joining or live.
   * Returns the stop function (the call page, on destroy).
   */
  track(active: TrackedCall): () => void {
    const sync = () => {
      const now = active.inCall && active.call ? { id: active.call.id, title: active.call.title } : null
      if (now?.id === this.#mine?.id && now?.title === this.#mine?.title) return
      if (!now) return this.#announceGone()
      this.#mine = now
      this.#channel?.postMessage({ type: 'here', call: now })
    }
    const unsubscribe = active.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      this.#announceGone()
    }
  }

  #announceGone() {
    const mine = this.#mine
    if (!mine) return
    this.#mine = null
    this.#channel?.postMessage({ type: 'gone', id: mine.id })
  }

  #receive(m: PresenceMessage) {
    switch (m.type) {
      case 'who':
        if (this.#mine) this.#channel?.postMessage({ type: 'here', call: this.#mine })
        return
      case 'here':
        this.#others = { ...this.#others, [m.call.id]: m.call }
        return
      case 'gone': {
        if (!(m.id in this.#others)) return
        const next = { ...this.#others }
        delete next[m.id]
        this.#others = next
      }
    }
  }
}

const KEY = Symbol('call-presence')

/** The nucleus layout owns it; pages and components under it read it. */
export function setCallPresence(presence: CallPresence): CallPresence {
  return setContext(KEY, presence)
}

export function getCallPresence(): CallPresence {
  const presence = getContext<CallPresence | undefined>(KEY)
  if (!presence) throw new Error('calls: no call presence — getCallPresence() works only under the nucleus layout')
  return presence
}

/** For component specs: the context a component under the nucleus layout sees. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a Svelte mount `context` map, never rendered
export const callPresenceContext = (presence: CallPresence) => new Map<unknown, unknown>([[KEY, presence]])

/** The browser's channel (one per tab, same origin). */
export const browserPresenceChannel = (): PresenceChannel => new BroadcastChannel(PRESENCE_CHANNEL) as PresenceChannel
