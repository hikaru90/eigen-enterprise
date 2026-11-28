<script lang="ts">
  import type { AiBilling } from '$lib/ai-usage/billing'
  import type { AiAmounts } from '$lib/ai-usage/overview'
  import { formatTokens } from '$lib/ai-usage/usage'
  import { AI_USAGE_PERIODS, formatShown, periodLabel, shownAmount, type AiUsagePeriod } from '$lib/ai-usage/view'

  /**
   * An AI co-worker's AI usage (wish acdb941e): its tokens and what they cost in
   * the period, the same periods as Settings → AI usage. A view of
   * settings.ai_usage_overview (filtered to the co-worker). The period switch
   * is links (`href`) on a page, or buttons (`onperiod`) inside a panel.
   * No usage in the period reads as zero, not as missing.
   */
  let {
    amounts,
    billing,
    period,
    href,
    onperiod,
    testid = 'coworker-usage',
  }: {
    /** Null: no AI calls in the period. */
    amounts: AiAmounts | null
    billing: AiBilling | null
    period: AiUsagePeriod
    href?: (period: AiUsagePeriod) => string
    onperiod?: (period: AiUsagePeriod) => void
    testid?: string
  } = $props()

  const tokens = $derived(amounts ? amounts.promptTokens + amounts.completionTokens : 0)
  const money = $derived(formatShown(amounts ? shownAmount(amounts, billing) : 0, billing))
  const pill = (on: boolean) => ['rounded-full px-2 py-0.5 text-xs', on ? 'bg-(--tone-blue) text-white' : 'text-muted-foreground hover:bg-muted']
</script>

<div class="space-y-1" data-testid={testid}>
  <p class="text-xs text-muted-foreground">
    <span class="font-medium text-foreground">AI usage</span> · {periodLabel(period, billing)}:
    <span data-testid="{testid}-tokens">{formatTokens(tokens)}</span>
    ({formatTokens(amounts?.promptTokens ?? 0)} in, {formatTokens(amounts?.completionTokens ?? 0)} out) ·
    <span data-testid="{testid}-cost">{money}</span>
  </p>
  <nav class="flex flex-wrap gap-1" aria-label="AI usage period" data-sveltekit-noscroll>
    {#each AI_USAGE_PERIODS as option (option.id)}
      {#if href}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the caller's href is already resolved -->
        <a href={href(option.id)} aria-current={period === option.id ? 'page' : undefined} class={pill(period === option.id)}>{option.label}</a>
      {:else}
        <button type="button" aria-pressed={period === option.id} class={pill(period === option.id)} onclick={() => onperiod?.(option.id)}
          >{option.label}</button
        >
      {/if}
    {/each}
  </nav>
</div>
