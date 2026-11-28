/**
 * The one door in the Ask bar (plan/concept-memory-one-door.md M1): what the person types or
 * says goes to memory.route_input (POST /api/assistant/route) first. Jev decides; only a
 * question (or a reminder, whose time the assistant writes) opens the chat. Anything filed
 * shows a chip — "Saved as task · change" — and change refiles it with the person's choice
 * (logged as the correction). Unsure → the chip asks. A failure keeps the words and says why.
 * Explicit methods only (the bar's handlers call them).
 */

export type InputRoute = 'question' | 'remember' | 'task' | 'document' | 'reminder'
export type FiledRoute = 'remember' | 'task' | 'document'

type RouteResult =
  | { outcome: 'filed'; route: FiledRoute; id: string; url: string; decisionId: string | null }
  | { outcome: 'chat'; route: 'question' | 'reminder'; decisionId: string | null }
  | { outcome: 'unsure'; decisionId: string; choices: InputRoute[] }

export type OneDoorState =
  | { kind: 'idle' }
  | { kind: 'routing'; text: string }
  | { kind: 'filed'; text: string; route: FiledRoute; id: string; url: string; decisionId: string | null }
  | { kind: 'unsure'; text: string; decisionId: string; choices: InputRoute[] }
  | { kind: 'failed'; text: string; error: string }

export type OneDoorDeps = {
  fetch: typeof globalThis.fetch
  /** Hand the words to the chat (the assistant answers). */
  ask: (text: string) => void
}

export const ROUTES: readonly InputRoute[] = ['question', 'remember', 'task', 'document', 'reminder']

export class OneDoor {
  state = $state<OneDoorState>({ kind: 'idle' })
  #deps: OneDoorDeps

  constructor(deps: OneDoorDeps) {
    this.#deps = deps
  }

  get busy(): boolean {
    return this.state.kind === 'routing'
  }

  async submit(text: string): Promise<void> {
    const words = text.trim()
    if (!words || this.busy) return
    await this.#route(words, { text: words })
  }

  /** The person's choice: after "change" on a filed input, or a pick when the brain was unsure. */
  async choose(route: InputRoute): Promise<void> {
    const s = this.state
    if (s.kind !== 'filed' && s.kind !== 'unsure') return
    if (s.kind === 'filed' && s.route === route) return
    const body: Record<string, unknown> = { text: s.text, as: route }
    if (s.decisionId) body.decision_id = s.decisionId
    if (s.kind === 'filed') body.replaces = { route: s.route, id: s.id }
    await this.#route(s.text, body)
  }

  dismiss(): void {
    if (this.state.kind !== 'routing') this.state = { kind: 'idle' }
  }

  async #route(text: string, body: Record<string, unknown>): Promise<void> {
    this.state = { kind: 'routing', text }
    let res: Response
    try {
      res = await this.#deps.fetch('/api/assistant/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      this.state = { kind: 'failed', text, error: err instanceof Error ? err.message : String(err) }
      return
    }
    const data = (await res.json().catch(() => null)) as (RouteResult & { error?: string }) | { error?: string } | null
    if (!res.ok || !data || !('outcome' in data)) {
      this.state = { kind: 'failed', text, error: data?.error ?? `The brain could not take this in (HTTP ${res.status}).` }
      return
    }
    if (data.outcome === 'chat') {
      this.state = { kind: 'idle' }
      this.#deps.ask(text)
      return
    }
    if (data.outcome === 'unsure') {
      this.state = { kind: 'unsure', text, decisionId: data.decisionId, choices: data.choices }
      return
    }
    this.state = { kind: 'filed', text, route: data.route, id: data.id, url: data.url, decisionId: data.decisionId }
  }
}
