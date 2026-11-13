<script lang="ts">
  import { cn } from '$lib/utils.js'

  /** The brand mark every piece carries: the primary dot and the style's name. */
  let { setName, class: className }: { setName: string; class?: string } = $props()
</script>

<span class={cn('flex items-center gap-2', className)}>
  <span class="size-3 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
  <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{setName}</span>
</span>
