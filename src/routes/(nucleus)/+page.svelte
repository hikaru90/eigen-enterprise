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
  import { consumeChatNdjsonStream, ChatStreamError } from '$lib/chat/consume-chat-ndjson'
  import ChatMarkdown from '$lib/components/chat-markdown.svelte'
  import ProviderOnboarding from '$lib/components/provider-onboarding.svelte'
  import { Button } from '$lib/components/ui/button'
  import VoiceInputButton from '$lib/components/voice-input-button.svelte'
  import {
    assistantTurnFromResponse,
    failedTurn,
    nucleusTurnForProgressEvent,
    statusLabelForProgressEvent,
    userTurn,
    type NucleusChatEntry,
    type NucleusTurn,
  } from './nucleus-chat'

  let entries = $state<NucleusChatEntry[]>([])
  let input = $state('')
  let busy = $state(false)
  let status = $state<string | null>(null)
  let sessionId = $state<string | null>(null)
  let abortController: AbortController | null = null

  let inputEl = $state<HTMLInputElement | undefined>(undefined)
  let transcriptEl = $state<HTMLDivElement | undefined>(undefined)
  let voiceStopFn = $state<(() => void) | undefined>(undefined)

  let entrySeq = 0

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

  async function sendStreaming(text: string) {
    busy = true
    status = null
    scrollToBottom()

    const body: { message: string; sessionId?: string } = { message: text }
    if (sessionId) body.sessionId = sessionId

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
        const errBody = await res.json().catch(() => null)
        throw new Error(errBody?.message ?? `HTTP ${res.status}`)
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
        },
        ac.signal,
      )

      const responseText = sanitizeFinalAnswerText(done.response ?? '', answerPreview)
      if (done.sessionId) sessionId = done.sessionId
      appendEntry(assistantTurnFromResponse(responseText))
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        appendEntry(failedTurn('Stopped.'))
      } else {
        console.error('[nucleus] chat stream failed', err)
        const message = `Error: ${err instanceof Error ? err.message : String(err)}`
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

    voiceStopFn?.()
    input = ''
    appendEntry(userTurn(text))
    void sendStreaming(text)
  }

  function stop() {
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
    inputEl?.focus()
  })
</script>

<div class="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4">
  {#if data.needsOnboarding}
    <ProviderOnboarding byokUiEnabled={data.byokUiEnabled} />
  {:else}
  <header class="flex justify-center pt-6">
    <p class="text-[11px] font-medium tracking-[0.25em] text-muted-foreground uppercase">
      Eigen Enterprise
    </p>
  </header>

  <main class="flex min-h-0 flex-1 flex-col">
    {#if entries.length === 0 && !busy}
      <div class="flex flex-1 items-center justify-center">
        <p class="text-muted-foreground/70 text-base tracking-wide">What do you need?</p>
      </div>
    {:else}
      <div
        bind:this={transcriptEl}
        class="min-h-0 flex-1 overflow-y-auto px-1 pt-6 pb-4"
        role="log"
        aria-label="Conversation"
      >
        {#each entries as entry (entry.key)}
          {#if entry.role === 'user'}
            <div class="flex w-full flex-row justify-end py-1.5">
              <div class="max-w-[85%] rounded-sm bg-foreground px-3.5 py-2 text-background">
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
              <div class="py-1.5">
                <ChatMarkdown content={entry.content} />
              </div>
            {/if}
          {:else if entry.role === 'tool_preview'}
            <p class="text-muted-foreground py-0.5 text-xs" data-testid="tool-preview">
              → using {entry.tool}{entry.inputSummary ? ` · ${entry.inputSummary}` : ''}…
            </p>
          {:else if entry.role === 'approval'}
            <div
              class="border-foreground/30 bg-muted/40 my-2 rounded-sm border border-dashed px-3 py-2"
              data-testid="approval-card"
            >
              <p class="text-sm font-medium">Needs your approval — pending</p>
              <p class="text-muted-foreground text-xs">
                {entry.tool} is queued for an owner decision. It has not run.
              </p>
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if busy}
      <div class="flex items-center gap-2 px-1 pb-2 text-sm text-muted-foreground">
        <LoaderCircle class="size-3.5 shrink-0 animate-spin" strokeWidth={1.75} />
        <span class="min-w-0 truncate">{status ?? 'Working…'}</span>
      </div>
    {/if}
  </main>

  <footer class="shrink-0 pb-6">
    <div
      data-testid="nucleus-chatbox"
      class="flex items-stretch gap-2 rounded-sm border-2 border-black bg-white p-2"
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
        class="bg-black text-white rounded-none px-4 hover:bg-black/90"
      >
        {#if busy}
          <Square class="size-4 shrink-0" strokeWidth={1.75} />
        {:else}
          <SendHorizontal class="size-4 shrink-0" strokeWidth={1.75} />
        {/if}
      </Button>
    </div>
  </footer>
  {/if}
</div>
