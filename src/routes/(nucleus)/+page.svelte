<script lang="ts">
  import type { PageProps } from './$types'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal'
  import Square from '@lucide/svelte/icons/square'
  import { onMount } from 'svelte'
  import { browser } from '$app/environment'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'

  let { data }: PageProps = $props()
  import { sanitizeFinalAnswerText } from '$lib/chat/chat-stream-types'
  import {
    chatFailureMessage,
    consumeChatNdjsonStream,
    ChatStreamError,
  } from '$lib/chat/consume-chat-ndjson'
  import {
    ApprovalRequestFailed,
    postApprovalDecision,
    putApprovalMode,
    type ApprovalDecision,
  } from '$lib/chat/approvals-client'
  import ApprovalCard from '$lib/components/approval-card.svelte'
  import ApprovalModeSelect from '$lib/components/approval-mode-select.svelte'
  import ChatMarkdown from '$lib/components/chat-markdown.svelte'
  import HomeSettingsMenu from '$lib/components/home-settings-menu.svelte'
  import ProviderOnboarding from '$lib/components/provider-onboarding.svelte'
  import { Button } from '$lib/components/ui/button'
  import VoiceInputButton from '$lib/components/voice-input-button.svelte'
  import WelcomeWizard from '$lib/components/welcome-wizard.svelte'
  import { cancelSpeak, speak } from '$lib/speech/tts'
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
  import { docTitle } from '$lib/shell/title'

  let entrySeq = 0

  // Restored from the server load (chat_message in Postgres): the saved transcript
  // and the session new turns continue. Seeded once per mount; live turns append.
  function restoredEntries(): NucleusChatEntry[] {
    return data.chatHistory.map((turn) => {
      entrySeq += 1
      return { ...turn, key: `nucleus-${entrySeq}` }
    })
  }
  function restoredSessionId(): string | null {
    return data.chatSessionId
  }

  let entries = $state<NucleusChatEntry[]>(restoredEntries())
  const chatMode = $derived(!data.showWelcome && !data.needsOnboarding)
  let input = $state('')
  let busy = $state(false)
  let status = $state<string | null>(null)
  let sessionId = $state<string | null>(restoredSessionId())
  let abortController: AbortController | null = null
  const HANDOFF_PENDING_KEY = 'ee.onboarding-handoff-pending'
  let handoffPendingInMemory = false

  /**
   * Assisted onboarding: when the scripted first run ends, the orchestrator
   * AGENT takes over — its first turn is generated server-side from the
   * onboarding context (POST /api/chat, onboardingHandoff), not scripted here.
   * Explicit event from the wizard; no prop-watching.
   */
  function handleOnboardingComplete(): void {
    // Website already under way (e.g. opened earlier): the chat simply continues it.
    if (!data.handoffAvailable) return
    // The wizard reloads page data right after this (welcome stamp); the swap
    // into the chat shell can remount this page, which killed an in-flight
    // greeting request (the owner saw nothing, and their next message hit the
    // still-running turn). The hand-off starts once the chat is up: here when
    // this instance survives (onentered), else in the new instance's onMount.
    markHandoffPending()
  }

  function markHandoffPending(): void {
    try {
      sessionStorage.setItem(HANDOFF_PENDING_KEY, '1')
    } catch {
      handoffPendingInMemory = true
    }
  }

  /** Exactly once: whoever takes the pending flag starts the greeting. */
  function startPendingHandoff(): void {
    let pending = handoffPendingInMemory
    handoffPendingInMemory = false
    try {
      if (sessionStorage.getItem(HANDOFF_PENDING_KEY) === '1') {
        sessionStorage.removeItem(HANDOFF_PENDING_KEY)
        pending = true
      }
    } catch {
      // storage unavailable: the in-memory flag decides
    }
    if (pending) void sendStreaming({ bootstrap: true, onboardingHandoff: true })
  }

  onMount(() => {
    if (chatMode) startPendingHandoff()
  })

  let inputEl = $state<HTMLInputElement | undefined>(undefined)
  let transcriptEl = $state<HTMLDivElement | undefined>(undefined)
  let voiceStopFn = $state<(() => void) | undefined>(undefined)

  const micSupported = $derived(
    browser &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined',
  )

  function scrollToBottom() {
    const el = transcriptEl
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
    })
  }

  function appendEntry(turn: NucleusTurn | null) {
    if (!turn) return
    entrySeq += 1
    entries.push({ ...turn, key: `nucleus-${entrySeq}` })
    scrollToBottom()
  }

  type ChatRequestBody =
    | { message: string; sessionId?: string }
    | { bootstrap: true; onboardingHandoff: true; sessionId?: string }
    | { bootstrap: true; approvalContinuation: string; sessionId?: string }

  async function sendStreaming(request: ChatRequestBody) {
    busy = true
    status = null
    scrollToBottom()

    const body: ChatRequestBody = sessionId ? { ...request, sessionId } : request

    const ac = new AbortController()
    abortController = ac

    try {
      const res = await fetch('/api/chat', {
        signal: ac.signal,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        // The status/body are for the console only — never rendered to the user.
        throw new Error(`chat request failed: HTTP ${res.status}`)
      }

      let answerPreview: string | undefined
      const done = await consumeChatNdjsonStream(
        res,
        (event) => {
          if (event.type === 'tool_result' && event.tool === 'answer_question') {
            answerPreview = event.preview
          }
          const turn = nucleusTurnForProgressEvent(event)
          if (turn) appendEntry(turn)
          status = statusLabelForProgressEvent(event)
          // Streamed content keeps the newest line in view.
          scrollToBottom()
        },
        ac.signal,
      )

      const responseText = sanitizeFinalAnswerText(done.response ?? '', answerPreview)
      if (done.sessionId) sessionId = done.sessionId
      const turn = assistantTurnFromResponse(responseText)
      if (turn) {
        speak(turn.content)
        appendEntry(turn)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        appendEntry(failedTurn('Stopped.'))
      } else {
        console.error('[nucleus] chat stream failed', err)
        // No raw error text reaches the user (code <-> harness <-> user).
        const message = chatFailureMessage(err)
        // Missing provider configuration gets a door, not just a wall: link to setup.
        const providerSetup =
          err instanceof ChatStreamError && err.code === 'llm_not_configured'
            ? (true as const)
            : undefined
        appendEntry(failedTurn(message, { providerSetup }))
      }
    } finally {
      busy = false
      status = null
      abortController = null
      scrollToBottom()
    }
  }

  function send() {
    const text = input.trim()
    if (!text || busy) return

    cancelSpeak()
    voiceStopFn?.()
    input = ''
    appendEntry(userTurn(text))
    void sendStreaming({ message: text })
  }

  // Approval cards: the owner decides in place; the agent then gets a
  // continuation turn and re-runs (or drops) the gated step.
  let decidingId = $state<string | null>(null)
  let approvalErrors = $state<Record<string, string>>({})

  async function decideApproval(approvalId: string, decision: ApprovalDecision) {
    if (busy || decidingId) return
    decidingId = approvalId
    approvalErrors = { ...approvalErrors, [approvalId]: '' }
    try {
      const decided = await postApprovalDecision(fetch, approvalId, decision)
      entries = withApprovalStatus(entries, approvalId, decided.status)
    } catch (err) {
      console.error('[nucleus] approval decision failed', err)
      // Fixed words only — never the server's text.
      approvalErrors = {
        ...approvalErrors,
        [approvalId]:
          err instanceof ApprovalRequestFailed && err.status === 409
            ? 'This request was already decided.'
            : 'That did not go through. Please try again.',
      }
      return
    } finally {
      decidingId = null
    }
    await sendStreaming({ bootstrap: true, approvalContinuation: approvalId })
  }

  function stop() {
    cancelSpeak()
    abortController?.abort()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function handleVoiceTranscript(text: string) {
    // Transcript fills the input (not auto-send): the user reviews the ASR
    // result and sends deliberately.
    input = input.trim() ? `${input.trimEnd()} ${text}` : text
  }

  onMount(() => {
    // Deep-linked draft (?prefill=, e.g. from the Apps "+" dialog): fill the
    // composer for the owner to review and send — never auto-send.
    const prefill = page.url.searchParams.get('prefill')
    if (prefill) {
      input = prefill
      history.replaceState(null, '', page.url.pathname)
    }
    inputEl?.focus()
    scrollToBottom()
  })
</script>

<svelte:head><title>{docTitle('Chat')}</title></svelte:head>

<!-- Chat: a full-viewport frame — header on top, the transcript is the ONLY
     scroll container, the input pinned at the bottom. The welcome wizard and
     provider gate keep the free-flowing page they were designed for. -->
<div
  class={chatMode
    ? 'mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col overflow-hidden px-4 sm:px-6'
    : 'flex min-h-dvh w-full flex-col px-4 sm:px-6 lg:px-10'}
>
  <!-- Welcome wizard and provider gate run without the app shell: they keep
       their own header with the settings cog. In chat the shell is the chrome. -->
  {#if !chatMode}
    <header class="relative flex shrink-0 justify-center pt-6 pb-2">
      <p class="text-sm font-semibold tracking-tight text-muted-foreground">eigenEnterprise</p>
      <div class="absolute top-5 right-0 flex items-center gap-3">
        <a
          href={resolve('/overview')}
          class="text-[11px] font-medium tracking-[0.2em] text-muted-foreground uppercase hover:text-foreground"
          data-testid="overview-link">Overview</a
        >
        <HomeSettingsMenu />
      </div>
    </header>
  {/if}

  {#if data.showWelcome}
    <!-- First open: the boot sequence leads; the provider step inside it stays a hard gate. -->
    <WelcomeWizard
      providerReady={!data.needsOnboarding}
      needsMail={data.needsMail}
      byokUiEnabled={data.byokUiEnabled}
      displayName={data.displayName}
      returnedFromProvider={data.returnedFromProvider}
      oncomplete={handleOnboardingComplete}
      onentered={startPendingHandoff}
    />
  {:else if data.needsOnboarding}
    <!-- Returning user whose tour is done but provider vanished: the connect gate again. -->
    <ProviderOnboarding byokUiEnabled={data.byokUiEnabled} />
  {:else}
    <main class="flex min-h-0 min-w-0 flex-1 flex-col">
      {#if entries.length === 0 && !busy}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-muted-foreground/70 text-base tracking-wide">What do you need?</p>
        </div>
      {:else}
        <div
          bind:this={transcriptEl}
          class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pt-4 pb-4"
          role="log"
          aria-label="Conversation"
          data-testid="nucleus-transcript"
        >
          {#each entries as entry (entry.key)}
            {#if entry.role === 'user'}
              <div class="flex w-full flex-row justify-end py-1.5">
                <div
                  class="max-w-[85%] min-w-0 rounded-sm bg-primary px-3.5 py-2 wrap-break-word text-primary-foreground"
                >
                  <ChatMarkdown content={entry.content} tone="user" />
                </div>
              </div>
            {:else if entry.role === 'assistant'}
              {#if entry.failed}
                <div class="py-1.5">
                  <p class="text-destructive text-sm leading-relaxed wrap-break-word">
                    {entry.content}
                  </p>
                  {#if entry.providerSetup}
                    <a
                      href={resolve('/settings/llm')}
                      class="text-destructive text-xs underline underline-offset-2"
                    >
                      Set up your AI provider →
                    </a>
                  {/if}
                </div>
              {:else}
                <div class="min-w-0 py-1.5 wrap-break-word">
                  <ChatMarkdown content={entry.content} />
                </div>
              {/if}
            {:else if entry.role === 'tool_preview'}
              <p class="text-muted-foreground truncate py-0.5 text-xs" data-testid="tool-preview">
                → using {entry.tool}{entry.inputSummary ? ` · ${entry.inputSummary}` : ''}…
              </p>
            {:else if entry.role === 'approval'}
              {@const approvalId = entry.approvalId}
              <ApprovalCard
                action={entry.action}
                tool={entry.tool}
                status={entry.status}
                canDecide={data.isAdmin && approvalId !== null}
                deciding={busy || (approvalId !== null && decidingId === approvalId)}
                error={approvalId ? approvalErrors[approvalId] || null : null}
                ondecide={(decision) => {
                  if (approvalId) void decideApproval(approvalId, decision)
                }}
              />
            {/if}
          {/each}

          {#if busy}
            <div class="flex items-center gap-2 px-1 pt-1 text-sm text-muted-foreground">
              <LoaderCircle class="size-3.5 shrink-0 animate-spin" strokeWidth={1.75} />
              <span class="min-w-0 truncate">{status ?? 'Working…'}</span>
            </div>
          {/if}
        </div>
      {/if}
    </main>

    <footer class="shrink-0 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div
        data-testid="nucleus-chatbox"
        class="flex items-stretch gap-2 rounded-sm border-2 border-primary bg-card p-2"
      >
        <div title={micSupported ? undefined : 'Voice input is not available in this browser'}>
          <VoiceInputButton
            language={(page.data as { preferredLanguage?: string }).preferredLanguage ?? 'en'}
            disabled={busy}
            bind:stopRef={voiceStopFn}
            ontranscript={handleVoiceTranscript}
            onerror={(message) => {
              console.error('[nucleus] voice input failed', message)
            }}
          />
        </div>
        <input
          bind:this={inputEl}
          bind:value={input}
          onkeydown={handleKeydown}
          placeholder="What do you need?"
          aria-label="Message"
          class="min-w-0 flex-1 border-0 bg-transparent px-2 text-base text-foreground shadow-none outline-none placeholder:text-muted-foreground"
          disabled={busy}
        />
        <Button
          type="button"
          onclick={busy ? stop : send}
          disabled={!busy && !input.trim()}
          aria-label={busy ? 'Stop' : 'Send'}
          class="bg-primary text-primary-foreground rounded-none px-4 hover:bg-primary/90"
        >
          {#if busy}
            <Square class="size-4 shrink-0" strokeWidth={1.75} />
          {:else}
            <SendHorizontal class="size-4 shrink-0" strokeWidth={1.75} />
          {/if}
        </Button>
      </div>
      {#if data.isAdmin && data.approvalMode}
        <div class="mt-2 px-1">
          <ApprovalModeSelect
            mode={data.approvalMode.status === 'ok' ? data.approvalMode.mode : null}
            save={(mode) => putApprovalMode(fetch, mode)}
          />
        </div>
      {/if}
    </footer>
  {/if}
</div>
