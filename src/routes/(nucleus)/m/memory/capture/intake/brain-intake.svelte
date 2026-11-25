<script lang="ts">
  import { resolve } from '$app/paths'
  import {
    INTAKE_PERIODS,
    intakeItemLink,
    intakePeriodLabel,
    intakeSourceKey,
    intakeSourceLabel,
    type BrainIntake,
  } from '$lib/memory/brain-intake'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Memory › What the brain took in (Contribute 30a8d920 part 2): the totals for
   * the last 24 hours, 7 days, 30 days and all time, one row per source, and the
   * newest items, each linked to where it opens. `intake` is memory.intake's
   * answer for the signed-in person (the page runs the registry tool as them);
   * `limit` is how many items were asked for, so a full list says it is cut.
   */
  let { intake, limit }: { intake: BrainIntake; limit: number } = $props()

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  function formatWhen(iso: string): string {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) throw new Error(`intake date is not a date: ${iso}`)
    return dateFormat.format(date)
  }

  const cell = 'px-3 py-2 text-right tabular-nums'
</script>

<div class="max-w-4xl space-y-8" data-testid="brain-intake">
  <p class="max-w-[65ch] text-sm text-muted-foreground" data-testid="intake-scope">
    {m.memory_intake_scope()}
  </p>

  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
    {#each INTAKE_PERIODS as period (period)}
      <div class="rounded-sm border border-border px-3 py-2" data-testid="intake-total-{period}">
        <dt class="text-xs text-muted-foreground">{intakePeriodLabel(period)}</dt>
        <dd class="text-lg font-semibold tabular-nums text-foreground">{intake.totals[period]}</dd>
      </div>
    {/each}
  </dl>

  {#if intake.totals.all === 0}
    <p class="text-sm text-muted-foreground" data-testid="intake-empty">
      {m.memory_intake_empty()}
    </p>
  {:else}
    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-foreground">{m.memory_intake_by_source()}</h3>
      <div class="overflow-x-auto rounded-sm border border-border">
        <table class="w-full text-sm">
          <thead class="text-xs text-muted-foreground">
            <tr class="border-b border-border">
              <th scope="col" class="px-3 py-2 text-left font-medium">{m.memory_intake_source()}</th
              >
              {#each INTAKE_PERIODS as period (period)}
                <th scope="col" class="px-3 py-2 text-right font-medium"
                  >{intakePeriodLabel(period)}</th
                >
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each intake.bySource as row (intakeSourceKey(row.source))}
              <tr class="border-b border-border last:border-b-0" data-testid="intake-source-row">
                <th scope="row" class="px-3 py-2 text-left font-normal text-foreground">
                  {intakeSourceLabel(row.source)}
                </th>
                {#each INTAKE_PERIODS as period (period)}
                  <td class={cell}>{row.counts[period]}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-foreground">{m.memory_intake_recent()}</h3>
      <ul class="divide-y divide-border rounded-sm border border-border">
        {#each intake.recent as item (`${item.kind}:${item.id}`)}
          {@const link = intakeItemLink(item.kind, item.id)}
          <li data-testid="intake-item" data-kind={item.kind}>
            <a
              href="{resolve(link.path)}?{link.query}"
              class="block px-3 py-2 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <p class="line-clamp-2 text-sm text-foreground">
                {item.title ?? m.notes_untitled()}
              </p>
              <p
                class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
              >
                <span>
                  {item.kind === 'thought'
                    ? m.memory_intake_kind_thought()
                    : m.memory_intake_kind_document()}
                </span>
                <span>
                  {item.sharedBy
                    ? m.memory_intake_shared_by({ name: item.sharedBy })
                    : intakeSourceLabel(item.source)}
                </span>
                {#if item.category}
                  <span class="font-medium text-foreground">{item.category}</span>
                {/if}
                <time datetime={item.at}>{formatWhen(item.at)}</time>
              </p>
            </a>
          </li>
        {/each}
      </ul>
      {#if intake.recent.length >= limit}
        <p class="text-xs text-muted-foreground" data-testid="intake-newest">
          {m.memory_intake_newest({ count: limit })}
        </p>
      {/if}
    </section>
  {/if}
</div>
