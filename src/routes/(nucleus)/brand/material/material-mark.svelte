<script lang="ts">
  import { cn } from '$lib/utils.js'

  /**
   * The brand mark every piece carries: the company logo (Settings → Company)
   * when there is one and it is switched on, else the primary dot and the
   * style's name. The export (modules/brand/material/document.ts) places it the same way.
   */
  let {
    setName,
    logoUrl = null,
    class: className,
  }: { setName: string; logoUrl?: string | null; class?: string } = $props()
</script>

{#if logoUrl}
  <img src={logoUrl} alt="" class={cn('h-7 max-w-40 object-contain', className)} data-testid="material-logo" />
{:else}
  <span class={cn('flex items-center gap-2', className)}>
    <span class="size-3 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
    <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{setName}</span>
  </span>
{/if}
