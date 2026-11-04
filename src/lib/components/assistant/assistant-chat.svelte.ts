import type { ApprovalModeState, AssistantConversation } from './types'
import {
  ApprovalRequestFailed,
  postApprovalDecision,
  type ApprovalDecision,
} from '$lib/chat/approvals-client'
import { sanitizeFinalAnswerText } from '$lib/chat/chat-stream-types'
import {
  chatFailureMessage,
  consumeChatNdjsonStream,
  ChatStreamError,
} from '$lib/chat/consume-chat-ndjson'
import {
  assistantTurnFromResponse,
  failedTurn,
  nucleusTurnForProgressEvent,
  statusLabelForProgressEvent,
  userTurn,
  withApprovalStatus,
  type NucleusChatEntry,
  type NucleusTurn,
} from './nucleus-chat'

export type AssistantChatDeps = {
  fetch: typeof globalThis.fetch
  /** The assistant's voice (gateway TTS); cancelSpeak stops it. */
  speak: (markdown: string) => void
  cancelSpeak: () => void
}

type ChatRequestBody =
  | { message: string; sessionId?: string }
  | { bootstrap: true; onboardingHandoff: true; sessionId?: string }
  | { bootstrap: true; approvalContinuation: string; sessionId?: string }

export type ConversationLoad = 'idle' | 'loading' | 'ready' | 'failed'

/**
 * The company agent's chat (moved from `/` into the assistant panel, polish
 * P-1; behavior unchanged): the current conversation restored from Postgres,
 * streamed turns over POST /api/chat (NDJSON), approval cards decided in
 * place with a continuation turn, stop, and the onboarding hand-off greeting.
 * Lives in the shell, so it survives client-side navigation.
 */
export class AssistantChat {
  entries = $state<NucleusChatEntry[]>([])
  sessionId = $state<string | null>(null)
  busy = $state(false)
  status = $state<string | null>(null)
  load = $state<ConversationLoad>('idle')
  /** null until the conversation loaded; false = the panel shows the provider setup. */
  providerReady = $state<boolean | null>(null)
  isAdmin = $state(false)
  approvalMode = $state<ApprovalModeState | null>(null)
  decidingId = $state<string | null>(null)
  approvalErrors = $state<Record<string, string>>({})
  /** Bumped on "New conversation": the view remounts its composer state. */
  generation = $state(0)

  /** The view's hook for keeping the newest line in view (no effect needed). */
  onchange: (() => void) | null = null

  #deps: AssistantChatDeps
  #seq = 0
  #abort: AbortController | null = null
  #loading: Promise<void> | null = null

  constructor(deps: AssistantChatDeps) {
    this.#deps = deps
  }

  #changed(): void {
    this.onchange?.()
  }

  #append(turn: NucleusTurn | null): void {
    if (!turn) return
    this.#seq += 1
    this.entries.push({ ...turn, key: `assistant-${this.#seq}` })
    this.#changed()
  }

  /** Load the current conversation once (first open); later calls wait for it. */
  ensureLoaded(): Promise<void> {
    if (this.load === 'ready') return Promise.resolve()
    if (this.#loading) return this.#loading
    this.#loading = this.#fetchConversation().finally(() => {
      this.#loading = null
    })
    return this.#loading
  }

  /** Retry after a failed load. */
  reload(): Promise<void> {
    this.load = 'idle'
    return this.ensureLoaded()
  }

  async #fetchConversation(): Promise<void> {
    this.load = 'loading'
    try {
      const res = await this.#deps.fetch('/api/assistant/conversation', {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`conversation load failed: HTTP ${res.status}`)
      const body = (await res.json()) as AssistantConversation
      // Live turns that arrived before the load finished stay after the saved ones.
      const live = this.entries
      this.entries = []
      for (const turn of body.turns) this.#append(turn)
      for (const entry of live) this.entries.push(entry)
      // A session started meanwhile (live turn) wins over the stored one.
      this.sessionId = this.sessionId ?? body.sessionId
      this.providerReady = body.providerReady
      this.isAdmin = body.isAdmin
      this.approvalMode = body.approvalMode
      this.load = 'ready'
      this.#changed()
    } catch (err) {
      console.error('[assistant] conversation load failed', err)
      this.load = 'failed'
    }
  }

  /** Send one member message (the top bar and the panel composer both end here). */
  async send(text: string): Promise<void> {
    const message = text.trim()
    if (!message || this.busy) return
    this.#deps.cancelSpeak()
    await this.ensureLoaded()
    this.#append(userTurn(message))
    await this.#stream({ message })
  }

  /** The agent's first turn after the scripted onboarding (no member speech). */
  async startHandoff(): Promise<void> {
    await this.ensureLoaded()
    await this.#stream({ bootstrap: true, onboardingHandoff: true })
  }

  /** A fresh chat session: the next message starts a new conversation. */
  reset(): void {
    this.stop()
    this.entries = []
    this.sessionId = null
    this.status = null
    this.approvalErrors = {}
    this.generation += 1
    this.#changed()
  }

  stop(): void {
    this.#deps.cancelSpeak()
    this.#abort?.abort()
  }

  /**
   * Approval cards: the owner decides in place; the agent then gets a
   * continuation turn and re-runs (or drops) the gated step.
   */
  async decideApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (this.busy || this.decidingId) return
    this.decidingId = approvalId
    this.approvalErrors = { ...this.approvalErrors, [approvalId]: '' }
    try {
      const decided = await postApprovalDecision(this.#deps.fetch, approvalId, decision)
      this.entries = withApprovalStatus(this.entries, approvalId, decided.status)
    } catch (err) {
      console.error('[assistant] approval decision failed', err)
      // Fixed words only — never the server's text.
      this.approvalErrors = {
        ...this.approvalErrors,
        [approvalId]:
          err instanceof ApprovalRequestFailed && err.status === 409
            ? 'This request was already decided.'
            : 'That did not go through. Please try again.',
      }
      return
    } finally {
      this.decidingId = null
    }
    await this.#stream({ bootstrap: true, approvalContinuation: approvalId })
  }

  async #stream(request: ChatRequestBody): Promise<void> {
    this.busy = true
    this.status = null
    this.#changed()
    const body: ChatRequestBody = this.sessionId
      ? { ...request, sessionId: this.sessionId }
      : request
    const ac = new AbortController()
    this.#abort = ac
    // A "New conversation" while this turn streams must not adopt its session.
    const generation = this.generation

    try {
      const res = await this.#deps.fetch('/api/chat', {
        signal: ac.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(body),
      })
      // The status/body are for the console only — never rendered to the user.
      if (!res.ok) throw new Error(`chat request failed: HTTP ${res.status}`)

      let answerPreview: string | undefined
      const done = await consumeChatNdjsonStream(
        res,
        (event) => {
          if (event.type === 'tool_result' && event.tool === 'answer_question') {
            answerPreview = event.preview
          }
          this.#append(nucleusTurnForProgressEvent(event))
          this.status = statusLabelForProgressEvent(event)
          this.#changed()
        },
        ac.signal,
      )

      const responseText = sanitizeFinalAnswerText(done.response ?? '', answerPreview)
      if (generation !== this.generation) return
      if (done.sessionId) this.sessionId = done.sessionId
      const turn = assistantTurnFromResponse(responseText)
      if (turn) {
        this.#deps.speak(turn.content)
        this.#append(turn)
      }
    } catch (err) {
      if (generation !== this.generation) return
      if ((err as Error)?.name === 'AbortError') {
        this.#append(failedTurn('Stopped.'))
      } else {
        console.error('[assistant] chat stream failed', err)
        // No raw error text reaches the user (code <-> harness <-> user).
        const message = chatFailureMessage(err)
        // Missing provider configuration gets a door, not just a wall: link to setup.
        const notConfigured = err instanceof ChatStreamError && err.code === 'llm_not_configured'
        if (notConfigured) this.providerReady = false
        this.#append(failedTurn(message, notConfigured ? { providerSetup: true } : undefined))
      }
    } finally {
      if (this.#abort === ac) {
        this.busy = false
        this.status = null
        this.#abort = null
      }
      this.#changed()
    }
  }
}
