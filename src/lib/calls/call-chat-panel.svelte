<script lang="ts">
  import { enterSends } from '$lib/components/keys/enter-sends'
  import type { CallChat } from './call-chat.svelte'
  import Send from '@lucide/svelte/icons/send'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount, tick } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { dictateInto } from '$lib/voice/dictation-insert'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'

  /**
   * The call's chat panel (proposal bb05b451): what the people in the call —
   * members and guests — write to each other, oldest first, guests marked.
   * Enter sends, Shift+Enter is a new line. The chat stays with the call (the
   * transcript page shows it afterwards).
   *
   * `dictation`: the line takes dictation like every field for people of the
   * company (the mic left of Send); a guest has no account to transcribe for.
   */
  let {
    chat,
    onclose,
    dictation = true,
  }: { chat: CallChat; onclose: () => void; dictation?: boolean } = $props()

  let draft = $state('')
  let draftEl = $state<HTMLTextAreaElement | undefined>(undefined)
  let listEl = $state<HTMLOListElement | undefined>(undefined)
  let voiceActive = $state(false)
  let cursorPlaced = false
  let unsubscribe = () => {}

  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

  /** Keep the newest line in view when the reader is at the bottom already (or wrote it). */
  async function follow(force = false) {
    const el = listEl
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    await tick()
    if (force || atBottom) el.scrollTop = el.scrollHeight
  }

  onMount(() => {
    unsubscribe = chat.subscribe(() => void follow())
    void follow(true)
    draftEl?.focus({ preventScroll: true })
  })

  onDestroy(() => unsubscribe())

  function ontranscript(text: string): void {
    if (!draftEl)
      throw new Error('call chat: the transcript arrived after the message field went away')
    dictateInto(draftEl, text, cursorPlaced)
    cursorPlaced = true
  }

  async function sendDraft() {
    if (voiceActive) return
    if (await chat.send(draft)) {
      draft = ''
      void follow(true)
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault()
    void sendDraft()
  }

  const onkeydown = enterSends(() => void sendDraft())
</script>

<aside
  class="flex h-full min-h-0 flex-col bg-neutral-900 text-neutral-50"
  aria-label="Chat"
  data-testid="call-chat-panel"
>
  <div class="flex items-center gap-2 border-b border-white/10 px-4 py-3">
    <h2 class="min-w-0 flex-1 text-sm font-semibold">Chat</h2>
    <button
      type="button"
      class="text-neutral-400 hover:text-white"
      aria-label="Close the chat"
      onclick={onclose}><X class="size-4" /></button
    >
  </div>

  {#if chat.messages.length === 0}
    <p class="flex-1 px-4 py-6 text-center text-sm text-neutral-400" data-testid="call-chat-empty">
      Nothing written yet. Everyone in the call reads what you write here, guests too.
    </p>
  {/if}
  <ol
    bind:this={listEl}
    class={[
      'flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4',
      chat.messages.length > 0 ? 'flex-1' : 'hidden',
    ]}
    aria-label="Messages"
    aria-live="polite"
    data-testid="call-chat-messages"
  >
    {#each chat.messages as m (m.seq)}
      <li
        class={['rounded-lg p-2.5', m.authorId === chat.me ? 'bg-white/10' : 'bg-white/5']}
        data-testid="call-chat-message"
        data-mine={m.authorId === chat.me ? 'true' : 'false'}
      >
        <p class="flex items-baseline gap-1.5 text-xs text-neutral-400">
          <span class="truncate font-semibold text-neutral-200" data-testid="call-chat-author"
            >{m.authorId === chat.me ? 'You' : m.authorName}</span
          >
          {#if m.authorKind === 'guest'}<span data-testid="call-chat-guest">Guest</span>{/if}
          <time class="ml-auto shrink-0 tabular-nums" datetime={m.createdAt}
            >{time.format(new Date(m.createdAt))}</time
          >
        </p>
        <p class="mt-1 text-sm break-words whitespace-pre-wrap" data-testid="call-chat-body">
          {m.body}
        </p>
      </li>
    {/each}
  </ol>

  {#if chat.problem}
    <div
      class="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-neutral-950 p-3 text-sm"
    >
      <ErrorNotice
        class="min-w-0 flex-1"
        testid="call-chat-problem"
        error={chat.problem.error}
        agent={chat.problem.agent}
        attempted="Using the chat in a call"
      />
      <button
        type="button"
        class="text-neutral-400 hover:text-white"
        aria-label="Dismiss"
        onclick={() => chat.dismissProblem()}><X class="size-4" /></button
      >
    </div>
  {/if}

  <form
    class="flex items-end gap-2 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    onsubmit={submit}
    data-testid="call-chat-form"
  >
    <label class="sr-only" for="call-chat-draft">Write a message</label>
    <textarea
      bind:this={draftEl}
      onfocus={() => (cursorPlaced = true)}
      {onkeydown}
      id="call-chat-draft"
      rows="2"
      maxlength="4000"
      class={[
        'min-h-10 min-w-0 flex-1 resize-none rounded-md border border-white/15 bg-neutral-950 px-3 py-2 text-sm placeholder:text-neutral-500 focus:border-white/40 focus:outline-none disabled:opacity-50',
        voiceActive && 'hidden',
      ]}
      placeholder="Write to everyone in the call"
      disabled={chat.sending}
      bind:value={draft}
      data-testid="call-chat-draft"></textarea>
    {#if dictation}
      <!-- the call stage is dark in both themes: the mic takes the dark tokens -->
      <div class={['dark flex items-center self-stretch', voiceActive && 'min-w-0 flex-1']}>
        <VoiceDictation
          bind:active={voiceActive}
          disabled={chat.sending}
          testid="call-chat-voice"
          {ontranscript}
          onclose={() => draftEl?.focus({ preventScroll: true })}
        />
      </div>
    {/if}
    {#if !voiceActive}
      <button
        type="submit"
        class="grid size-10 shrink-0 place-items-center rounded-md bg-white text-neutral-900 hover:bg-white/90 disabled:opacity-50"
        aria-label="Send"
        disabled={chat.sending || draft.trim() === ''}
        data-testid="call-chat-send"><Send class="size-4" /></button
      >
    {/if}
  </form>
</aside>
