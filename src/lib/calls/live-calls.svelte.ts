import type { CallDto } from './client'
import { getContext, setContext } from 'svelte'

/**
 * The person's live calls on any nucleus page (plan/video-calls.md owner
 * decision 5, "ring everywhere"): ONE EventSource on /api/calls/stream,
 * opened by the nucleus layout in onMount and closed on destroy. It feeds the
 * incoming-call toast (ringing) and the Messages call button (Join when a call
 * is live in that conversation).
 *
 * Frames carry the whole call: `call.ringing` = it rings for me now,
 * `call.state` = anything else. A call that is over leaves the feed. Every
 * (re)connect opens with a snapshot of my live calls, so on `open` the feed
 * starts empty and the snapshot refills it — a call that ended while the
 * stream was down cannot linger. A ring stops by itself at `ringUntil`.
 */

export type CallStreamSource = {
  readonly readyState: number
  addEventListener(type: string, fn: (e: Event) => void): void
  close(): void
}

type Entry = { call: CallDto; ringing: boolean }

const CLOSED = 2
const RETRY_MS = [5_000, 15_000, 60_000]
const isLive = (c: CallDto) => c.state === 'ringing' || c.state === 'active'

export class LiveCalls {
  #calls = $state<Record<string, Entry>>({})
  #status = $state<'connecting' | 'live' | 'reconnecting'>('connecting')
  #error = $state<string | null>(null)
  // Bookkeeping, not view state: plain collections on purpose.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ring timers are never rendered
  #timers = new Map<string, ReturnType<typeof setTimeout>>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- subscriber callbacks are never rendered
  #listeners = new Set<() => void>()
  #open: (() => CallStreamSource) | null = null
  #source: CallStreamSource | null = null
  #retry: ReturnType<typeof setTimeout> | undefined
  #failures = 0
  #stopped = false

  /** Calls ringing for me right now, oldest first. */
  get ringing(): CallDto[] {
    return Object.values(this.#calls)
      .filter((e) => e.ringing)
      .map((e) => e.call)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  /** Every live (ringing/active) call I am part of, newest first. */
  get calls(): CallDto[] {
    return Object.values(this.#calls)
      .map((e) => e.call)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get status() {
    return this.#status
  }

  /** The server could not load my calls (its `error` frame); null while fine. */
  get error() {
    return this.#error
  }

  /** The live call in this DM/channel that I am part of, if any. */
  liveFor(kind: 'dm' | 'channel', contextId: string): CallDto | null {
    return Object.values(this.#calls).find((e) => e.call.contextKind === kind && e.call.contextId === contextId)?.call ?? null
  }

  /** Called after every change (the toast starts/stops its ringtone here — no effect needed). */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  connect(open: () => CallStreamSource): void {
    this.#open = open
    this.#stopped = false
    this.#start()
  }

  /** Reopen a stream the browser gave up on (visible / online again); a live one is left alone. */
  resume(): void {
    if (this.#stopped || !this.#source || this.#source.readyState !== CLOSED) return
    clearTimeout(this.#retry)
    this.#restart()
  }

  close(): void {
    this.#stopped = true
    clearTimeout(this.#retry)
    this.#source?.close()
    this.#source = null
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#timers.clear()
    this.#listeners.clear()
  }

  /** Stop ringing for this call here and now (I accepted or declined it). */
  dismiss(id: string): void {
    const e = this.#calls[id]
    if (!e || !e.ringing) return
    this.#set({ ...this.#calls, [id]: { call: e.call, ringing: false } })
  }

  /** One frame from the stream (exposed for the layout's own optimistic updates and tests). */
  apply(event: 'call.ringing' | 'call.state', call: CallDto): void {
    const next = { ...this.#calls }
    if (!isLive(call)) delete next[call.id]
    else next[call.id] = { call, ringing: event === 'call.ringing' && Date.now() < Date.parse(call.ringUntil) }
    this.#set(next)
  }

  #set(next: Record<string, Entry>): void {
    this.#calls = next
    for (const [id, t] of this.#timers) {
      if (!next[id]?.ringing) {
        clearTimeout(t)
        this.#timers.delete(id)
      }
    }
    for (const [id, e] of Object.entries(next)) {
      if (!e.ringing || this.#timers.has(id)) continue
      this.#timers.set(
        id,
        setTimeout(() => {
          this.#timers.delete(id)
          this.dismiss(id)
        }, Math.max(0, Date.parse(e.call.ringUntil) - Date.now())),
      )
    }
    for (const fn of [...this.#listeners]) fn()
  }

  #start(): void {
    if (this.#stopped || !this.#open) return
    const source = this.#open()
    this.#source = source
    source.addEventListener('open', () => {
      if (this.#source !== source) return
      this.#failures = 0
      this.#status = 'live'
      this.#error = null
      this.#set({})
    })
    source.addEventListener('error', (e) => {
      if (this.#source !== source) return
      if (e instanceof MessageEvent && typeof e.data === 'string') {
        // The server's own `error` frame (its snapshot failed), not a dropped connection.
        const { error } = JSON.parse(e.data) as { error?: string }
        this.#error = error ?? 'the call feed failed'
        console.error('[calls] call feed:', this.#error)
        return
      }
      this.#status = 'reconnecting'
      if (source.readyState === CLOSED) {
        // The browser gave up (e.g. a non-200 answer): try again, slower each time.
        const wait = RETRY_MS[Math.min(this.#failures++, RETRY_MS.length - 1)]
        clearTimeout(this.#retry)
        this.#retry = setTimeout(() => this.#restart(), wait)
      }
    })
    for (const type of ['call.ringing', 'call.state'] as const) {
      source.addEventListener(type, (e) => {
        if (this.#source !== source || this.#stopped) return
        const { call } = JSON.parse((e as MessageEvent).data as string) as { call: CallDto }
        this.apply(type, call)
      })
    }
  }

  #restart(): void {
    this.#source?.close()
    this.#source = null
    this.#start()
  }
}

const KEY = Symbol('live-calls')

/** The nucleus layout owns the feed; pages under it read it. */
export function setLiveCalls(live: LiveCalls): LiveCalls {
  return setContext(KEY, live)
}

export function getLiveCalls(): LiveCalls {
  const live = getContext<LiveCalls | undefined>(KEY)
  if (!live) throw new Error('calls: no live call feed — getLiveCalls() works only under the nucleus layout')
  return live
}
