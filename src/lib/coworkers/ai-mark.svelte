<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { cn } from '$lib/utils'

  /**
   * The AI mark (plan/phase-ai-coworkers.md §6): a small neutral tag next to an
   * AI co-worker's name wherever it appears — messages, the people directory,
   * the org chart, members. Optionally the model family it runs on. Screen
   * readers hear "AI co-worker" (and the family), not "A I".
   */
  let {
    family = null,
    class: className = '',
    testid = 'ai-mark',
  }: {
    /** The model family (Anthropic, Google, …), shown after the mark. */
    family?: string | null
    class?: string
    testid?: string
  } = $props()
</script>

<span
  class={cn(
    'inline-flex shrink-0 items-center rounded-sm border border-border px-1 text-xs leading-4 font-medium text-muted-foreground',
    className,
  )}
  title={family ? m.coworkers_ai_mark_with_family({ family }) : m.coworkers_ai_mark_title()}
  data-testid={testid}
  data-family={family ?? undefined}
>
  <span aria-hidden="true">{m.coworkers_ai_mark()}{#if family}&nbsp;·&nbsp;{family}{/if}</span>
  <span class="sr-only">{family ? m.coworkers_ai_mark_with_family({ family }) : m.coworkers_ai_mark_title()}</span>
</span>
