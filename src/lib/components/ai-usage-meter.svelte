<script lang="ts">
  import { formatAiEur } from '$lib/ai-usage/billing'
  import { formatAiUsd, usageMeter, usageSentence, type AiUsageToday } from '$lib/ai-usage/usage'

  /**
   * A person's AI use today against the company's daily cap per member (proposal 30a8d920),
   * from settings.my_ai_usage. Below 80 % of the cap the bar is ink; from 80 % it turns red
   * (the red zone); at the cap it says the cap is reached. No cap and exempt (owner, admins)
   * are said plainly. `compact` is the assistant panel's pill; `full` is Settings → AI provider.
   */
  let {
    usage,
    variant = 'full',
    testid = 'ai-usage-meter',
  }: { usage: AiUsageToday; variant?: 'compact' | 'full'; testid?: string } = $props()

  const meter = $derived(usageMeter(usage))
  const sentence = $derived(usageSentence(meter))
  const red = $derived(meter.kind === 'capped' && meter.zone !== 'ok')
  const resets = $derived(
    new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(usage.resetsAt)),
  )
</script>

{#if variant === 'compact'}
  <span
    class={[
      'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] tabular-nums',
      red ? 'bg-destructive/10 text-destructive' : 'bg-muted text-foreground',
    ]}
    title={sentence}
    data-testid={testid}
    data-zone={meter.kind === 'capped' ? meter.zone : meter.kind}
  >
    <span class="sr-only">{sentence}</span>
    <span aria-hidden="true" class="inline-flex items-center gap-1.5">
      {#if meter.kind === 'capped'}
        <span class="relative h-1.5 w-10 overflow-hidden rounded-full bg-foreground/15">
          <span
            class={['absolute inset-y-0 left-0 rounded-full', red ? 'bg-destructive' : 'bg-foreground']}
            style="width: {Math.max(4, Math.round(meter.share * 100))}%"
          ></span>
        </span>
        {meter.spent} / {meter.cap}
      {:else}
        {meter.spent} today
      {/if}
    </span>
  </span>
{:else}
  <div class="space-y-2" data-testid={testid} data-zone={meter.kind === 'capped' ? meter.zone : meter.kind}>
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
      <span class="font-medium">Your AI use today</span>
      <span class={['tabular-nums', red ? 'text-destructive' : 'text-foreground']}>
        {#if meter.kind === 'capped'}
          {meter.spent} of {meter.cap}
        {:else}
          {meter.spent}
        {/if}
      </span>
    </div>
    {#if meter.kind === 'capped'}
      <div
        class="relative h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="Your AI use today against the daily cap"
        aria-valuemin={0}
        aria-valuemax={usage.capUsd ?? 0}
        aria-valuenow={Math.min(usage.spentUsd, usage.capUsd ?? 0)}
        aria-valuetext={sentence}
      >
        <!-- The red zone: the last 20 % of the cap. -->
        <span class="absolute inset-y-0 right-0 w-1/5 bg-destructive/15" aria-hidden="true"></span>
        <span
          class={['absolute inset-y-0 left-0 rounded-full', red ? 'bg-destructive' : 'bg-foreground']}
          style="width: {Math.round(meter.share * 100)}%"
          aria-hidden="true"
        ></span>
      </div>
      <p class={['text-sm', red ? 'text-destructive' : 'text-muted-foreground']} data-testid="{testid}-note">
        {#if meter.zone === 'over'}
          The daily cap is reached. Your AI requests wait until {resets} (midnight UTC).
        {:else}
          {meter.left} left today; the count starts again at {resets} (midnight UTC).
        {/if}
      </p>
    {:else if meter.kind === 'exempt'}
      <p class="text-sm text-muted-foreground" data-testid="{testid}-note">
        Owners and admins have no daily cap. Members can use up to {meter.cap} a day.
      </p>
    {:else}
      <p class="text-sm text-muted-foreground" data-testid="{testid}-note">
        The company has no daily AI cap per member.
      </p>
    {/if}
    {#if usage.invoiced}
      {@const inv = usage.invoiced}
      <p class="text-sm text-muted-foreground" data-testid="{testid}-invoiced">
        eigenInference today: {formatAiEur(inv.invoicedEur)} invoiced ({formatAiUsd(inv.providerUsd)} provider cost × {inv.billing.markup}, at 1 USD =
        {inv.billing.usdToEur} EUR of {inv.billing.rateDay}).
      </p>
    {/if}
  </div>
{/if}
