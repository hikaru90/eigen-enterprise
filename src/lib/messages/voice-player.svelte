<script module lang="ts">
  /** The one recording playing on this page: starting another pauses it. */
  let current: HTMLAudioElement | null = null
</script>

<script lang="ts">
  import Pause from '@lucide/svelte/icons/pause'
  import Play from '@lucide/svelte/icons/play'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { formatVoiceTimer } from '$lib/voice/voice-message'

  /**
   * A voice message's player, above its transcript: play/pause, a seek bar and the time.
   * Nothing loads until it is played (a long chat holds many recordings). The length shown
   * is the recorder's own measure (`durationMs`): a recorder's WebM carries none, so the
   * media element would say "Infinity". One recording plays at a time.
   */
  let {
    src,
    durationMs,
    testid = 'voice-player',
  }: {
    /** Where the recording is fetched from (members of the conversation only). */
    src: string
    durationMs: number
    /** Prefix for the `data-testid`s (`<testid>-toggle`, `<testid>-seek`, …). */
    testid?: string
  } = $props()

  type PlayerState = 'idle' | 'playing' | 'paused' | 'error'

  let audio = $state<HTMLAudioElement | null>(null)
  let playerState = $state<PlayerState>('idle')
  /** Where playback is, in seconds. */
  let position = $state(0)

  const total = $derived(Math.max(0, durationMs) / 1000)
  const shown = $derived(Math.min(position, total))
  // at rest the player says how long the recording is; once started, where it is
  const timeLabel = $derived(
    playerState === 'idle' && position === 0
      ? formatVoiceTimer(durationMs)
      : formatVoiceTimer(shown * 1000),
  )
  const playing = $derived(playerState === 'playing')

  function toggle(): void {
    const el = audio
    if (!el) return
    if (playerState === 'playing') {
      el.pause()
      return
    }
    if (playerState === 'error') {
      // a new attempt: load the recording again
      playerState = 'idle'
      el.load()
    }
    el.play().catch((err: unknown) => {
      // a pause before playback began aborts the play() call: that is not a failure
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.warn('[voice-player] the recording could not be played', err)
      playerState = 'error'
    })
  }

  function onPlay(): void {
    const el = audio
    if (!el) return
    if (current && current !== el) current.pause()
    current = el
    playerState = 'playing'
  }

  function onPause(): void {
    if (current === audio) current = null
    // `ended` follows a pause at the end; an error keeps its state
    if (playerState === 'playing') playerState = 'paused'
  }

  function onEnded(): void {
    if (current === audio) current = null
    if (audio) audio.currentTime = 0
    position = 0
    playerState = 'idle'
  }

  function onTimeUpdate(): void {
    if (audio && playerState !== 'idle') position = audio.currentTime
  }

  function onError(): void {
    if (current === audio) current = null
    console.warn('[voice-player] the recording could not be loaded', audio?.error?.code ?? '')
    playerState = 'error'
  }

  function seek(e: Event & { currentTarget: HTMLInputElement }): void {
    const to = Number(e.currentTarget.value)
    position = to
    if (audio) audio.currentTime = to
  }
</script>

<div class="flex flex-col gap-0.5">
  <div
    class="flex w-72 max-w-full min-w-0 items-center gap-2.5 rounded-full border border-border bg-foreground/[0.03] py-1 pr-3 pl-1"
    role="group"
    aria-label="Voice message"
    data-testid={testid}
    data-state={playerState}
  >
    <button
      type="button"
      class="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
      aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      title={playing ? 'Pause' : 'Play'}
      data-testid="{testid}-toggle"
      onclick={toggle}
    >
      {#if playing}
        <Pause class="size-4" aria-hidden="true" />
      {:else}
        <Play class="ml-0.5 size-4" aria-hidden="true" />
      {/if}
    </button>
    <input
      type="range"
      class="h-1 min-w-0 flex-1 cursor-pointer accent-primary"
      min="0"
      max={total}
      step="0.01"
      value={shown}
      aria-label="Position in voice message"
      aria-valuenow={Math.round(shown * 100) / 100}
      aria-valuetext="{formatVoiceTimer(shown * 1000)} of {formatVoiceTimer(durationMs)}"
      data-testid="{testid}-seek"
      oninput={seek}
    />
    <span class="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="{testid}-time"
      >{timeLabel}</span
    >
    <audio
      bind:this={audio}
      {src}
      preload="none"
      class="hidden"
      data-testid="{testid}-audio"
      onplay={onPlay}
      onpause={onPause}
      onended={onEnded}
      ontimeupdate={onTimeUpdate}
      onerror={onError}
    ></audio>
  </div>
  {#if playerState === 'error'}
    <ErrorNotice
      class="pl-3 text-xs"
      testid="{testid}-error"
      error="Recording unavailable"
      attempted="Playing a voice recording in Messages (the browser could not load the audio)"
    />
  {/if}
</div>
