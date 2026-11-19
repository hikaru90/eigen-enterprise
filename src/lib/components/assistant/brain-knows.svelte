<script lang="ts">
  import { resolve } from '$app/paths'

  /**
   * "Your Brain knows 1,200 decisions" (board request): a quiet retention line
   * on the assistant page. `count` is the decisions in the viewer's own Memory
   * (src/lib/server/memory/known-decisions.ts — the LLM's typed `decision`
   * category, archived ones left out); it links to the Memory that holds them.
   * The number uses the viewer's locale grouping, like the app's dates.
   */
  let { count }: { count: number } = $props()

  const numberFormat = new Intl.NumberFormat()
  const text = $derived(
    count === 0
      ? 'Your Brain knows no decisions yet'
      : `Your Brain knows ${numberFormat.format(count)} ${count === 1 ? 'decision' : 'decisions'}`,
  )
</script>

<a
  href={resolve('/m/memory')}
  class="mt-3 inline-flex w-fit max-w-full rounded-sm text-sm text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
  data-testid="brain-knows">{text}</a
>
