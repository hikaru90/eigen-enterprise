<script lang="ts">
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import VolumeX from '@lucide/svelte/icons/volume-x'
  import { onMount } from 'svelte'
  import { isVoiceEnabled, onVoiceEnabledChange, setVoiceEnabled } from '$lib/speech/tts'

  /**
   * The speaker in the assistant's composer (Contribute b34ce781: reading aloud is
   * toggleable, right where it reads). The same switch as "Voice on/off" in the settings menu
   * (`ee-voice`): both show the one setting. Off stops the current reading at once.
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
  class="grid w-9 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
  aria-pressed={on}
  aria-label="Read replies aloud"
  title={on ? 'Reading replies aloud — click to stop' : 'Replies are not read aloud — click to read them'}
  data-testid="assistant-voice-toggle"
  onclick={toggle}
>
  {#if on}
    <Volume2 class="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
  {:else}
    <VolumeX class="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
  {/if}
</button>
