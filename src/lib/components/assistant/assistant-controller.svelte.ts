import type { AssistantTab } from './types'
import { AssistantChat, type AssistantChatDeps } from './assistant-chat.svelte'
import { takePendingHandoff } from './handoff'
import {
  PANEL_DEFAULT_WIDTH,
  clampPanelWidth,
  readPanelWidth,
  writePanelWidth,
} from './panel-width'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export type AssistantDeps = AssistantChatDeps & {
  /** Where the panel width is remembered (per browser; may throw). */
  storage: () => StorageLike
  /** The window's width, for the 60% cap. */
  viewportWidth: () => number
}

/**
 * The one assistant (polish P-1): the shell's top bar ("Ask the assistant…",
 * ⌘K) and the panel on the right of every signed-in page share this state.
 * Explicit methods only — the bar, the panel and pages (dashboard, run list)
 * call them from their own event handlers.
 */
export class AssistantController {
  open = $state(false)
  tab = $state<AssistantTab>('chat')
  width = $state(PANEL_DEFAULT_WIDTH)
  /** The panel composer's draft (prefill lands here, never auto-sent). */
  draft = $state('')

  readonly chat: AssistantChat
  readonly fetch: typeof globalThis.fetch

  /** Registered by the bar / the panel composer when they mount. */
  barInput: HTMLInputElement | null = null
  composerInput: HTMLInputElement | null = null

  #deps: AssistantDeps

  constructor(deps: AssistantDeps) {
    this.#deps = deps
    this.fetch = deps.fetch
    this.chat = new AssistantChat(deps)
    const remembered = readPanelWidth(deps.storage)
    if (remembered !== null) this.width = clampPanelWidth(remembered, deps.viewportWidth())
  }

  /** ⌘K / Ctrl+K: into the top bar's input from anywhere. */
  focusBar(): void {
    this.barInput?.focus()
    this.barInput?.select()
  }

  openPanel(tab: AssistantTab = this.tab): void {
    this.tab = tab
    this.open = true
    void this.chat.ensureLoaded()
  }

  close(): void {
    this.open = false
  }

  toggle(): void {
    if (this.open) this.close()
    else this.openPanel()
  }

  selectTab(tab: AssistantTab): void {
    this.tab = tab
  }

  /** Submit from the top bar or the panel composer: the panel opens on the chat. */
  ask(text: string): void {
    if (!text.trim()) return
    this.openPanel('chat')
    void this.chat.send(text)
  }

  /** A fresh chat session; the composer is ready for its first message. */
  newConversation(): void {
    this.chat.reset()
    this.draft = ''
    this.openPanel('chat')
    queueMicrotask(() => this.composerInput?.focus())
  }

  /** A deep-linked draft (?prefill=): it waits in the composer for the member to send. */
  prefill(text: string): void {
    this.draft = text
    this.openPanel('chat')
    queueMicrotask(() => this.composerInput?.focus())
  }

  /** While dragging: follow the pointer within the bounds. */
  resizeTo(width: number): void {
    this.width = clampPanelWidth(width, this.#deps.viewportWidth())
  }

  /** At the end of a drag (or a keyboard step): remember the width. */
  commitWidth(): void {
    writePanelWidth(this.#deps.storage, this.width)
  }

  /** The onboarding hand-off (handoff.ts): the greeting streams into the opened panel. */
  startPendingHandoff(): void {
    if (!takePendingHandoff()) return
    this.openPanel('chat')
    void this.chat.startHandoff()
  }
}
