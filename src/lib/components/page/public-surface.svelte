<script lang="ts">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'

  /**
   * The signed-out / public background: the same tokens as the shell — the
   * active brand style when one is chosen, the app's white light default
   * otherwise (mirrors the (nucleus) layout wrapper). Never the old sage.
   */
  let { children }: { children: Snippet } = $props()
  const brandActive = $derived(Boolean(page.data.activeVisualSet))
</script>

<div
  class={[
    'min-h-dvh font-sans text-foreground',
    brandActive ? 'bg-background' : 'marketing-light-theme bg-white',
  ]}
  data-testid="public-surface"
>
  {@render children()}
</div>
