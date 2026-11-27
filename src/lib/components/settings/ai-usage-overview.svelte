<script lang="ts">
  import { resolve } from '$app/paths'
  import type { AiAmounts, AiUsageOverview, AiUsageProductId } from '$lib/ai-usage/overview'
  import { formatAiUsd, formatTokens } from '$lib/ai-usage/usage'
  import { AI_USAGE_PERIODS, dailyBars, usedProducts, type AiUsagePeriod } from '$lib/ai-usage/view'
  import SectionHeader from '$lib/components/page/section-header.svelte'

  /**
   * Settings → AI usage (plan/phase-ai-usage-overview.md §5), a view of
   * settings.ai_usage_overview: where the company's AI money goes. Observation only: amounts
   * and counts, people listed by name. Neutral bars; the one accent marks the product picked
   * in the legend.
   */
  let { overview, period }: { overview: AiUsageOverview; period: AiUsagePeriod } = $props()

  const bars = $derived(dailyBars(overview))
  const peak = $derived(Math.max(...bars.map((b) => b.costUsd), 0))
  const legend = $derived(usedProducts(overview))

  let picked = $state<AiUsageProductId | null>(null)
  let hovered = $state<string | null>(null)
  /** Opened table rows: `product:<id>` and `person:<userId>`. */
  let opened = $state<string[]>([])

  const hoveredBar = $derived(bars.find((b) => b.date === hovered) ?? null)

  const toggle = (key: string) => {
    opened = opened.includes(key) ? opened.filter((k) => k !== key) : [...opened, key]
  }

  const tokensOf = (a: AiAmounts) => formatTokens(a.promptTokens + a.completionTokens)
  const count = (n: number) => n.toLocaleString('en-US')
  const dayLabel = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  const segmentClass = (id: AiUsageProductId) =>
    picked === null ? 'bg-foreground/55' : picked === id ? 'bg-(--tone-blue)' : 'bg-foreground/15'

  const card = 'rounded-lg border border-border bg-card'
</script>

{#snippet amounts(a: AiAmounts)}
  <td class="px-3 py-2 text-right font-mono tabular-nums">{formatAiUsd(a.costUsd)}</td>
  <td class="px-3 py-2 text-right font-mono tabular-nums">{count(a.calls)}</td>
  <td class="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">{tokensOf(a)}</td>
{/snippet}

{#snippet head(first: string)}
  <thead class="text-xs text-muted-foreground">
    <tr class="border-b border-border">
      <th class="px-3 py-2 text-left font-medium">{first}</th>
      <th class="px-3 py-2 text-right font-medium">Cost</th>
      <th class="px-3 py-2 text-right font-medium">Calls</th>
      <th class="px-3 py-2 text-right font-medium">Tokens</th>
    </tr>
  </thead>
{/snippet}

{#snippet opener(key: string, label: string)}
  <button type="button" class="flex items-center gap-2 text-left font-medium" aria-expanded={opened.includes(key)} onclick={() => toggle(key)}>
    <span aria-hidden="true" class="w-3 text-muted-foreground">{opened.includes(key) ? '▾' : '▸'}</span>
    {label}
  </button>
{/snippet}

<div class="space-y-8" data-testid="ai-usage">
  <SectionHeader title="AI usage" description="What the company's AI calls cost, as the gateway reported it. Days are UTC.">
    {#snippet actions()}
      <nav class="flex gap-1" aria-label="Period" data-sveltekit-noscroll>
        {#each AI_USAGE_PERIODS as option (option.id)}
          <a
            href={resolve(`/settings/ai-usage?period=${option.id}`)}
            aria-current={period === option.id ? 'page' : undefined}
            class={['rounded-full px-3 py-1 text-sm', period === option.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted']}
          >
            {option.label}
          </a>
        {/each}
      </nav>
    {/snippet}
  </SectionHeader>

  <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
    <div class="{card} p-4">
      <dt class="text-sm text-muted-foreground">Spend</dt>
      <dd class="mt-1 text-2xl font-semibold" data-testid="ai-usage-spend">{formatAiUsd(overview.totals.costUsd)}</dd>
    </div>
    <div class="{card} p-4">
      <dt class="text-sm text-muted-foreground">Calls</dt>
      <dd class="mt-1 text-2xl font-semibold" data-testid="ai-usage-calls">{count(overview.totals.calls)}</dd>
    </div>
    <div class="{card} p-4">
      <dt class="text-sm text-muted-foreground">Tokens</dt>
      <dd class="mt-1 text-2xl font-semibold" data-testid="ai-usage-tokens">{tokensOf(overview.totals)}</dd>
      <dd class="text-xs text-muted-foreground">{formatTokens(overview.totals.cachedTokens)} of the input from the cache</dd>
    </div>
  </dl>

  {#if overview.totals.calls === 0}
    <p class="{card} p-6 text-center text-sm text-muted-foreground" data-testid="ai-usage-empty">No AI calls in this period.</p>
  {:else}
    <section class="space-y-3">
      <h3 class="text-sm font-semibold">Spend per day</h3>
      <div class="{card} p-4">
        <div class="flex justify-between gap-3 text-xs text-muted-foreground">
          <span>Full height: {formatAiUsd(peak)}</span>
          <span class="min-h-4 text-right" role="status" data-testid="ai-usage-day-detail">
            {#if hoveredBar}
              {dayLabel(hoveredBar.date)}: {formatAiUsd(hoveredBar.costUsd)}{#each hoveredBar.segments as segment (segment.id)}
                &nbsp;· {segment.label} {formatAiUsd(segment.costUsd)}
              {/each}
            {/if}
          </span>
        </div>
        <div class="mt-2 flex h-40 items-stretch gap-px border-b border-border sm:gap-0.5">
          {#each bars as bar (bar.date)}
            <button
              type="button"
              class="flex min-w-0 flex-1 flex-col-reverse items-center gap-0.5 rounded-t-sm hover:bg-muted/60"
              aria-label={`${dayLabel(bar.date)}: ${formatAiUsd(bar.costUsd)}`}
              data-testid="ai-usage-day"
              onmouseenter={() => (hovered = bar.date)}
              onmouseleave={() => (hovered = null)}
              onfocus={() => (hovered = bar.date)}
              onblur={() => (hovered = null)}
            >
              {#each bar.segments as segment (segment.id)}
                <span
                  class={['block w-full max-w-6 shrink last:rounded-t-sm', segmentClass(segment.id)]}
                  style:height={`${(segment.costUsd / peak) * 100}%`}
                ></span>
              {/each}
            </button>
          {/each}
        </div>
        <div class="mt-1 flex justify-between text-xs text-muted-foreground">
          <span>{dayLabel(bars[0]!.date)}</span>
          <span>{dayLabel(bars.at(-1)!.date)}</span>
        </div>
        <div class="mt-3 flex flex-wrap gap-1.5" aria-label="Mark one product in the bars" role="group">
          {#each legend as product (product.id)}
            <button
              type="button"
              class={['flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs', picked === product.id && 'bg-muted']}
              aria-pressed={picked === product.id}
              onclick={() => (picked = picked === product.id ? null : product.id)}
            >
              <span class={['size-2 rounded-full', segmentClass(product.id)]}></span>
              {product.label}
              <span class="font-mono text-muted-foreground">{formatAiUsd(product.costUsd)}</span>
            </button>
          {/each}
        </div>
      </div>
    </section>
  {/if}

  <section class="space-y-3" data-testid="ai-usage-products">
    <h3 class="text-sm font-semibold">Products</h3>
    <div class="{card} overflow-x-auto">
      <table class="w-full text-sm">
        {@render head('Product')}
        <tbody>
          {#each overview.products as product (product.id)}
            <tr class={['border-b border-border last:border-0', product.calls === 0 && 'text-muted-foreground']} data-testid="ai-usage-product-row">
              <td class="px-3 py-2">{@render opener(`product:${product.id}`, product.label)}</td>
              {@render amounts(product)}
            </tr>
            {#if opened.includes(`product:${product.id}`)}
              {#each product.tasks.filter((t) => t.calls > 0) as task (task.id)}
                <tr class="border-b border-border bg-muted/40 last:border-0" data-testid="ai-usage-sub-row">
                  <td class="py-2 pr-3 pl-8">{task.label}</td>
                  {@render amounts(task)}
                </tr>
              {:else}
                <tr class="border-b border-border bg-muted/40 last:border-0">
                  <td class="py-2 pr-3 pl-8 text-muted-foreground" colspan="4">No calls in this period.</td>
                </tr>
              {/each}
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  {#if overview.people.length > 0}
    <section class="space-y-3" data-testid="ai-usage-people">
      <h3 class="text-sm font-semibold">People & co-workers</h3>
      <div class="{card} overflow-x-auto">
        <table class="w-full text-sm">
          {@render head('Name')}
          <tbody>
            {#each overview.people as person (person.userId)}
              <tr class="border-b border-border last:border-0">
                <td class="px-3 py-2">
                  <div class="flex items-center gap-2">
                    {@render opener(`person:${person.userId}`, person.name)}
                    {#if person.kind === 'coworker'}
                      <span class="rounded-full border border-border px-2 text-xs text-muted-foreground">AI co-worker</span>
                    {/if}
                  </div>
                </td>
                {@render amounts(person)}
              </tr>
              {#if opened.includes(`person:${person.userId}`)}
                {#each person.products as product (product.id)}
                  <tr class="border-b border-border bg-muted/40 last:border-0" data-testid="ai-usage-sub-row">
                    <td class="py-2 pr-3 pl-8">{product.label}</td>
                    {@render amounts(product)}
                  </tr>
                {/each}
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  {#if overview.models.length > 0}
    <section class="space-y-3" data-testid="ai-usage-models">
      <h3 class="text-sm font-semibold">Models</h3>
      <div class="{card} overflow-x-auto">
        <table class="w-full text-sm">
          {@render head('Model')}
          <tbody>
            {#each overview.models as model (model.model)}
              <tr class="border-b border-border last:border-0">
                <td class="px-3 py-2 font-mono text-xs">
                  {#if model.model === null}<span class="font-sans text-muted-foreground">Not recorded</span>{:else}{model.model}{/if}
                </td>
                {@render amounts(model)}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>
