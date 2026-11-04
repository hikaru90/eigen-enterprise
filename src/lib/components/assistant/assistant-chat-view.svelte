<script lang="ts">
  import type { AssistantController } from './assistant-controller.svelte'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal'
  import Square from '@lucide/svelte/icons/square'
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import { putApprovalMode } from '$lib/chat/approvals-client'
  import ApprovalCard from '$lib/components/approval-card.svelte'
  import ApprovalModeSelect from '$lib/components/approval-mode-select.svelte'
  import ChatMarkdown from '$lib/components/chat-markdown.svelte'
  import { Button } from '$lib/components/ui/button'
  import VoiceInputButton from '$lib/components/voice-input-button.svelte'

  /**
   * The Chat tab: the current conversation with the company's agent —
   * transcript (markdown, quiet tool lines, approval cards) and the composer
   * (voice, send/stop). Behavior moved unchanged from the old chat at `/`.
   */
  let { assistant, language }: { assistant: AssistantController; language: string } = $props()

  const chat = $derived(assistant.chat)
  let inputEl = $state<HTMLInputElement | undefined>(undefined)
  let transcriptEl = $state<HTMLDivElement | undefined>(undefined)
  let voiceStopFn = $state<(() => void) | undefined>(undefined)

  const micSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'

  function scrollToBottom(): void {
    const el = transcriptEl
    if (!el) return
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }))
  }

  onMount(() => {
    assistant.composerInput = inputEl ?? null
    chat.onchange = scrollToBottom
    scrollToBottom()
    return () => {
      if (assistant.composerInput === inputEl) assistant.composerInput = null
      if (chat.onchange === scrollToBottom) chat.onchange = null
    }
  })

  function send(): void {
    const text = assistant.draft.trim()
    if (!text || chat.busy) return
    voiceStopFn?.()
    assistant.draft = ''
    assistant.ask(text)
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function handleVoiceTranscript(text: string): void {
    // Transcript fills the input (not auto-send): the user reviews the ASR
    // result and sends deliberately.
    const draft = assistant.draft
    assistant.draft = draft.trim() ? `${draft.trimEnd()} ${text}` : text
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="assistant-chat">
  {#if chat.providerReady === false}
    <div
      class="mx-3 mt-3 flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm"
      data-testid="assistant-provider-missing"
    >
      <p class="flex items-center gap-2 font-medium">
        <KeyRound class="size-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
        No AI provider is set up yet
      </p>
      <p class="text-xs text-foreground/60">
        The assistant needs one to think with. Connect it once and it answers right here.
      </p>
      <Button
        href={resolve('/settings/llm')}
        size="sm"
        class="self-start"
        data-testid="assistant-provider-setup">Set up the AI provider</Button
      >
    </div>
  {/if}

  {#if chat.load === 'failed'}
    <div
      class="mx-3 mt-3 flex items-center justify-between gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
      data-testid="assistant-load-failed"
    >
      <span>The conversation did not load.</span>
      <Button size="sm" variant="outline" onclick={() => void chat.reload()}>Try again</Button>
    </div>
  {/if}

  {#if chat.entries.length === 0 && !chat.busy}
    <div class="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      {#if chat.load === 'loading'}
        <LoaderCircle class="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
      {:else}
        <p class="text-base tracking-wide text-muted-foreground/80">What do you need?</p>
        <p class="text-xs text-muted-foreground/60">
          Ask about anything in the company, or ask it to do the work.
        </p>
      {/if}
    </div>
  {:else}
    <div
      bind:this={transcriptEl}
      class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-4 pb-4"
      role="log"
      aria-label="Conversation"
      data-testid="nucleus-transcript"
    >
      {#each chat.entries as entry (entry.key)}
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
              <p class="text-sm leading-relaxed wrap-break-word text-destructive">
                {entry.content}
              </p>
              {#if entry.providerSetup}
                <a
                  href={resolve('/settings/llm')}
                  class="text-xs text-destructive underline underline-offset-2"
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
          <p class="truncate py-0.5 text-xs text-muted-foreground" data-testid="tool-preview">
            → using {entry.tool}{entry.inputSummary ? ` · ${entry.inputSummary}` : ''}…
          </p>
        {:else if entry.role === 'approval'}
          {@const approvalId = entry.approvalId}
          <ApprovalCard
            action={entry.action}
            tool={entry.tool}
            status={entry.status}
            canDecide={chat.isAdmin && approvalId !== null}
            deciding={chat.busy || (approvalId !== null && chat.decidingId === approvalId)}
            error={approvalId ? chat.approvalErrors[approvalId] || null : null}
            ondecide={(decision) => {
              if (approvalId) void chat.decideApproval(approvalId, decision)
            }}
          />
        {/if}
      {/each}

      {#if chat.busy}
        <div
          class="flex items-center gap-2 px-1 pt-1 text-sm text-muted-foreground"
          data-testid="assistant-busy"
        >
          <LoaderCircle class="size-3.5 shrink-0 animate-spin" strokeWidth={1.75} />
          <span class="min-w-0 truncate">{chat.status ?? 'Working…'}</span>
        </div>
      {/if}
    </div>
  {/if}

  <footer class="shrink-0 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
    <div
      data-testid="nucleus-chatbox"
      class="flex items-stretch gap-1.5 rounded-md border border-primary/70 bg-card p-1.5 focus-within:border-primary"
    >
      <div title={micSupported ? undefined : 'Voice input is not available in this browser'}>
        <VoiceInputButton
          {language}
          disabled={chat.busy}
          bind:stopRef={voiceStopFn}
          ontranscript={handleVoiceTranscript}
          onerror={(message) => {
            console.error('[assistant] voice input failed', message)
          }}
        />
      </div>
      <input
        bind:this={inputEl}
        bind:value={assistant.draft}
        onkeydown={handleKeydown}
        placeholder="What do you need?"
        aria-label="Message"
        data-testid="assistant-composer-input"
        class="min-w-0 flex-1 border-0 bg-transparent px-1.5 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground"
        disabled={chat.busy}
      />
      <Button
        type="button"
        onclick={chat.busy ? () => chat.stop() : send}
        disabled={!chat.busy && !assistant.draft.trim()}
        aria-label={chat.busy ? 'Stop' : 'Send'}
        class="rounded-sm bg-primary px-3 text-primary-foreground hover:bg-primary/90"
      >
        {#if chat.busy}
          <Square class="size-4 shrink-0" strokeWidth={1.75} />
        {:else}
          <SendHorizontal class="size-4 shrink-0" strokeWidth={1.75} />
        {/if}
      </Button>
    </div>
    {#if chat.isAdmin && chat.approvalMode}
      <div class="mt-2 px-1">
        <ApprovalModeSelect
          mode={chat.approvalMode.status === 'ok' ? chat.approvalMode.mode : null}
          save={(mode) => putApprovalMode(assistant.fetch, mode)}
        />
      </div>
    {/if}
  </footer>
</div>
