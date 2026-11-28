import type { AssistantAttachment } from './attachments'
import type { ApprovalModeState, AssistantConversation } from './types'
import { ArtifactPanel } from './artifact-panel-state.svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { AiUsageToday } from '$lib/ai-usage/usage'
import {
  ApprovalRequestFailed,
  postApprovalDecision,
  type ApprovalDecision,
} from '$lib/chat/approvals-client'
import { sanitizeFinalAnswerText, TURN_NOT_EDITABLE_MESSAGE } from '$lib/chat/chat-stream-types'
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
  withRunningStepsStopped,
  withToolStepFinished,
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
  | {
      message: string
      attachments?: AssistantAttachment[]
      sessionId?: string
      /** Edit-and-resend: the stored message this one replaces (with everything after it). */
      replacesMessageId?: string
    }
  | { bootstrap: true; onboardingHandoff: true; sessionId?: string }
  | { bootstrap: true; approvalContinuation: string; sessionId?: string }

export type ConversationLoad = 'idle' | 'loading' | 'ready' | 'failed'

/** How an edited message went: sent, refused (the conversation stays as it was), or the turn failed. */
export type ResendOutcome = 'sent' | 'refused' | 'failed'

/** A stream's member turn: its entry (to name it once accepted) and, for an edit, what it replaced. */
type StreamTurn = {
  userKey: string
  replaced?: { at: number; entries: NucleusChatEntry[] }
}

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
  /**
   * The person's AI use today against the daily cap (GET /api/assistant/usage →
   * settings.my_ai_usage): null until read; read again after every reply.
   */
  usage = $state<AiUsageToday | null>(null)
  /** The last usage read failed (the meter says so instead of showing a stale amount). */
  usageFailed = $state(false)

  /** The artifact the assistant created or changed, open beside the chat (plan/phase-artifacts.md). */
  readonly artifact: ArtifactPanel

  /** The view's hook for keeping the newest line in view (no effect needed). */
  onchange: (() => void) | null = null

  #deps: AssistantChatDeps
  #seq = 0
  /**
   * The read files each message of this session carried (by entry key), so
   * Edit can give them back. Browser memory only: the stored turn keeps only
   * name, kind and size, so a reloaded message comes back without them.
   */
  #sentFiles = new SvelteMap<string, AssistantAttachment[]>()
  #abort: AbortController | null = null
  #loading: Promise<void> | null = null

  constructor(deps: AssistantChatDeps) {
    this.#deps = deps
    this.artifact = new ArtifactPanel(deps.fetch)
  }

  #changed(): void {
    this.onchange?.()
  }

  #append(turn: NucleusTurn | null): string | null {
    if (!turn) return null
    this.#seq += 1
    const key = `assistant-${this.#seq}`
    this.entries.push({ ...turn, key })
    this.#changed()
    return key
  }

  /**
   * The entry key of the one message Edit is offered on: the person's latest
   * message, once the server stored it, while no reply runs, and not after an
   * approval card (the decision is on record; a new message is the way on).
   */
  get editableKey(): string | null {
    if (this.busy || this.decidingId) return null
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!
      if (entry.role === 'approval') return null
      if (entry.role === 'user') return entry.messageId ? entry.key : null
    }
    return null
  }

  /** The read files a message of this session carried (null: not kept, e.g. after a reload). */
  sentFilesOf(key: string): AssistantAttachment[] | null {
    return this.#sentFiles.get(key) ?? null
  }

  /** Read the person's AI use today (the meter); a failure is shown, never a stale amount. */
  async refreshUsage(): Promise<void> {
    try {
      const res = await this.#deps.fetch('/api/assistant/usage', { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`usage read failed: HTTP ${res.status}`)
      this.usage = (await res.json()) as AiUsageToday
      this.usageFailed = false
    } catch (err) {
      console.error('[assistant] usage read failed', err)
      this.usage = null
      this.usageFailed = true
    }
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
      void this.refreshUsage()
    } catch (err) {
      console.error('[assistant] conversation load failed', err)
      this.load = 'failed'
    }
  }

  /**
   * Send one member message (the top bar and the panel composer both end here). Attached
   * files (already read) go with it; a message may be files alone.
   */
  async send(text: string, attachments: AssistantAttachment[] = []): Promise<void> {
    const message = text.trim()
    if ((!message && attachments.length === 0) || this.busy) return
    this.#deps.cancelSpeak()
    await this.ensureLoaded()
    const userKey = this.#appendMemberTurn(message, attachments)
    await this.#stream(attachments.length > 0 ? { message, attachments } : { message }, { userKey })
  }

  /**
   * Edit-and-resend (board a950ef11): the edited words replace the message
   * `key` names and everything after it (a stopped or finished reply) — here
   * and, on the server, in what the model sees — then the request runs again.
   * A refusal (the message is no longer editable) puts the conversation back.
   */
  async resend(key: string, text: string, attachments: AssistantAttachment[] = []): Promise<ResendOutcome> {
    const message = text.trim()
    if ((!message && attachments.length === 0) || this.busy) return 'refused'
    const at = this.entries.findIndex((e) => e.key === key)
    const target = this.entries[at]
    if (this.editableKey !== key || !target || target.role !== 'user' || !target.messageId) {
      this.#append(failedTurn(TURN_NOT_EDITABLE_MESSAGE))
      return 'refused'
    }
    this.#deps.cancelSpeak()
    const replaced = { at, entries: this.entries.slice(at) }
    this.entries = this.entries.slice(0, at)
    const userKey = this.#appendMemberTurn(message, attachments)
    const body = {
      message,
      ...(attachments.length > 0 ? { attachments } : {}),
      replacesMessageId: target.messageId,
    }
    return this.#stream(body, { userKey, replaced })
  }

  #appendMemberTurn(message: string, attachments: AssistantAttachment[]): string {
    const key = this.#append(
      userTurn(
        message,
        attachments.map(({ name, kind, sizeBytes }) => ({ name, kind, sizeBytes })),
      ),
    )!
    if (attachments.length > 0) this.#sentFiles.set(key, attachments)
    return key
  }

  /** The server stored the member turn: name its entry, and continue its session. */
  #accepted(userKey: string, event: { sessionId: string; messageId: string }): void {
    this.sessionId = event.sessionId
    const entry = this.entries.find((e) => e.key === userKey)
    if (entry && entry.role === 'user') entry.messageId = event.messageId
    this.#changed()
  }

  /** A refused edit: the edited entry leaves, the replaced turn comes back, the refusal is said. */
  #restoreReplaced(userKey: string, replaced: NonNullable<StreamTurn['replaced']>): void {
    this.#sentFiles.delete(userKey)
    this.entries = [...this.entries.filter((e) => e.key !== userKey), ...replaced.entries]
    this.#append(failedTurn(TURN_NOT_EDITABLE_MESSAGE))
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
    this.#sentFiles.clear()
    this.sessionId = null
    this.status = null
    this.approvalErrors = {}
    this.artifact.close()
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

  async #stream(request: ChatRequestBody, turn?: StreamTurn): Promise<ResendOutcome> {
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
      if (res.status === 409 && turn?.replaced && generation === this.generation) {
        // The edit was refused before anything changed on the server.
        console.error('[assistant] edit refused: HTTP 409')
        this.#restoreReplaced(turn.userKey, turn.replaced)
        return 'refused'
      }
      // The status/body are for the console only — never rendered to the user.
      if (!res.ok) throw new Error(`chat request failed: HTTP ${res.status}`)

      let answerPreview: string | undefined
      const done = await consumeChatNdjsonStream(
        res,
        (event) => {
          if (event.type === 'turn.accepted') {
            if (turn && generation === this.generation) this.#accepted(turn.userKey, event)
            return
          }
          if (event.type === 'tool_result' && event.tool === 'answer_question') {
            answerPreview = event.preview
          }
          if (event.type === 'tool.finished') {
            if (generation === this.generation) {
              this.entries = withToolStepFinished(this.entries, event)
              // An artifact the assistant wrote opens beside the chat (again after each change).
              if (event.artifact) void this.artifact.show(event.artifact.fileId)
              this.#changed()
            }
            return
          }
          this.#append(nucleusTurnForProgressEvent(event))
          this.status = statusLabelForProgressEvent(event)
          this.#changed()
        },
        ac.signal,
      )

      const responseText = sanitizeFinalAnswerText(done.response ?? '', answerPreview)
      if (generation !== this.generation) return 'failed'
      if (done.sessionId) this.sessionId = done.sessionId
      const reply = assistantTurnFromResponse(responseText, done.usage)
      if (reply) {
        this.#deps.speak(reply.content)
        this.#append(reply)
      }
      return 'sent'
    } catch (err) {
      if (generation !== this.generation) return 'failed'
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
      return 'failed'
    } finally {
      if (generation === this.generation) {
        this.entries = withRunningStepsStopped(this.entries)
        // Every reply (finished, stopped or failed) may have cost something: read the meter again.
        void this.refreshUsage()
      }
      if (this.#abort === ac) {
        this.busy = false
        this.status = null
        this.#abort = null
      }
      this.#changed()
    }
  }
}
