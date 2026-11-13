import type { HeartbeatState, PresenceView } from './presence'
import { getContext, setContext } from 'svelte'

/**
 * My own status on every nucleus page (Contribute e4ef6be1): shown at the
 * foot of the main nav, where people look for it, so Do not disturb is not
 * forgotten. Fed by this tab's heartbeat — every beat (POST
 * /api/messages/presence) answers my presence — by my own Do not disturb
 * switch (PUT), and by the Messages feed while Messages is open. Created by
 * the nucleus layout only while Messages (which owns presence) is on.
 */

export type SelfPresenceFetch = (input: string, init: RequestInit) => Promise<Response>

const ROUTE = '/api/messages/presence'

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `Status could not be updated (HTTP ${res.status}).`
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class SelfPresence {
  #view = $state<PresenceView | null>(null)
  #error = $state<string | null>(null)
  #saving = $state(false)

  constructor(private readonly env: { fetch: SelfPresenceFetch }) {}

  /** My status, or null until the first heartbeat answers. */
  get view(): PresenceView | null {
    return this.#view
  }

  /** The status could not be loaded or saved (shown, never hidden). */
  get error(): string | null {
    return this.#error
  }

  get saving(): boolean {
    return this.#saving
  }

  /** My presence as the server just told it (a beat's answer, a save, the Messages feed). */
  receive(view: PresenceView): void {
    this.#view = view
    this.#error = null
  }

  /** The heartbeat's `post` (PresenceHeartbeat): sends one beat and takes the answer as my status. */
  readonly beat = (body: { clientId: string; state: HeartbeatState }): void => {
    void this.env
      .fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      })
      .then(async (res) => {
        if (res.ok) {
          this.receive(((await res.json()) as { presence: PresenceView }).presence)
          return
        }
        this.#error = await refusal(res)
        console.error('[presence] heartbeat refused', res.status, this.#error)
      })
      .catch((err: unknown) => {
        this.#error = `Status could not be updated: ${reason(err)}`
        console.error('[presence] heartbeat failed', err)
      })
  }

  /** My own Do not disturb switch. */
  async setDoNotDisturb(on: boolean): Promise<void> {
    this.#saving = true
    try {
      const res = await this.env.fetch(ROUTE, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doNotDisturb: on }),
      })
      if (!res.ok) {
        this.#error = await refusal(res)
        return
      }
      this.receive(((await res.json()) as { presence: PresenceView }).presence)
    } catch (err) {
      this.#error = `Status could not be saved: ${reason(err)}`
    } finally {
      this.#saving = false
    }
  }
}

const KEY = Symbol('self-presence')

export function setSelfPresence(self: SelfPresence | null): SelfPresence | null {
  return setContext(KEY, self)
}

/** My status keeper, or null while Messages (which owns presence) is off. */
export function getSelfPresence(): SelfPresence | null {
  const self = getContext<SelfPresence | null | undefined>(KEY)
  if (self === undefined) throw new Error('presence: no status keeper — getSelfPresence() works only under the nucleus layout')
  return self
}
