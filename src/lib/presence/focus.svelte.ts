import { getContext, onDestroy, setContext } from 'svelte'
import { afterNavigate } from '$app/navigation'
import type { WhereItem } from './where'

/**
 * The one thing a page has open (plan/phase-multiplayer-presence.md):
 * declared by the page itself — Messages its conversation, Drive its file or
 * folder — never guessed from the address or the text. The nucleus layout
 * owns one keeper, puts its item into every heartbeat's `where` and beats at
 * once when it changes (`changed`).
 */
export class PresenceFocus {
  #item = $state<WhereItem | null>(null)

  constructor(private readonly changed: () => void) {}

  get item(): WhereItem | null {
    return this.#item
  }

  set(item: WhereItem | null): void {
    const now = this.#item
    if (now === item || (now && item && now.kind === item.kind && now.id === item.id)) return
    this.#item = item ? { kind: item.kind, id: item.id } : null
    this.changed()
  }
}

const KEY = Symbol('presence-focus')

export function setPresenceFocus(focus: PresenceFocus): PresenceFocus {
  return setContext(KEY, focus)
}

/** The layout's focus keeper; pages call it while they initialise. */
export function getPresenceFocus(): PresenceFocus {
  const focus = getContext<PresenceFocus | undefined>(KEY)
  if (!focus) throw new Error('presence: no focus keeper — getPresenceFocus() works only under the nucleus layout')
  return focus
}

/**
 * For a page whose open item comes from its data (a Drive file or folder):
 * declared after every navigation to it — the same page component stays
 * mounted from one file to the next — and cleared when the page goes.
 * Call while the page initialises.
 */
export function declarePresenceFocus(read: () => WhereItem | null): void {
  const focus = getPresenceFocus()
  afterNavigate(() => focus.set(read()))
  onDestroy(() => focus.set(null))
}
