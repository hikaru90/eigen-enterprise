<script lang="ts">
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import VolumeX from '@lucide/svelte/icons/volume-x'
  import { onMount } from 'svelte'
  import { isVoiceEnabled, onVoiceEnabledChange, setVoiceEnabled } from '$lib/speech/tts'

  /**
   * "Read replies aloud" under the assistant's composer (Contribute b34ce781: reading aloud is
   * toggleable, right where it reads; Contribute: "clarify what the speaker control is" — it
   * says what it does and its state in words, in its tooltip and to assistive tech). The same
   * switch as "Voice on/off" in the settings menu (`ee-voice`): both show the one setting. Off
   * stops the current reading at once.
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
