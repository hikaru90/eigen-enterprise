import type { AssistantAttachment } from './attachments'
import type { AssistantTab } from './types'
import { AssistantChat, type AssistantChatDeps } from './assistant-chat.svelte'
import { ComposerAttachments } from './composer-attachments.svelte'
import { takePendingHandoff } from './handoff'
import {
  PANEL_DEFAULT_WIDTH,
  clampPanelWidth,
  readPanelWidth,
  writePanelWidth,
} from './panel-width'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** The composer while it holds a sent message for editing (board a950ef11). */
export type ComposerEdit = {
  /** The transcript entry being edited (AssistantChat.editableKey). */
  key: string
  /** Files the message carried that this browser no longer holds (a reloaded message): attach them again. */
  missingFiles: string[]
  /** What the composer held before: Cancel gives it back. */
  stash: { draft: string; attachments: AssistantAttachment[] }
}

export type AssistantDeps = AssistantChatDeps & {
  /** Where the panel width is remembered (per browser; may throw). */
  storage: () => StorageLike
  /** The window's width, for the 60% cap. */
  viewportWidth: () => number
}

/**
 * The one assistant (polish P-1): the shell's top bar ("Ask the company brain…",
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
  /** Set while the composer holds a sent message for editing; sending then replaces that turn. */
  editing = $state<ComposerEdit | null>(null)

  readonly chat: AssistantChat
  /** Files waiting in the panel composer (they survive closing the panel, like the draft). */
  readonly attachments: ComposerAttachments
  readonly fetch: typeof globalThis.fetch

  /** Registered by the bar / the panel composer when they mount. */
  barInput: HTMLInputElement | null = null
  composerInput: HTMLInputElement | null = null

  #deps: AssistantDeps

  constructor(deps: AssistantDeps) {
    this.#deps = deps
    this.fetch = deps.fetch
    this.chat = new AssistantChat(deps)
    this.attachments = new ComposerAttachments(deps.fetch)
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
  ask(text: string, attachments: AssistantAttachment[] = []): void {
    if (!text.trim() && attachments.length === 0) return
    // A new message from the top bar ends an edit: the edited one is no longer the latest.
    if (this.editing) this.cancelEdit()
    this.openPanel('chat')
    void this.chat.send(text, attachments)
  }

  /** The panel composer's send: the edited message replaces its turn, else a new message. */
  submitComposer(text: string, attachments: AssistantAttachment[] = []): void {
    const edit = this.editing
    if (!edit) {
      this.ask(text, attachments)
      return
    }
    if (!text.trim() && attachments.length === 0) return
    this.editing = null
    void this.chat.resend(edit.key, text, attachments).then((outcome) => {
      // Refused: the conversation is as it was, and the edited words wait in the composer.
      if (outcome === 'refused') {
        this.draft = text
        this.attachments.restore(attachments)
      }
    })
  }

  /**
   * Edit (board a950ef11): the person's latest message goes back into the
   * composer — its words and the files it carried — to change and send again.
   */
  startEdit(key: string): void {
    if (this.chat.editableKey !== key) return
    const entry = this.chat.entries.find((e) => e.key === key)
    if (!entry || entry.role !== 'user') return
    const stash = this.editing?.stash ?? { draft: this.draft, attachments: this.attachments.ready }
    const files = this.chat.sentFilesOf(key)
    this.draft = entry.content
    this.attachments.restore(files ?? [])
    this.editing = {
      key,
      missingFiles: files ? [] : (entry.attachments ?? []).map((file) => file.name),
      stash,
    }
    this.openPanel('chat')
    queueMicrotask(() => this.composerInput?.focus())
  }

  /** Leave the edit: the composer gets back what it held before. */
  cancelEdit(): void {
    const edit = this.editing
    if (!edit) return
    this.editing = null
    this.draft = edit.stash.draft
    this.attachments.restore(edit.stash.attachments)
  }

  /** A fresh chat session; the composer is ready for its first message. */
  newConversation(): void {
    this.editing = null
    this.chat.reset()
    this.draft = ''
    this.attachments.clear()
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
