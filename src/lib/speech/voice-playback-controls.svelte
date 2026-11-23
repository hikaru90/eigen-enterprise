<script lang="ts">
  import { onMount } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import {
    VOICE_SPEED,
    canSetMediaVolume,
    getVoicePlayback,
    onVoicePlaybackChange,
    setVoiceSpeed,
    setVoiceVolume,
  } from '$lib/speech/tts'

  /**
   * Speed and volume of the reading voice for this browser (owner proposal 74cbc486). Shown in
   * the chat's voice popover and in the settings menu; both follow each change, and a change
   * applies to the reply being read right now (`$lib/speech/tts`). iOS Safari keeps media volume
   * read-only (the hardware buttons own it): there the volume row says so instead of a slider
   * that would do nothing.
   */
  let { canSetVolume = canSetMediaVolume() }: { canSetVolume?: boolean } = $props()
  const uid = $props.id()
  let speed = $state<number>(VOICE_SPEED.default)
  let volumePercent = $state(100)
  let problem = $state<string | null>(null)

  function show(playback: { speed: number; volume: number }): void {
    speed = playback.speed
    volumePercent = Math.round(playback.volume * 100)
  }

  onMount(() => {
    show(getVoicePlayback())
    return onVoicePlaybackChange(show)
  })

  function apply(set: () => void): void {
    problem = null
    try {
      set()
    } catch (err) {
      console.error('[tts] changing the voice speed or volume failed', err)
      problem = err instanceof Error ? err.message : String(err)
    }
  }

  function onSpeed(value: string): void {
    apply(() => setVoiceSpeed(Math.round(Number(value) * 100) / 100))
  }

  function onVolume(value: string): void {
    apply(() => setVoiceVolume(Math.round(Number(value)) / 100))
  }

  const rowClass = 'flex flex-col gap-1'
  const headClass = 'text-muted-foreground flex items-center justify-between text-xs font-medium'
  const rangeClass = 'accent-foreground h-4 w-full cursor-pointer'
</script>

<div
  class="flex flex-col gap-2.5 px-2 pt-1 pb-1.5"
  role="group"
  aria-label="Voice speed and volume"
  data-testid="voice-playback"
>
  <div class={rowClass}>
    <div class={headClass}>
      <label for="{uid}-speed">Speed</label>
      <span class="tabular-nums" data-testid="voice-speed-value">{speed}×</span>
    </div>
    <input
      id="{uid}-speed"
      type="range"
      class={rangeClass}
      min={VOICE_SPEED.min}
      max={VOICE_SPEED.max}
      step={VOICE_SPEED.step}
      value={speed}
      aria-valuetext="{speed} times"
      oninput={(e) => onSpeed(e.currentTarget.value)}
      data-testid="voice-speed"
    />
  </div>
  {#if canSetVolume}
    <div class={rowClass}>
      <div class={headClass}>
        <label for="{uid}-volume">Volume</label>
        <span class="tabular-nums" data-testid="voice-volume-value">{volumePercent}%</span>
      </div>
      <input
        id="{uid}-volume"
        type="range"
        class={rangeClass}
        min="0"
        max="100"
        step="5"
        value={volumePercent}
        aria-valuetext="{volumePercent} percent"
        oninput={(e) => onVolume(e.currentTarget.value)}
        data-testid="voice-volume"
      />
    </div>
  {:else}
    <div class={rowClass}>
      <span class="text-muted-foreground text-xs font-medium">Volume</span>
      <p
        class="text-muted-foreground text-xs leading-relaxed"
        data-testid="voice-volume-unsupported"
      >
        This browser does not let pages set the volume. Use your device's volume buttons.
      </p>
    </div>
  {/if}
  {#if problem}
    <ErrorNotice
      class="text-xs leading-relaxed"
      testid="voice-playback-problem"
      error={problem}
      attempted="Changing the reading voice's speed or volume for this browser"
    />
  {/if}
</div>
