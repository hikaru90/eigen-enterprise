<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Mic from '@lucide/svelte/icons/mic'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import { page } from '$app/state'
  import { DICTATION_MISSING_MESSAGE, DICTATION_UNSUPPORTED_MESSAGE, type SpeechReadiness } from './dictation-readiness'
  import { transcribeVoiceClip } from './transcribe-voice-clip'
  import { voiceFailureMessage } from './voice-failure-message'
  import {
    createVoiceMessageSession,
    formatVoiceTimer,
    IDLE_VOICE_VIEW,
    isVoiceRecordingSupported,
    VOICE_MESSAGE_MAX_MS,
    type VoiceMessageSession,
    type VoiceMessageView,
    type VoiceRecording,
  } from './voice-message'

  /**
   * Dictation for a text box (eigen's voice messages): a mic button that, once tapped, turns
   * into the voice bar — discard, a live waveform, the timer against the 5-minute cap, and
   * "done". Done uploads the whole clip once; the transcript comes back through `ontranscript`,
   * with the recording itself (a box that keeps it, like Messages, sends it along), and the box
   * appends the text to what was typed. Transcribing shows the wait with Cancel; a
   * failure shows the plain message with Retry (when the clip is still in memory) and Dismiss.
   *
   * Place it in the box's action row: idle it is one icon button, active it grows to fill the
   * row (`flex-1`); `active` tells the box to hide its other row controls meanwhile.
   * The session (`./voice-message`) owns every decision; this only renders its views.
   *
   * When dictation cannot work here (no speech-to-text set up, a browser without recording),
   * the mic stays where it is, marked unavailable, and a tap says why in the bar — never a
   * silent hide (plan/shared-memory-voice-agent-tools.md §2). `onclose` fires when the bar
   * gives the row back (transcript in, discarded, dismissed), so the box can take focus back.
   */
  let {
    ontranscript,
    disabled = false,
    // $bindable() sets up the parent binding; ESLint cannot see the parent read the assignments.
     
    active = $bindable(false),
    testid = 'voice',
    size = 'default',
    onclose,
    class: className = '',
  }: {
    /** The transcript, and the recording it was heard from (kept by boxes that play it back). */
    ontranscript: (text: string, recording: VoiceRecording) => void
    disabled?: boolean
    /** True while a voice message exists (recording, transcribing or failed). */
    active?: boolean
    /** Prefix for the `data-testid`s (`<testid>-mic`, `<testid>-bar`, …). */
    testid?: string
    /** `compact` (28px controls) sits inside a field (`./dictation-field.svelte`). */
    size?: 'default' | 'compact'
    /** The bar closed and the row is the box's again (not called when the box unmounts). */
    onclose?: () => void
    class?: string
  } = $props()

  let view = $state.raw<VoiceMessageView>(IDLE_VOICE_VIEW)
  let supported = $state(false)
  /** Why dictation can't start here, shown in the bar after a tap on the unavailable mic. */
  let notice = $state<string | null>(null)
  let session: VoiceMessageSession | null = null

  function phaseActive(phase: VoiceMessageView['phase']): boolean {
    return phase === 'recording' || phase === 'transcribing' || phase === 'failed'
  }

  /** Tells the box whether the bar holds the row; a bar that closes hands the row back. */
  function syncActive(): void {
    const next = notice !== null || phaseActive(view.phase)
    const closed = active && !next
    active = next
    if (closed) onclose?.()
  }

  onMount(() => {
    supported = isVoiceRecordingSupported()
    session = createVoiceMessageSession({
      transcribe: (clip, signal) => transcribeVoiceClip(clip, { signal }),
      onchange: (next) => {
        view = next
        syncActive()
      },
      ontranscript: (text, recording) => ontranscript(text, recording),
      onerror: (failure) => console.warn('[voice] message failed', failure.reason, failure.status ?? ''),
    })
  })
  onDestroy(() => {
    // the box went away mid-message: drop it silently, and give the box its row back
    session?.destroy()
    active = false
  })

  /** The shell says what dictation lacks (no OpenRouter key): the mic says so, before any recording. */
  const dictation = $derived((page.data.shell as { dictation?: SpeechReadiness } | null | undefined)?.dictation)
  const missingMessage = $derived(dictation?.ready === false ? DICTATION_MISSING_MESSAGE[dictation.missing] : null)
  const unavailable = $derived(missingMessage ?? (supported ? null : DICTATION_UNSUPPORTED_MESSAGE))
  const failure = $derived(view.phase === 'failed' ? view.failure : null)
  const showBar = $derived(notice !== null || phaseActive(view.phase))

  function startTap(): void {
    if (unavailable) {
      notice = unavailable
      syncActive()
      return
    }
    // the session makes its AudioContext synchronously inside this tap (iOS requires it)
    void session?.start()
  }

  function dismissNotice(): void {
    notice = null
    syncActive()
  }

  /** A quiet bar is still a visible line: levels map onto 12–100% of the bar's height. */
  function barScale(level: number): string {
    return (0.12 + 0.88 * Math.min(1, Math.max(0, level))).toFixed(3)
  }

  /** The control a keyboard user lands on when the bar (or its error) replaces the mic. */
  function focusOnMount(node: HTMLElement, enabled = true) {
    if (enabled) node.focus({ preventScroll: true })
  }

  const box = $derived(size === 'compact' ? 'size-7' : 'size-8')
  const iconButton = $derived(
    `grid ${box} shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40`,
  )
</script>

{#snippet waveform(dim: boolean)}
  <!-- display only: one bar per mic reading, the newest on the right; the oldest scroll out on the left -->
  <div
    class={['flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden transition-opacity', dim && 'opacity-40']}
    data-testid="{testid}-waveform"
    aria-hidden="true"
  >
    {#each view.levels as level, i (i)}
      <span
        class="block h-full w-[2px] shrink-0 origin-center rounded-full bg-foreground/70 [transform:scaleY(var(--lvl))] transition-transform duration-75 ease-out motion-reduce:transition-none"
        style:--lvl={barScale(level)}
      ></span>
    {/each}
  </div>
{/snippet}

{#if !showBar}
  <button
    type="button"
    class="{iconButton} {className}"
    disabled={disabled || view.phase === 'starting'}
    aria-disabled={unavailable ? 'true' : undefined}
    aria-label="Dictate"
    title={unavailable ?? 'Dictate (speech to text)'}
    data-testid="{testid}-mic"
    onclick={startTap}
  >
    {#if view.phase === 'starting'}
      <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
    {:else}
      <Mic class="size-4" aria-hidden="true" />
    {/if}
  </button>
{:else}
  <div class="flex min-w-0 flex-1 items-center gap-2 {className}" role="group" aria-label="Voice message" data-testid="{testid}-bar">
    {#if notice}
      <p class="m-0 min-w-0 flex-1 pl-1 text-xs leading-5 text-destructive" role="alert" data-testid="{testid}-error">{notice}</p>
      <button
        type="button"
        use:focusOnMount
        class={iconButton}
        aria-label="Dismiss"
        title="Dismiss"
        data-testid="{testid}-discard"
        onclick={dismissNotice}
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    {:else if view.phase === 'recording'}
      <button type="button" class={iconButton} aria-label="Discard recording" title="Discard recording" data-testid="{testid}-discard" onclick={() => session?.discard()}>
        <X class="size-4" aria-hidden="true" />
      </button>
      {@render waveform(false)}
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive motion-reduce:animate-none" aria-hidden="true"></span>
      <span class="shrink-0 text-xs tabular-nums text-foreground" role="timer" aria-label="Recording time" data-testid="{testid}-timer"
        >{formatVoiceTimer(view.elapsedMs)} <span class="text-muted-foreground">/ {formatVoiceTimer(VOICE_MESSAGE_MAX_MS)}</span></span
      >
      <button
        type="button"
        use:focusOnMount
        class="grid {box} shrink-0 cursor-pointer place-items-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        aria-label="Done — transcribe"
        title="Done — transcribe"
        data-testid="{testid}-send"
        onclick={() => void session?.send()}
      >
        <Check class="size-4" aria-hidden="true" />
      </button>
    {:else if view.phase === 'transcribing'}
      <div class="flex shrink-0 items-center gap-2 pl-1 text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="{testid}-status">
        <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
        <span>Transcribing… <span class="tabular-nums">{formatVoiceTimer(view.transcribingElapsedMs)}</span></span>
      </div>
      {@render waveform(true)}
      <button type="button" class={iconButton} aria-label="Cancel transcription" title="Cancel transcription" data-testid="{testid}-cancel" onclick={() => session?.discard()}>
        <X class="size-4" aria-hidden="true" />
      </button>
    {:else if failure}
      <p class="m-0 min-w-0 flex-1 pl-1 text-xs leading-5 text-destructive" role="alert" data-testid="{testid}-error">
        {voiceFailureMessage(failure)}
      </p>
      {#if failure.retryable}
        <button
          type="button"
          use:focusOnMount
          class="h-7 shrink-0 cursor-pointer rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="{testid}-retry"
          onclick={() => void session?.retry()}>Retry</button
        >
      {/if}
      <button
        type="button"
        use:focusOnMount={!failure.retryable}
        class={iconButton}
        aria-label={failure.retryable ? 'Discard recording' : 'Dismiss'}
        title={failure.retryable ? 'Discard recording' : 'Dismiss'}
        data-testid="{testid}-discard"
        onclick={() => session?.discard()}
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    {/if}
  </div>
{/if}
