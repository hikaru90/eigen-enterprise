import type { HeartbeatBody, PresenceView } from './presence'
import { getContext, setContext } from 'svelte'
import { shownErrorOf, type ShownError } from '$lib/errors/agent-report'

/**
 * My own status on every nucleus page (Contribute e4ef6be1): shown at the
 * foot of the main nav, where people look for it, so Do not disturb is not
 * forgotten. Fed by this tab's heartbeat — every beat (POST
 * /api/messages/presence) answers my presence — by my own Do not disturb
 * switch (PUT), and by the Messages feed while Messages is open. Created by
 * the nucleus layout only while Messages (which owns presence) is on.
 *
 * Share where I am (plan/phase-multiplayer-presence.md): my own switch for
 * whether others see where I work (PUT /api/messages/presence/where); the
 * beat's answer and every save carry it.
 */

/** My presence as the presence routes answer it: with my Share where I am switch. */
export type MyPresenceView = PresenceView & { shareWhere?: boolean }

export type SelfPresenceFetch = (input: string, init: RequestInit) => Promise<Response>

const ROUTE = '/api/messages/presence'

async function refusal(res: Response): Promise<ShownError> {
  const body = (await res.json().catch(() => null)) as unknown
  return (
    shownErrorOf(body) ?? {
      error: `Status could not be updated (HTTP ${res.status}).`,
      agent: null,
    }
  )
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class SelfPresence {
  #view = $state<PresenceView | null>(null)
  #error = $state<ShownError | null>(null)
  #saving = $state(false)
  #shareWhere = $state<boolean | null>(null)

  constructor(
    private readonly env: {
      fetch: SelfPresenceFetch
      /** The page is hidden — on a navigation, by the time the browser aborts its last beats. */
      hidden: () => boolean
    },
  ) {}

  /** My status, or null until the first heartbeat answers. */
  get view(): PresenceView | null {
    return this.#view
  }

  /** The status could not be loaded or saved (shown, never hidden). */
  get error(): ShownError | null {
    return this.#error
  }

  get saving(): boolean {
    return this.#saving
  }

  /** Share where I am, or null until the server has said (the first beat's answer). */
  get shareWhere(): boolean | null {
    return this.#shareWhere
  }

  /**
   * My presence as the server just told it (a beat's answer, a save, the
   * Messages feed). The Messages feed carries no share switch: it is kept.
   */
  receive(view: MyPresenceView): void {
    const { shareWhere, ...presence } = view
    this.#view = presence
    if (typeof shareWhere === 'boolean') this.#shareWhere = shareWhere
    this.#error = null
  }

  /** The heartbeat's `post` (PresenceHeartbeat): sends one beat and takes the answer as my status. */
  readonly beat = (body: HeartbeatBody): void => {
    void this.env
      .fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      })
      .then(async (res) => {
        if (res.ok) {
          this.receive(((await res.json()) as { presence: MyPresenceView }).presence)
          return
        }
        this.#error = await refusal(res)
        console.error('[presence] heartbeat refused', res.status, this.#error.error)
      })
      .catch((err: unknown) => {
        // A beat that fails once the page is hidden went out with the page: the browser aborts
        // a navigating page's last beats (idle, gone). That is the page leaving, not a failure —
        // the server's window runs out on its own, and the next visible beat reports an outage.
        if (this.env.hidden()) return
        this.#error = { error: `Status could not be updated: ${reason(err)}`, agent: null }
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
      this.receive(((await res.json()) as { presence: MyPresenceView }).presence)
    } catch (err) {
      this.#error = { error: `Status could not be saved: ${reason(err)}`, agent: null }
    } finally {
      this.#saving = false
    }
  }

  /** My own Share where I am switch (on by default on the server). */
  async setShareWhere(on: boolean): Promise<void> {
    this.#saving = true
    try {
      const res = await this.env.fetch(`${ROUTE}/where`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shareWhere: on }),
      })
      if (!res.ok) {
        this.#error = await refusal(res)
        return
      }
      this.receive(((await res.json()) as { presence: MyPresenceView }).presence)
    } catch (err) {
      this.#error = { error: `Sharing where you are could not be saved: ${reason(err)}`, agent: null }
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
  if (self === undefined)
    throw new Error(
      'presence: no status keeper — getSelfPresence() works only under the nucleus layout',
    )
  return self
}
