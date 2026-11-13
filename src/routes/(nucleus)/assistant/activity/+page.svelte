<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the module filter is resolve() + a query string */
  import { onMount } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { resolve } from '$app/paths'
  import {
    callTimestampBounds,
    chooseActivitySpendBucketUnit,
    computeActivitySpendSpan,
    fillActivitySpendBuckets,
    startOfUtcPeriod,
    utcDateKey,
    type ActivitySpendBucket,
  } from '$lib/activity/spend-chart'
  import AiDateRangePicker from '$lib/components/ai-date-range-picker.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { formatActivityCredits } from '$lib/pricing/credits'
  import { docTitle } from '$lib/shell/title'
  import ActivitySpendChart from './activity-spend-chart.svelte'

  type ActivityCallRow = {
    id: string
    provider: string
    gatewayHost?: string | null
    operation: string
    context?: string | null
    baseCostUsd: string
    markupUsd: string
    totalCostUsd: string
    groupId?: string | null
    durationMs?: number | null
    createdAt: string | Date
  }

  let { data } = $props()

  let fromDate = $state<string | null>(data.from)
  let toDate = $state<string | null>(data.to)

  const dayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
  /** Days group in UTC (server); the label names that UTC day. */
  const dayLabel = (day: string) => dayFormat.format(new Date(`${day}T12:00:00Z`))
  const timeLabel = (iso: string) => timeFormat.format(new Date(iso))
  const chip = (on: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 -ring ${
      on
        ? 'border-foreground bg-foreground text-background'
        : 'border-border text-foreground/70 hover:text-foreground'
    }`
  const gatewayProviderSet = $derived(new Set<string>(data.gatewayProviders))
  let allCalls = $state<ActivityCallRow[]>([])
  let isLoading = $state(true)
  let loadError = $state('')
  let expandedGroups = $state<Record<string, boolean>>({})
  let currentPage = $state(1)

  const PAGE_SIZE = 20

  function toggleGroup(groupId: string) {
    expandedGroups = { ...expandedGroups, [groupId]: !expandedGroups[groupId] }
  }

  function sumTotalUsd(calls: ActivityCallRow[]): string {
    let total = 0
    for (const c of calls) total += Number(c.totalCostUsd)
    return total.toFixed(6)
  }

  function endpointLabelFromHost(hostname: string): string {
    const h = hostname
      .trim()
      .toLowerCase()
      .replace(/^www\./, '')
    const parts = h.split('.').filter(Boolean)
    if (parts.length <= 2) return parts[0] ?? h
    return parts[parts.length - 2] ?? parts[0]
  }

  function groupProviderLabel(calls: ActivityCallRow[]): { label: string; isPaid: boolean } {
    const first = calls[0]
    if (first.provider === 'agent') return { label: 'Agent', isPaid: false }
    const host = first.gatewayHost?.trim()
    if (host) return { label: endpointLabelFromHost(host), isPaid: true }
    return { label: 'Gateway', isPaid: true }
  }

  function formatDuration(ms: number | null | undefined): string {
    if (ms == null) return '\u2014'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  function totalDurationMs(calls: ActivityCallRow[]): number | null {
    let total = 0
    let hasAny = false
    for (const c of calls) {
      if (c.durationMs != null) {
        total += c.durationMs
        hasAny = true
      }
    }
    return hasAny ? total : null
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

  function formatDate(value: unknown): string {
    if (value instanceof Date) return timeFmt.format(value)
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value)
      if (!Number.isNaN(d.getTime())) return timeFmt.format(d)
    }
    return String(value)
  }

  // --- Derived: filter calls by date range ---
  const filteredCalls = $derived(
    allCalls.filter((c) => {
      const d = new Date(c.createdAt)
      if (fromDate && d < new Date(fromDate)) return false
      if (toDate && d > new Date(toDate)) return false
      return true
    }),
  )

  // --- Derived: group filtered calls ---
  const grouped = $derived.by(() => {
    const groups: Array<{
      key: string
      groupId: string | null
      calls: ActivityCallRow[]
      firstOp: string
      groupTotalUsd: string
    }> = []
    const groupMap = new SvelteMap<string, ActivityCallRow[]>()
    const order: string[] = []

    for (const c of filteredCalls) {
      const key = c.groupId ?? `__ungrouped__${c.id}`
      let list = groupMap.get(key)
      if (!list) {
        list = []
        groupMap.set(key, list)
        order.push(key)
      }
      list.push(c)
    }

    for (const key of order) {
      const list = groupMap.get(key)!
      list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      groups.push({
        key,
        groupId: key.startsWith('__ungrouped__') ? null : key,
        calls: list,
        firstOp: list[0].operation,
        groupTotalUsd: sumTotalUsd(list),
      })
    }
    return groups
  })

  // --- Derived: client-side pagination ---
  const totalPages = $derived(Math.max(1, Math.ceil(grouped.length / PAGE_SIZE)))

  const pagedGroups = $derived.by(() => {
    const safePage = Math.min(currentPage, totalPages)
    const startIdx = (safePage - 1) * PAGE_SIZE
    return grouped.slice(startIdx, startIdx + PAGE_SIZE)
  })

  // --- Derived: totals ---
  const pageTotals = $derived.by(() => {
    let base = 0
    let markup = 0
    let total = 0
    for (const g of pagedGroups) {
      for (const c of g.calls) {
        base += Number(c.baseCostUsd)
        markup += Number(c.markupUsd)
        total += Number(c.totalCostUsd)
      }
    }
    return {
      baseCostUsd: base.toFixed(6),
      markupUsd: markup.toFixed(6),
      totalCostUsd: total.toFixed(6),
    }
  })

  const overallTotals = $derived.by(() => {
    let base = 0
    let markup = 0
    let total = 0
    for (const c of filteredCalls) {
      if (gatewayProviderSet.has(c.provider) && Number(c.totalCostUsd) > 0) {
        base += Number(c.baseCostUsd)
        markup += Number(c.markupUsd)
        total += Number(c.totalCostUsd)
      }
    }
    return {
      baseCostUsd: base.toFixed(6),
      markupUsd: markup.toFixed(6),
      totalCostUsd: total.toFixed(6),
    }
  })

  const showOverall = $derived(Number(overallTotals.totalCostUsd) > 0)

  // --- Derived: spend series (client-side) ---
  const spendSeries = $derived.by(() => {
    const gatewayCalls = filteredCalls.filter(
      (c) => gatewayProviderSet.has(c.provider) && Number(c.totalCostUsd) > 0,
    )
    if (gatewayCalls.length === 0) return null

    const { earliest: earliestCallAt, latest: latestCallAt } = callTimestampBounds(gatewayCalls)
    const allTime = !fromDate && !toDate

    const span = computeActivitySpendSpan({
      from: fromDate ? new Date(fromDate) : null,
      to: toDate ? new Date(toDate) : null,
      earliestCallAt: allTime || !fromDate ? earliestCallAt : null,
      latestCallAt: allTime || !toDate ? latestCallAt : null,
    })
    const unit = chooseActivitySpendBucketUnit(span.spanDays)

    const byPeriod = new SvelteMap<string, { totalCostUsd: number; callCount: number }>()
    for (const c of gatewayCalls) {
      const d = new Date(c.createdAt)
      const periodDate = startOfUtcPeriod(d, unit)
      const key = utcDateKey(periodDate)
      const existing = byPeriod.get(key) ?? { totalCostUsd: 0, callCount: 0 }
      existing.totalCostUsd += Number(c.totalCostUsd)
      existing.callCount += 1
      byPeriod.set(key, existing)
    }

    const distinctGroupIds = new Set(filteredCalls.map((c) => c.groupId ?? `__ungrouped__${c.id}`))
    const totalGroups = distinctGroupIds.size
    const totalCalls = gatewayCalls.length

    const normalized: ActivitySpendBucket[] = []
    for (const [key, val] of byPeriod) {
      normalized.push({
        periodStart: key,
        totalCostUsd: val.totalCostUsd.toFixed(6),
        callCount: val.callCount,
        groupCount: totalCalls > 0 ? Math.round((val.callCount / totalCalls) * totalGroups) : 0,
      })
    }

    const buckets = fillActivitySpendBuckets(normalized, span.from, span.to, unit)
    return { unit, buckets, totalGroups }
  })

  // --- Derived: display labels ---
  const pageTotalCredits = $derived(formatActivityCredits(pageTotals.totalCostUsd))

  // --- Fetch all data once on mount ---
  onMount(async () => {
    try {
      const res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: null, to: null, returnAll: true }),
      })
      if (res.ok) {
        const json = (await res.json()) as { calls?: ActivityCallRow[] }
        allCalls = json.calls ?? []
      } else {
        loadError = await res.text()
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading = false
    }
  })
</script>

<svelte:head>
  <title>{docTitle('Activity', 'Assistant')}</title>
</svelte:head>

<SectionHeader
  title="Activity"
  description="What the assistant and the system did, newest first."
/>

<section class="mt-6" aria-label="Activity log" data-testid="activity-log">
  {#if data.modules.length > 1}
    <nav
      class="mb-4 flex flex-wrap gap-1.5"
      aria-label="Filter by module"
      data-testid="activity-filter"
    >
      <a
        href={resolve('/(nucleus)/assistant/activity')}
        aria-current={data.module === null ? 'page' : undefined}
        class={chip(data.module === null)}>All</a
      >
      {#each data.modules as m (m.id)}
        <a
          href={`${resolve('/(nucleus)/assistant/activity')}?module=${encodeURIComponent(m.id)}`}
          aria-current={data.module === m.id ? 'page' : undefined}
          data-testid="activity-filter-{m.id}"
          class={chip(data.module === m.id)}>{m.label}</a
        >
      {/each}
    </nav>
  {/if}

  {#if data.log.length === 0}
    <p
      class="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground"
      data-testid="activity-log-empty"
    >
      Nothing has happened yet.
    </p>
  {:else}
    <div class="flex flex-col gap-6">
      {#each data.log as group (group.day)}
        <section aria-label={dayLabel(group.day)} data-testid="activity-day">
          <h2 class="mb-2 text-[13px] font-medium text-foreground/70">{dayLabel(group.day)}</h2>
          <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {#each group.entries as entry (entry.id)}
              <li class="px-4 py-2.5 text-sm" data-testid="activity-entry">
                <details class="group">
                  <summary
                    class="flex min-w-0 cursor-pointer list-none items-center gap-3 outline-none focus-visible:ring-2 -ring [&::-webkit-details-marker]:hidden"
                  >
                    <span
                      class="w-16 shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                      >{timeLabel(entry.ts)}</span
                    >
                    <span class="min-w-0 flex-1 truncate">
                      <span class="font-medium">{entry.actor}</span>
                      <span class="text-foreground/80">· {entry.text}</span>
                    </span>
                    <span
                      class="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-foreground/60 sm:inline"
                      >{entry.moduleLabel}</span
                    >
                    {#if entry.outcome === 'done'}
                      <span class="shrink-0 text-xs text-emerald-700 dark:text-emerald-400"
                        >Done</span
                      >
                    {:else if entry.outcome === 'failed'}
                      <span class="shrink-0 text-xs text-destructive">Didn't work</span>
                    {/if}
                  </summary>
                  <ul
                    class="mt-2 ml-19 space-y-0.5 text-xs text-muted-foreground"
                    data-testid="activity-details"
                  >
                    {#each entry.details as line (line)}
                      <li><code class="font-mono">{line}</code></li>
                    {/each}
                  </ul>
                </details>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/if}
</section>

<div class="mt-10 flex items-center justify-between">
  <h2 class="text-sm font-semibold">AI usage</h2>
  <AiDateRangePicker
    from={fromDate ?? undefined}
    to={toDate ?? undefined}
    onChange={(f, t) => {
      fromDate = f
      toDate = t
      currentPage = 1
    }}
  />
</div>

{#if isLoading}
  <p class="text-muted-foreground py-8 text-center text-xs">Loading activity…</p>
{:else if loadError}
  <p class="py-8 text-center text-xs text-red-500">{loadError}</p>
{:else}
  {#if showOverall && spendSeries}
    <ActivitySpendChart
      buckets={spendSeries.buckets}
      unit={spendSeries.unit}
      totalGroups={spendSeries.totalGroups}
    />
  {/if}

  <Card.Root class="mt-4 border border-border bg-card shadow-none ring-0">
    <Card.Header>
      <Card.Title class="text-sm">Calls</Card.Title>
      <Card.Description class="text-muted-foreground text-xs">
        All LLM gateway calls and agent tool operations.
      </Card.Description>
    </Card.Header>
    <Card.Content class="overflow-x-auto px-0">
      <table class="w-full text-left text-xs">
        <thead class="bg-muted/50 border-b border-border">
          <tr>
            <th class="p-2 font-medium">When</th>
            <th class="p-2 font-medium">Provider</th>
            <th class="p-2 font-medium">Operation</th>
            <th class="p-2 font-medium">Duration</th>
            <th class="p-2 font-medium">Credits</th>
          </tr>
        </thead>
        <tbody>
          {#each pagedGroups as group (group.key)}
            {@const prov = groupProviderLabel(group.calls)}
            {@const groupLabel = group.firstOp.replace(/\.(success|error)\(.*\)$/, '')}
            {@const context = group.calls.find((c) => c.context)?.context}
            {@const dur = totalDurationMs(group.calls)}
            {@const isExpanded = !!expandedGroups[group.key]}
            {@const hasMultipleCalls = group.calls.length > 1}

            <tr
              class="border-b border-border/60 {hasMultipleCalls
                ? 'cursor-pointer hover:bg-muted/50'
                : ''}"
              onclick={() => hasMultipleCalls && toggleGroup(group.key)}
            >
              <td class="p-2 whitespace-nowrap">
                {#if hasMultipleCalls}
                  <span class="inline-block w-4 text-muted-foreground text-xs"
                    >{isExpanded ? '▼' : '▶'}</span
                  >
                {/if}
                {formatDate(group.calls[0].createdAt)}
              </td>
              <td class="p-2">
                <span class="inline-flex items-center gap-1">
                  {#if prov.isPaid}
                    <span class="text-destructive">●</span>
                  {:else}
                    <span class="text-green-600">●</span>
                  {/if}
                  {prov.label}
                </span>
              </td>
              <td class="p-2">
                <span class="font-mono text-xs truncate max-w-[250px] block">{groupLabel}</span>
                {#if context}
                  <span class="text-xs text-muted-foreground truncate max-w-[250px] block"
                    >{context}</span
                  >
                {/if}
                {#if hasMultipleCalls}
                  <span class="text-xs text-muted-foreground">({group.calls.length} calls)</span
                  >
                {/if}
              </td>
              <td class="p-2 font-mono text-xs text-muted-nowrap">{formatDuration(dur)}</td>
              <td class="p-2 font-mono text-xs tabular-nums"
                >{formatActivityCredits(group.groupTotalUsd)}</td
              >
            </tr>

            {#if isExpanded && hasMultipleCalls}
              {#each group.calls as call (call.id)}
                {@const callProv = groupProviderLabel([call])}
                <tr class="border-b border-border/30 bg-muted/20">
                  <td class="p-2 pl-8 whitespace-nowrap text-muted-foreground"
                    >{formatDate(call.createdAt)}</td
                  >
                  <td class="p-2 text-muted-foreground">
                    <span class="inline-flex items-center gap-1">
                      {#if callProv.isPaid}
                        <span class="text-destructive">●</span>
                      {:else}
                        <span class="text-green-600">●</span>
                      {/if}
                      {callProv.label}
                    </span>
                  </td>
                  <td class="p-2">
                    <span
                      class="font-mono text-xs truncate max-w-[250px] block text-muted-foreground"
                      >{call.operation}</span
                    >
                    {#if call.context}
                      <span class="text-xs text-muted-foreground truncate max-w-[250px] block"
                        >{call.context}</span
                      >
                    {/if}
                  </td>
                  <td class="p-2 font-mono text-xs text-muted-nowrap"
                    >{formatDuration(call.durationMs)}</td
                  >
                  <td class="p-2 font-mono text-xs tabular-nums"
                    >{formatActivityCredits(call.totalCostUsd)}</td
                  >
                </tr>
              {/each}
            {/if}
          {:else}
            <tr>
              <td class="text-muted-foreground p-4 text-xs" colspan="5">No activity logged yet.</td>
            </tr>
          {/each}
        </tbody>
        <tfoot class="border-t-2 border-border bg-muted/30">
          <tr>
            <td class="p-2 text-right text-xs font-medium" colspan="4">Total (this page)</td>
            <td class="p-2 font-mono text-xs tabular-nums">{pageTotalCredits}</td>
          </tr>
        </tfoot>
      </table>
    </Card.Content>
  </Card.Root>

  {#if totalPages > 1}
    <div class="mt-4 flex items-center justify-center gap-3">
      {#if currentPage > 1}
        <button
          onclick={() => {
            currentPage = currentPage - 1
          }}
        >
          <Button variant="outline" size="xs">Previous</Button>
        </button>
      {/if}
      <span class="text-muted-foreground text-xs">
        Page {currentPage} of {totalPages}
        ({grouped.length} groups)
      </span>
      {#if currentPage < totalPages}
        <button
          onclick={() => {
            currentPage = currentPage + 1
          }}
        >
          <Button variant="outline" size="xs">Next</Button>
        </button>
      {/if}
    </div>
  {/if}
{/if}
