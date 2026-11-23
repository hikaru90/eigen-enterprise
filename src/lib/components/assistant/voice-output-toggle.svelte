<script lang="ts">
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import VolumeX from '@lucide/svelte/icons/volume-x'
  import { onMount } from 'svelte'
  import * as Popover from '$lib/components/ui/popover'
  import { isVoiceEnabled, onVoiceEnabledChange, setVoiceEnabled } from '$lib/speech/tts'
  import VoicePlaybackControls from '$lib/speech/voice-playback-controls.svelte'

  /**
   * "Read replies aloud" under the assistant's composer (Contribute b34ce781: reading aloud is
   * toggleable, right where it reads; Contribute: "clarify what the speaker control is" — it
   * says what it does and its state in words, in its tooltip and to assistive tech). The same
   * switch as "Voice on/off" in the settings menu (`ee-voice`): both show the one setting. Off
   * stops the current reading at once. Beside it, a small popover holds the voice's speed and
   * volume (owner proposal 74cbc486; the same controls as the settings menu).
   */
  let on = $state(true)

  onMount(() => {
    on = isVoiceEnabled()
    return onVoiceEnabledChange((enabled) => (on = enabled))
  })

  function toggle(): void {
    setVoiceEnabled(!on)
  }
</script>

<span class="inline-flex shrink-0 items-center">
  <button
    type="button"
    role="switch"
    class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
    aria-checked={on}
    title={on
      ? 'Replies are read aloud as they arrive. Click to stop reading them aloud.'
      : 'Replies are not read aloud. Click to have them read aloud.'}
    data-testid="assistant-voice-toggle"
    onclick={toggle}
  >
    {#if on}
      <Volume2 class="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
    {:else}
      <VolumeX class="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
    {/if}
    <span>Read replies aloud: {on ? 'On' : 'Off'}</span>
  </button>
  <Popover.Root>
    <Popover.Trigger
      class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
      aria-label="Voice speed and volume"
      title="Voice speed and volume"
      data-testid="assistant-voice-playback"
    >
      <SlidersHorizontal
        class="pointer-events-none size-3.5 shrink-0"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </Popover.Trigger>
    <Popover.Content side="top" align="start" sideOffset={6} class="w-56 gap-1 pt-2 pb-2">
      <VoicePlaybackControls />
    </Popover.Content>
  </Popover.Root>
</span>
