<script lang="ts">
  import type { CallBrain } from './call-brain.svelte'
  import Lock from '@lucide/svelte/icons/lock'
  import Send from '@lucide/svelte/icons/send'
  import Share2 from '@lucide/svelte/icons/share-2'
  import X from '@lucide/svelte/icons/x'
  import { dictateInto } from '$lib/voice/dictation-insert'
  import VoiceDictation from '$lib/voice/voice-dictation.svelte'

  /**
   * The call's Company Brain panel (modules/calls/brain.ts). Off until
   * someone switches it on; then it only listens. "Ask the Brain" is the one
   * way it answers — to me alone (it may use my own Memory) — and I may
   * share an answer with my colleagues in the call. Shared answers show for
   * everyone here, from the Company Brain, asked by whom.
   *
   * The question takes dictation like every field (the Contribute mic, left of Ask): the
   * words go in at the cursor; asking stays the person's tap.
   */
  let { brain, onclose }: { brain: CallBrain; onclose: () => void } = $props()

  let question = $state('')
  let questionEl = $state<HTMLTextAreaElement | undefined>(undefined)
  /** The voice bar holds the ask row (recording, transcribing or saying why it can't). */
  let voiceActive = $state(false)
  let cursorPlaced = false

  function ontranscript(text: string): void {
    if (!questionEl) throw new Error('call brain: the transcript arrived after the question field went away')
    dictateInto(questionEl, text, cursorPlaced)
    cursorPlaced = true
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (voiceActive) return
    if (await brain.ask(question)) question = ''
  }
</script>

<aside class="flex h-full min-h-0 flex-col bg-neutral-900 text-neutral-50" aria-label="Company Brain" data-testid="call-brain-panel">
  <div class="flex items-center gap-2 border-b border-white/10 px-4 py-3">
    <h2 class="min-w-0 flex-1 text-sm font-semibold">Company Brain</h2>
    <button type="button" class="text-neutral-400 hover:text-white" aria-label="Close the Company Brain panel" onclick={onclose}><X class="size-4" /></button>
  </div>

  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium" data-testid="call-brain-state">
          {#if brain.listening}<span>Listening</span>
            {#if brain.byName}<span class="font-normal text-neutral-400">· switched on by {brain.byName}</span>{/if}{:else}Off{/if}
        </p>
        <p class="mt-1 text-xs text-neutral-400">
          It only listens to the transcript. It never speaks, posts or suggests anything — it answers only what you ask. Everyone in the call sees
          when it is on, and anyone can switch it off.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={brain.listening}
        aria-label="Company Brain listening"
        class={['relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors', brain.listening ? 'bg-amber-300' : 'bg-white/20']}
        data-testid="call-brain-toggle"
        onclick={() => brain.toggle()}
        ><span class={['absolute top-0.5 size-5 rounded-full bg-white transition-all', brain.listening ? 'left-[1.375rem]' : 'left-0.5']}></span></button
      >
    </div>

    {#if brain.problem}
      <div class="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-neutral-950 p-3 text-sm" role="alert" data-testid="call-brain-problem">
        <p class="min-w-0 flex-1">{brain.problem}</p>
        <button type="button" class="text-neutral-400 hover:text-white" aria-label="Dismiss" onclick={() => brain.dismissProblem()}><X class="size-4" /></button>
      </div>
    {/if}

    {#if brain.answers.length > 0}
      <section aria-label="Your answers" class="flex flex-col gap-2">
        <h3 class="flex items-center gap-1.5 text-xs font-medium tracking-wide text-neutral-400 uppercase"><Lock class="size-3" aria-hidden="true" /> Only you see these</h3>
        <ul class="flex flex-col gap-2">
          {#each brain.answers as a (a.id)}
            <li class="rounded-lg bg-white/5 p-3" data-testid="call-brain-answer" data-shared={a.shared ? 'true' : 'false'}>
              <p class="text-xs text-neutral-400">{a.question}</p>
              <p class="mt-1 text-sm whitespace-pre-wrap">{a.answer}</p>
              {#if a.shared}
                <p class="mt-2 text-xs text-neutral-400">Shared with the call</p>
              {:else}
                <button
                  type="button"
                  class="mt-2 inline-flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/10"
                  data-testid="call-brain-share"
                  title="Your colleagues in this call will see your question and this answer (guests don't)"
                  onclick={() => brain.share(a.id)}><Share2 class="size-3.5" aria-hidden="true" /> Share in call</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if brain.shared.length > 0}
      <section aria-label="Shared in this call" class="flex flex-col gap-2">
        <h3 class="text-xs font-medium tracking-wide text-neutral-400 uppercase">Shared in this call</h3>
        <ul class="flex flex-col gap-2">
          {#each brain.shared as s (s.id)}
            <li class="rounded-lg border border-white/10 p-3" data-testid="call-brain-shared">
              <p class="text-xs text-neutral-400" data-testid="call-brain-shared-label">Company Brain · asked by {s.askedByName}</p>
              <p class="mt-1 text-xs text-neutral-300">{s.question}</p>
              <p class="mt-1 text-sm whitespace-pre-wrap">{s.answer}</p>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>

  <form class="flex items-end gap-2 border-t border-white/10 p-3" onsubmit={submit} data-testid="call-brain-ask">
    <label class="sr-only" for="call-brain-question">Ask the Brain</label>
    <textarea
      bind:this={questionEl}
      onfocus={() => (cursorPlaced = true)}
      id="call-brain-question"
      rows="2"
      maxlength="1000"
      class={['min-h-10 min-w-0 flex-1 resize-none rounded-md border border-white/15 bg-neutral-950 px-3 py-2 text-sm placeholder:text-neutral-500 focus:border-white/40 focus:outline-none disabled:opacity-50', voiceActive && 'hidden']}
      placeholder={brain.listening ? 'Ask the Brain — only you see the answer' : 'Switch the Brain on to ask it'}
      disabled={!brain.listening || brain.asking}
      bind:value={question}
      data-testid="call-brain-question"
    ></textarea>
    <!-- the call stage is dark in both themes: the mic takes the dark tokens -->
    <div class={['dark flex items-center self-stretch', voiceActive && 'min-w-0 flex-1']}>
      <VoiceDictation
        bind:active={voiceActive}
        disabled={!brain.listening || brain.asking}
        testid="call-brain-voice"
        {ontranscript}
        onclose={() => questionEl?.focus({ preventScroll: true })}
      />
    </div>
    {#if !voiceActive}
      <button
        type="submit"
        class="grid size-10 shrink-0 place-items-center rounded-md bg-white text-neutral-900 hover:bg-white/90 disabled:opacity-50"
        aria-label="Ask"
        disabled={!brain.listening || brain.asking || question.trim() === ''}
        data-testid="call-brain-send"><Send class="size-4" /></button
      >
    {/if}
  </form>
</aside>
