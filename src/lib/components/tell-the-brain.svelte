<script lang="ts">
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import { assistantIfOn } from '$lib/components/assistant/context'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * The one door (plan/concept-memory-one-door.md, decision 1): Memory has no
   * input of its own any more. Where it used to send people to Capture, this
   * line sends them to the Ask bar — "Tell the brain" focuses it (⌘K does the
   * same), and the brain files what they say. The Ask bar takes text and voice;
   * its panel's composer takes files too. With the Assistant switched off
   * there is no Ask bar, and the line says so instead of pointing at nothing.
   */
  let { class: className = '' }: { class?: string } = $props()

  const assistant = assistantIfOn()
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground {className}"
  data-testid="tell-the-brain"
>
  {#if assistant}
    <p class="min-w-0">{m.memory_tell_brain()}</p>
    <button
      type="button"
      class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
      data-testid="tell-the-brain-open"
      onclick={() => assistant.focusBar()}
    >
      <Sparkles class="size-4" aria-hidden="true" />
      {m.memory_tell_brain_open()}
    </button>
  {:else}
    <p class="min-w-0" data-testid="tell-the-brain-off">{m.memory_tell_brain_off()}</p>
  {/if}
</div>
