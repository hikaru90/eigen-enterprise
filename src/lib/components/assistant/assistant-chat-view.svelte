<script lang="ts">
  import type { AssistantController } from './assistant-controller.svelte'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import Pencil from '@lucide/svelte/icons/pencil'
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal'
  import Square from '@lucide/svelte/icons/square'
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import { putApprovalMode } from '$lib/chat/approvals-client'
  import ApprovalCard from '$lib/components/approval-card.svelte'
  import ApprovalModeSelect from '$lib/components/approval-mode-select.svelte'
  import ChatMarkdown from '$lib/components/chat-markdown.svelte'
  import { Button } from '$lib/components/ui/button'
  import AttachmentChip from './attachment-chip.svelte'
  import { ASSISTANT_ATTACHMENT_ACCEPT, ASSISTANT_ATTACHMENT_LIMITS_TEXT } from './attachments'
  import { dictateInto } from '$lib/voice/dictation-insert'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'
  import VoiceOutputToggle from './voice-output-toggle.svelte'

  /**
   * The Chat tab: the current conversation with the company's agent —
   * transcript (markdown, quiet tool lines, approval cards) and the composer:
   * attach · message · microphone · send/stop, the microphone directly left of send
   * (Contribute: improve voice input), and "Read replies aloud" labelled under it.
   * The mic is the one dictation control (`$lib/voice/voice-dictation.svelte`, as in
   * Contribute): while it records its bar takes the composer row; Done puts the words in at
   * the cursor for the person to read and send. It never sends by itself.
   */
  let { assistant }: { assistant: AssistantController } = $props()

  const chat = $derived(assistant.chat)
  const attachments = $derived(assistant.attachments)
  let fileInputEl = $state<HTMLInputElement | undefined>(undefined)
  const canSend = $derived(
    !attachments.reading && (assistant.draft.trim().length > 0 || attachments.ready.length > 0),
  )
  let inputEl = $state<HTMLInputElement | undefined>(undefined)
  let transcriptEl = $state<HTMLDivElement | undefined>(undefined)
  /** The voice bar holds the composer row (recording, transcribing or saying why it can't). */
  let voiceActive = $state(false)
  /** The person put the cursor in the message (dictation goes there, else after the text). */
  let cursorPlaced = false

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
    if (!canSend || chat.busy) return
    if (voiceActive) return
    const text = assistant.draft.trim()
    assistant.draft = ''
    assistant.submitComposer(text, attachments.take())
  }

  function handleFilesChosen(e: Event): void {
    const input = e.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    // Cleared so choosing the same file again fires another change.
    input.value = ''
    if (files.length > 0) void attachments.add(files)
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape' && assistant.editing) {
      e.preventDefault()
      assistant.cancelEdit()
    }
  }

  function handleVoiceTranscript(text: string): void {
    // Transcript fills the input (not auto-send): the user reviews the ASR
    // result and sends deliberately.
    if (!inputEl) throw new Error('assistant composer: the transcript arrived after the field went away')
    dictateInto(inputEl, text, cursorPlaced)
    cursorPlaced = true
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
        <p class="text-base tracking-wide text-muted-foreground">What do you need?</p>
        <p class="text-xs text-muted-foreground">
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
          <div class="group/message flex w-full flex-col items-end py-1.5">
            <div
              class={[
                'flex max-w-[85%] min-w-0 flex-col gap-1.5 rounded-sm bg-primary px-3.5 py-2 wrap-break-word text-primary-foreground',
                assistant.editing?.key === entry.key && 'opacity-50',
              ]}
            >
              {#if entry.attachments?.length}
                <ul class="flex flex-wrap gap-1.5" aria-label="Attached files">
                  {#each entry.attachments as file, i (i)}
                    <AttachmentChip
                      name={file.name}
                      kind={file.kind}
                      sizeBytes={file.sizeBytes}
                      tone="user"
                      testid="assistant-message-attachment"
                    />
                  {/each}
                </ul>
              {/if}
              {#if entry.content}
                <ChatMarkdown content={entry.content} tone="user" />
              {/if}
            </div>
            {#if chat.editableKey === entry.key && assistant.editing?.key !== entry.key}
              <button
                type="button"
                class="mt-0.5 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                aria-label="Edit message"
                title="Edit and send again"
                data-testid="assistant-message-edit"
                onclick={() => assistant.startEdit(entry.key)}
              >
                <Pencil class="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                Edit
              </button>
            {/if}
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
    {#if assistant.editing}
      <div
        class="mb-1.5 flex flex-col gap-0.5 rounded-sm bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground"
        data-testid="assistant-editing"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-1.5">
            <Pencil class="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            Editing your message — sending replaces it and the reply after it.
          </span>
          <button
            type="button"
            class="cursor-pointer rounded-sm px-1.5 py-0.5 text-foreground hover:bg-foreground/[0.06]"
            aria-label="Cancel editing"
            onclick={() => assistant.cancelEdit()}>Cancel</button
          >
        </div>
        {#if assistant.editing.missingFiles.length > 0}
          {@const files = assistant.editing.missingFiles}
          <p>
            Attach {files.join(', ')} again if the edited message still needs {files.length === 1
              ? 'it'
              : 'them'}.
          </p>
        {/if}
      </div>
    {/if}
    {#if attachments.items.length > 0}
      <ul class="mb-1.5 flex flex-wrap gap-1.5 px-0.5" aria-label="Files to send">
        {#each attachments.items as item (item.key)}
          <AttachmentChip
            name={item.name}
            kind={item.status === 'ready' ? item.attachment.kind : null}
            sizeBytes={item.sizeBytes}
            reading={item.status === 'reading'}
            onremove={() => attachments.remove(item.key)}
            testid="assistant-composer-attachment"
          />
        {/each}
      </ul>
    {/if}
    <div
      data-testid="nucleus-chatbox"
      class="flex items-stretch gap-1.5 rounded-md border border-primary/70 bg-card p-1.5 focus-within:border-primary focus-within:ring-1 focus-within:ring-ring"
    >
      <input
        bind:this={fileInputEl}
        type="file"
        multiple
        accept={ASSISTANT_ATTACHMENT_ACCEPT}
        class="hidden"
        tabindex="-1"
        aria-hidden="true"
        data-testid="assistant-attach-input"
        onchange={handleFilesChosen}
      />
      <button
        type="button"
        class={[
          'grid w-9 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
          voiceActive && 'hidden',
        ]}
        aria-label="Attach files"
        title={`Attach files: ${ASSISTANT_ATTACHMENT_LIMITS_TEXT}`}
        data-testid="assistant-attach"
        disabled={chat.busy}
        onclick={() => fileInputEl?.click()}
      >
        <Paperclip class="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <input
        bind:this={inputEl}
        bind:value={assistant.draft}
        onkeydown={handleKeydown}
        placeholder="What do you need?"
        aria-label="Message"
        data-testid="assistant-composer-input"
        class={[
          'min-w-0 flex-1 border-0 bg-transparent px-1.5 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground',
          voiceActive && 'hidden',
        ]}
        disabled={chat.busy}
        onfocus={() => (cursorPlaced = true)}
      />
      <div class={['flex items-center', voiceActive && 'min-w-0 flex-1']} data-testid="assistant-mic">
        <VoiceDictation
          bind:active={voiceActive}
          disabled={chat.busy}
          testid="assistant-voice"
          ontranscript={handleVoiceTranscript}
          onclose={() => inputEl?.focus({ preventScroll: true })}
        />
      </div>
      <Button
        type="button"
        onclick={chat.busy ? () => chat.stop() : send}
        disabled={!chat.busy && !canSend}
        aria-label={chat.busy ? 'Stop' : 'Send'}
        data-testid="assistant-send"
        class={['rounded-sm bg-primary px-3 text-primary-foreground hover:bg-primary/90', voiceActive && 'hidden']}
      >
        {#if chat.busy}
          <Square class="size-4 shrink-0" strokeWidth={1.75} />
        {:else}
          <SendHorizontal class="size-4 shrink-0" strokeWidth={1.75} />
        {/if}
      </Button>
    </div>
    {#each attachments.errors as message, i (i)}
      <p
        class="mt-1.5 px-1 text-xs text-destructive"
        role="alert"
        data-testid="assistant-attachment-error"
      >
        {message}
      </p>
    {/each}
    <div class="mt-1 flex items-center px-0.5">
      <VoiceOutputToggle />
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
