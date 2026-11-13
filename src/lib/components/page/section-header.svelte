<script lang="ts">
  import type { Snippet } from 'svelte'

  /**
   * The heading of one tab's content under a PageHeader (h2): one style for
   * every area, optional one-line description and actions on the right.
   */
  let {
    title,
    description,
    actions,
    testid,
  }: { title: string; description?: string | null; actions?: Snippet; testid?: string } = $props()
</script>

<div class="mt-8 flex min-w-0 flex-wrap items-end justify-between gap-3" data-testid={testid}>
  <!-- The board's hairline label: a 1px rule on the left of title and description. -->
  <div class="hairline flex min-w-0 flex-col gap-0.5">
    <h2 class="text-[15px] leading-snug font-medium">{title}</h2>
    {#if description}<p class="text-sm text-muted-foreground">{description}</p>{/if}
  </div>
  {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</div>
